import { describe, expect, it } from 'vitest';
import { applyXeroObservation, prepareCandidate } from './workflow';
import type { StatementLine, WorkflowState } from './types';

function line(id: string, bankAccountId = 'bank-current', amountMinor = -12345): StatementLine {
  return {
    id,
    companyId: 'company-1',
    bankAccountId,
    postedAt: '2026-07-21',
    amountMinor,
    currency: 'GBP',
    payee: 'RITE Agency',
    description: 'Fixture',
    reference: id,
    status: 'new',
    statusVersion: 0,
    activeCandidateSetId: null,
    note: '',
    dedupeKey: id
  };
}

describe('Xero-backed workflow', () => {
  it('settles and later invalidates a BankTransaction without deleting the statement line', () => {
    const initial: WorkflowState = { lines: [line('line-spend')], candidateSets: [] };
    const prepared = prepareCandidate(initial, {
      id: 'set-spend', companyId: 'company-1', kind: 'bank_transaction', attemptNumber: 1,
      correlationToken: 'WB-L-SPEND', xeroObjectId: 'xero-spend',
      lines: [{ statementLineId: 'line-spend', role: 'primary', requiredForSettlement: true, expectedBankAccountId: 'bank-current', expectedAmountMinor: -12345 }]
    });
    const reconciled = applyXeroObservation(prepared, 'set-spend', { objectStatus: 'AUTHORISED', isReconciled: true, fingerprintMatches: true });
    expect(reconciled.lines[0].status).toBe('reconciled');
    const invalidated = applyXeroObservation(reconciled, 'set-spend', { objectStatus: 'DELETED', isReconciled: false });
    expect(invalidated.lines).toHaveLength(1);
    expect(invalidated.lines[0]).toMatchObject({ status: 'needs_you', activeCandidateSetId: null });
    expect(invalidated.candidateSets[0].status).toBe('invalidated');
  });

  it('does not trust a reconciled flag when the immutable fingerprint has not matched', () => {
    const initial: WorkflowState = { lines: [line('line-unverified')], candidateSets: [] };
    const prepared = prepareCandidate(initial, {
      id: 'set-unverified', companyId: 'company-1', kind: 'bank_transaction', attemptNumber: 1,
      correlationToken: 'WB-L-UNVERIFIED', xeroObjectId: 'xero-unverified',
      lines: [{ statementLineId: 'line-unverified', role: 'primary', requiredForSettlement: true, expectedBankAccountId: 'bank-current', expectedAmountMinor: -12345 }]
    });
    const observed = applyXeroObservation(prepared, 'set-unverified', { objectStatus: 'AUTHORISED', isReconciled: true, fingerprintMatches: false });
    expect(observed.lines[0].status).toBe('prepared');
    expect(observed.candidateSets[0].status).toBe('active');
  });

  it('returns a reversed bill payment to prepared when its parent remains authorised', () => {
    const initial: WorkflowState = { lines: [line('line-bill', 'bank-current', -34567)], candidateSets: [] };
    const prepared = prepareCandidate(initial, {
      id: 'set-bill', companyId: 'company-1', kind: 'bill', attemptNumber: 1,
      correlationToken: 'WB-L-BILL', xeroObjectId: 'xero-bill',
      lines: [{ statementLineId: 'line-bill', role: 'primary', requiredForSettlement: true, expectedBankAccountId: 'bank-current', expectedAmountMinor: -34567 }]
    });
    const paid = applyXeroObservation(prepared, 'set-bill', {
      parentStatus: 'PAID',
      payment: { xeroObjectId: 'payment-1', status: 'AUTHORISED', isReconciled: true, amountMinor: 34567, bankAccountId: 'bank-current' }
    });
    expect(paid.lines[0].status).toBe('reconciled');
    const reversed = applyXeroObservation(paid, 'set-bill', {
      parentStatus: 'AUTHORISED',
      payment: { xeroObjectId: 'payment-1', status: 'DELETED', isReconciled: false, amountMinor: 34567, bankAccountId: 'bank-current' }
    });
    expect(reversed.lines[0].status).toBe('prepared');
    expect(reversed.candidateSets[0].status).toBe('active');
  });

  it('settles transfer sides independently and invalidates both when Xero deletes the transfer', () => {
    const initial: WorkflowState = {
      lines: [line('line-source', 'bank-current', -6789), line('line-destination', 'bank-savings', 6789)],
      candidateSets: []
    };
    const prepared = prepareCandidate(initial, {
      id: 'set-transfer', companyId: 'company-1', kind: 'transfer', attemptNumber: 1,
      correlationToken: 'WB-L-TRANSFER', xeroObjectId: 'xero-transfer',
      transferTransactionIds: { source: 'source-transaction', destination: 'destination-transaction' },
      lines: [
        { statementLineId: 'line-source', role: 'transfer_source', requiredForSettlement: true, expectedBankAccountId: 'bank-current', expectedAmountMinor: -6789 },
        { statementLineId: 'line-destination', role: 'transfer_destination', requiredForSettlement: true, expectedBankAccountId: 'bank-savings', expectedAmountMinor: 6789 }
      ]
    });
    const partial = applyXeroObservation(prepared, 'set-transfer', { objectStatus: 'AUTHORISED', fromIsReconciled: true, toIsReconciled: false, fromFingerprintMatches: true, toFingerprintMatches: true });
    expect(partial.lines.map(item => item.status)).toEqual(['reconciled', 'prepared']);
    expect(partial.candidateSets[0].status).toBe('active');
    const settled = applyXeroObservation(partial, 'set-transfer', { objectStatus: 'AUTHORISED', fromIsReconciled: true, toIsReconciled: true, fromFingerprintMatches: true, toFingerprintMatches: true });
    expect(settled.lines.map(item => item.status)).toEqual(['reconciled', 'reconciled']);
    expect(settled.candidateSets[0].status).toBe('settled');
    const deleted = applyXeroObservation(settled, 'set-transfer', { objectStatus: 'DELETED', fromIsReconciled: false, toIsReconciled: false });
    expect(deleted.lines.map(item => item.status)).toEqual(['needs_you', 'needs_you']);
  });
});
