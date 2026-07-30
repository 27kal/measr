import { artifactPaths, readJson, writeJson } from './agent-artifacts.ts';
import { freshXeroAccessToken, xeroRequest } from './xero.ts';
import { normalizeXeroLedger } from './xero-ledger.ts';

type Service = Parameters<typeof freshXeroAccessToken>[0] & {
  from: (table: string) => any;
  storage: any;
};

type Row = Record<string, any>;
export interface XeroAnalysisSnapshot {
  schemaVersion: 1 | 2;
  companyId: string;
  organisation: string;
  createdAt: string;
  expiresAt: string;
  referenceData: Record<string, unknown>;
  historySummary: Record<string, unknown>;
  bankTransactions: Row[];
  invoices: Row[];
  bankTransfers: Row[];
}
export type XeroBankLedger = {
  searchedAt: string;
  fromDate: string;
  toDate: string;
  movements: ReturnType<typeof normalizeXeroLedger>;
  bankTransactions: Row[];
  payments: Row[];
  bankTransfers: Row[];
};
const INSPECTABLE_ATTACHMENT_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const MAX_INSPECTABLE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_INSPECTABLE_ATTACHMENTS = 3;
const MAX_INSPECTABLE_TOTAL_BYTES = 20 * 1024 * 1024;

async function connection(service: Service, companyId: string) {
  const { data, error } = await service.from('xero_connections').select('tenant_id,tenant_name').eq('company_id', companyId).is('disconnected_at', null).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Xero is not connected');
  return data as { tenant_id: string; tenant_name: string };
}

export async function getXeroReferenceData(service: Service, companyId: string) {
  const connected = await connection(service, companyId);
  const token = await freshXeroAccessToken(service, companyId);
  const [accountsPayload, contacts, taxRatesPayload] = await Promise.all([
    xeroRequest(token, connected.tenant_id, 'Accounts'),
    pagedXeroRows(token, connected.tenant_id, 'Contacts?summaryOnly=true', 'Contacts', 10),
    xeroRequest(token, connected.tenant_id, 'TaxRates')
  ]);
  const accounts = (accountsPayload.Accounts ?? []).filter((item: Row) => item.Status === 'ACTIVE');
  return {
    organisation: connected.tenant_name,
    bankAccounts: accounts.filter((item: Row) => item.Type === 'BANK').map((item: Row) => ({ id: item.AccountID, code: item.Code ?? '', name: item.Name, currency: item.CurrencyCode })),
    postingAccounts: accounts.filter((item: Row) => item.Type !== 'BANK' && item.Code).map((item: Row) => ({ code: item.Code, name: item.Name, class: item.Class, type: item.Type, taxType: item.TaxType ?? '' })),
    contacts: contacts.filter((item: Row) => item.ContactStatus === 'ACTIVE').map((item: Row) => ({ id: item.ContactID, name: item.Name })),
    taxRates: (taxRatesPayload.TaxRates ?? []).filter((item: Row) => item.Status === 'ACTIVE').map((item: Row) => ({ taxType: item.TaxType, name: item.Name, effectiveRate: item.EffectiveRate }))
  };
}

function isoDate(value: unknown): string {
  if (typeof value !== 'string') return '';
  const direct = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (direct) return direct;
  const milliseconds = value.match(/\/Date\((\d+)/)?.[1];
  return milliseconds ? new Date(Number(milliseconds)).toISOString().slice(0, 10) : '';
}

function daysApart(left: string, right: string): number {
  const leftTime = Date.parse(`${left}T12:00:00Z`);
  const rightTime = Date.parse(`${right}T12:00:00Z`);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) ? Math.abs(leftTime - rightTime) / 86_400_000 : 9999;
}

function normalized(value: unknown): string {
  return String(value ?? '').toLocaleLowerCase('en-GB').replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreCandidate(input: { amountMinor: number; postedAt: string; payee: string }, candidate: { amount: number; date: string; contact: string }) {
  const reasons: string[] = [];
  let score = 0;
  if (Math.round(Math.abs(candidate.amount) * 100) === Math.abs(input.amountMinor)) { score += 0.6; reasons.push('exact amount'); }
  const days = daysApart(input.postedAt, candidate.date);
  if (days <= 7) { score += 0.2; reasons.push(`${days}-day date distance`); }
  else if (days <= 60) { score += 0.1; reasons.push(`${Math.round(days)}-day date distance`); }
  const payee = normalized(input.payee);
  const contact = normalized(candidate.contact);
  if (payee && contact && (payee.includes(contact) || contact.includes(payee))) { score += 0.2; reasons.push('contact/payee match'); }
  return { score: Math.min(1, score), reasons };
}

async function pagedXeroRows(token: string, tenantId: string, endpoint: string, collection: string, maximumPages = 5): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const payload = await xeroRequest(token, tenantId, `${endpoint}${separator}page=${page}`);
    const batch = payload[collection] ?? [];
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

function dateWhere(fromDate: string, toDate: string): string {
  const parts = (value: string) => value.split('-').map(Number);
  const [fromYear, fromMonth, fromDay] = parts(fromDate);
  const [toYear, toMonth, toDay] = parts(toDate);
  return encodeURIComponent(`Date>=DateTime(${fromYear},${fromMonth},${fromDay})&&Date<=DateTime(${toYear},${toMonth},${toDay})`);
}

export function currentInvoiceCandidateEndpoint(input: { amountMinor: number }): string {
  const expectedType = input.amountMinor < 0 ? 'ACCPAY' : 'ACCREC';
  const amountDue = (Math.abs(input.amountMinor) / 100).toFixed(2);
  const where = encodeURIComponent(`Status=="AUTHORISED"&&Type=="${expectedType}"&&AmountDue==${amountDue}`);
  return `Invoices?where=${where}&order=Date DESC&summaryOnly=true`;
}

export async function getXeroBankLedger(service: Service, companyId: string, fromDate: string, toDate: string) {
  const connected = await connection(service, companyId);
  const token = await freshXeroAccessToken(service, companyId);
  const where = dateWhere(fromDate, toDate);
  const [bankTransactions, payments, bankTransfers] = await Promise.all([
    pagedXeroRows(token, connected.tenant_id, `BankTransactions?where=${where}`, 'BankTransactions', 10),
    pagedXeroRows(token, connected.tenant_id, `Payments?where=${where}`, 'Payments', 10),
    pagedXeroRows(token, connected.tenant_id, `BankTransfers?where=${where}`, 'BankTransfers', 10)
  ]);
  return {
    searchedAt: new Date().toISOString(), fromDate, toDate,
    movements: normalizeXeroLedger({ bankTransactions, payments, bankTransfers }),
    bankTransactions, payments, bankTransfers
  };
}

export async function findCurrentXeroCandidates(service: Service, companyId: string, input: { amountMinor: number; postedAt: string; payee: string }) {
  const connected = await connection(service, companyId);
  const token = await freshXeroAccessToken(service, companyId);
  const authorised = encodeURIComponent('Status=="AUTHORISED"');
  const [bankTransactions, invoices, bankTransfers] = await Promise.all([
    pagedXeroRows(token, connected.tenant_id, `BankTransactions?where=${authorised}`, 'BankTransactions'),
    pagedXeroRows(token, connected.tenant_id, currentInvoiceCandidateEndpoint(input), 'Invoices'),
    pagedXeroRows(token, connected.tenant_id, 'BankTransfers', 'BankTransfers', 3)
  ]);
  const candidates: Array<Record<string, unknown> & { score: number; matchReasons: string[] }> = [];

  for (const item of bankTransactions) {
    const expectedType = input.amountMinor < 0 ? 'SPEND' : 'RECEIVE';
    if (item.Type !== expectedType || item.IsReconciled) continue;
    const candidate = { amount: Number(item.Total ?? 0), date: isoDate(item.DateString ?? item.Date), contact: String(item.Contact?.Name ?? '') };
    const match = scoreCandidate(input, candidate);
    if (match.score < 0.6) continue;
    candidates.push({ entityType: 'bank_transaction', entityId: item.BankTransactionID, entityNumber: '', type: item.Type, status: item.Status, amount: candidate.amount, amountDue: candidate.amount, date: candidate.date, contactId: item.Contact?.ContactID ?? '', contactName: candidate.contact, reference: item.Reference ?? '', bankAccountId: item.BankAccount?.AccountID ?? '', bankAccountName: item.BankAccount?.Name ?? '', isReconciled: Boolean(item.IsReconciled), hasAttachments: Boolean(item.HasAttachments), score: match.score, matchReasons: match.reasons });
  }

  for (const item of invoices) {
    const expectedType = input.amountMinor < 0 ? 'ACCPAY' : 'ACCREC';
    if (item.Type !== expectedType || item.Status !== 'AUTHORISED') continue;
    const amountDue = Number(item.AmountDue ?? item.Total ?? 0);
    const candidate = { amount: amountDue, date: isoDate(item.DateString ?? item.Date), contact: String(item.Contact?.Name ?? '') };
    const match = scoreCandidate(input, candidate);
    if (match.score < 0.6) continue;
    candidates.push({ entityType: 'invoice', entityId: item.InvoiceID, entityNumber: item.InvoiceNumber ?? '', type: item.Type, status: item.Status, amount: Number(item.Total ?? 0), amountDue, date: candidate.date, dueDate: isoDate(item.DueDateString ?? item.DueDate), contactId: item.Contact?.ContactID ?? '', contactName: candidate.contact, reference: item.Reference ?? '', hasAttachments: Boolean(item.HasAttachments), score: match.score, matchReasons: match.reasons });
  }

  for (const item of bankTransfers) {
    if (item.FromIsReconciled && item.ToIsReconciled) continue;
    const candidate = { amount: Number(item.Amount ?? 0), date: isoDate(item.DateString ?? item.Date), contact: '' };
    const match = scoreCandidate(input, candidate);
    if (match.score < 0.6) continue;
    candidates.push({ entityType: 'transfer', entityId: item.BankTransferID, entityNumber: '', status: item.Status ?? 'AUTHORISED', amount: candidate.amount, amountDue: candidate.amount, date: candidate.date, reference: item.Reference ?? '', fromBankAccountId: item.FromBankAccount?.AccountID ?? '', fromBankAccountName: item.FromBankAccount?.Name ?? '', toBankAccountId: item.ToBankAccount?.AccountID ?? '', toBankAccountName: item.ToBankAccount?.Name ?? '', fromIsReconciled: Boolean(item.FromIsReconciled), toIsReconciled: Boolean(item.ToIsReconciled), score: match.score, matchReasons: match.reasons });
  }

  return {
    searchedAt: new Date().toISOString(),
    statementLine: input,
    candidates: candidates.sort((left, right) => right.score - left.score).slice(0, 12)
  };
}

export function findXeroCandidatesInSnapshot(snapshot: XeroAnalysisSnapshot, input: { amountMinor: number; postedAt: string; payee: string }) {
  const candidates: Array<Record<string, unknown> & { score: number; matchReasons: string[] }> = [];
  for (const item of snapshot.bankTransactions) {
    const expectedType = input.amountMinor < 0 ? 'SPEND' : 'RECEIVE';
    if (item.Type !== expectedType || item.IsReconciled || item.Status !== 'AUTHORISED') continue;
    const candidate = { amount: Number(item.Total ?? 0), date: isoDate(item.DateString ?? item.Date), contact: String(item.Contact?.Name ?? '') };
    const match = scoreCandidate(input, candidate);
    if (match.score < 0.6) continue;
    candidates.push({ entityType: 'bank_transaction', entityId: item.BankTransactionID, entityNumber: '', type: item.Type, status: item.Status, amount: candidate.amount, amountDue: candidate.amount, date: candidate.date, contactId: item.Contact?.ContactID ?? '', contactName: candidate.contact, reference: item.Reference ?? '', bankAccountId: item.BankAccount?.AccountID ?? '', bankAccountName: item.BankAccount?.Name ?? '', isReconciled: Boolean(item.IsReconciled), hasAttachments: Boolean(item.HasAttachments), score: match.score, matchReasons: match.reasons });
  }
  for (const item of snapshot.invoices) {
    const expectedType = input.amountMinor < 0 ? 'ACCPAY' : 'ACCREC';
    if (item.Type !== expectedType || item.Status !== 'AUTHORISED') continue;
    const amountDue = Number(item.AmountDue ?? item.Total ?? 0);
    const candidate = { amount: amountDue, date: isoDate(item.DateString ?? item.Date), contact: String(item.Contact?.Name ?? '') };
    const match = scoreCandidate(input, candidate);
    if (match.score < 0.6) continue;
    candidates.push({ entityType: 'invoice', entityId: item.InvoiceID, entityNumber: item.InvoiceNumber ?? '', type: item.Type, status: item.Status, amount: Number(item.Total ?? 0), amountDue, date: candidate.date, dueDate: isoDate(item.DueDateString ?? item.DueDate), contactId: item.Contact?.ContactID ?? '', contactName: candidate.contact, reference: item.Reference ?? '', hasAttachments: Boolean(item.HasAttachments), score: match.score, matchReasons: match.reasons });
  }
  for (const item of snapshot.bankTransfers) {
    if (item.FromIsReconciled && item.ToIsReconciled) continue;
    const candidate = { amount: Number(item.Amount ?? 0), date: isoDate(item.DateString ?? item.Date), contact: '' };
    const match = scoreCandidate(input, candidate);
    if (match.score < 0.6) continue;
    candidates.push({ entityType: 'transfer', entityId: item.BankTransferID, entityNumber: '', status: item.Status ?? 'AUTHORISED', amount: candidate.amount, amountDue: candidate.amount, date: candidate.date, reference: item.Reference ?? '', fromBankAccountId: item.FromBankAccount?.AccountID ?? '', fromBankAccountName: item.FromBankAccount?.Name ?? '', toBankAccountId: item.ToBankAccount?.AccountID ?? '', toBankAccountName: item.ToBankAccount?.Name ?? '', fromIsReconciled: Boolean(item.FromIsReconciled), toIsReconciled: Boolean(item.ToIsReconciled), score: match.score, matchReasons: match.reasons });
  }
  return { searchedAt: snapshot.createdAt, snapshotExpiresAt: snapshot.expiresAt, statementLine: input, candidates: candidates.sort((left, right) => right.score - left.score).slice(0, 12) };
}

export async function createXeroAnalysisSnapshot(service: Service, companyId: string, ledger: XeroBankLedger): Promise<XeroAnalysisSnapshot> {
  const connected = await connection(service, companyId);
  const token = await freshXeroAccessToken(service, companyId);
  const authorised = encodeURIComponent('Status=="AUTHORISED"');
  const [accountsPayload, contacts, taxRatesPayload, invoices] = await Promise.all([
    xeroRequest(token, connected.tenant_id, 'Accounts'),
    pagedXeroRows(token, connected.tenant_id, 'Contacts?summaryOnly=true', 'Contacts', 10),
    xeroRequest(token, connected.tenant_id, 'TaxRates'),
    pagedXeroRows(token, connected.tenant_id, `Invoices?where=${authorised}&summaryOnly=true`, 'Invoices', 10)
  ]);
  const historySummary = await getXeroHistorySummary(service, companyId);
  const accounts = (accountsPayload.Accounts ?? []).filter((item: Row) => item.Status === 'ACTIVE');
  const createdAt = new Date();
  return {
    schemaVersion: 2,
    companyId,
    organisation: connected.tenant_name,
    createdAt: createdAt.toISOString(),
    // A batch snapshot is immutable. Keep it valid for a full large import so
    // Xero reads scale with result pages, not with the number of statement lines.
    expiresAt: new Date(createdAt.getTime() + 6 * 60 * 60_000).toISOString(),
    referenceData: {
      organisation: connected.tenant_name,
      bankAccounts: accounts.filter((item: Row) => item.Type === 'BANK').map((item: Row) => ({ id: item.AccountID, code: item.Code ?? '', name: item.Name, currency: item.CurrencyCode })),
      postingAccounts: accounts.filter((item: Row) => item.Type !== 'BANK' && item.Code).map((item: Row) => ({ code: item.Code, name: item.Name, class: item.Class, type: item.Type, taxType: item.TaxType ?? '' })),
      contacts: contacts.filter((item: Row) => item.ContactStatus === 'ACTIVE').map((item: Row) => ({ id: item.ContactID, name: item.Name })),
      taxRates: (taxRatesPayload.TaxRates ?? []).filter((item: Row) => item.Status === 'ACTIVE').map((item: Row) => ({ taxType: item.TaxType, name: item.Name, effectiveRate: item.EffectiveRate }))
    },
    historySummary: historySummary as Record<string, unknown>,
    bankTransactions: ledger.bankTransactions,
    invoices,
    bankTransfers: ledger.bankTransfers
  };
}

export async function getCurrentXeroEntity(service: Service, companyId: string, entityType: 'invoice' | 'bank_transaction', entityId: string): Promise<Row> {
  const connected = await connection(service, companyId);
  const token = await freshXeroAccessToken(service, companyId);
  const endpoint = entityType === 'invoice' ? 'Invoices' : 'BankTransactions';
  const payload = await xeroRequest(token, connected.tenant_id, `${endpoint}/${encodeURIComponent(entityId)}`);
  const entity = payload[endpoint]?.[0];
  if (!entity) throw new Error('The selected Xero entity was not returned');
  return entity;
}

export function selectInspectableXeroAttachments(attachments: Row[]): Row[] {
  let totalBytes = 0;
  return [...attachments]
    .filter(attachment => INSPECTABLE_ATTACHMENT_TYPES.has(String(attachment.MimeType ?? '').toLowerCase()))
    .filter(attachment => Number(attachment.ContentLength ?? 0) > 0 && Number(attachment.ContentLength) <= MAX_INSPECTABLE_ATTACHMENT_BYTES)
    .sort((left, right) => Number(String(right.MimeType).toLowerCase() === 'application/pdf') - Number(String(left.MimeType).toLowerCase() === 'application/pdf'))
    .filter(attachment => {
      const size = Number(attachment.ContentLength);
      if (totalBytes + size > MAX_INSPECTABLE_TOTAL_BYTES) return false;
      totalBytes += size;
      return true;
    })
    .slice(0, MAX_INSPECTABLE_ATTACHMENTS);
}

export async function fetchInspectableXeroAttachments(service: Service, companyId: string, entityType: 'invoice' | 'bank_transaction', entityId: string): Promise<Array<{ attachmentId: string; filename: string; mimeType: string; byteSize: number; bytes: Uint8Array }>> {
  const connected = await connection(service, companyId);
  const token = await freshXeroAccessToken(service, companyId);
  const endpoint = entityType === 'invoice' ? 'Invoices' : 'BankTransactions';
  const list = await xeroRequest(token, connected.tenant_id, `${endpoint}/${encodeURIComponent(entityId)}/Attachments`);
  const selected = selectInspectableXeroAttachments(Array.isArray(list.Attachments) ? list.Attachments : []);
  const files: Array<{ attachmentId: string; filename: string; mimeType: string; byteSize: number; bytes: Uint8Array }> = [];
  for (const attachment of selected) {
    const filename = String(attachment.FileName ?? 'attachment');
    const mimeType = String(attachment.MimeType).toLowerCase();
    const response = await fetch(`https://api.xero.com/api.xro/2.0/${endpoint}/${encodeURIComponent(entityId)}/Attachments/${encodeURIComponent(filename)}`, {
      headers: { authorization: `Bearer ${token}`, 'xero-tenant-id': connected.tenant_id, accept: mimeType }
    });
    if (!response.ok) throw new Error(`Xero attachment ${filename} failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_INSPECTABLE_ATTACHMENT_BYTES) throw new Error(`Xero attachment ${filename} has an invalid size`);
    files.push({ attachmentId: String(attachment.AttachmentID ?? ''), filename, mimeType, byteSize: bytes.length, bytes });
  }
  return files;
}

function increment(map: Map<string, { count: number; total: number }>, key: string, amount: number) {
  const current = map.get(key) ?? { count: 0, total: 0 };
  current.count += 1;
  current.total += amount;
  map.set(key, current);
}

function ranked(map: Map<string, { count: number; total: number }>) {
  return [...map].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.count - a.count).slice(0, 80);
}

export async function refreshXeroHistorySummary(service: Service, companyId: string) {
  const connected = await connection(service, companyId);
  const token = await freshXeroAccessToken(service, companyId);
  const since = new Date();
  since.setUTCFullYear(since.getUTCFullYear() - 1);
  const where = encodeURIComponent(`Date>=DateTime(${since.getUTCFullYear()},${since.getUTCMonth() + 1},${since.getUTCDate()})`);
  const bankTransactions: Row[] = [];
  const invoices: Row[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const payload = await xeroRequest(token, connected.tenant_id, `BankTransactions?where=${where}&page=${page}`);
    const rows = payload.BankTransactions ?? [];
    bankTransactions.push(...rows);
    if (rows.length < 100) break;
  }
  for (let page = 1; page <= 5; page += 1) {
    const payload = await xeroRequest(token, connected.tenant_id, `Invoices?where=${where}&page=${page}`);
    const rows = payload.Invoices ?? [];
    invoices.push(...rows);
    if (rows.length < 100) break;
  }
  const patterns = new Map<string, { count: number; total: number }>();
  for (const transaction of bankTransactions) {
    for (const line of transaction.LineItems ?? []) increment(patterns, [transaction.Type, transaction.Contact?.Name ?? 'unknown', line.AccountCode ?? 'unknown', line.TaxType ?? 'unknown'].join(' | '), Number(line.LineAmount ?? transaction.Total ?? 0));
  }
  for (const invoice of invoices) {
    for (const line of invoice.LineItems ?? []) increment(patterns, [invoice.Type, invoice.Contact?.Name ?? 'unknown', line.AccountCode ?? 'unknown', line.TaxType ?? 'unknown'].join(' | '), Number(line.LineAmount ?? invoice.Total ?? 0));
  }
  const summary = {
    generatedAt: new Date().toISOString(), organisation: connected.tenant_name, since: since.toISOString().slice(0, 10),
    counts: { bankTransactions: bankTransactions.length, invoices: invoices.length },
    patterns: ranked(patterns),
    recentExamples: [
      ...bankTransactions.slice(0, 60).map(item => ({ kind: 'bank_transaction', id: item.BankTransactionID, type: item.Type, date: item.DateString ?? item.Date, contact: item.Contact?.Name ?? '', reference: item.Reference ?? '', total: item.Total, status: item.Status, isReconciled: item.IsReconciled, lines: (item.LineItems ?? []).map((line: Row) => ({ description: line.Description, accountCode: line.AccountCode, taxType: line.TaxType, lineAmount: line.LineAmount })) })),
      ...invoices.slice(0, 60).map(item => ({ kind: item.Type === 'ACCPAY' ? 'bill' : 'invoice', id: item.InvoiceID, type: item.Type, date: item.DateString ?? item.Date, contact: item.Contact?.Name ?? '', reference: item.Reference ?? '', total: item.Total, status: item.Status, lines: (item.LineItems ?? []).map((line: Row) => ({ description: line.Description, accountCode: line.AccountCode, taxType: line.TaxType, lineAmount: line.LineAmount })) }))
    ]
  };
  await writeJson(service as any, artifactPaths.historySummary(companyId), summary);
  return summary;
}

export async function getXeroHistorySummary(service: Service, companyId: string) {
  return await readJson(service as any, artifactPaths.historySummary(companyId)) ?? await refreshXeroHistorySummary(service, companyId);
}
