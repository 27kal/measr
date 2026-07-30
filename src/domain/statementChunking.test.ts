import { describe, expect, it } from 'vitest';
import { chunkBody, chunkHeaderContext, planStatementChunks, stitchStatementChunks, CHUNK_DATA_ROWS, SINGLE_PASS_MAX_ROWS } from '../../supabase/functions/_shared/statement-chunking';
import { validateStatementExtraction, type StatementExtraction } from '../../supabase/functions/_shared/statement-import-validation';

function csvOf(rows: number): string {
  const lines = ['Date,Description,Amount'];
  for (let index = 0; index < rows; index += 1) {
    lines.push(`2026-06-${String((index % 28) + 1).padStart(2, '0')},Coffee ${index},-4.50`);
  }
  return lines.join('\n');
}

function segment(overrides: Partial<StatementExtraction>): StatementExtraction {
  return {
    institution: '', accountName: '', accountIdentifier: '', currency: 'GBP',
    periodStart: '', periodEnd: '', openingBalanceMinor: null, closingBalanceMinor: null,
    moneyInMinor: null, moneyOutMinor: null, transactionOrder: 'ascending',
    transactions: [], notes: [], ...overrides
  };
}

describe('statement chunk planning', () => {
  it('returns null for statements that fit one pass', () => {
    expect(planStatementChunks(csvOf(SINGLE_PASS_MAX_ROWS - 1))).toBeNull();
  });

  it('partitions every line exactly once', () => {
    const text = csvOf(481);
    const plan = planStatementChunks(text)!;
    expect(plan.dataRowCount).toBe(482); // header + 481 rows
    expect(plan.chunks.length).toBe(Math.ceil(482 / CHUNK_DATA_ROWS));
    // Contiguous, non-overlapping, covering the file.
    expect(plan.chunks[0].lineStart).toBe(1);
    for (let index = 1; index < plan.chunks.length; index += 1) {
      expect(plan.chunks[index].lineStart).toBe(plan.chunks[index - 1].lineEnd + 1);
    }
    expect(plan.chunks.at(-1)!.lineEnd).toBe(plan.lines.length);
  });

  it('numbers segment lines with absolute file positions', () => {
    const plan = planStatementChunks(csvOf(200))!;
    const second = plan.chunks[1];
    const body = chunkBody(plan, second);
    expect(body.startsWith(`L${second.lineStart}: `)).toBe(true);
    expect(chunkHeaderContext(plan)).toContain('L1: Date,Description,Amount');
  });
});

describe('statement chunk stitching', () => {
  it('concatenates transactions and derives the covering period', () => {
    const stitched = stitchStatementChunks([
      segment({ institution: 'Amex', periodStart: '2026-06-01', periodEnd: '2026-06-15', transactions: [
        { postedAt: '2026-06-02', amountMinor: -450, payee: 'Coffee', description: 'Coffee', reference: '', balanceAfterMinor: null, sourceLocator: 'CSV row 2' }
      ] }),
      segment({ periodStart: '2026-06-16', periodEnd: '2026-06-30', transactions: [
        { postedAt: '2026-06-20', amountMinor: 1000, payee: 'Refund', description: 'Refund', reference: '', balanceAfterMinor: null, sourceLocator: 'CSV row 90' }
      ] })
    ]);
    expect(stitched.institution).toBe('Amex');
    expect(stitched.transactions.length).toBe(2);
    expect(stitched.periodStart).toBe('2026-06-01');
    expect(stitched.periodEnd).toBe('2026-06-30');
    expect(stitched.moneyInMinor).toBeNull();
    const validation = validateStatementExtraction(stitched);
    expect(validation.valid).toBe(true);
  });

  it('keeps whole-statement totals only when every segment reported them', () => {
    const withTotals = stitchStatementChunks([
      segment({ moneyInMinor: 100, moneyOutMinor: 50 }),
      segment({ moneyInMinor: 200, moneyOutMinor: 0 })
    ]);
    expect(withTotals.moneyInMinor).toBe(300);
    const partial = stitchStatementChunks([
      segment({ moneyInMinor: 100 }),
      segment({ moneyInMinor: null })
    ]);
    expect(partial.moneyInMinor).toBeNull();
  });

  it('takes opening balance from the first segment and closing from the last', () => {
    const stitched = stitchStatementChunks([
      segment({ openingBalanceMinor: 5000, closingBalanceMinor: null }),
      segment({ openingBalanceMinor: null, closingBalanceMinor: 4000 })
    ]);
    expect(stitched.openingBalanceMinor).toBe(5000);
    expect(stitched.closingBalanceMinor).toBe(4000);
  });

  it('flags duplicated source locators across segments through validation', () => {
    const stitched = stitchStatementChunks([
      segment({ transactions: [{ postedAt: '2026-06-02', amountMinor: -450, payee: '', description: 'One', reference: '', balanceAfterMinor: null, sourceLocator: 'CSV row 2' }] }),
      segment({ transactions: [{ postedAt: '2026-06-03', amountMinor: -450, payee: '', description: 'Two', reference: '', balanceAfterMinor: null, sourceLocator: 'CSV row 2' }] })
    ]);
    const validation = validateStatementExtraction(stitched);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(' ')).toContain('extracted more than once');
  });
});
