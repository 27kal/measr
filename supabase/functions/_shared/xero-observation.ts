import { freshXeroAccessToken, xeroRequest } from './xero.ts';
import { paymentMatchesStatement, transactionMatchesStatement, xeroDate } from './xero-verification.ts';

type Row = Record<string, any>;
type Service = { from: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> };

export type ObservationLineResult = {
  statementLineId: string;
  status: 'prepared' | 'reconciled' | 'needs_you';
  verificationStatus: 'prepared' | 'reconciled' | 'invalidated';
  reason: string;
};

export type CandidateObservationResult = {
  candidateSetId: string;
  status: 'active' | 'settled' | 'invalidated';
  lines: ObservationLineResult[];
};

export async function observeXeroCandidate(
  service: Service,
  candidateSetId: string,
  existingSession?: { accessToken: string; tenantId: string }
): Promise<CandidateObservationResult> {
  const { data: set, error: setError } = await service.from('candidate_sets').select('*, candidate_set_lines(*), xero_objects(*)').eq('id', candidateSetId).maybeSingle();
  if (setError) throw new Error(setError.message);
  if (!set) throw new Error('Candidate not found');

  const { data: connection, error: connectionError } = await service.from('xero_connections').select('tenant_id').eq('company_id', set.company_id).is('disconnected_at', null).maybeSingle();
  if (connectionError) throw new Error(connectionError.message);
  if (!connection) throw new Error('Xero is not connected');
  if (existingSession && existingSession.tenantId !== connection.tenant_id) throw new Error('Xero observation session belongs to a different organisation');

  const accountIds = set.candidate_set_lines.map((line: Row) => line.expected_bank_account_id);
  const { data: accounts, error: accountsError } = await service.from('bank_accounts').select('id,xero_account_id').in('id', accountIds);
  if (accountsError) throw new Error(accountsError.message);
  const xeroAccount = (id: string) => accounts?.find((account: Row) => account.id === id)?.xero_account_id;
  const accessToken = existingSession?.accessToken ?? await freshXeroAccessToken(service, set.company_id);
  const tenantId = existingSession?.tenantId ?? connection.tenant_id;
  const objectUpdates: Row[] = [];
  let lineResults: ObservationLineResult[] = [];
  let candidateStatus: CandidateObservationResult['status'] = 'active';
  let invalidationReason: string | null = null;

  if (set.kind === 'bank_transaction') {
    const object = set.xero_objects.find((item: Row) => item.object_role === 'primary');
    if (!object) throw new Error('The linked Xero bank transaction was not found');
    const payload = await xeroRequest(accessToken, tenantId, `BankTransactions/${object.xero_object_id}`);
    const transaction = payload.BankTransactions?.[0];
    if (!transaction) throw new Error('Xero transaction was not returned');
    const member = set.candidate_set_lines[0];
    const fingerprintMatches = transactionMatchesStatement(transaction, {
      amountMinor: Number(member.expected_amount_minor),
      xeroBankAccountId: xeroAccount(member.expected_bank_account_id) ?? null,
      postedAt: String(member.expected_posted_at)
    });
    objectUpdates.push({ xeroObjectId: object.xero_object_id, xeroStatus: transaction.Status, isReconciled: transaction.IsReconciled, payload: transaction });
    if (transaction.Status === 'DELETED') {
      invalidationReason = 'The Workbench candidate was deleted in Xero. Review the line before creating a new attempt.';
      candidateStatus = 'invalidated';
      lineResults = [{ statementLineId: member.statement_line_id, status: 'needs_you', verificationStatus: 'invalidated', reason: invalidationReason }];
    } else if (transaction.IsReconciled && fingerprintMatches) {
      candidateStatus = 'settled';
      lineResults = [{ statementLineId: member.statement_line_id, status: 'reconciled', verificationStatus: 'reconciled', reason: 'Xero reports the exact linked transaction reconciled.' }];
    } else {
      lineResults = [{ statementLineId: member.statement_line_id, status: 'prepared', verificationStatus: 'prepared', reason: transaction.IsReconciled ? 'Xero state changed but the amount or bank account did not verify.' : 'Candidate exists in Xero and is not yet reconciled.' }];
    }
  } else if (set.kind === 'bill' || set.kind === 'invoice') {
    let parent = set.xero_objects.find((item: Row) => item.object_role === 'parent_document');
    const knownPayment = set.xero_objects.find((item: Row) => item.object_role === 'payment');
    let payment: Row | undefined;
    if (!parent && knownPayment) {
      const paymentPayload = await xeroRequest(accessToken, tenantId, `Payments/${knownPayment.xero_object_id}`);
      payment = paymentPayload.Payments?.[0];
      const parentId = payment?.Invoice?.InvoiceID;
      if (!parentId) throw new Error('The reconciled Xero payment did not return its parent document');
      const parentPayload = await xeroRequest(accessToken, tenantId, `Invoices/${parentId}`);
      const discoveredInvoice = parentPayload.Invoices?.[0];
      if (!discoveredInvoice) throw new Error('The parent Xero document was not returned');
      const { data: insertedParent, error: insertParentError } = await service.from('xero_objects').insert({
        company_id: set.company_id, candidate_set_id: set.id, object_type: 'invoice', object_role: 'parent_document',
        xero_object_id: parentId, xero_status: discoveredInvoice.Status, is_reconciled: false,
        correlation_token: set.correlation_token, correlation_channels: ['local_only'],
        observed_payload: discoveredInvoice, observed_at: new Date().toISOString()
      }).select().single();
      if (insertParentError) throw new Error(insertParentError.message);
      parent = insertedParent;
    }
    if (!parent) throw new Error('The linked Xero document was not found');
    const payload = await xeroRequest(accessToken, tenantId, `Invoices/${parent.xero_object_id}`);
    const invoice = payload.Invoices?.[0];
    if (!invoice) throw new Error('The linked Xero document was not returned');
    const member = set.candidate_set_lines[0];
    objectUpdates.push({ xeroObjectId: parent.xero_object_id, xeroStatus: invoice.Status, isReconciled: false, payload: invoice });
    if (invoice.Status === 'DELETED' || invoice.Status === 'VOIDED') {
      invalidationReason = 'The linked bill or invoice was removed in Xero. Review the line before continuing.';
      candidateStatus = 'invalidated';
      lineResults = [{ statementLineId: member.statement_line_id, status: 'needs_you', verificationStatus: 'invalidated', reason: invalidationReason }];
    } else {
      const paymentSummary = invoice.Payments?.find((item: Row) => item.Status !== 'DELETED');
      const paymentId = paymentSummary?.PaymentID ?? knownPayment?.xero_object_id;
      if (!payment && paymentId) {
        const paymentPayload = await xeroRequest(accessToken, tenantId, `Payments/${paymentId}`);
        payment = paymentPayload?.Payments?.[0];
      }
      const matches = payment && paymentMatchesStatement(payment, {
        amountMinor: Number(member.expected_amount_minor),
        xeroBankAccountId: xeroAccount(member.expected_bank_account_id) ?? null,
        postedAt: String(member.expected_posted_at),
        parentInvoiceId: String(parent.xero_object_id)
      });
      if (payment) {
        const storedPayment = set.xero_objects.find((item: Row) => item.xero_object_id === payment.PaymentID);
        if (!storedPayment) {
          const { error: paymentInsertError } = await service.from('xero_objects').insert({
            company_id: set.company_id, candidate_set_id: set.id, object_type: 'payment', object_role: 'payment',
            xero_object_id: payment.PaymentID, xero_status: payment.Status, is_reconciled: payment.IsReconciled,
            correlation_token: set.correlation_token, correlation_channels: ['local_only'],
            observed_payload: payment, observed_at: new Date().toISOString()
          });
          if (paymentInsertError) throw new Error(paymentInsertError.message);
        }
        objectUpdates.push({ xeroObjectId: payment.PaymentID, xeroStatus: payment.Status, isReconciled: payment.IsReconciled, payload: payment });
      }
      if (invoice.Status === 'PAID' && payment?.Status === 'AUTHORISED' && payment.IsReconciled && matches) {
        candidateStatus = 'settled';
        lineResults = [{ statementLineId: member.statement_line_id, status: 'reconciled', verificationStatus: 'reconciled', reason: 'Xero reports the exact linked payment reconciled and the document paid.' }];
      } else {
        const reason = payment?.Status === 'DELETED'
          ? 'The Xero payment was reversed; the authorised document is ready to match again.'
          : !payment
            ? 'Authorised document exists and is waiting for a Xero payment.'
            : !matches
              ? 'Xero recorded a payment, but its parent, bank account, amount or date does not match this statement line.'
              : !payment.IsReconciled
                ? 'The matching Xero payment exists but is not reconciled.'
                : invoice.Status !== 'PAID'
                  ? 'The matching payment is reconciled, but the Xero document is not paid.'
                  : `The matching Xero payment has unsupported status ${payment.Status ?? 'unknown'}.`;
        lineResults = [{ statementLineId: member.statement_line_id, status: 'prepared', verificationStatus: 'prepared', reason }];
      }
    }
  } else {
    const transferObject = set.xero_objects.find((item: Row) => item.object_type === 'bank_transfer');
    if (!transferObject) throw new Error('The linked Xero bank transfer was not found');
    const payload = await xeroRequest(accessToken, tenantId, `BankTransfers/${transferObject.xero_object_id}`);
    const transfer = payload.BankTransfers?.[0];
    if (!transfer) throw new Error('Xero bank transfer was not returned');
    objectUpdates.push({ xeroObjectId: transferObject.xero_object_id, xeroStatus: transfer.Status ?? 'AUTHORISED', isReconciled: transfer.FromIsReconciled && transfer.ToIsReconciled, payload: transfer });
    const sourceTransaction = set.xero_objects.find((item: Row) => item.object_role === 'source_transaction');
    const destinationTransaction = set.xero_objects.find((item: Row) => item.object_role === 'destination_transaction');
    if (sourceTransaction) objectUpdates.push({ xeroObjectId: sourceTransaction.xero_object_id, xeroStatus: transfer.Status ?? 'AUTHORISED', isReconciled: Boolean(transfer.FromIsReconciled), payload: { BankTransactionID: sourceTransaction.xero_object_id, BankTransferID: transfer.BankTransferID, IsReconciled: Boolean(transfer.FromIsReconciled), Status: transfer.Status ?? 'AUTHORISED' } });
    if (destinationTransaction) objectUpdates.push({ xeroObjectId: destinationTransaction.xero_object_id, xeroStatus: transfer.Status ?? 'AUTHORISED', isReconciled: Boolean(transfer.ToIsReconciled), payload: { BankTransactionID: destinationTransaction.xero_object_id, BankTransferID: transfer.BankTransferID, IsReconciled: Boolean(transfer.ToIsReconciled), Status: transfer.Status ?? 'AUTHORISED' } });
    if (transfer.Status === 'DELETED') {
      invalidationReason = 'The shared bank transfer was deleted in Xero. Both statement lines need review.';
      candidateStatus = 'invalidated';
      lineResults = set.candidate_set_lines.map((member: Row) => ({ statementLineId: String(member.statement_line_id), status: 'needs_you', verificationStatus: 'invalidated', reason: invalidationReason! }));
    } else {
      lineResults = set.candidate_set_lines.map((member: Row) => {
        const source = member.role === 'transfer_source';
        const reconciled = source ? transfer.FromIsReconciled : transfer.ToIsReconciled;
        const transferDateMatches = xeroDate(transfer.Date, transfer.DateString) === String(member.expected_posted_at);
        const matches = Math.round(Math.abs(transfer.Amount) * 100) === Math.abs(Number(member.expected_amount_minor))
          && (source ? transfer.FromBankAccount?.AccountID : transfer.ToBankAccount?.AccountID) === xeroAccount(String(member.expected_bank_account_id))
          && transferDateMatches;
        return {
          statementLineId: String(member.statement_line_id),
          status: reconciled && matches ? 'reconciled' : 'prepared',
          verificationStatus: reconciled && matches ? 'reconciled' : 'prepared',
          reason: reconciled && matches ? 'Xero reports this exact side of the transfer reconciled.' : 'The shared transfer exists; this side is waiting for verified reconciliation.'
        } as ObservationLineResult;
      });
      candidateStatus = lineResults.every(result => result.status === 'reconciled') ? 'settled' : 'active';
    }
  }

  const { error } = await service.rpc('apply_candidate_observation', {
    p_candidate_set_id: candidateSetId,
    p_object_updates: objectUpdates,
    p_line_results: lineResults,
    p_candidate_status: candidateStatus,
    p_invalidation_reason: invalidationReason
  });
  if (error) throw new Error(error.message);
  return { candidateSetId, status: candidateStatus, lines: lineResults };
}
