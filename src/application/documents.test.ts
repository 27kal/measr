import { describe, expect, it } from 'vitest';
import { documentUserContent, safeDocumentFilename, sanitizeDocumentHistory, xeroAttachmentFilename, xeroEvidenceStorageKey, xeroEvidenceUri, type StoredDocument } from '../../supabase/functions/_shared/documents.ts';

const document: StoredDocument = {
  id: '12345678-1234-1234-1234-123456789012', company_id: 'company', statement_line_id: 'line',
  storage_key: 'stored', filename: 'Supplier invoice.pdf', mime_type: 'application/pdf', byte_size: 123,
  sha256: 'a'.repeat(64), analysis_status: 'analysed', analysis_error: null, candidate_set_id: null,
  xero_object_type: null, xero_object_id: null, xero_filename: null, xero_attachment_id: null,
  xero_uploaded_at: null, xero_upload_error: null, created_at: '2026-07-27T00:00:00Z', updated_at: '2026-07-27T00:00:00Z'
};

describe('line documents', () => {
  it('uses an ASCII Xero-safe, collision-resistant attachment name', () => {
    expect(safeDocumentFilename('inv+?:é.pdf')).toBe('inv-e.pdf');
    expect(xeroAttachmentFilename(document.id, 'inv+?:é.pdf')).toBe('WB-12345678-inv-e.pdf');
  });

  it('passes PDFs as file inputs and images as image inputs', () => {
    expect(documentUserContent(document, 'data:application/pdf;base64,abc')[1]).toEqual({
      type: 'input_file', file: 'data:application/pdf;base64,abc', filename: 'Supplier invoice.pdf'
    });
    expect(documentUserContent({ ...document, mime_type: 'image/png', filename: 'receipt.png' }, 'data:image/png;base64,abc')[1]).toEqual({
      type: 'input_image', image: 'data:image/png;base64,abc', detail: 'high'
    });
  });

  it('replaces document bytes with durable private references in saved threads', () => {
    const dataUrl = 'data:application/pdf;base64,abc';
    const history = [{ role: 'user', content: [{ type: 'input_file', file: dataUrl, filename: document.filename }] }];
    expect(sanitizeDocumentHistory(history, new Map([[dataUrl, document.id]]))).toEqual([
      { role: 'user', content: [{ type: 'input_file', file: { url: `workbench://document/${document.id}` }, filename: document.filename }] }
    ]);
  });

  it('replaces Xero evidence bytes with a company-scoped private snapshot reference', () => {
    const dataUrl = 'data:application/pdf;base64,eGVybw==';
    const storageKey = xeroEvidenceStorageKey('company', 'invoice-id', 'attachment-id', 'Invoice 0052.pdf');
    const durableUri = xeroEvidenceUri(storageKey);
    const history = [{ role: 'user', content: [{ type: 'input_file', file: dataUrl, filename: 'Invoice 0052.pdf' }] }];
    expect(storageKey).toBe('company/xero-evidence/invoice-id/attachment-id-Invoice-0052.pdf');
    expect(sanitizeDocumentHistory(history, new Map([[dataUrl, durableUri]]))).toEqual([
      { role: 'user', content: [{ type: 'input_file', file: { url: durableUri }, filename: 'Invoice 0052.pdf' }] }
    ]);
  });
});
