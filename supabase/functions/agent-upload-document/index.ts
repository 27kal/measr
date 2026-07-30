import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { artifactPaths, readJson } from '../_shared/agent-artifacts.ts';
import { analysisIsFresh, queueDocumentAnalysis } from '../_shared/document-analysis.ts';
import { DOCUMENT_BUCKET, DOCUMENT_MIME_TYPES, MAX_DOCUMENT_BYTES, documentStorageKey, sha256Hex, type StoredDocument } from '../_shared/documents.ts';

type Row = Record<string, any>;

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let service: any = null;
  let document: StoredDocument | null = null;
  try {
    const form = await request.formData();
    const companyId = String(form.get('companyId') ?? '');
    const lineId = String(form.get('lineId') ?? '');
    const runId = String(form.get('runId') ?? '');
    const statusVersion = Number(form.get('statusVersion'));
    const file = form.get('file');
    if (!companyId || !lineId || !runId || !Number.isInteger(statusVersion) || !(file instanceof File)) return json({ error: 'companyId, lineId, runId, statusVersion and file are required' }, 422);
    const access = await requireCompanyAccess(request, companyId);
    service = access.service;
    if (access.role === 'viewer') return json({ error: 'Viewers cannot upload bookkeeping documents' }, 403);
    if (!DOCUMENT_MIME_TYPES.has(file.type)) return json({ error: 'Upload a PDF, PNG, JPEG or WebP document' }, 422);
    if (file.size <= 0 || file.size > MAX_DOCUMENT_BYTES) return json({ error: 'Documents must be between 1 byte and 10 MB' }, 422);

    const [thread, lineResult] = await Promise.all([
      readJson<Row>(service, artifactPaths.lineThread(companyId, lineId)),
      service.from('statement_lines').select('*').eq('id', lineId).eq('company_id', companyId).maybeSingle()
    ]);
    if (!thread || thread.kind !== 'line' || thread.runId !== runId) return json({ error: 'The agent thread changed; refresh before uploading the document' }, 409);
    if (lineResult.error || !lineResult.data) return json({ error: lineResult.error?.message ?? 'Statement line not found' }, 404);
    const line = lineResult.data as Row;
    if (line.status_version !== statusVersion) return json({ error: 'The statement line changed; refresh before uploading the document' }, 409);
    const resolved = Boolean(line.active_candidate_set_id) || ['prepared', 'reconciled'].includes(line.status);
    if (!resolved && thread.workflowProjection?.statusVersion !== line.status_version) return json({ error: 'The saved agent run was produced for an older statement-line version' }, 409);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    const existing = await service.from('documents').select('*').eq('company_id', companyId).eq('statement_line_id', lineId).eq('sha256', sha256).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
      document = existing.data as StoredDocument;
    } else {
      const id = crypto.randomUUID();
      const filename = file.name.slice(0, 255) || 'document';
      const storageKey = documentStorageKey(companyId, lineId, id, filename);
      const uploaded = await service.storage.from(DOCUMENT_BUCKET).upload(storageKey, new Blob([bytes], { type: file.type }), { upsert: false, contentType: file.type });
      if (uploaded.error) throw new Error(`Could not store the document: ${uploaded.error.message}`);
      const inserted = await service.from('documents').insert({
        id, company_id: companyId, statement_line_id: lineId, storage_key: storageKey,
        filename, mime_type: file.type, byte_size: file.size, sha256,
        source: 'user_upload', analysis_status: 'pending', uploaded_by: access.userId
      }).select('*').single();
      if (inserted.error) {
        await service.storage.from(DOCUMENT_BUCKET).remove([storageKey]);
        throw new Error(inserted.error.message);
      }
      document = inserted.data as StoredDocument;
    }

    if (document.analysis_status === 'analysed') return json({ document, alreadyAnalysed: true });
    if (analysisIsFresh(document)) return json({ document, alreadyProcessing: true }, 202);

    const processing = await service.from('documents').update({ analysis_status: 'processing', analysis_error: null, updated_at: new Date().toISOString() }).eq('id', document.id).eq('company_id', companyId).select('*').single();
    if (processing.error) throw new Error(processing.error.message);
    document = processing.data as StoredDocument;
    queueDocumentAnalysis(service, companyId, line, thread, document);
    return json({ document }, existing.data ? 202 : 201);
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('agent-upload-document failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not analyse the document', documentId: document?.id ?? null }, 502);
  }
});
