import { describe, expect, it } from 'vitest';
import { currentInvoiceCandidateEndpoint, findXeroCandidatesInSnapshot, type XeroAnalysisSnapshot } from '../../supabase/functions/_shared/agent-xero.ts';

describe('current Xero invoice candidate search', () => {
  it('queries exact outstanding supplier bills newest-first for a spend', () => {
    const endpoint = currentInvoiceCandidateEndpoint({ amountMinor: -9817 });
    const url = new URL(`https://example.test/${endpoint}`);
    expect(decodeURIComponent(url.searchParams.get('where') ?? '')).toBe('Status=="AUTHORISED"&&Type=="ACCPAY"&&AmountDue==98.17');
    expect(url.searchParams.get('order')).toBe('Date DESC');
    expect(url.searchParams.get('summaryOnly')).toBe('true');
  });

  it('queries exact outstanding sales invoices for a receipt', () => {
    const endpoint = currentInvoiceCandidateEndpoint({ amountMinor: 420000 });
    expect(decodeURIComponent(new URL(`https://example.test/${endpoint}`).searchParams.get('where') ?? '')).toContain('Type=="ACCREC"&&AmountDue==4200.00');
  });
});

describe('snapshot-backed Xero candidate search', () => {
  it('finds the same exact open bill without another network request', () => {
    const snapshot: XeroAnalysisSnapshot = {
      schemaVersion: 1, companyId: 'company', organisation: 'Example Ltd', createdAt: '2026-07-28T08:00:00Z', expiresAt: '2026-07-28T08:10:00Z',
      referenceData: {}, historySummary: {}, bankTransactions: [], bankTransfers: [],
      invoices: [{ InvoiceID: 'bill-53', InvoiceNumber: '0053', Type: 'ACCPAY', Status: 'AUTHORISED', AmountDue: 98.17, Total: 98.17, DateString: '2026-06-30', Contact: { ContactID: 'contact', Name: 'Joiin Ltd' }, HasAttachments: true }]
    };
    const result = findXeroCandidatesInSnapshot(snapshot, { amountMinor: -9817, postedAt: '2026-07-01', payee: 'JOIIN LTD' });
    expect(result.searchedAt).toBe(snapshot.createdAt);
    expect(result.candidates).toMatchObject([{ entityType: 'invoice', entityId: 'bill-53', entityNumber: '0053', score: 1 }]);
  });
});
