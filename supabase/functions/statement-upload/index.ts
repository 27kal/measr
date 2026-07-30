import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { DOCUMENT_BUCKET, safeDocumentFilename, sha256Hex } from '../_shared/documents.ts';

const MAX_BYTES = 25 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  pdf: 'application/pdf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
const ALLOWED = new Set(Object.values(MIME_BY_EXTENSION).concat('application/csv'));

function kickWorker(): void {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const secret = Deno.env.get('AGENT_RUNNER_SECRET');
  if (!baseUrl || !secret) return;
  const task = fetch(`${baseUrl}/functions/v1/statement-import-worker`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench-runner-secret': secret },
    body: '{}'
  }).then(response => {
    if (!response.ok) console.error('statement import worker kick failed', response.status);
  }).catch(error => console.error('statement import worker kick failed', error));
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
}

function mimeType(file: File): string {
  const extension = file.name.split('.').at(-1)?.toLocaleLowerCase('en-GB') ?? '';
  const fromExtension = MIME_BY_EXTENSION[extension];
  if (fromExtension) return fromExtension;
  return file.type.toLocaleLowerCase('en-GB');
}

function publicImport(row: Record<string, unknown>) {
  return {
    id: row.id,
    companyId: row.company_id,
    bankAccountId: row.bank_account_id,
    filename: row.filename,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    status: row.status,
    institution: row.detected_institution,
    accountName: row.detected_account_name,
    accountIdentifier: row.detected_account_identifier,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    transactionCount: Number(row.transaction_count ?? 0),
    importedCount: Number(row.imported_count ?? 0),
    duplicateCount: Number(row.duplicate_count ?? 0),
    validation: row.validation,
    error: row.last_error,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const form = await request.formData();
    const companyId = String(form.get('companyId') ?? '');
    const bankAccountId = String(form.get('bankAccountId') ?? '');
    const file = form.get('file');
    if (!companyId || !bankAccountId || !(file instanceof File)) return json({ error: 'companyId, bankAccountId and file are required' }, 422);
    const { service, userId, role } = await requireCompanyAccess(request, companyId);
    if (role === 'viewer') return json({ error: 'Viewers cannot upload bank statements' }, 403);
    const account = await service.from('bank_accounts').select('id').eq('id', bankAccountId).eq('company_id', companyId).maybeSingle();
    if (account.error || !account.data) return json({ error: account.error?.message ?? 'Bank account not found' }, 404);
    if (file.size <= 0 || file.size > MAX_BYTES) return json({ error: 'Upload a statement smaller than 25 MB' }, 422);
    const resolvedMime = mimeType(file);
    if (!ALLOWED.has(resolvedMime)) return json({ error: 'Upload a CSV, TSV, XLS, XLSX or PDF bank statement' }, 422);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (resolvedMime === 'application/pdf' && new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') return json({ error: 'The uploaded file is not a valid PDF' }, 422);
    const sha256 = await sha256Hex(bytes);
    const existing = await service.from('statement_imports').select('*').eq('company_id', companyId).eq('bank_account_id', bankAccountId).eq('sha256', sha256).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data && existing.data.status !== 'failed') {
      if (['queued', 'retryable', 'processing'].includes(existing.data.status)) kickWorker();
      return json({ statementImport: publicImport(existing.data), replay: true }, 200);
    }
    if (existing.data) {
      const retried = await service.from('statement_imports').update({
        status: 'queued', attempts: 0, available_at: new Date().toISOString(), last_error: null,
        extraction: null, validation: null, completed_at: null, updated_at: new Date().toISOString()
      }).eq('id', existing.data.id).select('*').single();
      if (retried.error) throw new Error(retried.error.message);
      await service.from('statement_import_org_queue').upsert({ company_id: companyId }, { onConflict: 'company_id' });
      kickWorker();
      return json({ statementImport: publicImport(retried.data), replay: true }, 202);
    }

    const id = crypto.randomUUID();
    const filename = safeDocumentFilename(file.name || 'bank-statement');
    const storageKey = `${companyId}/statement-imports/${id}-${filename}`;
    const uploaded = await service.storage.from(DOCUMENT_BUCKET).upload(storageKey, new Blob([bytes], { type: resolvedMime }), { contentType: resolvedMime, upsert: false });
    if (uploaded.error) throw new Error(`Could not store the statement: ${uploaded.error.message}`);
    const inserted = await service.from('statement_imports').insert({
      id, company_id: companyId, bank_account_id: bankAccountId, storage_key: storageKey,
      filename, mime_type: resolvedMime, byte_size: bytes.length, sha256, created_by: userId
    }).select('*').single();
    if (inserted.error) {
      await service.storage.from(DOCUMENT_BUCKET).remove([storageKey]);
      throw new Error(inserted.error.message);
    }
    const queued = await service.from('statement_import_org_queue').upsert({ company_id: companyId }, { onConflict: 'company_id' });
    if (queued.error) throw new Error(queued.error.message);
    kickWorker();
    return json({ statementImport: publicImport(inserted.data) }, 202);
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('statement-upload failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not upload the statement' }, 502);
  }
});
