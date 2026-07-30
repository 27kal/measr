import { describe, expect, it } from 'vitest';
import { planStatementImportDeletion } from './statementImportDeletion';
import type { CandidateSet, StatementImport, StatementLine } from './types';

function statementImport(overrides: Partial<StatementImport> = {}): StatementImport {
  return {
    id: 'import-1', companyId: 'company-1', bankAccountId: 'bank-current', filename: 'july.csv',
    mimeType: 'text/csv', byteSize: 512, status: 'complete', institution: 'Demo bank', accountName: '',
    accountIdentifier: '', periodStart: null, periodEnd: null, transactionCount: 2, importedCount: 2,
    duplicateCount: 0, validation: null, error: null, ingestionRunId: 'run-1', chunkTotal: null, chunkDone: 0,
    createdAt: '2026-07-30T10:00:00.000Z', completedAt: '2026-07-30T10:00:05.000Z', ...overrides
  };
}

function line(id: string, ingestionRunId: string | null, overrides: Partial<StatementLine> = {}): StatementLine {
  return {
    id, companyId: 'company-1', bankAccountId: 'bank-current', ingestionRunId, postedAt: '2026-07-21',
    amountMinor: -12345, currency: 'GBP', payee: 'RITE Agency', description: 'Fixture', reference: id,
    status: 'new', statusVersion: 0, activeCandidateSetId: null, note: '', dedupeKey: id, ...overrides
  };
}

function candidateSet(id: string, lineIds: string[], xeroObjects: CandidateSet['xeroObjects'] = []): CandidateSet {
  return {
    id, companyId: 'company-1', attemptNumber: 1, kind: 'bank_transaction', status: 'active',
    lines: lineIds.map(statementLineId => ({
      statementLineId, role: 'primary', requiredForSettlement: true,
      expectedBankAccountId: 'bank-current', expectedAmountMinor: -12345, verificationStatus: 'prepared'
    })),
    xeroObjects, invalidationReason: null
  };
}

const liveXeroObject: CandidateSet['xeroObjects'][number] = {
  id: 'object-1', objectType: 'bank_transaction', objectRole: 'primary',
  xeroObjectId: '11111111-1111-1111-1111-111111111111', xeroStatus: 'AUTHORISED',
  isReconciled: false, correlationToken: 'token-1', correlationChannels: ['reference'], deletedAt: null
};

describe('statement import deletion', () => {
  it('removes only the lines its own ingestion run created', () => {
    const lines = [line('line-a', 'run-1'), line('line-b', 'run-1'), line('line-earlier', 'run-0')];
    const plan = planStatementImportDeletion(statementImport(), lines, []);
    expect(plan.deletable).toBe(true);
    expect(plan.lineIds).toEqual(['line-a', 'line-b']);
  });

  it('refuses deletion while a line still has a live Xero entity', () => {
    const lines = [line('line-a', 'run-1', { status: 'prepared', activeCandidateSetId: 'set-1' })];
    const plan = planStatementImportDeletion(statementImport(), lines, [candidateSet('set-1', ['line-a'], [liveXeroObject])]);
    expect(plan.deletable).toBe(false);
    expect(plan.blockers.join(' ')).toContain('already has a Xero entity');
  });

  it('allows deletion once the Xero entity is gone', () => {
    const lines = [line('line-a', 'run-1', { status: 'needs_you', activeCandidateSetId: 'set-1' })];
    const deleted = { ...liveXeroObject, deletedAt: '2026-07-30T11:00:00.000Z' };
    const plan = planStatementImportDeletion(statementImport(), lines, [candidateSet('set-1', ['line-a'], [deleted])]);
    expect(plan.deletable).toBe(true);
    expect(plan.lineIds).toEqual(['line-a']);
  });

  it('reopens the far side of a transfer instead of deleting it', () => {
    const lines = [line('line-a', 'run-1', { activeCandidateSetId: 'set-1' }), line('line-far', 'run-0', { activeCandidateSetId: 'set-1' })];
    const plan = planStatementImportDeletion(statementImport(), lines, [candidateSet('set-1', ['line-a', 'line-far'])]);
    expect(plan.lineIds).toEqual(['line-a']);
    expect(plan.reopenedLineIds).toEqual(['line-far']);
    expect(plan.candidateSetIds).toEqual(['set-1']);
  });

  it('refuses deletion while the statement is still being read', () => {
    const plan = planStatementImportDeletion(statementImport({ status: 'processing', ingestionRunId: null }), [], []);
    expect(plan.deletable).toBe(false);
    expect(plan.blockers.join(' ')).toContain('still reading');
  });

  it('deletes an uncommitted upload that produced no canonical lines', () => {
    const plan = planStatementImportDeletion(statementImport({ status: 'failed', ingestionRunId: null }), [line('line-other', 'run-0')], []);
    expect(plan.deletable).toBe(true);
    expect(plan.lineIds).toEqual([]);
  });
});
