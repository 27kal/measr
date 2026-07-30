import { describe, expect, it } from 'vitest';
import { oneRecoveryMatch, recoveryLookupPath, recoveryMatches, sha256Json } from '../../supabase/functions/_shared/xero-recovery';
import { bankTransactionMatchesPreparation, bankTransferMatchesPreparation, invoiceMatchesStatement } from '../../supabase/functions/_shared/xero-verification';

describe('Xero preparation recovery', () => {
  const token = 'WB-1234567890ABCDEF-A1';

  it('uses an exact marker lookup for every supported object class', () => {
    expect(decodeURIComponent(recoveryLookupPath('bank_transaction', token))).toBe(`BankTransactions?where=Reference==\"${token}\"`);
    expect(decodeURIComponent(recoveryLookupPath('bill', token))).toBe(`Invoices?where=Reference==\"${token}\"&createdByMyApp=true`);
    expect(decodeURIComponent(recoveryLookupPath('transfer', token))).toBe(`BankTransfers?where=Reference==\"${token}\"`);
  });

  it('rejects ambiguous live marker matches but ignores deleted history', () => {
    expect(oneRecoveryMatch([{ Status: 'DELETED' }, { Status: 'AUTHORISED', BankTransactionID: 'one' }])).toMatchObject({ BankTransactionID: 'one' });
    expect(() => oneRecoveryMatch([{ Status: 'AUTHORISED' }, { Status: 'AUTHORISED' }])).toThrow('ambiguous');
    expect(recoveryMatches('invoice', { Invoices: [{ InvoiceID: 'one' }] })).toHaveLength(1);
  });

  it('fingerprints the immutable accounting shape before reattachment', () => {
    expect(bankTransactionMatchesPreparation({ Reference: token, Type: 'SPEND', Status: 'AUTHORISED', Total: 12.34, BankAccount: { AccountID: 'bank-1' }, DateString: '2026-07-23T00:00:00' }, { reference: token, amountMinor: -1234, xeroBankAccountId: 'bank-1', postedAt: '2026-07-23' })).toBe(true);
    expect(invoiceMatchesStatement({ Reference: token, Type: 'ACCPAY', Status: 'AUTHORISED', Total: 12.34, DateString: '2026-06-30T00:00:00' }, { reference: token, kind: 'bill', amountMinor: -1234, date: '2026-06-30' })).toBe(true);
    expect(bankTransferMatchesPreparation({ Reference: token, Status: 'AUTHORISED', Amount: 12.34, FromBankAccount: { AccountID: 'bank-1' }, ToBankAccount: { AccountID: 'bank-2' }, DateString: '2026-07-23T00:00:00', BankTransferID: 'transfer', FromBankTransactionID: 'from', ToBankTransactionID: 'to' }, { reference: token, amountMinor: -1234, fromXeroBankAccountId: 'bank-1', toXeroBankAccountId: 'bank-2', postedAt: '2026-07-23' })).toBe(true);
  });

  it('produces a stable request fingerprint and changes it with accounting intent', async () => {
    const first = await sha256Json({ amount: 12.34, account: '200' });
    expect(await sha256Json({ amount: 12.34, account: '200' })).toBe(first);
    expect(await sha256Json({ amount: 12.34, account: '201' })).not.toBe(first);
  });
});
