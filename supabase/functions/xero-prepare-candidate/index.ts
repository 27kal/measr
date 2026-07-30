import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifiedUserId } from '../_shared/auth.ts';
import { corsHeaders, json } from '../_shared/http.ts';
import { oneRecoveryMatch, recoveryLookupPath, recoveryMatches, sha256Json } from '../_shared/xero-recovery.ts';
import { authorisedInvoicePayload, freshXeroAccessToken, xeroRequest, type XeroEntity } from '../_shared/xero.ts';
import { transferShape } from '../_shared/xero-transfer.ts';
import { bankTransactionMatchesPreparation, bankTransferMatchesPreparation, invoiceMatchesStatement } from '../_shared/xero-verification.ts';
import { syncCandidateDocumentsToXero } from '../_shared/documents.ts';

type Row = Record<string, unknown>;
type ReservedPreparation = {
  candidateSetId: string;
  correlationToken: string;
  idempotencyKey: string;
  preparationState: 'creating' | 'created_in_xero' | 'committed' | 'recovery_needed';
  reused: boolean;
};

function candidateObject(kind: XeroEntity, payload: Row): Row | null {
  const collection = kind === 'transfer' ? payload.BankTransfers : kind === 'bill' || kind === 'invoice' ? payload.Invoices : payload.BankTransactions;
  return Array.isArray(collection) && collection[0] && typeof collection[0] === 'object' ? collection[0] as Row : null;
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function storedXeroObjects(kind: XeroEntity, companyId: string, setId: string, token: string, object: Row): Row[] {
  const common = { companyId, candidateSetId: setId, correlationToken: token };
  if (kind === 'transfer') return [
    { ...common, objectType: 'bank_transfer', objectRole: 'primary', xeroObjectId: object.BankTransferID, xeroStatus: object.Status ?? 'AUTHORISED', isReconciled: Boolean(object.FromIsReconciled && object.ToIsReconciled), correlationChannels: ['reference', 'history_note'], observedPayload: object },
    { ...common, objectType: 'bank_transaction', objectRole: 'source_transaction', xeroObjectId: object.FromBankTransactionID, xeroStatus: object.Status ?? 'AUTHORISED', isReconciled: Boolean(object.FromIsReconciled), correlationChannels: ['local_only'], observedPayload: { BankTransactionID: object.FromBankTransactionID, BankTransferID: object.BankTransferID } },
    { ...common, objectType: 'bank_transaction', objectRole: 'destination_transaction', xeroObjectId: object.ToBankTransactionID, xeroStatus: object.Status ?? 'AUTHORISED', isReconciled: Boolean(object.ToIsReconciled), correlationChannels: ['local_only'], observedPayload: { BankTransactionID: object.ToBankTransactionID, BankTransferID: object.BankTransferID } }
  ];
  return [{
    ...common,
    objectType: kind === 'bill' || kind === 'invoice' ? 'invoice' : 'bank_transaction',
    objectRole: kind === 'bill' || kind === 'invoice' ? 'parent_document' : 'primary',
    xeroObjectId: object.InvoiceID ?? object.BankTransactionID,
    xeroStatus: object.Status ?? 'AUTHORISED',
    isReconciled: Boolean(object.IsReconciled),
    correlationChannels: ['url', 'reference', 'history_note'],
    observedPayload: object
  }];
}

async function markRecovery(service: ReturnType<typeof createClient>, candidateSetId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const { error: markError } = await service.rpc('mark_xero_preparation_recovery', { p_candidate_set_id: candidateSetId, p_error: message });
  if (markError) console.error('Could not mark Xero preparation for recovery', markError);
}

Deno.serve(async request => {
  let service: ReturnType<typeof createClient> | null = null;
  let reserved: ReservedPreparation | null = null;
  try {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const userId = verifiedUserId(request);
    if (!userId) return json({ error: 'Invalid or expired session' }, 401);
    const input = await request.json() as { companyId: string; lineId: string; kind: XeroEntity; pairedTransferLineId?: string; candidate: Record<string, unknown> };
    const { data: membership } = await service.from('company_memberships').select('role').eq('company_id', input.companyId).eq('user_id', userId).maybeSingle();
    if (!membership) return json({ error: 'Company access denied' }, 403);
    if (membership.role === 'viewer') return json({ error: 'Viewers cannot prepare bookkeeping candidates' }, 403);

    const lineIds = [input.lineId, input.pairedTransferLineId].filter(Boolean) as string[];
    if ((input.kind === 'transfer' && lineIds.length !== 2) || (input.kind !== 'transfer' && lineIds.length !== 1)) return json({ error: 'Candidate has the wrong number of statement lines' }, 422);
    const { data: lines, error: lineError } = await service.from('statement_lines').select('*').eq('company_id', input.companyId).in('id', lineIds);
    if (lineError || !lines || lines.length !== lineIds.length) return json({ error: 'Statement line changed; refresh and try again' }, 409);
    if (lines.some(line => line.active_candidate_set_id)) {
      const activeIds = [...new Set(lines.map(line => line.active_candidate_set_id).filter(Boolean))];
      if (activeIds.length === 1) {
        const { data: existing } = await service.from('candidate_sets').select('id,kind,status,correlation_token,preparation_state').eq('id', activeIds[0]).maybeSingle();
        if (existing?.kind === input.kind && existing.preparation_state === 'committed') return json({ candidateSetId: existing.id, correlationToken: existing.correlation_token, alreadyCommitted: true }, 200);
      }
      return json({ error: 'Statement line changed; refresh and try again' }, 409);
    }

    let transfer: ReturnType<typeof transferShape> | null = null;
    if (input.kind === 'transfer') {
      try {
        transfer = transferShape(lines);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Invalid transfer statement lines' }, 422);
      }
    }

    const { data: connection } = await service.from('xero_connections').select('*').eq('company_id', input.companyId).is('disconnected_at', null).single();
    if (!connection) return json({ error: 'Xero is not connected' }, 409);
    const failurePoint = request.headers.get('x-workbench-failure-point');
    let injectFailureAfterWrite = false;
    if (failurePoint) {
      const configuredToken = Deno.env.get('XERO_FAILURE_INJECTION_TOKEN');
      const suppliedToken = request.headers.get('x-workbench-failure-token');
      if (membership.role !== 'owner' || connection.tenant_name !== 'Demo Company (UK)' || !configuredToken || suppliedToken !== configuredToken) return json({ error: 'Failure injection is not authorised' }, 403);
      if (failurePoint !== 'after_xero_write') return json({ error: 'Unknown failure injection point' }, 422);
      injectFailureAfterWrite = true;
    }
    const primary = transfer?.source ?? lines.find(line => line.id === input.lineId)!;
    const accountIds = input.kind === 'transfer' ? [transfer!.source.bank_account_id, transfer!.destination.bank_account_id] : [primary.bank_account_id];
    const { data: localAccounts } = await service.from('bank_accounts').select('id,xero_account_id').eq('company_id', input.companyId).in('id', accountIds);
    const xeroAccountId = (localId: string) => localAccounts?.find(account => account.id === localId)?.xero_account_id as string | undefined;
    const primaryXeroBankAccountId = xeroAccountId(primary.bank_account_id);

    let xeroPayload: Row;
    let endpoint: string;
    if (input.kind === 'bill' || input.kind === 'invoice') {
      if (!validIsoDate(input.candidate.documentDate) || !validIsoDate(input.candidate.dueDate) || String(input.candidate.dueDate) < String(input.candidate.documentDate)) return json({ error: 'Bills and invoices require valid document and due dates' }, 422);
      if (String(input.candidate.invoiceNumber ?? '').length > 255) return json({ error: 'The invoice number exceeds Xero’s 255-character limit' }, 422);
      endpoint = 'Invoices';
      xeroPayload = { Invoices: [{ ...authorisedInvoicePayload({ kind: input.kind, contactId: String(input.candidate.contactId), accountCode: String(input.candidate.accountCode), taxType: String(input.candidate.taxType ?? ''), amount: Math.abs(primary.amount_minor) / 100, invoiceNumber: String(input.candidate.invoiceNumber ?? ''), reference: '', description: String(input.candidate.description || primary.description), date: String(input.candidate.documentDate), dueDate: String(input.candidate.dueDate) }) }] };
    } else if (input.kind === 'transfer') {
      const fromAccountId = xeroAccountId(transfer!.source.bank_account_id);
      const toAccountId = xeroAccountId(transfer!.destination.bank_account_id);
      if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) return json({ error: 'Both transfer sides must be mapped to different Xero bank accounts' }, 422);
      endpoint = 'BankTransfers';
      xeroPayload = { BankTransfers: [{ FromBankAccount: { AccountID: fromAccountId }, ToBankAccount: { AccountID: toAccountId }, Amount: Math.abs(primary.amount_minor) / 100, Date: primary.posted_at, Reference: '' }] };
    } else {
      if (!primaryXeroBankAccountId) return json({ error: 'This bank account must be mapped to a Xero bank account in Settings' }, 422);
      endpoint = 'BankTransactions';
      xeroPayload = { BankTransactions: [{ Type: primary.amount_minor < 0 ? 'SPEND' : 'RECEIVE', BankAccount: { AccountID: primaryXeroBankAccountId }, Contact: { ContactID: input.candidate.contactId }, Status: 'AUTHORISED', Date: primary.posted_at, Reference: '', LineAmountTypes: 'Inclusive', LineItems: [{ Description: String(input.candidate.description || primary.description), Quantity: 1, UnitAmount: Math.abs(primary.amount_minor) / 100, AccountCode: input.candidate.accountCode, ...(input.candidate.taxType ? { TaxType: input.candidate.taxType } : {}) }] }] };
    }

    const lineSpecs = lines.map(line => ({ statementLineId: line.id, role: input.kind === 'transfer' ? (line.id === transfer!.source.id ? 'transfer_source' : 'transfer_destination') : 'primary' }));
    // Reserve first, then put the durable token into the exact request that is fingerprinted and sent to Xero.
    const tokenSeed = `WB-${String(primary.id).replaceAll('-', '').slice(0, 20).toUpperCase()}-A`;
    const agentRunId = request.headers.get('x-workbench-agent-run-id');
    const requestShape = { endpoint, payload: xeroPayload, tokenSeed, ...(agentRunId ? { agentRunId } : {}) };
    const provisionalFingerprint = await sha256Json(requestShape);
    const { data: initialReservation, error: reserveError } = await service.rpc('reserve_xero_preparation', {
      p_company_id: input.companyId,
      p_kind: input.kind,
      p_created_by: userId,
      p_line_specs: lineSpecs,
      p_preparation_request: requestShape,
      p_preparation_fingerprint: provisionalFingerprint
    });
    if (reserveError || !initialReservation) return json({ error: reserveError?.message ?? 'Could not reserve Xero preparation' }, 409);
    reserved = initialReservation as ReservedPreparation;
    if (reserved.preparationState === 'committed') return json({ candidateSetId: reserved.candidateSetId, correlationToken: reserved.correlationToken, alreadyCommitted: true }, 200);

    const root = (xeroPayload[endpoint] as Row[])[0];
    root.Reference = reserved.correlationToken;
    // The durable marker is excluded from the intent fingerprint and checked independently.
    // This keeps the fingerprint stable while SQL allocates the attempt number atomically.
    root.Reference = '';
    const accessToken = await freshXeroAccessToken(service, input.companyId);
    let object: Row | null = null;
    let recovered = false;

    if (reserved.reused) {
      const lookup = await xeroRequest(accessToken, connection.tenant_id, recoveryLookupPath(input.kind, reserved.correlationToken));
      object = oneRecoveryMatch(recoveryMatches(input.kind, lookup));
      recovered = Boolean(object);
    }

    root.Reference = reserved.correlationToken;
    if (object) {
      const matches = input.kind === 'transfer'
        ? bankTransferMatchesPreparation(object, { reference: reserved.correlationToken, amountMinor: Number(primary.amount_minor), fromXeroBankAccountId: String((root.FromBankAccount as Row).AccountID), toXeroBankAccountId: String((root.ToBankAccount as Row).AccountID), postedAt: String(primary.posted_at) })
        : input.kind === 'bill' || input.kind === 'invoice'
          ? invoiceMatchesStatement(object, { reference: reserved.correlationToken, kind: input.kind, amountMinor: Number(primary.amount_minor), date: String(root.Date) })
          : bankTransactionMatchesPreparation(object, { reference: reserved.correlationToken, amountMinor: Number(primary.amount_minor), xeroBankAccountId: String(primaryXeroBankAccountId), postedAt: String(primary.posted_at) });
      if (!matches) throw new Error('A Xero object has the reserved marker but its accounting fingerprint does not match');
    } else {
      const { error: startError } = await service.rpc('mark_xero_preparation_started', { p_candidate_set_id: reserved.candidateSetId });
      if (startError) throw new Error(startError.message);
      const result = await xeroRequest(accessToken, connection.tenant_id, endpoint, {
        method: 'POST',
        headers: { 'Idempotency-Key': reserved.idempotencyKey },
        body: JSON.stringify(xeroPayload)
      });
      object = candidateObject(input.kind, result);
      if (!object || object.HasErrors) return json({ error: 'Xero rejected the candidate', details: object?.ValidationErrors ?? [] }, 422);
      if (input.kind === 'transfer' && (!object.FromBankTransactionID || !object.ToBankTransactionID)) throw new Error('Xero did not return both transfer transaction identifiers');
      const { error: receiptError } = await service.from('candidate_sets').update({ preparation_state: 'created_in_xero', xero_write_succeeded_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', reserved.candidateSetId).eq('status', 'building');
      if (receiptError) throw new Error(`Xero created the candidate but its receipt could not be persisted: ${receiptError.message}`);
    }

    if (injectFailureAfterWrite) throw new Error('Injected failure after Xero creation and before local commit');

    const objects = storedXeroObjects(input.kind, input.companyId, reserved.candidateSetId, reserved.correlationToken, object!);
    const { data: committed, error: commitError } = await service.rpc('commit_xero_preparation', { p_candidate_set_id: reserved.candidateSetId, p_xero_objects: objects, p_recovered: recovered || reserved.reused });
    if (commitError) throw new Error(`Xero candidate exists but local commit failed: ${commitError.message}`);
    const xeroObjectId = String(object!.InvoiceID ?? object!.BankTransferID ?? object!.BankTransactionID);
    const attachmentTarget = input.kind === 'bill' || input.kind === 'invoice'
      ? { endpoint: 'Invoices' as const, objectType: 'invoice' as const }
      : input.kind === 'transfer'
        ? { endpoint: 'BankTransfers' as const, objectType: 'bank_transfer' as const }
        : { endpoint: 'BankTransactions' as const, objectType: 'bank_transaction' as const };
    const attachments = await syncCandidateDocumentsToXero(service, input.companyId, lineIds, reserved.candidateSetId, attachmentTarget.endpoint, attachmentTarget.objectType, xeroObjectId, accessToken, connection.tenant_id);
    return json({ candidateSetId: reserved.candidateSetId, correlationToken: reserved.correlationToken, xeroObjectId, recovered: recovered || reserved.reused, commit: committed, attachments }, reserved.reused ? 200 : 201);
  } catch (error) {
    console.error('xero-prepare-candidate failed', error);
    if (service && reserved) await markRecovery(service, reserved.candidateSetId, error);
    return json({ error: error instanceof Error ? error.message : 'Candidate preparation failed unexpectedly', recoveryReserved: Boolean(reserved) }, 500);
  }
});
