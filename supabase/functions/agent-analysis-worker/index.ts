import { json } from '../_shared/http.ts';
import { serviceClient } from '../_shared/company-access.ts';
import { artifactPaths, readJson, readThreadLineage, writeJson } from '../_shared/agent-artifacts.ts';
import { runLineBatchAgent } from '../_shared/agent-runtime.ts';
import { createXeroAnalysisSnapshot, getXeroBankLedger, type XeroAnalysisSnapshot } from '../_shared/agent-xero.ts';
import { preflightXeroReconciliation } from '../_shared/xero-preflight.ts';
import { XeroRateLimitError } from '../_shared/xero.ts';

type Row = Record<string, any>;
type Claim = {
  jobId: string;
  batchId: string;
  companyId: string;
  statementLineId: string;
  expectedStatusVersion: number;
  attempt: number;
  leaseToken: string;
};

function authorised(request: Request): boolean {
  const expected = Deno.env.get('AGENT_RUNNER_SECRET');
  const supplied = request.headers.get('x-workbench-runner-secret');
  return Boolean(expected && supplied && expected === supplied);
}

function scheduleNextWorker(): void {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const secret = Deno.env.get('AGENT_RUNNER_SECRET');
  if (!baseUrl || !secret) return;
  const task = fetch(`${baseUrl}/functions/v1/agent-analysis-worker`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-runner-secret': secret }, body: '{}'
  }).then(response => {
    if (!response.ok) console.error('follow-up analysis worker failed', response.status);
  }).catch(error => console.error('follow-up analysis worker failed', error));
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
}

async function finish(service: any, claim: Claim, outcome: 'succeeded' | 'skipped' | 'retryable' | 'failed', runId?: string, error?: string) {
  const { error: finishError } = await service.rpc('finish_agent_analysis_job', {
    p_job_id: claim.jobId,
    p_lease_token: claim.leaseToken,
    p_outcome: outcome,
    p_result_run_id: runId ?? null,
    p_error: error ?? null
  });
  if (finishError) throw new Error(`Could not finish analysis job: ${finishError.message}`);
}

async function loadOrCreateSnapshot(service: any, claim: Claim, batch: Row): Promise<XeroAnalysisSnapshot> {
  if (batch.snapshot_path && batch.snapshot_expires_at && Date.parse(batch.snapshot_expires_at) > Date.now()) {
    const existing = await readJson<XeroAnalysisSnapshot>(service, batch.snapshot_path);
    if (existing) return existing;
  }

  const { data: batchJobs, error: jobsError } = await service.from('agent_analysis_jobs').select('statement_line_id').eq('batch_id', claim.batchId);
  if (jobsError) throw new Error(jobsError.message);
  const lineIds = (batchJobs ?? []).map((job: Row) => String(job.statement_line_id));
  const { data: batchLines, error: linesError } = await service.from('statement_lines').select('id,posted_at').in('id', lineIds);
  if (linesError) throw new Error(linesError.message);
  const dates = (batchLines ?? []).map((line: Row) => String(line.posted_at)).sort();
  if (!dates.length) throw new Error('The analysis batch has no statement lines');
  const shiftDate = (value: string, days: number) => {
    const date = new Date(`${value}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const ledger = await getXeroBankLedger(service, claim.companyId, shiftDate(dates[0], -7), shiftDate(dates[dates.length - 1], 7));
  await preflightXeroReconciliation(service, claim.companyId, lineIds, null, ledger);

  const snapshot = await createXeroAnalysisSnapshot(service, claim.companyId, ledger);
  const path = artifactPaths.analysisSnapshot(claim.companyId, claim.batchId);
  await writeJson(service, path, snapshot);
  const { error } = await service.rpc('set_agent_analysis_snapshot', {
    p_batch_id: claim.batchId,
    p_path: path,
    p_created_at: snapshot.createdAt,
    p_expires_at: snapshot.expiresAt
  });
  if (error) throw new Error(error.message);
  return snapshot;
}

async function processClaim(service: any, claim: Claim) {
  try {
    const threadPath = artifactPaths.lineThread(claim.companyId, claim.statementLineId);
    const [batchResult, lineResult, companyResult, previousThread, lineage] = await Promise.all([
      service.from('agent_analysis_batches').select('*').eq('id', claim.batchId).maybeSingle(),
      service.from('statement_lines').select('*').eq('id', claim.statementLineId).eq('company_id', claim.companyId).maybeSingle(),
      service.from('companies').select('id,legal_name,companies_house_number,base_currency,vat_registered,vat_scheme').eq('id', claim.companyId).maybeSingle(),
      readJson<Row>(service, threadPath),
      readThreadLineage<Row>(service, threadPath)
    ]);
    if (batchResult.error || lineResult.error || companyResult.error) throw new Error(batchResult.error?.message ?? lineResult.error?.message ?? companyResult.error?.message);
    if (!batchResult.data || !lineResult.data || !companyResult.data) {
      await finish(service, claim, 'skipped', undefined, 'Batch, company or statement line no longer exists');
      return { jobId: claim.jobId, outcome: 'skipped' };
    }
    const recovered = [previousThread, ...lineage].find(thread => thread?.batch?.jobId === claim.jobId && thread.runId);
    if (recovered && (recovered.workflowProjection || lineResult.data.status === 'needs_you')) {
      await finish(service, claim, 'succeeded', String(recovered.runId));
      return { jobId: claim.jobId, outcome: 'succeeded', recovered: true };
    }

    let line = lineResult.data as Row;
    if (line.status !== 'new' || line.active_candidate_set_id || Number(line.status_version) !== claim.expectedStatusVersion) {
      await finish(service, claim, 'skipped', undefined, 'Statement line changed before analysis');
      return { jobId: claim.jobId, outcome: 'skipped' };
    }

    const snapshot = await loadOrCreateSnapshot(service, claim, batchResult.data);
    const refreshed = await service.from('statement_lines').select('*').eq('id', claim.statementLineId).eq('company_id', claim.companyId).maybeSingle();
    if (refreshed.error) throw new Error(refreshed.error.message);
    line = refreshed.data as Row;
    if (!line || line.status !== 'new' || line.active_candidate_set_id || Number(line.status_version) !== claim.expectedStatusVersion) {
      await finish(service, claim, 'skipped', undefined, 'Xero preflight changed the statement line');
      return { jobId: claim.jobId, outcome: 'skipped' };
    }

    const bankResult = await service.from('bank_accounts').select('id,name,currency,source,xero_account_id').eq('id', line.bank_account_id).eq('company_id', claim.companyId).maybeSingle();
    if (bankResult.error) throw new Error(bankResult.error.message);
    const artifact = await runLineBatchAgent(service, claim.companyId, line, companyResult.data, bankResult.data ?? {}, snapshot, {
      batchId: claim.batchId,
      jobId: claim.jobId,
      snapshotCreatedAt: snapshot.createdAt
    });
    await finish(service, claim, 'succeeded', String(artifact.runId));
    return { jobId: claim.jobId, outcome: 'succeeded', runId: artifact.runId };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : 'Agent analysis failed';
    console.error('agent analysis job failed', { jobId: claim.jobId, attempt: claim.attempt, message });
    if (error instanceof XeroRateLimitError) {
      const { error: deferError } = await service.rpc('defer_agent_analysis_job', {
        p_job_id: claim.jobId,
        p_lease_token: claim.leaseToken,
        p_error: message,
        p_retry_after_seconds: error.retryAfterSeconds
      });
      if (deferError) throw new Error(`Could not defer rate-limited analysis job: ${deferError.message}`);
      return { jobId: claim.jobId, outcome: 'deferred', retryAfterSeconds: error.retryAfterSeconds };
    }
    await finish(service, claim, claim.attempt >= 5 ? 'failed' : 'retryable', undefined, message);
    return { jobId: claim.jobId, outcome: claim.attempt >= 5 ? 'failed' : 'retryable', error: message };
  }
}

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!authorised(request)) return json({ error: 'Runner authentication failed' }, 401);
  try {
    const service = serviceClient();
    const { data, error } = await service.rpc('claim_agent_analysis_jobs', { p_limit: 2, p_lease_seconds: 145 });
    if (error) throw new Error(error.message);
    const claims = (Array.isArray(data) ? data : []) as Claim[];
    const results = await Promise.all(claims.map(claim => processClaim(service, claim)));
    if (claims.length) scheduleNextWorker();
    return json({ claimed: claims.length, results });
  } catch (error) {
    console.error('agent-analysis-worker failed', error);
    return json({ error: error instanceof Error ? error.message : 'Analysis worker failed' }, 502);
  }
});
