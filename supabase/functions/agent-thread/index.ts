import { corsHeaders, json } from '../_shared/http.ts';
import { artifactPaths, readJson, readThreadLineage } from '../_shared/agent-artifacts.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { companyId, lineId, kind = 'line' } = await request.json() as { companyId?: string; lineId?: string; kind?: 'line' | 'bootstrap' };
    if (!companyId || (kind === 'line' && !lineId)) return json({ error: 'companyId and lineId are required' }, 422);
    const { service } = await requireCompanyAccess(request, companyId);
    const path = kind === 'bootstrap' ? artifactPaths.bootstrapThread(companyId) : artifactPaths.lineThread(companyId, lineId!);
    const thread = await readJson<Record<string, unknown>>(service, path);
    if (!thread || kind === 'bootstrap') return json({ thread });
    const lineage = await readThreadLineage<Record<string, any>>(service, path);
    const timeline = lineage.map(run => ({
      runId: run.runId,
      parentRunId: run.parentRunId,
      createdAt: run.createdAt,
      userMessage: run.userMessage,
      document: run.document,
      reconsideration: run.reconsideration,
      finalOutput: run.finalOutput
    }));
    return json({ thread: { ...thread, timeline } });
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    return json({ error: error instanceof Error ? error.message : 'Could not read agent thread' }, 502);
  }
});
