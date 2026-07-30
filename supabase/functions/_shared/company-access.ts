import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifiedUserId } from './auth.ts';

export function serviceClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

export async function requireCompanyAccess(request: Request, companyId: string) {
  const userId = verifiedUserId(request);
  if (!userId) throw new Response(JSON.stringify({ error: 'Invalid or expired session' }), { status: 401, headers: { 'content-type': 'application/json' } });
  const service = serviceClient();
  const { data: membership, error } = await service.from('company_memberships').select('role').eq('company_id', companyId).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!membership) throw new Response(JSON.stringify({ error: 'Company access denied' }), { status: 403, headers: { 'content-type': 'application/json' } });
  return { service, userId, role: String(membership.role) };
}
