import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { syncPendingCompanyDocumentsToXero } from '../_shared/documents.ts';

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function redirect(origin: string, status: string, detail?: string): Response {
  const target = new URL(origin);
  target.searchParams.set('xero', status);
  if (detail) target.searchParams.set('detail', detail.slice(0, 180));
  return Response.redirect(target, 302);
}

Deno.serve(async request => {
  const requestUrl = new URL(request.url);
  const appOrigin = Deno.env.get('APP_ORIGIN') ?? 'http://127.0.0.1:8765';
  const code = requestUrl.searchParams.get('code');
  const state = requestUrl.searchParams.get('state');
  const oauthError = requestUrl.searchParams.get('error');
  if (oauthError) return redirect(appOrigin, 'error', oauthError);
  if (!code || !state) return redirect(appOrigin, 'error', 'Missing OAuth code or state');
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const stateHash = await sha256(state);
  const { data: stateRow, error: stateError } = await service.from('xero_oauth_states').update({ consumed_at: new Date().toISOString() }).eq('state_hash', stateHash).is('consumed_at', null).gt('expires_at', new Date().toISOString()).select().single();
  if (stateError || !stateRow) return redirect(appOrigin, 'error', 'OAuth state is invalid, expired or already used');
  const clientId = Deno.env.get('XERO_CLIENT_ID')!;
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET')!;
  const redirectUri = Deno.env.get('XERO_REDIRECT_URI')!;
  const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
  });
  const tokens = await tokenResponse.json() as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  if (!tokenResponse.ok || !tokens.access_token || !tokens.refresh_token) return redirect(appOrigin, 'error', `Token exchange failed: ${tokens.error ?? tokenResponse.status}`);
  const connectionsResponse = await fetch('https://api.xero.com/connections', { headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' } });
  const connections = await connectionsResponse.json() as Array<{ id: string; tenantId: string; tenantName: string; tenantType: string; updatedDateUtc: string }>;
  if (!connectionsResponse.ok || !connections.length) return redirect(appOrigin, 'error', 'Xero returned no organisation connection');
  const connection = [...connections].sort((a, b) => b.updatedDateUtc.localeCompare(a.updatedDateUtc))[0];
  const { error: storeError } = await service.rpc('store_xero_connection', { p_company_id: stateRow.company_id, p_connection_id: connection.id, p_tenant_id: connection.tenantId, p_tenant_name: connection.tenantName, p_refresh_token: tokens.refresh_token, p_scopes: (tokens.scope ?? '').split(' ').filter(Boolean), p_connected_by: stateRow.user_id });
  if (storeError) return redirect(appOrigin, 'error', storeError.message);
  const organisationResponse = await fetch('https://api.xero.com/api.xro/2.0/Organisation', { headers: { authorization: `Bearer ${tokens.access_token}`, 'xero-tenant-id': connection.tenantId, accept: 'application/json' } });
  if (organisationResponse.ok) {
    const organisationPayload = await organisationResponse.json() as { Organisations?: Array<{ BaseCurrency?: string }> };
    if (organisationPayload.Organisations?.[0]?.BaseCurrency === 'GBP') await service.from('companies').update({ base_currency: 'GBP' }).eq('id', stateRow.company_id);
  }
  if ((tokens.scope ?? '').split(' ').includes('accounting.attachments')) {
    await syncPendingCompanyDocumentsToXero(service, stateRow.company_id, tokens.access_token, connection.tenantId);
  }
  return redirect(stateRow.return_to, 'connected');
});
