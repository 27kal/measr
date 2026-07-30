import { describe, expect, it } from 'vitest';
import { paymentMatchesStatement, transactionMatchesStatement, xeroDate } from '../../supabase/functions/_shared/xero-verification';

const expected = {
  amountMinor: -7410,
  xeroBankAccountId: 'bank-1',
  postedAt: '2026-07-16',
  parentInvoiceId: 'invoice-1'
};

describe('Xero observation fingerprints', () => {
  it('normalizes both Xero date encodings', () => {
    expect(xeroDate('/Date(1784160000000+0000)/')).toBe('2026-07-16');
    expect(xeroDate('/Date(0+0000)/', '2026-07-16T00:00:00')).toBe('2026-07-16');
  });

  it('matches a payment using Xero’s Account field and its parent invoice', () => {
    expect(paymentMatchesStatement({
      Amount: 74.1,
      Account: { AccountID: 'bank-1' },
      Invoice: { InvoiceID: 'invoice-1' },
      DateString: '2026-07-16T00:00:00'
    }, expected)).toBe(true);
  });

  it('rejects a payment for the wrong statement date or parent', () => {
    expect(paymentMatchesStatement({ Amount: 74.1, Account: { AccountID: 'bank-1' }, Invoice: { InvoiceID: 'invoice-2' }, DateString: '2026-07-16T00:00:00' }, expected)).toBe(false);
    expect(paymentMatchesStatement({ Amount: 74.1, Account: { AccountID: 'bank-1' }, Invoice: { InvoiceID: 'invoice-1' }, DateString: '2026-07-17T00:00:00' }, expected)).toBe(false);
  });

  it('matches bank transactions with amount, account and date', () => {
    expect(transactionMatchesStatement({ Total: 74.1, BankAccount: { AccountID: 'bank-1' }, DateString: '2026-07-16T00:00:00' }, expected)).toBe(true);
  });
});
