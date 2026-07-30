// Deleting an imported statement removes the canonical lines it created and
// every Workbench record derived from them. It must never silently orphan a
// real Xero entity: once a line has a live Xero object, Workbench can no longer
// prove the bookkeeping is undone, so the whole import is refused.

import type { CandidateSet, StatementImport, StatementLine } from './types';

export interface StatementImportDeletionPlan {
  /** Canonical lines created by this import, all of which are removed. */
  lineIds: string[];
  /** Candidate sets that reference at least one removed line. */
  candidateSetIds: string[];
  /**
   * Lines in those candidate sets that this import did not create — the other
   * side of a transfer. They survive and are returned to `new`.
   */
  reopenedLineIds: string[];
  /** Human-readable reasons the import cannot be deleted. Empty means allowed. */
  blockers: string[];
  deletable: boolean;
}

const DELETABLE_STATUSES: ReadonlyArray<StatementImport['status']> = [
  'queued', 'retryable', 'awaiting_confirmation', 'complete', 'failed'
];

export function planStatementImportDeletion(
  statementImport: StatementImport,
  lines: StatementLine[],
  candidateSets: CandidateSet[]
): StatementImportDeletionPlan {
  const blockers: string[] = [];
  if (!DELETABLE_STATUSES.includes(statementImport.status)) {
    blockers.push('Workbench is still reading this statement. Wait for it to finish, then delete it.');
  }

  // Only a committed import owns canonical lines, and it owns exactly the lines
  // of its ingestion run. Deduplicated lines belong to the earlier import that
  // first created them and are deliberately left alone.
  const runId = statementImport.ingestionRunId;
  const owned = runId
    ? lines.filter(line => line.ingestionRunId === runId && line.companyId === statementImport.companyId)
    : [];
  const lineIds = owned.map(line => line.id);
  const ownedIds = new Set(lineIds);

  const touchedSets = candidateSets.filter(set => set.lines.some(member => ownedIds.has(member.statementLineId)));
  const liveXeroSets = touchedSets.filter(set => set.xeroObjects.some(object => !object.deletedAt));
  if (liveXeroSets.length) {
    const count = new Set(
      liveXeroSets.flatMap(set => set.lines.map(member => member.statementLineId)).filter(id => ownedIds.has(id))
    ).size;
    blockers.push(
      `${count} line${count === 1 ? '' : 's'} from this statement already ${count === 1 ? 'has' : 'have'} a Xero entity. Delete or void the Xero record first, then delete the statement.`
    );
  }

  const reopenedLineIds = [...new Set(
    touchedSets.flatMap(set => set.lines.map(member => member.statementLineId)).filter(id => !ownedIds.has(id))
  )];

  return {
    lineIds,
    candidateSetIds: touchedSets.map(set => set.id),
    reopenedLineIds,
    blockers,
    deletable: blockers.length === 0
  };
}
