import { xeroDate } from './xero-verification.ts';

type Row = Record<string, any>;

export type LedgerMovement = {
  key: string;
  kind: 'bank_transaction' | 'bill' | 'invoice';
  objectIds: string[];
  bankAccountId: string;
  amountMinor: number;
  postedAt: string;
  isReconciled: boolean;
  status: string;
  contactName: string;
  reference: string;
  objects: Array<{
    objectType: 'bank_transaction' | 'payment';
    objectRole: 'primary' | 'payment';
    xeroObjectId: string;
    xeroStatus: string;
    isReconciled: boolean;
    correlationChannels: string[];
    observedPayload: Row;
  }>;
};

export type LedgerLine = {
  id: string;
  xeroBankAccountId: string;
  postedAt: string;
  amountMinor: number;
};

export type LedgerClassification =
  | { outcome: 'reconciled'; lineId: string; movement: LedgerMovement }
  | { outcome: 'ambiguous'; lineId: string; candidates: LedgerMovement[]; reason: string }
  | { outcome: 'unmatched'; lineId: string };

function id(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function signedBankTransactionAmount(item: Row): number | null {
  const amount = Number(item.Total);
  if (!Number.isFinite(amount)) return null;
  if (item.Type === 'SPEND') return -Math.round(Math.abs(amount) * 100);
  if (item.Type === 'RECEIVE') return Math.round(Math.abs(amount) * 100);
  return null;
}

function signedPaymentAmount(item: Row): number | null {
  const amount = Number(item.BankAmount ?? item.Amount);
  if (!Number.isFinite(amount)) return null;
  const invoiceType = item.Invoice?.Type;
  if (invoiceType === 'ACCPAY') return -Math.round(Math.abs(amount) * 100);
  if (invoiceType === 'ACCREC') return Math.round(Math.abs(amount) * 100);
  return null;
}

export function normalizeXeroLedger(input: { bankTransactions?: Row[]; payments?: Row[]; bankTransfers?: Row[] }): LedgerMovement[] {
  const movements = new Map<string, LedgerMovement>();

  for (const item of input.bankTransactions ?? []) {
    const objectId = id(item.BankTransactionID);
    const bankAccountId = id(item.BankAccount?.AccountID);
    const postedAt = xeroDate(item.Date, item.DateString) ?? '';
    const amountMinor = signedBankTransactionAmount(item);
    if (!objectId || !bankAccountId || !postedAt || amountMinor === null || item.Status === 'DELETED') continue;
    const key = `bank_transaction:${objectId}`;
    movements.set(key, {
      key, kind: 'bank_transaction', objectIds: [objectId], bankAccountId, amountMinor, postedAt,
      isReconciled: Boolean(item.IsReconciled), status: String(item.Status ?? ''),
      contactName: String(item.Contact?.Name ?? ''), reference: String(item.Reference ?? ''),
      objects: [{ objectType: 'bank_transaction', objectRole: 'primary', xeroObjectId: objectId, xeroStatus: String(item.Status ?? 'AUTHORISED'), isReconciled: Boolean(item.IsReconciled), correlationChannels: ['local_only'], observedPayload: item }]
    });
  }

  for (const item of input.payments ?? []) {
    const objectId = id(item.PaymentID);
    const invoiceId = id(item.Invoice?.InvoiceID);
    const bankAccountId = id(item.Account?.AccountID);
    const postedAt = xeroDate(item.Date, item.DateString) ?? '';
    const amountMinor = signedPaymentAmount(item);
    const kind = item.Invoice?.Type === 'ACCPAY' ? 'bill' : item.Invoice?.Type === 'ACCREC' ? 'invoice' : null;
    if (!objectId || !invoiceId || !bankAccountId || !postedAt || amountMinor === null || !kind || item.Status === 'DELETED') continue;
    const key = `payment:${objectId}`;
    movements.set(key, {
      key, kind, objectIds: [objectId], bankAccountId, amountMinor, postedAt,
      isReconciled: Boolean(item.IsReconciled), status: String(item.Status ?? ''),
      contactName: String(item.Invoice?.Contact?.Name ?? ''), reference: String(item.Reference ?? item.Invoice?.InvoiceNumber ?? ''),
      objects: [{ objectType: 'payment', objectRole: 'payment', xeroObjectId: objectId, xeroStatus: String(item.Status ?? 'AUTHORISED'), isReconciled: Boolean(item.IsReconciled), correlationChannels: ['local_only'], observedPayload: item }]
    });
  }

  // Transfers expose the underlying bank-transaction IDs and a reconciliation
  // flag for each account side. Use those transaction IDs so each imported line
  // remains independently observable through the normal BankTransactions path.
  for (const item of input.bankTransfers ?? []) {
    if (item.Status === 'DELETED') continue;
    const postedAt = xeroDate(item.Date, item.DateString) ?? '';
    const amountMinor = Math.round(Math.abs(Number(item.Amount)) * 100);
    if (!postedAt || !Number.isFinite(amountMinor) || amountMinor === 0) continue;
    const sides = [
      { objectId: id(item.FromBankTransactionID), bankAccountId: id(item.FromBankAccount?.AccountID), amountMinor: -amountMinor, reconciled: Boolean(item.FromIsReconciled) },
      { objectId: id(item.ToBankTransactionID), bankAccountId: id(item.ToBankAccount?.AccountID), amountMinor, reconciled: Boolean(item.ToIsReconciled) }
    ];
    for (const side of sides) {
      if (!side.objectId || !side.bankAccountId) continue;
      const key = `bank_transaction:${side.objectId}`;
      if (movements.has(key)) continue;
      const payload = { BankTransactionID: side.objectId, BankTransferID: item.BankTransferID, BankAccount: { AccountID: side.bankAccountId }, Date: item.Date, DateString: item.DateString, Total: Number(item.Amount), Type: side.amountMinor < 0 ? 'SPEND' : 'RECEIVE', Status: item.Status ?? 'AUTHORISED', IsReconciled: side.reconciled };
      movements.set(key, {
        key, kind: 'bank_transaction', objectIds: [side.objectId], bankAccountId: side.bankAccountId,
        amountMinor: side.amountMinor, postedAt, isReconciled: side.reconciled, status: String(item.Status ?? 'AUTHORISED'),
        contactName: '', reference: String(item.Reference ?? ''),
        objects: [{ objectType: 'bank_transaction', objectRole: 'primary', xeroObjectId: side.objectId, xeroStatus: String(item.Status ?? 'AUTHORISED'), isReconciled: side.reconciled, correlationChannels: ['local_only'], observedPayload: payload }]
      });
    }
  }

  return [...movements.values()];
}

function daysApart(left: string, right: string): number {
  return Math.abs(Date.parse(`${left}T12:00:00Z`) - Date.parse(`${right}T12:00:00Z`)) / 86_400_000;
}

function sameAccountAndAmount(line: LedgerLine, movement: LedgerMovement): boolean {
  return line.xeroBankAccountId === movement.bankAccountId && line.amountMinor === movement.amountMinor;
}

export function classifyReconciledLedger(
  allLines: LedgerLine[],
  requestedLineIds: Set<string>,
  movements: LedgerMovement[],
  mappedObjectIds: Set<string>,
  nearDateDays = 7
): LedgerClassification[] {
  const reconciled = movements.filter(movement => movement.isReconciled);
  const isAvailable = (movement: LedgerMovement) => !movement.objectIds.some(objectId => mappedObjectIds.has(objectId));
  const exactForLine = new Map<string, LedgerMovement[]>();
  for (const line of allLines) exactForLine.set(line.id, reconciled.filter(movement => isAvailable(movement) && sameAccountAndAmount(line, movement) && line.postedAt === movement.postedAt));

  const exactLineCount = new Map<string, number>();
  for (const candidates of exactForLine.values()) for (const candidate of candidates) exactLineCount.set(candidate.key, (exactLineCount.get(candidate.key) ?? 0) + 1);

  return allLines.filter(line => requestedLineIds.has(line.id)).map(line => {
    const occupiedExact = reconciled.filter(movement => !isAvailable(movement) && sameAccountAndAmount(line, movement) && line.postedAt === movement.postedAt);
    const exact = exactForLine.get(line.id) ?? [];
    if (exact.length === 1 && exactLineCount.get(exact[0].key) === 1 && occupiedExact.length === 0) return { outcome: 'reconciled', lineId: line.id, movement: exact[0] };
    if (exact.length > 0 || occupiedExact.length > 0) return { outcome: 'ambiguous', lineId: line.id, candidates: [...exact, ...occupiedExact], reason: exact.length + occupiedExact.length > 1 ? 'More than one reconciled Xero movement has the same bank account, date and amount.' : 'The matching reconciled Xero movement could also belong to another imported statement line or is already linked.' };
    const near = reconciled.filter(movement => sameAccountAndAmount(line, movement) && daysApart(line.postedAt, movement.postedAt) <= nearDateDays);
    if (near.length > 0) return { outcome: 'ambiguous', lineId: line.id, candidates: near, reason: 'A reconciled Xero movement has the same account and amount on a nearby date, so creating another record could duplicate it.' };
    return { outcome: 'unmatched', lineId: line.id };
  });
}
