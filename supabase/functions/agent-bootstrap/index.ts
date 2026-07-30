import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { bootstrapAgentMemory } from '../_shared/agent-runtime.ts';

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { companyId } = await request.json() as { companyId?: string };
    if (!companyId) return json({ error: 'companyId is required' }, 422);
    const { service } = await requireCompanyAccess(request, companyId);
    const artifact = await bootstrapAgentMemory(service, companyId);
    return json({ thread: artifact });
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('agent-bootstrap failed', error);
    return json({ error: error instanceof Error ? error.message : 'Agent bootstrap failed' }, 502);
  }
});
