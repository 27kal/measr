import type { CandidateSet, StatementLine } from '../domain/types';

export function candidateSetsForObservation(
  candidateSets: CandidateSet[],
  lines: StatementLine[],
  companyId: string,
  bankAccountId: string,
  includeSettled: boolean
): CandidateSet[] {
  const bankLineIds = new Set(
    lines
      .filter(line => line.companyId === companyId && line.bankAccountId === bankAccountId)
      .map(line => line.id)
  );

  return candidateSets.filter(set =>
    set.companyId === companyId
    && (set.status === 'active' || (includeSettled && set.status === 'settled'))
    && set.lines.some(member => bankLineIds.has(member.statementLineId))
  );
}
