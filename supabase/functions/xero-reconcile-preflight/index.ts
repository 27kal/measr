import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { preflightXeroReconciliation } from '../_shared/xero-preflight.ts';

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const input = await request.json() as { companyId?: string; lineIds?: string[] };
    if (!input.companyId || !Array.isArray(input.lineIds) || input.lineIds.length === 0) return json({ error: 'companyId and at least one lineId are required' }, 422);
    if (input.lineIds.length > 50 || input.lineIds.some(lineId => !/^[0-9a-f-]{36}$/i.test(lineId))) return json({ error: 'lineIds must contain at most 50 valid IDs' }, 422);
    const { service, userId } = await requireCompanyAccess(request, input.companyId);
    const results = await preflightXeroReconciliation(service, input.companyId, [...new Set(input.lineIds)], userId);
    return json({
      results,
      reconciledLineIds: results.filter(result => result.outcome === 'reconciled').map(result => result.lineId),
      ambiguousLineIds: results.filter(result => result.outcome === 'ambiguous').map(result => result.lineId),
      unmatchedLineIds: results.filter(result => result.outcome === 'unmatched').map(result => result.lineId)
    });
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('xero-reconcile-preflight failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not check the Xero bank ledger' }, 502);
  }
});
