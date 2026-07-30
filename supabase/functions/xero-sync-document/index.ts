import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { syncDocumentToPreparedLine, type StoredDocument } from '../_shared/documents.ts';

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const input = await request.json() as { companyId?: string; documentId?: string };
    if (!input.companyId || !input.documentId) return json({ error: 'companyId and documentId are required' }, 422);
    const { service, role } = await requireCompanyAccess(request, input.companyId);
    if (role === 'viewer') return json({ error: 'Viewers cannot send documents to Xero' }, 403);
    const { data: document, error: documentError } = await service.from('documents').select('*').eq('id', input.documentId).eq('company_id', input.companyId).maybeSingle();
    if (documentError || !document) return json({ error: documentError?.message ?? 'Document not found' }, 404);
    const synced = await syncDocumentToPreparedLine(service, input.companyId, document as StoredDocument);
    return json({ document: synced });
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('xero-sync-document failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not send the document to Xero' }, 502);
  }
});
