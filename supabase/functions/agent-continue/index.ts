import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { artifactPaths, readJson } from '../_shared/agent-artifacts.ts';
import { continueLineAgent } from '../_shared/agent-runtime.ts';

type Row = Record<string, any>;

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const input = await request.json() as { companyId?: string; lineId?: string; runId?: string; statusVersion?: number; message?: string };
    const message = input.message?.trim() ?? '';
    if (!input.companyId || !input.lineId || !input.runId || !Number.isInteger(input.statusVersion) || !message) return json({ error: 'companyId, lineId, runId, statusVersion and message are required' }, 422);
    if (message.length > 4_000) return json({ error: 'Message must be 4,000 characters or fewer' }, 422);
    const { service } = await requireCompanyAccess(request, input.companyId);
    const [thread, lineResult] = await Promise.all([
      readJson<Row>(service, artifactPaths.lineThread(input.companyId, input.lineId)),
      service.from('statement_lines').select('*').eq('id', input.lineId).eq('company_id', input.companyId).maybeSingle()
    ]);
    if (!thread || thread.kind !== 'line' || thread.runId !== input.runId) return json({ error: 'The agent thread changed; refresh before sending this message' }, 409);
    if (lineResult.error || !lineResult.data) return json({ error: lineResult.error?.message ?? 'Statement line not found' }, 404);
    const line = lineResult.data as Row;
    if (line.status_version !== input.statusVersion) return json({ error: 'The statement line changed; refresh before continuing the conversation' }, 409);
    const resolved = Boolean(line.active_candidate_set_id) || ['prepared', 'reconciled'].includes(line.status);
    if (!resolved && thread.workflowProjection?.statusVersion !== line.status_version) return json({ error: 'The saved thread was produced for an older statement-line version' }, 409);
    const artifact = await continueLineAgent(service, input.companyId, line, thread, message);
    return json({ thread: artifact });
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('agent-continue failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not continue the agent thread' }, 502);
  }
});
