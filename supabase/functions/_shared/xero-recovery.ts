type XeroRecord = Record<string, unknown>;
type XeroEntity = 'bank_transaction' | 'bill' | 'invoice' | 'transfer';

const collections: Record<XeroEntity, string> = {
  bank_transaction: 'BankTransactions',
  bill: 'Invoices',
  invoice: 'Invoices',
  transfer: 'BankTransfers'
};

export function recoveryLookupPath(kind: XeroEntity, correlationToken: string): string {
  if (!/^WB-[A-Z0-9-]+$/.test(correlationToken)) throw new Error('Invalid Workbench correlation token');
  const where = encodeURIComponent(`Reference==\"${correlationToken}\"`);
  const createdBy = kind === 'bill' || kind === 'invoice' ? '&createdByMyApp=true' : '';
  return `${collections[kind]}?where=${where}${createdBy}`;
}

export function recoveryMatches(kind: XeroEntity, payload: XeroRecord): XeroRecord[] {
  const collection = payload[collections[kind]];
  return Array.isArray(collection) ? collection as XeroRecord[] : [];
}

export function oneRecoveryMatch(matches: XeroRecord[]): XeroRecord | null {
  const live = matches.filter(match => match.Status !== 'DELETED' && match.Status !== 'VOIDED');
  if (live.length > 1) throw new Error('More than one live Xero object has this Workbench marker; recovery is ambiguous');
  return live[0] ?? null;
}

export async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
