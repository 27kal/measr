import { describe, expect, it } from 'vitest';
import { authorisedInvoicePayload } from '../../supabase/functions/_shared/xero';

describe('authorised Xero invoice payload', () => {
  it('keeps the supplier invoice number separate from the Workbench correlation marker', () => {
    expect(authorisedInvoicePayload({
      kind: 'bill',
      contactId: 'contact-1',
      accountCode: '485',
      taxType: 'INPUT2',
      amount: 98.17,
      invoiceNumber: '509E97FE-0053',
      reference: 'WB-LINE-A1',
      description: 'Joiin subscription',
      date: '2026-06-30',
      dueDate: '2026-06-30'
    })).toMatchObject({
      Type: 'ACCPAY',
      Status: 'AUTHORISED',
      InvoiceNumber: '509E97FE-0053',
      Reference: 'WB-LINE-A1',
      Date: '2026-06-30',
      DueDate: '2026-06-30'
    });
  });
});
