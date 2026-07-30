// Pure planning and stitching for chunked tabular extraction. A statement too
// large for one model pass is split into deterministic line-range segments;
// each segment is extracted in its own worker run and persisted, and the
// stitched whole is validated by the same deterministic statement validator
// as a single-pass extraction. No Deno APIs: vitest imports this directly.

import type { StatementExtraction } from './statement-import-validation.ts';

export const SINGLE_PASS_MAX_ROWS = 120;
export const CHUNK_DATA_ROWS = 80;
export const MAX_CHUNKED_ROWS = 2500;
export const HEADER_CONTEXT_LINES = 3;

export interface StatementChunk {
  index: number;
  /** 1-based inclusive line numbers into the raw file text. */
  lineStart: number;
  lineEnd: number;
  dataRows: number;
}

export interface StatementChunkPlan {
  lines: string[];
  dataRowCount: number;
  chunks: StatementChunk[];
}

export function countDataRows(text: string): number {
  return text.split('\n').filter(line => line.trim().length > 0).length;
}

/**
 * Returns null when the statement fits one extraction pass. Chunk boundaries
 * partition the raw lines so segments never overlap and cover the whole file.
 */
export function planStatementChunks(text: string): StatementChunkPlan | null {
  const lines = text.split('\n');
  const dataRowCount = lines.filter(line => line.trim().length > 0).length;
  if (dataRowCount <= SINGLE_PASS_MAX_ROWS) return null;

  const chunks: StatementChunk[] = [];
  let start = 1;
  let dataRows = 0;
  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
    if (lines[lineNumber - 1].trim().length > 0) dataRows += 1;
    if (dataRows === CHUNK_DATA_ROWS && lineNumber < lines.length) {
      chunks.push({ index: chunks.length, lineStart: start, lineEnd: lineNumber, dataRows });
      start = lineNumber + 1;
      dataRows = 0;
    }
  }
  if (start <= lines.length && dataRows > 0) {
    chunks.push({ index: chunks.length, lineStart: start, lineEnd: lines.length, dataRows });
  } else if (chunks.length > 0) {
    chunks[chunks.length - 1] = { ...chunks[chunks.length - 1], lineEnd: lines.length };
  }
  return { lines, dataRowCount, chunks };
}

/** The file's opening lines, shown to every segment as header context. */
export function chunkHeaderContext(plan: StatementChunkPlan): string {
  return plan.lines.slice(0, HEADER_CONTEXT_LINES).map((line, index) => `L${index + 1}: ${line}`).join('\n');
}

/** The segment body with absolute line numbers, so source locators stay unique file-wide. */
export function chunkBody(plan: StatementChunkPlan, chunk: StatementChunk): string {
  const body: string[] = [];
  for (let lineNumber = chunk.lineStart; lineNumber <= chunk.lineEnd; lineNumber += 1) {
    body.push(`L${lineNumber}: ${plan.lines[lineNumber - 1]}`);
  }
  return body.join('\n');
}

function firstNonEmpty(values: string[]): string {
  return values.find(value => value.trim().length > 0) ?? '';
}

function validIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Combines per-segment extractions (in chunk order) into one statement
 * extraction. Transactions keep segment display order; the statement period
 * covers every extracted transaction; whole-statement control totals are
 * propagated only when every segment reported them, otherwise they stay null
 * and the deterministic validator treats the result as structural proof.
 */
export function stitchStatementChunks(parts: StatementExtraction[]): StatementExtraction {
  if (parts.length === 0) throw new Error('No extraction segments to stitch');
  const transactions = parts.flatMap(part => part.transactions);
  const dates = [
    ...transactions.map(transaction => transaction.postedAt),
    ...parts.flatMap(part => [part.periodStart, part.periodEnd])
  ].filter(validIsoDate).sort();
  const allMoneyIn = parts.every(part => part.moneyInMinor !== null);
  const allMoneyOut = parts.every(part => part.moneyOutMinor !== null);
  const notes = [...new Set(parts.flatMap(part => part.notes))];
  return {
    institution: firstNonEmpty(parts.map(part => part.institution)),
    accountName: firstNonEmpty(parts.map(part => part.accountName)),
    accountIdentifier: firstNonEmpty(parts.map(part => part.accountIdentifier)),
    currency: firstNonEmpty(parts.map(part => part.currency)) || 'GBP',
    periodStart: dates[0] ?? '',
    periodEnd: dates.at(-1) ?? '',
    openingBalanceMinor: parts[0].openingBalanceMinor,
    closingBalanceMinor: parts.at(-1)!.closingBalanceMinor,
    moneyInMinor: allMoneyIn ? parts.reduce((sum, part) => sum + (part.moneyInMinor ?? 0), 0) : null,
    moneyOutMinor: allMoneyOut ? parts.reduce((sum, part) => sum + (part.moneyOutMinor ?? 0), 0) : null,
    transactionOrder: parts[0].transactionOrder,
    transactions,
    notes: [...notes, `Stitched from ${parts.length} extraction segments.`]
  };
}
