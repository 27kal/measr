import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';

function kickWorker(): void {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const secret = Deno.env.get('AGENT_RUNNER_SECRET');
  if (!baseUrl || !secret) return;
  const task = fetch(`${baseUrl}/functions/v1/xero-observation-worker`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench-runner-secret': secret },
    body: '{}'
  }).then(response => {
    if (!response.ok) console.error('Xero observation worker kick failed', response.status);
  }).catch(error => console.error('Xero observation worker kick failed', error));
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const input = await request.json() as { companyId?: string };
    if (!input.companyId) return json({ error: 'companyId is required' }, 422);
    const { service, role } = await requireCompanyAccess(request, input.companyId);
    if (role === 'viewer') return json({ error: 'Viewers cannot schedule a Xero refresh' }, 403);
    const { data, error } = await service.rpc('enqueue_xero_observation', { p_company_id: input.companyId, p_source: 'manual' });
    if (error) throw new Error(error.message);
    kickWorker();
    return json(data ?? { scheduled: true }, 202);
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('xero-observation-control failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not schedule Xero observation' }, 502);
  }
});
