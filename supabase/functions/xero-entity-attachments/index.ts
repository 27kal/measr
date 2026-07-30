import { requireCompanyAccess } from '../_shared/company-access.ts';
import { corsHeaders, json } from '../_shared/http.ts';
import { freshXeroAccessToken, xeroRequest } from '../_shared/xero.ts';

type Row = Record<string, unknown>;

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const input = await request.json() as { companyId?: string; entityType?: string; entityId?: string };
    if (!input.companyId || !input.entityId || !['invoice', 'bank_transaction'].includes(input.entityType ?? '')) {
      return json({ error: 'companyId, supported entityType and entityId are required' }, 422);
    }
    if (!/^[0-9a-f-]{36}$/i.test(input.entityId)) return json({ error: 'entityId must be a Xero GUID' }, 422);
    const { service } = await requireCompanyAccess(request, input.companyId);
    const { data: connection, error } = await service.from('xero_connections').select('tenant_id').eq('company_id', input.companyId).is('disconnected_at', null).maybeSingle();
    if (error || !connection) return json({ error: error?.message ?? 'Xero is not connected' }, 409);
    const endpoint = input.entityType === 'invoice' ? 'Invoices' : 'BankTransactions';
    const payload = await xeroRequest(await freshXeroAccessToken(service, input.companyId), connection.tenant_id, `${endpoint}/${encodeURIComponent(input.entityId)}/Attachments`);
    return json({
      attachments: (payload.Attachments ?? []).map((attachment: Row) => ({
        id: String(attachment.AttachmentID ?? ''),
        filename: String(attachment.FileName ?? ''),
        mimeType: String(attachment.MimeType ?? ''),
        contentLength: Number.isFinite(Number(attachment.ContentLength)) ? Number(attachment.ContentLength) : null
      }))
    });
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    return json({ error: error instanceof Error ? error.message : 'Could not load Xero attachments' }, 502);
  }
});
