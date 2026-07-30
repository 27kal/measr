import { describe, expect, it } from 'vitest';
import { classifyReconciledLedger, normalizeXeroLedger } from '../../supabase/functions/_shared/xero-ledger';

const bank = 'bank-1';

describe('Xero bank-ledger preflight', () => {
  it('normalizes reconciled bank transactions, payments and both transfer sides with signed bank amounts', () => {
    const movements = normalizeXeroLedger({
      bankTransactions: [{ BankTransactionID: 'spend-1', Type: 'SPEND', Status: 'AUTHORISED', Total: 12.34, DateString: '2026-07-10', IsReconciled: true, BankAccount: { AccountID: bank }, Contact: { Name: 'Supplier' } }],
      payments: [{ PaymentID: 'payment-1', Status: 'AUTHORISED', BankAmount: 42, DateString: '2026-07-11', IsReconciled: true, Account: { AccountID: bank }, Invoice: { InvoiceID: 'invoice-1', Type: 'ACCREC', Contact: { Name: 'Customer' } } }],
      bankTransfers: [{ BankTransferID: 'transfer-1', Status: 'AUTHORISED', Amount: 50, DateString: '2026-07-12', FromBankTransactionID: 'from-1', ToBankTransactionID: 'to-1', FromBankAccount: { AccountID: 'bank-1' }, ToBankAccount: { AccountID: 'bank-2' }, FromIsReconciled: true, ToIsReconciled: true }]
    });
    expect(movements.map(movement => [movement.key, movement.amountMinor, movement.kind])).toEqual([
      ['bank_transaction:spend-1', -1234, 'bank_transaction'],
      ['payment:payment-1', 4200, 'invoice'],
      ['bank_transaction:from-1', -5000, 'bank_transaction'],
      ['bank_transaction:to-1', 5000, 'bank_transaction']
    ]);
  });

  it('accepts only a one-to-one exact account, signed amount and date match', () => {
    const [movement] = normalizeXeroLedger({ bankTransactions: [{ BankTransactionID: 'spend-1', Type: 'SPEND', Status: 'AUTHORISED', Total: 12.34, DateString: '2026-07-10', IsReconciled: true, BankAccount: { AccountID: bank } }] });
    const lines = [{ id: 'line-1', xeroBankAccountId: bank, postedAt: '2026-07-10', amountMinor: -1234 }];
    expect(classifyReconciledLedger(lines, new Set(['line-1']), [movement], new Set())).toMatchObject([{ outcome: 'reconciled', lineId: 'line-1', movement: { key: 'bank_transaction:spend-1' } }]);
  });

  it('keeps duplicate statement fingerprints ambiguous instead of attaching one movement twice', () => {
    const [movement] = normalizeXeroLedger({ bankTransactions: [{ BankTransactionID: 'spend-1', Type: 'SPEND', Status: 'AUTHORISED', Total: 12.34, DateString: '2026-07-10', IsReconciled: true, BankAccount: { AccountID: bank } }] });
    const lines = [
      { id: 'line-1', xeroBankAccountId: bank, postedAt: '2026-07-10', amountMinor: -1234 },
      { id: 'line-2', xeroBankAccountId: bank, postedAt: '2026-07-10', amountMinor: -1234 }
    ];
    expect(classifyReconciledLedger(lines, new Set(['line-1', 'line-2']), [movement], new Set()).map(result => result.outcome)).toEqual(['ambiguous', 'ambiguous']);
  });

  it('blocks nearby-date and already-mapped movements as possible duplicates', () => {
    const [movement] = normalizeXeroLedger({ bankTransactions: [{ BankTransactionID: 'spend-1', Type: 'SPEND', Status: 'AUTHORISED', Total: 12.34, DateString: '2026-07-11', IsReconciled: true, BankAccount: { AccountID: bank } }] });
    const line = { id: 'line-1', xeroBankAccountId: bank, postedAt: '2026-07-10', amountMinor: -1234 };
    expect(classifyReconciledLedger([line], new Set(['line-1']), [movement], new Set())[0].outcome).toBe('ambiguous');
    expect(classifyReconciledLedger([{ ...line, postedAt: '2026-07-11' }], new Set(['line-1']), [movement], new Set(['spend-1']))[0].outcome).toBe('ambiguous');
  });
});
