import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { artifactPaths, readJson, readThreadLineage } from '../_shared/agent-artifacts.ts';
import { scheduleAcceptedHandbookPropagation } from '../_shared/agent-propagation.ts';

type Row = Record<string, any>;

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const input = await request.json() as { companyId?: string; lineId?: string; runId?: string };
    if (!input.companyId || !input.lineId) return json({ error: 'companyId and lineId are required' }, 422);
    const { service, role } = await requireCompanyAccess(request, input.companyId);
    if (role === 'viewer') return json({ error: 'Viewers cannot start handbook propagation' }, 403);
    const [lineResult, latest] = await Promise.all([
      service.from('statement_lines').select('*').eq('company_id', input.companyId).eq('id', input.lineId).maybeSingle(),
      readJson<Row>(service, artifactPaths.lineThread(input.companyId, input.lineId))
    ]);
    if (lineResult.error || !lineResult.data) return json({ error: lineResult.error?.message ?? 'Statement line not found' }, 404);
    const line = lineResult.data as Row;
    if (!line.active_candidate_set_id && !['prepared', 'reconciled'].includes(String(line.status))) return json({ error: 'Handbook propagation starts only after the source recommendation is prepared' }, 409);
    let thread = latest;
    if (input.runId && latest?.runId !== input.runId) {
      const lineage = await readThreadLineage<Row>(service, artifactPaths.lineThread(input.companyId, input.lineId));
      thread = lineage.find(run => run.runId === input.runId) ?? null;
    }
    if (!thread || thread.kind !== 'line') return json({ error: 'Source agent run not found' }, 404);
    const existing = await readJson<Row>(service, artifactPaths.propagation(input.companyId, String(thread.runId)));
    scheduleAcceptedHandbookPropagation(service, input.companyId, line, thread);
    return json({ scheduled: true, sourceRunId: thread.runId, propagation: existing }, existing?.status === 'complete' ? 200 : 202);
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('agent-propagate-handbook failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not schedule handbook propagation' }, 502);
  }
});
