import { json } from '../_shared/http.ts';
import { serviceClient } from '../_shared/company-access.ts';
import { preflightXeroReconciliation } from '../_shared/xero-preflight.ts';
import { observeXeroCandidate } from '../_shared/xero-observation.ts';
import { freshXeroAccessToken, XeroRateLimitError } from '../_shared/xero.ts';

type Row = Record<string, any>;
type Claim = { jobId: string; companyId: string; attempt: number; leaseToken: string; fullSweep: boolean };

function authorised(request: Request): boolean {
  const expected = Deno.env.get('AGENT_RUNNER_SECRET');
  const supplied = request.headers.get('x-workbench-runner-secret');
  return Boolean(expected && supplied && expected === supplied);
}

function scheduleNextWorker(): void {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const secret = Deno.env.get('AGENT_RUNNER_SECRET');
  if (!baseUrl || !secret) return;
  const task = fetch(`${baseUrl}/functions/v1/xero-observation-worker`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench-runner-secret': secret },
    body: '{}'
  }).then(response => {
    if (!response.ok) console.error('follow-up Xero observation worker failed', response.status);
  }).catch(error => console.error('follow-up Xero observation worker failed', error));
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
}

async function finish(
  service: any,
  claim: Claim,
  outcome: 'succeeded' | 'retryable' | 'failed',
  counts: { candidateCount?: number; unlinkedLineCount?: number; changedLineCount?: number } = {},
  result: Record<string, unknown> = {},
  error?: string
) {
  const { error: finishError } = await service.rpc('finish_xero_observation_job', {
    p_job_id: claim.jobId,
    p_lease_token: claim.leaseToken,
    p_outcome: outcome,
    p_candidate_count: counts.candidateCount ?? 0,
    p_unlinked_line_count: counts.unlinkedLineCount ?? 0,
    p_changed_line_count: counts.changedLineCount ?? 0,
    p_result: result,
    p_error: error ?? null
  });
  if (finishError) throw new Error(`Could not finish Xero observation job: ${finishError.message}`);
}

async function processClaim(service: any, claim: Claim) {
  let candidateCount = 0;
  let unlinkedLineCount = 0;
  let changedLineCount = 0;
  try {
    const [connectionResult, candidatesResult, unlinkedResult] = await Promise.all([
      service.from('xero_connections').select('tenant_id').eq('company_id', claim.companyId).is('disconnected_at', null).maybeSingle(),
      service.from('candidate_sets').select('id,status,updated_at,xero_objects(observed_at)').eq('company_id', claim.companyId).in('status', ['active', 'settled']).order('created_at'),
      service.from('statement_lines').select('id,status,status_version,note,active_candidate_set_id').eq('company_id', claim.companyId).in('status', ['new', 'processing', 'needs_you', 'waiting_doc']).is('active_candidate_set_id', null)
    ]);
    if (connectionResult.error || candidatesResult.error || unlinkedResult.error) {
      throw new Error(connectionResult.error?.message ?? candidatesResult.error?.message ?? unlinkedResult.error?.message);
    }
    if (!connectionResult.data) {
      await finish(service, claim, 'succeeded', {}, { skipped: 'Xero disconnected' });
      return { jobId: claim.jobId, outcome: 'succeeded', skipped: true };
    }

    const recentCutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
    const settledPollCutoff = Date.now() - 30 * 60 * 1000;
    const candidates = (candidatesResult.data ?? []).filter((candidate: Row) => {
      if (candidate.status === 'active' || claim.fullSweep) return true;
      if (Date.parse(candidate.updated_at) < recentCutoff) return false;
      const lastObservedAt = Math.max(0, ...(candidate.xero_objects ?? []).map((object: Row) => Date.parse(object.observed_at ?? '') || 0));
      return lastObservedAt <= settledPollCutoff;
    });
    const unlinked = (unlinkedResult.data ?? []) as Row[];
    candidateCount = candidates.length;
    unlinkedLineCount = unlinked.length;

    const directResults = unlinked.length
      ? await preflightXeroReconciliation(service, claim.companyId, unlinked.map(line => String(line.id)), null)
      : [];
    changedLineCount += directResults.filter(result => result.outcome !== 'unmatched').length;

    const candidateIds = candidates.map((candidate: Row) => String(candidate.id));
    const previousLines = new Map<string, Row>();
    if (candidateIds.length) {
      const { data: memberships, error: membershipsError } = await service.from('candidate_set_lines').select('statement_line_id').in('candidate_set_id', candidateIds);
      if (membershipsError) throw new Error(membershipsError.message);
      const lineIds = [...new Set((memberships ?? []).map((membership: Row) => String(membership.statement_line_id)))];
      if (lineIds.length) {
        const { data: lines, error: linesError } = await service.from('statement_lines').select('id,status,note,active_candidate_set_id').in('id', lineIds);
        if (linesError) throw new Error(linesError.message);
        for (const line of lines ?? []) previousLines.set(String(line.id), line);
      }
    }

    const session = candidateIds.length ? {
      accessToken: await freshXeroAccessToken(service, claim.companyId),
      tenantId: String(connectionResult.data.tenant_id)
    } : undefined;
    const observations = [];
    for (const candidate of candidates) {
      const observation = await observeXeroCandidate(service, String(candidate.id), session);
      observations.push(observation);
      for (const line of observation.lines) {
        const previous = previousLines.get(line.statementLineId);
        const expectedCandidate = line.status === 'needs_you' ? null : observation.candidateSetId;
        if (!previous || previous.status !== line.status || previous.note !== line.reason || previous.active_candidate_set_id !== expectedCandidate) changedLineCount += 1;
      }
    }

    const result = {
      observedAt: new Date().toISOString(),
      fullSweep: claim.fullSweep,
      candidates: observations.map(observation => ({ id: observation.candidateSetId, status: observation.status, lines: observation.lines.length })),
      directReconciliation: {
        reconciled: directResults.filter(item => item.outcome === 'reconciled').length,
        ambiguous: directResults.filter(item => item.outcome === 'ambiguous').length,
        unmatched: directResults.filter(item => item.outcome === 'unmatched').length
      }
    };
    await finish(service, claim, 'succeeded', { candidateCount, unlinkedLineCount, changedLineCount }, result);
    return { jobId: claim.jobId, outcome: 'succeeded', ...result, changedLineCount };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : 'Xero observation failed';
    console.error('Xero observation job failed', { jobId: claim.jobId, attempt: claim.attempt, message });
    if (error instanceof XeroRateLimitError) {
      const { error: deferError } = await service.rpc('defer_xero_observation_job', {
        p_job_id: claim.jobId,
        p_lease_token: claim.leaseToken,
        p_error: message,
        p_retry_after_seconds: error.retryAfterSeconds
      });
      if (deferError) throw new Error(`Could not defer rate-limited Xero observation: ${deferError.message}`);
      return { jobId: claim.jobId, outcome: 'deferred', retryAfterSeconds: error.retryAfterSeconds };
    }
    const outcome = claim.attempt >= 5 ? 'failed' : 'retryable';
    await finish(service, claim, outcome, { candidateCount, unlinkedLineCount, changedLineCount }, {}, message);
    return { jobId: claim.jobId, outcome, error: message };
  }
}

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!authorised(request)) return json({ error: 'Runner authentication failed' }, 401);
  try {
    const service = serviceClient();
    const { data, error } = await service.rpc('claim_xero_observation_jobs', { p_limit: 2, p_lease_seconds: 210 });
    if (error) throw new Error(error.message);
    const claims = (Array.isArray(data) ? data : []) as Claim[];
    const results = await Promise.all(claims.map(claim => processClaim(service, claim)));
    if (claims.length) scheduleNextWorker();
    return json({ claimed: claims.length, results });
  } catch (error) {
    console.error('xero-observation-worker failed', error);
    return json({ error: error instanceof Error ? error.message : 'Xero observation worker failed' }, 502);
  }
});
