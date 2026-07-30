import { describe, expect, it } from 'vitest';
import type { CandidateSet, StatementLine } from '../domain/types';
import { candidateSetsForObservation } from './observation';

const line = (id: string, companyId = 'company-1', bankAccountId = 'bank-1'): StatementLine => ({
  id,
  companyId,
  bankAccountId,
  postedAt: '2026-07-16',
  amountMinor: -7410,
  currency: 'GBP',
  payee: 'Xero',
  description: 'DIRECT DEBIT',
  reference: id,
  status: 'reconciled',
  statusVersion: 2,
  activeCandidateSetId: null,
  note: '',
  dedupeKey: id
});

const candidate = (id: string, status: CandidateSet['status'], statementLineId: string, companyId = 'company-1'): CandidateSet => ({
  id,
  companyId,
  attemptNumber: 1,
  kind: 'bank_transaction',
  status,
  invalidationReason: null,
  lines: [{ statementLineId, role: 'primary', requiredForSettlement: true, expectedBankAccountId: 'bank-1', expectedAmountMinor: -7410, verificationStatus: status === 'settled' ? 'reconciled' : 'prepared' }],
  xeroObjects: []
});

describe('Xero observation selection', () => {
  it('polls settled candidates in production so reversals can be discovered', () => {
    const lines = [line('active-line'), line('settled-line'), line('invalidated-line')];
    const sets = [candidate('active', 'active', 'active-line'), candidate('settled', 'settled', 'settled-line'), candidate('invalidated', 'invalidated', 'invalidated-line')];

    expect(candidateSetsForObservation(sets, lines, 'company-1', 'bank-1', true).map(set => set.id)).toEqual(['active', 'settled']);
  });

  it('does not poll settled candidates in the simulated demo refresh', () => {
    const lines = [line('active-line'), line('settled-line')];
    const sets = [candidate('active', 'active', 'active-line'), candidate('settled', 'settled', 'settled-line')];

    expect(candidateSetsForObservation(sets, lines, 'company-1', 'bank-1', false).map(set => set.id)).toEqual(['active']);
  });
});
