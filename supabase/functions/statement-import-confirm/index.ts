import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';

function kickAnalysisWorker(): void {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const secret = Deno.env.get('AGENT_RUNNER_SECRET');
  if (!baseUrl || !secret) return;
  const task = fetch(`${baseUrl}/functions/v1/agent-analysis-worker`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-runner-secret': secret }, body: '{}'
  }).then(response => {
    if (!response.ok) console.error('analysis worker kick after statement import failed', response.status);
  }).catch(error => console.error('analysis worker kick after statement import failed', error));
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const input = await request.json() as { companyId?: string; importId?: string };
    if (!input.companyId || !input.importId) return json({ error: 'companyId and importId are required' }, 422);
    const { service, role } = await requireCompanyAccess(request, input.companyId);
    if (role === 'viewer') return json({ error: 'Viewers cannot confirm bank statements' }, 403);
    const statementImport = await service.from('statement_imports').select('id,company_id').eq('id', input.importId).eq('company_id', input.companyId).maybeSingle();
    if (statementImport.error || !statementImport.data) return json({ error: statementImport.error?.message ?? 'Statement import not found' }, 404);
    const { data, error } = await service.rpc('commit_statement_import', { p_import_id: input.importId, p_confirm_profile: true });
    if (error) throw new Error(error.message);
    kickAnalysisWorker();
    return json(data);
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('statement-import-confirm failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not import the statement' }, 502);
  }
});
