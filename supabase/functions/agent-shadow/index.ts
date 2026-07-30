import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { runLineShadowAgent } from '../_shared/agent-runtime.ts';

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { companyId, lineId } = await request.json() as { companyId?: string; lineId?: string };
    if (!companyId || !lineId) return json({ error: 'companyId and lineId are required' }, 422);
    const { service } = await requireCompanyAccess(request, companyId);
    const [{ data: line, error: lineError }, { data: company, error: companyError }] = await Promise.all([
      service.from('statement_lines').select('*').eq('id', lineId).eq('company_id', companyId).maybeSingle(),
      service.from('companies').select('id,legal_name,companies_house_number,base_currency,vat_registered,vat_scheme').eq('id', companyId).maybeSingle()
    ]);
    if (lineError || companyError) throw new Error(lineError?.message ?? companyError?.message);
    if (!line || !company) return json({ error: 'Statement line or company not found' }, 404);
    const { data: bankAccount, error: bankError } = await service.from('bank_accounts').select('id,name,currency,source,xero_account_id').eq('id', line.bank_account_id).eq('company_id', companyId).maybeSingle();
    if (bankError) throw new Error(bankError.message);
    const artifact = await runLineShadowAgent(service, companyId, line, company, bankAccount ?? {});
    return json({ thread: artifact });
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('agent-shadow failed', error);
    return json({ error: error instanceof Error ? error.message : 'Agent shadow run failed' }, 502);
  }
});
