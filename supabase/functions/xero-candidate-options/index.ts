import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifiedUserId } from '../_shared/auth.ts';
import { corsHeaders, json } from '../_shared/http.ts';
import { freshXeroAccessToken, xeroRequest } from '../_shared/xero.ts';

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const userId = verifiedUserId(request);
  if (!userId) return json({ error: 'Invalid or expired session' }, 401);
  const { companyId } = await request.json() as { companyId?: string };
  if (!companyId) return json({ error: 'companyId is required' }, 422);

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: membership } = await service.from('company_memberships').select('role').eq('company_id', companyId).eq('user_id', userId).maybeSingle();
  if (!membership) return json({ error: 'Company access denied' }, 403);
  const { data: connection } = await service.from('xero_connections').select('tenant_id').eq('company_id', companyId).is('disconnected_at', null).maybeSingle();
  if (!connection) return json({ error: 'Xero is not connected' }, 409);

  try {
    const accessToken = await freshXeroAccessToken(service, companyId);
    const [accountPayload, contactPayload] = await Promise.all([
      xeroRequest(accessToken, connection.tenant_id, 'Accounts'),
      xeroRequest(accessToken, connection.tenant_id, 'Contacts?summaryOnly=true')
    ]);
    const activeAccounts = (accountPayload.Accounts ?? []).filter((account: Record<string, unknown>) => account.Status === 'ACTIVE');
    const bankAccounts = activeAccounts.filter((account: Record<string, unknown>) => account.Type === 'BANK' && account.CurrencyCode === 'GBP').map((account: Record<string, unknown>) => ({ id: account.AccountID, name: account.Name, code: account.Code ?? '' }));
    // Workbench bank accounts mirror Xero one-to-one; this read is the sync point.
    const { error: syncError } = await service.rpc('sync_xero_bank_accounts', { p_company_id: companyId, p_accounts: bankAccounts });
    if (syncError) throw new Error(`Could not sync Xero bank accounts: ${syncError.message}`);
    return json({
      bankAccounts,
      contacts: (contactPayload.Contacts ?? []).filter((contact: Record<string, unknown>) => contact.ContactStatus === 'ACTIVE').map((contact: Record<string, unknown>) => ({ id: contact.ContactID, name: contact.Name })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
      accounts: activeAccounts.filter((account: Record<string, unknown>) => account.Type !== 'BANK' && ['EXPENSE', 'REVENUE'].includes(String(account.Class))).map((account: Record<string, unknown>) => ({ code: account.Code, name: account.Name, class: account.Class, taxType: account.TaxType ?? '' })).filter((account: { code?: string }) => account.code).sort((a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code))
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not load Xero candidate options' }, 502);
  }
});
