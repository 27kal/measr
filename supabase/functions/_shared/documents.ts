import { freshXeroAccessToken } from './xero.ts';

export const DOCUMENT_BUCKET = 'agent-artifacts';
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const DOCUMENT_URI_PREFIX = 'workbench://document/';
const XERO_EVIDENCE_URI_PREFIX = 'workbench://xero-evidence/';

type Row = Record<string, any>;
type Service = any;

export type StoredDocument = {
  id: string;
  company_id: string;
  statement_line_id: string;
  storage_key: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  analysis_status: 'pending' | 'processing' | 'analysed' | 'failed';
  analysis_error: string | null;
  candidate_set_id: string | null;
  xero_object_type: string | null;
  xero_object_id: string | null;
  xero_filename: string | null;
  xero_attachment_id: string | null;
  xero_uploaded_at: string | null;
  xero_upload_error: string | null;
  created_at: string;
  updated_at: string;
};

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function bytesDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

export function safeDocumentFilename(filename: string): string {
  const normalized = filename.normalize('NFKD').replace(/[^\x20-\x7E]/g, '');
  const safe = normalized.replace(/[<>:"/\\|?*\0+]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
  return (safe || 'document').slice(0, 180);
}

export function xeroAttachmentFilename(documentId: string, filename: string): string {
  return `WB-${documentId.replaceAll('-', '').slice(0, 8).toUpperCase()}-${safeDocumentFilename(filename)}`.slice(0, 220);
}

export function documentStorageKey(companyId: string, lineId: string, documentId: string, filename: string): string {
  return `${companyId}/documents/${lineId}/${documentId}-${safeDocumentFilename(filename)}`;
}

export function xeroEvidenceStorageKey(companyId: string, entityId: string, attachmentId: string, filename: string): string {
  return `${companyId}/xero-evidence/${entityId}/${attachmentId}-${safeDocumentFilename(filename)}`;
}

export function xeroEvidenceUri(storageKey: string): string {
  return `${XERO_EVIDENCE_URI_PREFIX}${encodeURIComponent(storageKey)}`;
}

export async function archiveXeroEvidence(service: Service, storageKey: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  const { error } = await service.storage.from(DOCUMENT_BUCKET).upload(storageKey, new Blob([new Uint8Array(bytes)], { type: mimeType }), { contentType: mimeType, upsert: true });
  if (error) throw new Error(`Could not archive Xero evidence: ${error.message}`);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function downloadDocument(service: Service, document: StoredDocument): Promise<{ bytes: Uint8Array; dataUrl: string }> {
  const { data, error } = await service.storage.from(DOCUMENT_BUCKET).download(document.storage_key);
  if (error || !data) throw new Error(`Could not read ${document.filename}: ${error?.message ?? 'document missing'}`);
  const bytes = new Uint8Array(await data.arrayBuffer());
  return { bytes, dataUrl: bytesDataUrl(bytes, document.mime_type) };
}

export function documentUserContent(document: StoredDocument, dataUrl: string, currentContext?: unknown): Array<Record<string, unknown>> {
  const prompt = {
    type: 'input_text',
    text: `The bookkeeper uploaded ${document.filename} as evidence for this bank line. Inspect the document, reconsider the complete accounting treatment, and return a complete revised recommendation. Cite the document in your evidence. Do not assume that the document belongs to the line if its supplier, date or amount conflicts.${currentContext === undefined ? '' : `\n\nCurrent server-fetched context for this document turn:\n${JSON.stringify(currentContext)}`}`
  };
  if (document.mime_type === 'application/pdf') return [prompt, { type: 'input_file', file: dataUrl, filename: document.filename }];
  return [prompt, { type: 'input_image', image: dataUrl, detail: 'high' }];
}

function transform(value: unknown, visit: (value: Row) => Row): unknown {
  if (Array.isArray(value)) return value.map(item => transform(item, visit));
  if (!value || typeof value !== 'object') return value;
  const mapped = visit(value as Row);
  return Object.fromEntries(Object.entries(mapped).map(([key, child]) => [key, transform(child, visit)]));
}

export async function hydrateDocumentHistory(service: Service, companyId: string, history: unknown[]): Promise<{ history: unknown[]; dataUrls: Map<string, string> }> {
  const ids = new Set<string>();
  const xeroEvidenceKeys = new Set<string>();
  transform(history, value => {
    const fileUri = value.type === 'input_file' && typeof value.file === 'object' && typeof value.file?.url === 'string' ? value.file.url : '';
    const imageUri = value.type === 'input_image' && typeof value.image === 'string' ? value.image : '';
    const uri = fileUri || imageUri;
    if (uri.startsWith(DOCUMENT_URI_PREFIX)) ids.add(uri.slice(DOCUMENT_URI_PREFIX.length));
    if (uri.startsWith(XERO_EVIDENCE_URI_PREFIX)) xeroEvidenceKeys.add(decodeURIComponent(uri.slice(XERO_EVIDENCE_URI_PREFIX.length)));
    return value;
  });
  if (!ids.size && !xeroEvidenceKeys.size) return { history: structuredClone(history), dataUrls: new Map() };

  const { data, error } = ids.size
    ? await service.from('documents').select('*').eq('company_id', companyId).in('id', [...ids])
    : { data: [], error: null };
  if (error) throw new Error(error.message);
  const documents = new Map<string, StoredDocument>((data ?? []).map((document: Row) => [String(document.id), document as StoredDocument]));
  const dataUrls = new Map<string, string>();
  for (const id of ids) {
    const document = documents.get(id);
    if (!document) throw new Error('A document referenced by the agent thread no longer exists');
    dataUrls.set((await downloadDocument(service, document)).dataUrl, `${DOCUMENT_URI_PREFIX}${id}`);
  }
  for (const storageKey of xeroEvidenceKeys) {
    if (!storageKey.startsWith(`${companyId}/xero-evidence/`)) throw new Error('A Xero evidence reference is outside this company');
    const { data: blob, error: storageError } = await service.storage.from(DOCUMENT_BUCKET).download(storageKey);
    if (storageError || !blob) throw new Error(`A Xero evidence snapshot is unavailable: ${storageError?.message ?? 'missing'}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    dataUrls.set(bytesDataUrl(bytes, blob.type || 'application/octet-stream'), xeroEvidenceUri(storageKey));
  }

  const hydrated = transform(history, value => {
    if (value.type === 'input_file' && typeof value.file === 'object' && typeof value.file?.url === 'string' && value.file.url.startsWith(DOCUMENT_URI_PREFIX)) {
      const durableUri = value.file.url;
      const dataUrl = [...dataUrls.entries()].find(([, uri]) => uri === durableUri)?.[0];
      return { ...value, file: dataUrl };
    }
    if (value.type === 'input_file' && typeof value.file === 'object' && typeof value.file?.url === 'string' && value.file.url.startsWith(XERO_EVIDENCE_URI_PREFIX)) {
      const durableUri = value.file.url;
      const dataUrl = [...dataUrls.entries()].find(([, uri]) => uri === durableUri)?.[0];
      return { ...value, file: dataUrl };
    }
    if (value.type === 'input_image' && typeof value.image === 'string' && value.image.startsWith(DOCUMENT_URI_PREFIX)) {
      const durableUri = value.image;
      const dataUrl = [...dataUrls.entries()].find(([, uri]) => uri === durableUri)?.[0];
      return { ...value, image: dataUrl };
    }
    if (value.type === 'input_image' && typeof value.image === 'string' && value.image.startsWith(XERO_EVIDENCE_URI_PREFIX)) {
      const durableUri = value.image;
      const dataUrl = [...dataUrls.entries()].find(([, uri]) => uri === durableUri)?.[0];
      return { ...value, image: dataUrl };
    }
    return value;
  }) as unknown[];
  return { history: hydrated, dataUrls };
}

export function sanitizeDocumentHistory(history: unknown[], dataUrls: Map<string, string>): unknown[] {
  return transform(history, value => {
    if (value.type === 'input_file' && typeof value.file === 'string' && dataUrls.has(value.file)) {
      const reference = dataUrls.get(value.file)!;
      return { ...value, file: { url: reference.startsWith('workbench://') ? reference : `${DOCUMENT_URI_PREFIX}${reference}` } };
    }
    if (value.type === 'input_image' && typeof value.image === 'string' && dataUrls.has(value.image)) {
      const reference = dataUrls.get(value.image)!;
      return { ...value, image: reference.startsWith('workbench://') ? reference : `${DOCUMENT_URI_PREFIX}${reference}` };
    }
    return value;
  }) as unknown[];
}

async function postXeroAttachment(token: string, tenantId: string, endpoint: string, objectId: string, filename: string, mimeType: string, bytes: Uint8Array): Promise<Row> {
  const response = await fetch(`https://api.xero.com/api.xro/2.0/${endpoint}/${objectId}/Attachments/${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'xero-tenant-id': tenantId,
      accept: 'application/json',
      'content-type': mimeType
    },
    body: new Blob([new Uint8Array(bytes)], { type: mimeType })
  });
  const text = await response.text();
  let payload: Row = {};
  try { payload = text ? JSON.parse(text) as Row : {}; } catch { payload = { Message: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`Xero attachment upload failed (${response.status}): ${payload.Message ?? text.slice(0, 500)}`);
  return payload;
}

async function findXeroAttachment(token: string, tenantId: string, endpoint: string, objectId: string, filename: string, byteSize: number): Promise<Row | null> {
  const response = await fetch(`https://api.xero.com/api.xro/2.0/${endpoint}/${objectId}/Attachments`, {
    headers: { authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId, accept: 'application/json' }
  });
  const text = await response.text();
  let payload: Row = {};
  try { payload = text ? JSON.parse(text) as Row : {}; } catch { payload = { Message: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`Xero attachment lookup failed (${response.status}): ${payload.Message ?? text.slice(0, 500)}`);
  return (Array.isArray(payload.Attachments) ? payload.Attachments : []).find((attachment: Row) =>
    String(attachment.FileName ?? '').toLowerCase() === filename.toLowerCase()
    && Number(attachment.ContentLength ?? byteSize) === byteSize
  ) ?? null;
}

export async function syncDocumentToXero(service: Service, companyId: string, document: StoredDocument, candidateSetId: string, endpoint: 'BankTransactions' | 'Invoices' | 'BankTransfers', objectType: 'bank_transaction' | 'invoice' | 'bank_transfer', objectId: string, token?: string, tenantId?: string): Promise<StoredDocument> {
  let resolvedToken = token;
  let resolvedTenant = tenantId;
  if (!resolvedToken || !resolvedTenant) {
    const { data: connection, error } = await service.from('xero_connections').select('tenant_id').eq('company_id', companyId).is('disconnected_at', null).maybeSingle();
    if (error || !connection) throw new Error(error?.message ?? 'Xero is not connected');
    resolvedTenant = String(connection.tenant_id);
    resolvedToken = await freshXeroAccessToken(service, companyId);
  }
  const { bytes } = await downloadDocument(service, document);
  const filename = xeroAttachmentFilename(document.id, document.filename);
  const existing = await findXeroAttachment(resolvedToken, resolvedTenant, endpoint, objectId, filename, document.byte_size);
  const payload = existing ? null : await postXeroAttachment(resolvedToken, resolvedTenant, endpoint, objectId, filename, document.mime_type, bytes);
  const attachment = existing ?? (Array.isArray(payload?.Attachments) ? payload.Attachments[0] : null);
  const patch = {
    candidate_set_id: candidateSetId,
    xero_object_type: objectType,
    xero_object_id: objectId,
    xero_filename: filename,
    xero_attachment_id: attachment?.AttachmentID ?? null,
    xero_uploaded_at: new Date().toISOString(),
    xero_upload_error: null,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await service.from('documents').update(patch).eq('id', document.id).eq('company_id', companyId).select('*').single();
  if (error) throw new Error(`Xero received the attachment but Workbench could not record it: ${error.message}`);
  return data as StoredDocument;
}

export async function syncDocumentToPreparedLine(service: Service, companyId: string, document: StoredDocument): Promise<StoredDocument> {
  const { data: line, error: lineError } = await service.from('statement_lines').select('active_candidate_set_id').eq('id', document.statement_line_id).eq('company_id', companyId).maybeSingle();
  if (lineError || !line?.active_candidate_set_id) throw new Error(lineError?.message ?? 'Prepare the recommendation before sending its document to Xero');
  const { data: objects, error: objectError } = await service.from('xero_objects').select('object_type,object_role,xero_object_id').eq('candidate_set_id', line.active_candidate_set_id).eq('company_id', companyId);
  if (objectError) throw new Error(objectError.message);
  const object = (objects ?? []).find((item: Row) => item.object_role === 'parent_document' || item.object_role === 'primary');
  if (!object) throw new Error('The prepared Xero entity is not available yet');
  const mapping = object.object_type === 'invoice'
    ? { endpoint: 'Invoices' as const, objectType: 'invoice' as const }
    : object.object_type === 'bank_transfer'
      ? { endpoint: 'BankTransfers' as const, objectType: 'bank_transfer' as const }
      : { endpoint: 'BankTransactions' as const, objectType: 'bank_transaction' as const };
  return await syncDocumentToXero(service, companyId, document, String(line.active_candidate_set_id), mapping.endpoint, mapping.objectType, String(object.xero_object_id));
}

export async function syncCandidateDocumentsToXero(service: Service, companyId: string, lineIds: string[], candidateSetId: string, endpoint: 'BankTransactions' | 'Invoices' | 'BankTransfers', objectType: 'bank_transaction' | 'invoice' | 'bank_transfer', objectId: string, token: string, tenantId: string): Promise<{ uploaded: string[]; errors: Array<{ documentId: string; message: string }> }> {
  const { data, error } = await service.from('documents').select('*').eq('company_id', companyId).in('statement_line_id', lineIds).eq('analysis_status', 'analysed').is('xero_uploaded_at', null).order('created_at');
  if (error) return { uploaded: [], errors: [{ documentId: '', message: `Could not load supporting documents: ${error.message}` }] };
  const uploaded: string[] = [];
  const errors: Array<{ documentId: string; message: string }> = [];
  for (const row of data ?? []) {
    const document = row as StoredDocument;
    try {
      await syncDocumentToXero(service, companyId, document, candidateSetId, endpoint, objectType, objectId, token, tenantId);
      uploaded.push(document.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ documentId: document.id, message });
      await service.from('documents').update({ candidate_set_id: candidateSetId, xero_object_type: objectType, xero_object_id: objectId, xero_upload_error: message, updated_at: new Date().toISOString() }).eq('id', document.id).eq('company_id', companyId);
    }
  }
  return { uploaded, errors };
}

export async function syncPendingCompanyDocumentsToXero(service: Service, companyId: string, token: string, tenantId: string): Promise<{ uploaded: string[]; errors: Array<{ documentId: string; message: string }> }> {
  const { data, error } = await service.from('documents').select('*').eq('company_id', companyId).eq('analysis_status', 'analysed').is('xero_uploaded_at', null).not('candidate_set_id', 'is', null).not('xero_object_id', 'is', null).order('created_at');
  if (error) return { uploaded: [], errors: [{ documentId: '', message: error.message }] };
  const uploaded: string[] = [];
  const errors: Array<{ documentId: string; message: string }> = [];
  for (const row of data ?? []) {
    const document = row as StoredDocument;
    const target = document.xero_object_type === 'invoice'
      ? { endpoint: 'Invoices' as const, objectType: 'invoice' as const }
      : document.xero_object_type === 'bank_transfer'
        ? { endpoint: 'BankTransfers' as const, objectType: 'bank_transfer' as const }
        : { endpoint: 'BankTransactions' as const, objectType: 'bank_transaction' as const };
    try {
      await syncDocumentToXero(service, companyId, document, String(document.candidate_set_id), target.endpoint, target.objectType, String(document.xero_object_id), token, tenantId);
      uploaded.push(document.id);
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : String(syncError);
      errors.push({ documentId: document.id, message });
      await service.from('documents').update({ xero_upload_error: message, updated_at: new Date().toISOString() }).eq('id', document.id).eq('company_id', companyId);
    }
  }
  return { uploaded, errors };
}
