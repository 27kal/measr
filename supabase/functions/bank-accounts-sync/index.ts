import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { json } from '../_shared/http.ts';
import { freshXeroAccessToken, xeroRequest } from '../_shared/xero.ts';

// Maintenance boundary: mirrors Xero bank accounts into bank_accounts for one
// company or for every connected company. The interactive sync happens in
// xero-candidate-options when a member opens the company; this function exists
// for backfills and operational runs, so it authenticates like the workers.

function authorised(request: Request): boolean {
  const expected = Deno.env.get('AGENT_RUNNER_SECRET');
  const supplied = request.headers.get('x-workbench-runner-secret');
  return Boolean(expected && supplied && expected === supplied);
}

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!authorised(request)) return json({ error: 'Unauthorized' }, 401);

  const { companyId } = await request.json().catch(() => ({})) as { companyId?: string };
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let query = service.from('xero_connections').select('company_id, tenant_id').is('disconnected_at', null);
  if (companyId) query = query.eq('company_id', companyId);
  const { data: connections, error: connectionsError } = await query;
  if (connectionsError) return json({ error: connectionsError.message }, 500);

  const results: Array<{ companyId: string; synced?: number; accounts?: number; error?: string }> = [];
  for (const connection of connections ?? []) {
    try {
      const accessToken = await freshXeroAccessToken(service, connection.company_id);
      const payload = await xeroRequest(accessToken, connection.tenant_id, 'Accounts');
      const bankAccounts = (payload.Accounts ?? [])
        .filter((account: Record<string, unknown>) => account.Status === 'ACTIVE' && account.Type === 'BANK' && account.CurrencyCode === 'GBP')
        .map((account: Record<string, unknown>) => ({ id: account.AccountID, name: account.Name, code: account.Code ?? '' }));
      const { data: inserted, error: syncError } = await service.rpc('sync_xero_bank_accounts', { p_company_id: connection.company_id, p_accounts: bankAccounts });
      if (syncError) throw new Error(syncError.message);
      results.push({ companyId: connection.company_id, synced: Number(inserted ?? 0), accounts: bankAccounts.length });
    } catch (error) {
      results.push({ companyId: connection.company_id, error: error instanceof Error ? error.message : 'Sync failed' });
    }
  }
  return json({ results });
});
