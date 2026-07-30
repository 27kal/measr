import { describe, expect, it } from 'vitest';
import { validateExistingXeroMatch, validateNewXeroCandidate } from '../../supabase/functions/_shared/agent-validator';

const line = { amountMinor: 420000, postedAt: '2026-07-12', payee: 'Dishpatch', description: 'Dishpatch customer receipt', reference: 'INV-0361' };
const recommendation = { proposedOperation: 'match_existing', candidateKind: 'invoice', existingXeroEntityType: 'invoice', existingXeroEntityId: '7cbc509a-6811-4ae5-a82e-406af6d2c36a', existingXeroEntityNumber: 'INV-0361' };
const candidate = { entityType: 'invoice', entityId: recommendation.existingXeroEntityId, entityNumber: 'INV-0361', score: 1, amountDue: 4200 };
const entity = { InvoiceID: recommendation.existingXeroEntityId, InvoiceNumber: 'INV-0361', Type: 'ACCREC', Status: 'AUTHORISED', CurrencyCode: 'GBP', AmountDue: 4200, Contact: { Name: 'Dishpatch Ltd' } };

describe('deterministic agent match validator', () => {
  it('accepts a unique current authorised invoice with an exact outstanding amount and corroborated identity', () => {
    const result = validateExistingXeroMatch({ line, xeroBankAccountId: 'bank-id', recommendation, currentCandidates: [candidate], entity });
    expect(result).toMatchObject({ valid: true, kind: 'invoice', objectType: 'invoice', objectRole: 'parent_document' });
  });

  it('rejects the recommendation when an equally strong duplicate is current', () => {
    const result = validateExistingXeroMatch({ line, xeroBankAccountId: 'bank-id', recommendation, currentCandidates: [candidate, { ...candidate, entityId: '08f2a0ca-85d3-4678-a9d7-4a190600612e' }], entity });
    expect(result).toEqual({ valid: false, failure: { code: 'entity_not_unique', explanation: 'A different current Xero entity is an equally strong or stronger match.' } });
  });

  it('rejects a stale outstanding amount even when the agent thread still recommends it', () => {
    const result = validateExistingXeroMatch({ line, xeroBankAccountId: 'bank-id', recommendation, currentCandidates: [candidate], entity: { ...entity, AmountDue: 2100 } });
    expect(result).toMatchObject({ valid: false, failure: { code: 'amount_mismatch' } });
  });

  it('rejects a bank transaction from a different mapped bank account', () => {
    const bankRecommendation = { ...recommendation, candidateKind: 'bank_transaction', existingXeroEntityType: 'bank_transaction', existingXeroEntityId: '664b825f-ff66-4548-93f7-2921321cdcd1', existingXeroEntityNumber: '' };
    const bankCandidate = { entityType: 'bank_transaction', entityId: bankRecommendation.existingXeroEntityId, score: 1, amount: 4200 };
    const bankEntity = { BankTransactionID: bankRecommendation.existingXeroEntityId, Type: 'RECEIVE', Status: 'AUTHORISED', CurrencyCode: 'GBP', Total: 4200, IsReconciled: false, Contact: { Name: 'Dishpatch Ltd' }, BankAccount: { AccountID: 'other-bank' } };
    const result = validateExistingXeroMatch({ line, xeroBankAccountId: 'mapped-bank', recommendation: bankRecommendation, currentCandidates: [bankCandidate], entity: bankEntity });
    expect(result).toMatchObject({ valid: false, failure: { code: 'bank_account_mismatch' } });
  });
});

describe('deterministic new-candidate validator', () => {
  const createRecommendation = { proposedOperation: 'create_new', candidateKind: 'bank_transaction', contactId: 'contact-1', accountCode: '429', taxType: 'INPUT2', description: 'Team lunch' };
  const referenceData = { contacts: [{ id: 'contact-1' }], postingAccounts: [{ code: '429' }], taxRates: [{ taxType: 'INPUT2' }] };

  it('accepts a complete recommendation using current Xero references', () => {
    expect(validateNewXeroCandidate({ line: { amountMinor: -1200 }, recommendation: createRecommendation, currentCandidates: [], referenceData })).toEqual({ valid: true, kind: 'bank_transaction', candidate: { contactId: 'contact-1', accountCode: '429', taxType: 'INPUT2', description: 'Team lunch' } });
  });

  it('rejects creating a duplicate when a strong current Xero candidate appears', () => {
    expect(validateNewXeroCandidate({ line: { amountMinor: -1200 }, recommendation: createRecommendation, currentCandidates: [{ score: 0.8 }], referenceData })).toMatchObject({ valid: false, failure: { code: 'possible_duplicate' } });
  });

  it('rejects a stale account code from the saved agent thread', () => {
    expect(validateNewXeroCandidate({ line: { amountMinor: -1200 }, recommendation: createRecommendation, currentCandidates: [], referenceData: { ...referenceData, postingAccounts: [] } })).toMatchObject({ valid: false, failure: { code: 'reference_not_current' } });
  });

  it('resolves a missing contact ID only from one exact current Xero contact name', () => {
    const recommendationByName = { ...createRecommendation, contactId: '', contactName: 'Oakhill Service Statio' };
    const current = { ...referenceData, contacts: [{ id: 'oakhill-id', name: 'OAKHILL SERVICE STATIO' }] };
    expect(validateNewXeroCandidate({ line: { amountMinor: -8067 }, recommendation: recommendationByName, currentCandidates: [], referenceData: current })).toMatchObject({ valid: true, candidate: { contactId: 'oakhill-id' } });
  });

  it('rejects ambiguous exact-name contact resolution', () => {
    const recommendationByName = { ...createRecommendation, contactId: '', contactName: 'Oakhill Service Statio' };
    const current = { ...referenceData, contacts: [{ id: 'one', name: 'Oakhill Service Statio' }, { id: 'two', name: 'OAKHILL SERVICE STATIO' }] };
    expect(validateNewXeroCandidate({ line: { amountMinor: -8067 }, recommendation: recommendationByName, currentCandidates: [], referenceData: current })).toMatchObject({ valid: false, failure: { code: 'candidate_incomplete' } });
  });

  it('preserves structured supplier-document metadata for an authorised bill', () => {
    const bill = { ...createRecommendation, candidateKind: 'bill', reference: '509E97FE-0053', documentDate: '2026-06-30', dueDate: '2026-06-30' };
    expect(validateNewXeroCandidate({ line: { amountMinor: -9817 }, recommendation: bill, currentCandidates: [], referenceData })).toEqual({
      valid: true,
      kind: 'bill',
      candidate: {
        contactId: 'contact-1',
        accountCode: '429',
        taxType: 'INPUT2',
        description: 'Team lunch',
        invoiceNumber: '509E97FE-0053',
        documentDate: '2026-06-30',
        dueDate: '2026-06-30'
      }
    });
  });

  it('rejects a bill whose dates are missing, invalid or reversed', () => {
    const bill = { ...createRecommendation, candidateKind: 'bill', reference: 'BILL-1' };
    expect(validateNewXeroCandidate({ line: { amountMinor: -1200 }, recommendation: bill, currentCandidates: [], referenceData })).toMatchObject({ valid: false, failure: { code: 'candidate_incomplete' } });
    expect(validateNewXeroCandidate({ line: { amountMinor: -1200 }, recommendation: { ...bill, documentDate: '2026-02-31', dueDate: '2026-03-01' }, currentCandidates: [], referenceData })).toMatchObject({ valid: false, failure: { code: 'candidate_incomplete' } });
    expect(validateNewXeroCandidate({ line: { amountMinor: -1200 }, recommendation: { ...bill, documentDate: '2026-07-02', dueDate: '2026-07-01' }, currentCandidates: [], referenceData })).toMatchObject({ valid: false, failure: { code: 'candidate_incomplete' } });
  });
});
