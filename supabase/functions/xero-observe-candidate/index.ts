import { verifiedUserId } from '../_shared/auth.ts';
import { corsHeaders, json } from '../_shared/http.ts';
import { serviceClient } from '../_shared/company-access.ts';
import { observeXeroCandidate } from '../_shared/xero-observation.ts';

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const userId = verifiedUserId(request);
  if (!userId) return json({ error: 'Invalid or expired session' }, 401);
  try {
    const { candidateSetId } = await request.json() as { candidateSetId?: string };
    if (!candidateSetId) return json({ error: 'candidateSetId is required' }, 422);
    const service = serviceClient();
    const { data: set, error: setError } = await service.from('candidate_sets').select('company_id').eq('id', candidateSetId).maybeSingle();
    if (setError) throw new Error(setError.message);
    if (!set) return json({ error: 'Candidate not found' }, 404);
    const { data: membership, error: membershipError } = await service.from('company_memberships').select('role').eq('company_id', set.company_id).eq('user_id', userId).maybeSingle();
    if (membershipError) throw new Error(membershipError.message);
    if (!membership) return json({ error: 'Company access denied' }, 403);
    return json(await observeXeroCandidate(service, candidateSetId));
  } catch (error) {
    console.error('xero-observe-candidate failed', error);
    return json({ error: error instanceof Error ? error.message : 'Xero observation failed' }, 502);
  }
});
