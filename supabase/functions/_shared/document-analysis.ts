import { continueLineAgentWithDocument } from './agent-runtime.ts';
import { syncDocumentToPreparedLine, type StoredDocument } from './documents.ts';

type Row = Record<string, any>;
type Service = any;

export async function analyseStoredDocument(service: Service, companyId: string, line: Row, thread: Row, document: StoredDocument): Promise<void> {
  try {
    await continueLineAgentWithDocument(service, companyId, line, thread, document);
    const { data: analysed, error } = await service.from('documents').update({
      analysis_status: 'analysed', analysis_error: null, updated_at: new Date().toISOString()
    }).eq('id', document.id).eq('company_id', companyId).select('*').single();
    if (error) throw new Error(error.message);
    if (line.active_candidate_set_id && analysed) {
      try {
        await syncDocumentToPreparedLine(service, companyId, analysed as StoredDocument);
      } catch (syncError) {
        const message = syncError instanceof Error ? syncError.message : String(syncError);
        await service.from('documents').update({ xero_upload_error: message, updated_at: new Date().toISOString() }).eq('id', document.id).eq('company_id', companyId);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('document analysis failed', { documentId: document.id, message });
    await service.from('documents').update({
      analysis_status: 'failed', analysis_error: message, updated_at: new Date().toISOString()
    }).eq('id', document.id).eq('company_id', companyId);
  }
}

export function queueDocumentAnalysis(service: Service, companyId: string, line: Row, thread: Row, document: StoredDocument): void {
  const task = analyseStoredDocument(service, companyId, line, thread, document);
  const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(task);
  else void task;
}

export function analysisIsFresh(document: Pick<StoredDocument, 'analysis_status' | 'updated_at'>, now = Date.now()): boolean {
  return document.analysis_status === 'processing' && now - Date.parse(document.updated_at) < 120_000;
}
