type XeroRecord = Record<string, unknown>;

function nestedId(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as XeroRecord)[key];
  return typeof id === 'string' ? id : null;
}

export function xeroDate(value: unknown, dateString?: unknown): string | null {
  if (typeof dateString === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateString)) return dateString.slice(0, 10);
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const milliseconds = value.match(/\/Date\((\d+)/)?.[1];
  return milliseconds ? new Date(Number(milliseconds)).toISOString().slice(0, 10) : null;
}

export function paymentMatchesStatement(
  payment: XeroRecord,
  expected: { amountMinor: number; xeroBankAccountId: string | null; postedAt: string; parentInvoiceId: string }
): boolean {
  const amount = typeof payment.Amount === 'number' ? payment.Amount : Number(payment.Amount);
  const accountId = nestedId(payment.Account, 'AccountID') ?? nestedId(payment.BankAccount, 'AccountID');
  const invoiceId = nestedId(payment.Invoice, 'InvoiceID');
  return Number.isFinite(amount)
    && Math.round(Math.abs(amount) * 100) === Math.abs(expected.amountMinor)
    && accountId === expected.xeroBankAccountId
    && invoiceId === expected.parentInvoiceId
    && xeroDate(payment.Date, payment.DateString) === expected.postedAt;
}

export function transactionMatchesStatement(
  transaction: XeroRecord,
  expected: { amountMinor: number; xeroBankAccountId: string | null; postedAt: string }
): boolean {
  const total = typeof transaction.Total === 'number' ? transaction.Total : Number(transaction.Total);
  const accountId = nestedId(transaction.BankAccount, 'AccountID');
  return Number.isFinite(total)
    && Math.round(Math.abs(total) * 100) === Math.abs(expected.amountMinor)
    && accountId === expected.xeroBankAccountId
    && xeroDate(transaction.Date, transaction.DateString) === expected.postedAt;
}

export function invoiceMatchesStatement(
  invoice: XeroRecord,
  expected: { kind: 'bill' | 'invoice'; amountMinor: number; date: string; reference: string }
): boolean {
  const total = typeof invoice.Total === 'number' ? invoice.Total : Number(invoice.Total);
  return invoice.Reference === expected.reference
    && invoice.Type === (expected.kind === 'bill' ? 'ACCPAY' : 'ACCREC')
    && Number.isFinite(total)
    && Math.round(Math.abs(total) * 100) === Math.abs(expected.amountMinor)
    && xeroDate(invoice.Date, invoice.DateString) === expected.date
    && invoice.Status !== 'DELETED'
    && invoice.Status !== 'VOIDED';
}

export function bankTransactionMatchesPreparation(
  transaction: XeroRecord,
  expected: { amountMinor: number; xeroBankAccountId: string; postedAt: string; reference: string }
): boolean {
  return transaction.Reference === expected.reference
    && transaction.Type === (expected.amountMinor < 0 ? 'SPEND' : 'RECEIVE')
    && transaction.Status !== 'DELETED'
    && transactionMatchesStatement(transaction, expected);
}

export function bankTransferMatchesPreparation(
  transfer: XeroRecord,
  expected: { amountMinor: number; fromXeroBankAccountId: string; toXeroBankAccountId: string; postedAt: string; reference: string }
): boolean {
  const amount = typeof transfer.Amount === 'number' ? transfer.Amount : Number(transfer.Amount);
  return transfer.Reference === expected.reference
    && transfer.Status !== 'DELETED'
    && Number.isFinite(amount)
    && Math.round(Math.abs(amount) * 100) === Math.abs(expected.amountMinor)
    && nestedId(transfer.FromBankAccount, 'AccountID') === expected.fromXeroBankAccountId
    && nestedId(transfer.ToBankAccount, 'AccountID') === expected.toXeroBankAccountId
    && xeroDate(transfer.Date, transfer.DateString) === expected.postedAt
    && typeof transfer.BankTransferID === 'string'
    && typeof transfer.FromBankTransactionID === 'string'
    && typeof transfer.ToBankTransactionID === 'string';
}
