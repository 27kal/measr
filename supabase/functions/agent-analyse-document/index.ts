import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { artifactPaths, readJson } from '../_shared/agent-artifacts.ts';
import { analysisIsFresh, queueDocumentAnalysis } from '../_shared/document-analysis.ts';
import type { StoredDocument } from '../_shared/documents.ts';

type Row = Record<string, any>;

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const input = await request.json() as { companyId?: string; lineId?: string; runId?: string; statusVersion?: number; documentId?: string };
    if (!input.companyId || !input.lineId || !input.runId || !input.documentId || !Number.isInteger(input.statusVersion)) return json({ error: 'companyId, lineId, runId, statusVersion and documentId are required' }, 422);
    const access = await requireCompanyAccess(request, input.companyId);
    if (access.role === 'viewer') return json({ error: 'Viewers cannot analyse bookkeeping documents' }, 403);
    const { service } = access;
    const [thread, lineResult, documentResult] = await Promise.all([
      readJson<Row>(service, artifactPaths.lineThread(input.companyId, input.lineId)),
      service.from('statement_lines').select('*').eq('id', input.lineId).eq('company_id', input.companyId).maybeSingle(),
      service.from('documents').select('*').eq('id', input.documentId).eq('company_id', input.companyId).eq('statement_line_id', input.lineId).maybeSingle()
    ]);
    if (!thread || thread.kind !== 'line' || thread.runId !== input.runId) return json({ error: 'The agent thread changed; refresh before retrying the document' }, 409);
    if (lineResult.error || !lineResult.data) return json({ error: lineResult.error?.message ?? 'Statement line not found' }, 404);
    if (documentResult.error || !documentResult.data) return json({ error: documentResult.error?.message ?? 'Document not found' }, 404);
    const line = lineResult.data as Row;
    const document = documentResult.data as StoredDocument;
    if (line.status_version !== input.statusVersion) return json({ error: 'The statement line changed; refresh before retrying the document' }, 409);
    const resolved = Boolean(line.active_candidate_set_id) || ['prepared', 'reconciled'].includes(line.status);
    if (!resolved && thread.workflowProjection?.statusVersion !== line.status_version) return json({ error: 'The saved thread was produced for an older statement-line version' }, 409);
    if (document.analysis_status === 'analysed') return json({ document, alreadyAnalysed: true });
    if (analysisIsFresh(document)) return json({ document, alreadyProcessing: true }, 202);

    const processing = await service.from('documents').update({ analysis_status: 'processing', analysis_error: null, updated_at: new Date().toISOString() }).eq('id', document.id).eq('company_id', input.companyId).select('*').single();
    if (processing.error) throw new Error(processing.error.message);
    const queued = processing.data as StoredDocument;
    queueDocumentAnalysis(service, input.companyId, line, thread, queued);
    return json({ document: queued }, 202);
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('agent-analyse-document failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not retry document analysis' }, 502);
  }
});
