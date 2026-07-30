export type MatchValidationCode =
  | 'unsupported_operation'
  | 'unsupported_entity_type'
  | 'entity_not_current'
  | 'entity_not_unique'
  | 'entity_mismatch'
  | 'entity_not_open'
  | 'amount_mismatch'
  | 'direction_mismatch'
  | 'bank_account_mismatch'
  | 'currency_mismatch'
  | 'identity_not_corroborated';

export type MatchValidationFailure = { code: MatchValidationCode; explanation: string };

export type CreateValidationCode =
  | 'unsupported_operation'
  | 'unsupported_entity_type'
  | 'direction_mismatch'
  | 'candidate_incomplete'
  | 'reference_not_current'
  | 'possible_duplicate';

export type CreateValidationFailure = { code: CreateValidationCode; explanation: string };

type Row = Record<string, any>;

export type ExistingMatchValidationInput = {
  line: { amountMinor: number; postedAt: string; payee: string; description: string; reference: string };
  xeroBankAccountId: string | null;
  recommendation: {
    proposedOperation: string;
    candidateKind: string;
    existingXeroEntityType: string;
    existingXeroEntityId: string;
    existingXeroEntityNumber: string;
  };
  currentCandidates: Array<Row & { entityType: string; entityId: string; score: number }>;
  entity: Row;
};

function normalized(value: unknown): string {
  return String(value ?? '')
    .toLocaleLowerCase('en-GB')
    .replace(/\b(limited|ltd|plc|llp|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function nested(value: unknown, key: string): string {
  return value && typeof value === 'object' ? String((value as Row)[key] ?? '') : '';
}

function exactMinor(value: unknown): number {
  return Math.round(Math.abs(Number(value)) * 100);
}

function corroboratesIdentity(line: ExistingMatchValidationInput['line'], entity: Row, entityNumber: string): boolean {
  const payee = normalized(line.payee);
  const contact = normalized(entity.Contact?.Name);
  if (payee && contact && (payee.includes(contact) || contact.includes(payee))) return true;
  const statement = normalized([line.payee, line.description, line.reference].join(' '));
  return [entityNumber, entity.Reference].some(value => {
    const marker = normalized(value);
    return marker.length >= 4 && statement.includes(marker);
  });
}

function fail(code: MatchValidationCode, explanation: string): { valid: false; failure: MatchValidationFailure } {
  return { valid: false, failure: { code, explanation } };
}

export function validateExistingXeroMatch(input: ExistingMatchValidationInput):
  | { valid: true; selectedCandidate: Row; objectType: 'invoice' | 'bank_transaction'; objectRole: 'parent_document' | 'primary'; kind: 'bill' | 'invoice' | 'bank_transaction' }
  | { valid: false; failure: MatchValidationFailure } {
  const { line, recommendation, currentCandidates, entity } = input;
  if (recommendation.proposedOperation !== 'match_existing') return fail('unsupported_operation', 'The saved agent run does not propose matching an existing Xero entity.');
  if (!['invoice', 'bank_transaction'].includes(recommendation.existingXeroEntityType)) return fail('unsupported_entity_type', 'Only existing bills, invoices and bank transactions are supported in this first execution path.');
  if (!['bill', 'invoice', 'bank_transaction'].includes(recommendation.candidateKind)) return fail('unsupported_entity_type', 'The proposed candidate kind cannot be attached as a single-line Xero candidate.');

  const selected = currentCandidates.find(candidate => candidate.entityType === recommendation.existingXeroEntityType && candidate.entityId === recommendation.existingXeroEntityId);
  if (!selected || Number(selected.score) < 0.8) return fail('entity_not_current', 'A fresh Xero search no longer returns this entity as a strong candidate for the line.');
  const equalOrBetter = currentCandidates.filter(candidate => candidate.entityType === selected.entityType && candidate.entityId !== selected.entityId && exactMinor(candidate.amountDue ?? candidate.amount) === Math.abs(line.amountMinor) && Number(candidate.score) >= Number(selected.score));
  if (equalOrBetter.length) return fail('entity_not_unique', 'A different current Xero entity is an equally strong or stronger match.');

  const entityId = recommendation.existingXeroEntityType === 'invoice' ? entity.InvoiceID : entity.BankTransactionID;
  if (entityId !== recommendation.existingXeroEntityId) return fail('entity_mismatch', 'Xero returned a different entity from the one named by the saved run.');
  if (entity.Status !== 'AUTHORISED') return fail('entity_not_open', `The Xero entity is now ${entity.Status ?? 'in an unknown state'}, not AUTHORISED.`);
  if (entity.CurrencyCode && entity.CurrencyCode !== 'GBP') return fail('currency_mismatch', 'The Xero entity is not denominated in GBP.');

  if (recommendation.existingXeroEntityType === 'invoice') {
    const kind = line.amountMinor < 0 ? 'bill' : 'invoice';
    if (recommendation.candidateKind !== kind || entity.Type !== (kind === 'bill' ? 'ACCPAY' : 'ACCREC')) return fail('direction_mismatch', 'The bill/invoice direction does not match the statement line.');
    if (exactMinor(entity.AmountDue) !== Math.abs(line.amountMinor)) return fail('amount_mismatch', 'The current outstanding amount no longer equals the statement line.');
    if (!corroboratesIdentity(line, entity, String(entity.InvoiceNumber ?? recommendation.existingXeroEntityNumber))) return fail('identity_not_corroborated', 'Neither contact identity nor invoice/reference text corroborates the match.');
    return { valid: true, selectedCandidate: selected, objectType: 'invoice', objectRole: 'parent_document', kind };
  }

  if (recommendation.candidateKind !== 'bank_transaction' || entity.Type !== (line.amountMinor < 0 ? 'SPEND' : 'RECEIVE')) return fail('direction_mismatch', 'The spend/receive direction does not match the statement line.');
  if (entity.IsReconciled) return fail('entity_not_open', 'The bank transaction is already reconciled in Xero.');
  if (exactMinor(entity.Total) !== Math.abs(line.amountMinor)) return fail('amount_mismatch', 'The Xero transaction total no longer equals the statement line.');
  if (!input.xeroBankAccountId || nested(entity.BankAccount, 'AccountID') !== input.xeroBankAccountId) return fail('bank_account_mismatch', 'The Xero transaction belongs to a different bank account.');
  if (!corroboratesIdentity(line, entity, '')) return fail('identity_not_corroborated', 'Neither contact identity nor reference text corroborates the match.');
  return { valid: true, selectedCandidate: selected, objectType: 'bank_transaction', objectRole: 'primary', kind: 'bank_transaction' };
}

export function validateNewXeroCandidate(input: {
  line: { amountMinor: number };
  recommendation: Row;
  currentCandidates: Array<Row & { score: number }>;
  referenceData: { contacts: Row[]; postingAccounts: Row[]; taxRates: Row[] };
}):
  | { valid: true; kind: 'bill' | 'invoice' | 'bank_transaction'; candidate: { contactId: string; accountCode: string; taxType: string; description: string; invoiceNumber?: string; documentDate?: string; dueDate?: string } }
  | { valid: false; failure: CreateValidationFailure } {
  const { recommendation, line, referenceData } = input;
  const createFail = (code: CreateValidationCode, explanation: string) => ({ valid: false as const, failure: { code, explanation } });
  if (recommendation.proposedOperation !== 'create_new') return createFail('unsupported_operation', 'The saved agent run does not propose creating a new Xero record.');
  if (!['bill', 'invoice', 'bank_transaction'].includes(recommendation.candidateKind)) return createFail('unsupported_entity_type', 'This recommendation type cannot yet be created automatically.');
  if ((line.amountMinor < 0 && recommendation.candidateKind === 'invoice') || (line.amountMinor > 0 && recommendation.candidateKind === 'bill')) return createFail('direction_mismatch', 'The proposed bill or invoice direction does not match the statement line.');
  let contactId = String(recommendation.contactId ?? '');
  const contactName = String(recommendation.contactName ?? '');
  const accountCode = String(recommendation.accountCode ?? '');
  const taxType = String(recommendation.taxType ?? '');
  if ((!contactId && !contactName) || !accountCode || !taxType) return createFail('candidate_incomplete', 'The recommendation must resolve a Xero contact, posting account and tax rate before it can be used.');
  if (contactId) {
    if (!referenceData.contacts.some(contact => contact.id === contactId)) return createFail('reference_not_current', 'The recommended Xero contact is no longer active.');
  } else {
    const contactKey = (value: unknown) => String(value ?? '').toLocaleLowerCase('en-GB').replace(/[^a-z0-9]+/g, ' ').trim();
    const exactMatches = referenceData.contacts.filter(contact => contactKey(contact.name) === contactKey(contactName));
    if (exactMatches.length !== 1) return createFail('candidate_incomplete', exactMatches.length ? 'More than one current Xero contact has the recommended name; ask the agent to identify the exact contact.' : 'The recommended contact does not exist as a current Xero contact; ask the agent to revise the recommendation.');
    contactId = String(exactMatches[0].id);
  }
  if (!referenceData.postingAccounts.some(account => account.code === accountCode)) return createFail('reference_not_current', 'The recommended Xero account is no longer active.');
  if (!referenceData.taxRates.some(rate => rate.taxType === taxType)) return createFail('reference_not_current', 'The recommended Xero tax rate is no longer active.');
  if (input.currentCandidates.some(candidate => Number(candidate.score) >= 0.8)) return createFail('possible_duplicate', 'A fresh Xero search now finds a strong existing candidate. Ask the agent to reconsider before creating a duplicate.');
  const candidate = { contactId, accountCode, taxType, description: String(recommendation.description ?? '') };
  if (recommendation.candidateKind === 'bank_transaction') return { valid: true, kind: recommendation.candidateKind, candidate };
  const documentDate = String(recommendation.documentDate ?? '');
  const dueDate = String(recommendation.dueDate ?? '');
  const isIsoDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!isIsoDate(documentDate) || !isIsoDate(dueDate)) return createFail('candidate_incomplete', 'The recommendation must include valid document and due dates before a bill or invoice can be created.');
  if (dueDate < documentDate) return createFail('candidate_incomplete', 'The recommended due date cannot be earlier than the document date.');
  return {
    valid: true,
    kind: recommendation.candidateKind,
    candidate: { ...candidate, invoiceNumber: String(recommendation.reference ?? ''), documentDate, dueDate }
  };
}
