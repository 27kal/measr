import type { StatementLine } from './types';

export interface CsvImportResult {
  lines: StatementLine[];
  errors: Array<{ row: number; message: string }>;
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

function parseDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const uk = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!uk) return null;
  const [, day, month, year] = uk;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

export function importStatementCsv(
  text: string,
  context: { companyId: string; bankAccountId: string; existingDedupeKeys?: Set<string> }
): CsvImportResult {
  const [headerRow, ...dataRows] = parseRows(text);
  if (!headerRow) return { lines: [], errors: [{ row: 1, message: 'CSV is empty' }] };
  const headers = headerRow.map(header => header.toLowerCase().replaceAll(' ', ''));
  const aliases = {
    date: ['date'],
    amount: ['amount', 'amount(gbp)'],
    description: ['description', 'notes', 'type', 'reference', 'counterparty'],
    payee: ['payee', 'counterparty'],
    reference: ['reference']
  } as const;
  const hasAny = (names: readonly string[]) => names.some(name => headers.includes(name));
  const missing = (['date', 'amount', 'description'] as const).filter(field => !hasAny(aliases[field]));
  if (missing.length) return { lines: [], errors: [{ row: 1, message: `Missing columns: ${missing.join(', ')}` }] };

  const valueOf = (row: string[], names: readonly string[]) => {
    for (const name of names) {
      const index = headers.indexOf(name);
      const value = index >= 0 ? row[index]?.trim() ?? '' : '';
      if (value) return value;
    }
    return '';
  };
  const occurrences = new Map<string, number>();
  const seen = new Set(context.existingDedupeKeys ?? []);
  const lines: StatementLine[] = [];
  const errors: CsvImportResult['errors'] = [];

  dataRows.forEach((row, rowIndex) => {
    const sourceRow = rowIndex + 2;
    const postedAt = parseDate(valueOf(row, aliases.date));
    const amount = Number(valueOf(row, aliases.amount).replaceAll(',', '').replace(/[£\s]/g, ''));
    const description = valueOf(row, aliases.description);
    if (!postedAt) errors.push({ row: sourceRow, message: 'Date must be DD/MM/YYYY or YYYY-MM-DD' });
    if (!Number.isFinite(amount) || amount === 0) errors.push({ row: sourceRow, message: 'Amount must be a non-zero number' });
    if (!description) errors.push({ row: sourceRow, message: 'Description is required' });
    if (!postedAt || !Number.isFinite(amount) || amount === 0 || !description) return;

    const payee = valueOf(row, aliases.payee);
    const reference = valueOf(row, aliases.reference);
    const amountMinor = Math.round(amount * 100);
    const signature = [context.bankAccountId, postedAt, amountMinor, payee.toLowerCase(), description.toLowerCase(), reference.toLowerCase()].join('|');
    const occurrence = (occurrences.get(signature) ?? 0) + 1;
    occurrences.set(signature, occurrence);
    const dedupeKey = hash(`${signature}|${occurrence}`);
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    lines.push({
      id: `line-${dedupeKey}`,
      companyId: context.companyId,
      bankAccountId: context.bankAccountId,
      postedAt,
      amountMinor,
      currency: 'GBP',
      payee,
      description,
      reference,
      status: 'new',
      statusVersion: 0,
      activeCandidateSetId: null,
      note: 'Imported and waiting for analysis.',
      dedupeKey
    });
  });
  return { lines, errors };
}
