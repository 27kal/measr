import { getXeroBankLedger, type XeroBankLedger } from './agent-xero.ts';
import { classifyReconciledLedger, type LedgerLine, type LedgerMovement } from './xero-ledger.ts';
import { sha256Json } from './xero-recovery.ts';

type Service = { from: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> };
type Row = Record<string, any>;

export type XeroPreflightResult = {
  lineId: string;
  outcome: 'reconciled' | 'ambiguous' | 'unmatched';
  message: string;
  candidateSetId?: string;
  candidates?: Array<{ key: string; kind: string; date: string; amountMinor: number; contactName: string; reference: string }>;
};

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function candidateSummary(movement: LedgerMovement) {
  return { key: movement.key, kind: movement.kind, date: movement.postedAt, amountMinor: movement.amountMinor, contactName: movement.contactName, reference: movement.reference };
}

export async function preflightXeroReconciliation(service: Service, companyId: string, requestedLineIds: string[], userId: string | null, suppliedLedger?: XeroBankLedger): Promise<XeroPreflightResult[]> {
  const requested = new Set(requestedLineIds);
  if (requested.size === 0) return [];
  const [{ data: lines, error: lineError }, { data: accounts, error: accountError }, { data: mappedObjects, error: objectError }] = await Promise.all([
    service.from('statement_lines').select('id,bank_account_id,posted_at,amount_minor,status,status_version,active_candidate_set_id').eq('company_id', companyId).in('status', ['new', 'processing', 'needs_you', 'waiting_doc']).is('active_candidate_set_id', null),
    service.from('bank_accounts').select('id,xero_account_id').eq('company_id', companyId),
    service.from('xero_objects').select('xero_object_id').eq('company_id', companyId)
  ]);
  if (lineError || accountError || objectError) throw new Error(lineError?.message ?? accountError?.message ?? objectError?.message);
  const lineRows = (lines ?? []) as Row[];
  const requestedRows = lineRows.filter(line => requested.has(String(line.id)));
  const accountMap = new Map((accounts ?? []).map((account: Row) => [String(account.id), String(account.xero_account_id ?? '')]));
  const ledgerLines: LedgerLine[] = lineRows.flatMap(line => {
    const xeroBankAccountId = accountMap.get(String(line.bank_account_id)) ?? '';
    return xeroBankAccountId ? [{ id: String(line.id), xeroBankAccountId, postedAt: String(line.posted_at), amountMinor: Number(line.amount_minor) }] : [];
  });
  const requestedLedgerLines = ledgerLines.filter(line => requested.has(line.id));
  const missingMapping = requestedRows.filter(line => !accountMap.get(String(line.bank_account_id))).map(line => String(line.id));
  const results: XeroPreflightResult[] = missingMapping.map(lineId => ({ lineId, outcome: 'unmatched', message: 'The statement source is not mapped to a Xero bank account.' }));
  if (requestedLedgerLines.length === 0) return results;

  const dates = ledgerLines.map(line => line.postedAt).sort();
  const ledger = suppliedLedger ?? await getXeroBankLedger(service as any, companyId, shiftDate(dates[0], -7), shiftDate(dates[dates.length - 1], 7));
  const classifications = classifyReconciledLedger(ledgerLines, new Set(requestedLedgerLines.map(line => line.id)), ledger.movements, new Set((mappedObjects ?? []).map((object: Row) => String(object.xero_object_id))));
  const rowById = new Map(requestedRows.map(line => [String(line.id), line]));

  for (const classification of classifications) {
    const line = rowById.get(classification.lineId);
    if (!line) continue;
    if (classification.outcome === 'unmatched') {
      results.push({ lineId: classification.lineId, outcome: 'unmatched', message: 'No reconciled Xero ledger movement matched this statement line.' });
      continue;
    }
    if (classification.outcome === 'ambiguous') {
      const candidates = classification.candidates.map(candidateSummary);
      const { error } = await service.rpc('mark_xero_reconciliation_ambiguous', {
        p_company_id: companyId, p_line_id: classification.lineId, p_expected_status_version: Number(line.status_version),
        p_reason: classification.reason, p_candidates: candidates
      });
      if (error) throw new Error(error.message);
      results.push({ lineId: classification.lineId, outcome: 'ambiguous', message: classification.reason, candidates });
      continue;
    }

    const movement = classification.movement;
    const observation = {
      schemaVersion: 1, mode: 'observed_xero_reconciliation', observedAt: ledger.searchedAt,
      line: { id: classification.lineId, statusVersion: Number(line.status_version), bankAccountId: String(line.bank_account_id), postedAt: String(line.posted_at), amountMinor: Number(line.amount_minor) },
      xero: candidateSummary(movement),
      validation: { ruleset: 'xero-ledger-preflight-v1', evidence: ['mapped_bank_account', 'exact_signed_amount', 'exact_date', 'unique_line_and_movement', 'xero_is_reconciled'] }
    };
    const fingerprint = await sha256Json(observation);
    const { data, error } = await service.rpc('commit_observed_xero_reconciliation', {
      p_company_id: companyId, p_line_id: classification.lineId, p_expected_status_version: Number(line.status_version),
      p_kind: movement.kind, p_created_by: userId, p_observation: observation,
      p_observation_fingerprint: fingerprint, p_xero_objects: movement.objects
    });
    if (error) throw new Error(error.message);
    results.push({ lineId: classification.lineId, outcome: 'reconciled', candidateSetId: data?.candidateSetId, message: 'Matched to a unique reconciled Xero ledger movement.' });
  }
  return results;
}
