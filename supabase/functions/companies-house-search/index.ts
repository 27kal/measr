import { verifiedUserId } from '../_shared/auth.ts';
import { corsHeaders, json } from '../_shared/http.ts';

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (!verifiedUserId(request)) return json({ error: 'Invalid or expired session' }, 401);
  const { query } = await request.json() as { query?: string };
  if (!query || query.trim().length < 2) return json({ items: [] });
  const apiKey = Deno.env.get('COMPANIES_HOUSE_API_KEY');
  if (!apiKey) return json({ error: 'Companies House is not configured' }, 503);
  const response = await fetch(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(query)}&items_per_page=8`, {
    headers: { authorization: `Basic ${btoa(`${apiKey}:`)}` }
  });
  if (!response.ok) return json({ error: 'Companies House search failed' }, response.status);
  const payload = await response.json() as { items?: Array<Record<string, unknown>> };
  const items = (payload.items ?? [])
    .filter(item => item.company_status === 'active' && item.company_number)
    .map(item => ({
      number: item.company_number,
      legalName: item.title,
      registeredOffice: typeof item.address_snippet === 'string' ? item.address_snippet : '',
      companyStatus: item.company_status
    }));
  return json({ items });
});
