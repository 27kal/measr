import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifiedUserId } from '../_shared/auth.ts';
import { corsHeaders, json } from '../_shared/http.ts';

const scopes = ['offline_access', 'accounting.settings.read', 'accounting.contacts', 'accounting.invoices', 'accounting.payments', 'accounting.banktransactions', 'accounting.attachments'];

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const userId = verifiedUserId(request);
  if (!userId) return json({ error: 'Invalid or expired session' }, 401);
  const url = Deno.env.get('SUPABASE_URL')!;
  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { companyId } = await request.json() as { companyId?: string };
  if (!companyId) return json({ error: 'companyId is required' }, 422);
  const { data: membership } = await service.from('company_memberships').select('role').eq('company_id', companyId).eq('user_id', userId).maybeSingle();
  if (!membership) return json({ error: 'Company access denied' }, 403);
  const clientId = Deno.env.get('XERO_CLIENT_ID');
  const redirectUri = Deno.env.get('XERO_REDIRECT_URI');
  const appOrigin = Deno.env.get('APP_ORIGIN') ?? 'http://127.0.0.1:8765';
  if (!clientId || !redirectUri) return json({ error: 'Xero OAuth is not configured' }, 503);
  const stateBytes = crypto.getRandomValues(new Uint8Array(32));
  const state = btoa(String.fromCharCode(...stateBytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const { error } = await service.from('xero_oauth_states').insert({ state_hash: await sha256(state), company_id: companyId, user_id: userId, return_to: `${appOrigin}/?xero=connected&company=${companyId}`, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
  if (error) return json({ error: error.message }, 500);
  const authorize = new URL('https://login.xero.com/identity/connect/authorize');
  authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: scopes.join(' '), state }).toString();
  return json({ url: authorize.toString() });
});
