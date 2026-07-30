import type {
  CandidateSet,
  CandidateSetLine,
  StatementLine,
  WorkflowState,
  XeroObject,
  XeroObservation
} from './types';

export class WorkflowError extends Error {}

function cloneState(state: WorkflowState): WorkflowState {
  return structuredClone(state);
}

function lineById(state: WorkflowState, id: string): StatementLine {
  const line = state.lines.find(candidate => candidate.id === id);
  if (!line) throw new WorkflowError(`Unknown statement line ${id}`);
  return line;
}

function setLineStatus(line: StatementLine, status: StatementLine['status'], note: string): void {
  line.status = status;
  line.note = note;
  line.statusVersion += 1;
}

function xeroObject(
  setId: string,
  objectType: XeroObject['objectType'],
  objectRole: XeroObject['objectRole'],
  xeroObjectId: string,
  correlationToken: string
): XeroObject {
  return {
    id: `${setId}:${objectRole}`,
    objectType,
    objectRole,
    xeroObjectId,
    xeroStatus: 'AUTHORISED',
    isReconciled: false,
    correlationToken,
    correlationChannels: ['url', 'reference', 'history_note'],
    deletedAt: null
  };
}

export interface PrepareCandidateInput {
  id: string;
  companyId: string;
  kind: CandidateSet['kind'];
  attemptNumber: number;
  correlationToken: string;
  xeroObjectId: string;
  lines: Array<Omit<CandidateSetLine, 'verificationStatus'>>;
  transferTransactionIds?: { source: string; destination: string };
}

export function prepareCandidate(state: WorkflowState, input: PrepareCandidateInput): WorkflowState {
  if (input.lines.length === 0) throw new WorkflowError('A candidate set must link at least one statement line');
  if (state.candidateSets.some(set => set.id === input.id)) throw new WorkflowError(`Candidate set ${input.id} already exists`);

  const next = cloneState(state);
  const linkedLines = input.lines.map(link => lineById(next, link.statementLineId));
  for (const line of linkedLines) {
    if (line.companyId !== input.companyId) throw new WorkflowError('Candidate set cannot cross companies');
    if (line.activeCandidateSetId) throw new WorkflowError(`Statement line ${line.id} already has an active candidate`);
  }

  const objects: XeroObject[] = input.kind === 'transfer'
    ? [
        { ...xeroObject(input.id, 'bank_transfer', 'primary', input.xeroObjectId, input.correlationToken), correlationChannels: ['reference', 'history_note'] },
        xeroObject(input.id, 'bank_transaction', 'source_transaction', input.transferTransactionIds?.source ?? '', input.correlationToken),
        xeroObject(input.id, 'bank_transaction', 'destination_transaction', input.transferTransactionIds?.destination ?? '', input.correlationToken)
      ]
    : [xeroObject(
        input.id,
        input.kind === 'bill' || input.kind === 'invoice' ? 'invoice' : 'bank_transaction',
        input.kind === 'bill' || input.kind === 'invoice' ? 'parent_document' : 'primary',
        input.xeroObjectId,
        input.correlationToken
      )];

  const candidateSet: CandidateSet = {
    id: input.id,
    companyId: input.companyId,
    attemptNumber: input.attemptNumber,
    kind: input.kind,
    status: 'active',
    lines: input.lines.map(line => ({ ...line, verificationStatus: 'prepared' })),
    xeroObjects: objects,
    invalidationReason: null
  };
  next.candidateSets.push(candidateSet);
  for (const line of linkedLines) {
    line.activeCandidateSetId = candidateSet.id;
    setLineStatus(line, 'prepared', 'Candidate created in Xero. Open Xero to reconcile this statement line.');
  }
  return next;
}

function invalidateSet(state: WorkflowState, set: CandidateSet, reason: string): void {
  set.status = 'invalidated';
  set.invalidationReason = reason;
  for (const membership of set.lines) {
    membership.verificationStatus = 'invalidated';
    const line = lineById(state, membership.statementLineId);
    line.activeCandidateSetId = null;
    setLineStatus(line, 'needs_you', reason);
  }
}

export function applyXeroObservation(
  state: WorkflowState,
  candidateSetId: string,
  observation: XeroObservation
): WorkflowState {
  const next = cloneState(state);
  const set = next.candidateSets.find(candidate => candidate.id === candidateSetId);
  if (!set) throw new WorkflowError(`Unknown candidate set ${candidateSetId}`);

  if (set.kind === 'bank_transaction') {
    const primary = set.xeroObjects.find(object => object.objectRole === 'primary');
    if (!primary) throw new WorkflowError('BankTransaction candidate has no primary object');
    primary.xeroStatus = observation.objectStatus ?? primary.xeroStatus;
    primary.isReconciled = observation.isReconciled ?? primary.isReconciled;
    if (observation.objectStatus === 'DELETED') {
      primary.deletedAt = new Date().toISOString();
      invalidateSet(next, set, 'The Workbench candidate was deleted in Xero. Review the line before creating a new attempt.');
    } else if (observation.isReconciled && observation.fingerprintMatches) {
      set.status = 'settled';
      for (const membership of set.lines) {
        membership.verificationStatus = 'reconciled';
        setLineStatus(lineById(next, membership.statementLineId), 'reconciled', 'Xero reports the linked transaction reconciled.');
      }
    }
    return next;
  }

  if (set.kind === 'transfer') {
    const transfer = set.xeroObjects.find(object => object.objectType === 'bank_transfer');
    if (!transfer) throw new WorkflowError('Transfer candidate has no BankTransfer object');
    transfer.xeroStatus = observation.objectStatus ?? transfer.xeroStatus;
    if (observation.objectStatus === 'DELETED') {
      transfer.deletedAt = new Date().toISOString();
      invalidateSet(next, set, 'The shared bank transfer was deleted in Xero. Both statement lines need review.');
      return next;
    }

    for (const membership of set.lines) {
      const reconciled = membership.role === 'transfer_source'
        ? observation.fromIsReconciled === true && observation.fromFingerprintMatches === true
        : observation.toIsReconciled === true && observation.toFingerprintMatches === true;
      membership.verificationStatus = reconciled ? 'reconciled' : 'prepared';
      setLineStatus(
        lineById(next, membership.statementLineId),
        reconciled ? 'reconciled' : 'prepared',
        reconciled ? 'Xero reports this side of the transfer reconciled.' : 'The shared transfer exists in Xero and this side is waiting to be reconciled.'
      );
    }
    set.status = set.lines.every(line => !line.requiredForSettlement || line.verificationStatus === 'reconciled') ? 'settled' : 'active';
    return next;
  }

  const parent = set.xeroObjects.find(object => object.objectRole === 'parent_document');
  if (!parent) throw new WorkflowError('Invoice candidate has no parent document');
  parent.xeroStatus = observation.parentStatus ?? parent.xeroStatus;

  if (observation.parentStatus === 'DELETED' || observation.parentStatus === 'VOIDED') {
    parent.deletedAt = new Date().toISOString();
    invalidateSet(next, set, 'The linked bill or invoice was removed in Xero. Review the line before continuing.');
    return next;
  }

  if (observation.payment) {
    const existingPayment = set.xeroObjects.find(object => object.xeroObjectId === observation.payment?.xeroObjectId);
    const payment = existingPayment ?? xeroObject(
      set.id,
      'payment',
      'payment',
      observation.payment.xeroObjectId,
      parent.correlationToken
    );
    payment.xeroStatus = observation.payment.status;
    payment.isReconciled = observation.payment.isReconciled;
    if (!existingPayment) set.xeroObjects.push(payment);

    if (observation.payment.status === 'DELETED' && observation.parentStatus === 'AUTHORISED') {
      payment.deletedAt = new Date().toISOString();
      set.status = 'active';
      for (const membership of set.lines) {
        membership.verificationStatus = 'prepared';
        setLineStatus(lineById(next, membership.statementLineId), 'prepared', 'The Xero payment was reversed; the authorised document is ready to match again.');
      }
      return next;
    }

    const paymentMatches = set.lines.every(membership =>
      Math.abs(membership.expectedAmountMinor) === Math.abs(observation.payment!.amountMinor)
      && membership.expectedBankAccountId === observation.payment!.bankAccountId
    );
    if (observation.parentStatus === 'PAID' && observation.payment.status === 'AUTHORISED' && observation.payment.isReconciled && paymentMatches) {
      set.status = 'settled';
      for (const membership of set.lines) {
        membership.verificationStatus = 'reconciled';
        setLineStatus(lineById(next, membership.statementLineId), 'reconciled', 'Xero reports the linked payment reconciled and the document paid.');
      }
    }
  }
  return next;
}
