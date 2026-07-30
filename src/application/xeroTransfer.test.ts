import { describe, expect, it } from 'vitest';
import { transferShape } from '../../supabase/functions/_shared/xero-transfer';

const source = { id: 'source', bank_account_id: 'current', amount_minor: -6789, posted_at: '2026-07-21' };
const destination = { id: 'destination', bank_account_id: 'savings', amount_minor: 6789, posted_at: '2026-07-21' };

describe('Xero transfer shape', () => {
  it('derives source and destination from signed amounts, independent of query order', () => {
    expect(transferShape([destination, source])).toEqual({ source, destination });
  });

  it('rejects mismatched amounts, dates and bank accounts', () => {
    expect(() => transferShape([source, { ...destination, amount_minor: 6700 }])).toThrow('equal and opposite');
    expect(() => transferShape([source, { ...destination, posted_at: '2026-07-22' }])).toThrow('same posting date');
    expect(() => transferShape([source, { ...destination, bank_account_id: 'current' }])).toThrow('different bank accounts');
  });
});
