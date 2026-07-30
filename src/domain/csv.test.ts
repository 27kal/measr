import { describe, expect, it } from 'vitest';
import { importStatementCsv } from './csv';

const csv = `Date,Amount,Payee,Description,Reference
21/07/2026,-12.34,Shop,"Office, paper",ABC
21/07/2026,-12.34,Shop,"Office, paper",ABC
`;

describe('CSV statement ingestion', () => {
  it('keeps distinct identical statement occurrences but deduplicates a replay', () => {
    const first = importStatementCsv(csv, { companyId: 'company-1', bankAccountId: 'bank-1' });
    expect(first.errors).toEqual([]);
    expect(first.lines).toHaveLength(2);
    expect(first.lines[0].dedupeKey).not.toBe(first.lines[1].dedupeKey);
    const replay = importStatementCsv(csv, {
      companyId: 'company-1',
      bankAccountId: 'bank-1',
      existingDedupeKeys: new Set(first.lines.map(line => line.dedupeKey))
    });
    expect(replay.lines).toHaveLength(0);
  });

  it('rejects an invalid row before a canonical bookkeeping line exists', () => {
    const result = importStatementCsv('Date,Amount,Description\nnot-a-date,0,', { companyId: 'company-1', bankAccountId: 'bank-1' });
    expect(result.lines).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('maps a Starling business statement without losing its counterparty or reference', () => {
    const starling = `Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category,Notes
01/07/2026,Joiin Subscription,JOIIN SUBSCRIPTION,CARD SUBSCRIPTION,-98.17,22092.73,ADMIN,
`;
    const result = importStatementCsv(starling, { companyId: 'company-1', bankAccountId: 'bank-1' });
    expect(result.errors).toEqual([]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      postedAt: '2026-07-01',
      payee: 'Joiin Subscription',
      reference: 'JOIIN SUBSCRIPTION',
      description: 'CARD SUBSCRIPTION',
      amountMinor: -9817
    });
  });
});
