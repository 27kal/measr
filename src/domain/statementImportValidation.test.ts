import { describe, expect, it } from 'vitest';
import { addStatementDedupeKeys, sameTransactionSet, statementIdentityMatches, validateStatementExtraction, type StatementExtraction } from '../../supabase/functions/_shared/statement-import-validation';

function balancedStatement(): StatementExtraction {
  return {
    institution: 'Starling Bank',
    accountName: 'Business current',
    accountIdentifier: '60-83-70 · •••• 1234',
    currency: 'GBP',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    openingBalanceMinor: 10_000,
    closingBalanceMinor: 11_500,
    moneyInMinor: 2_000,
    moneyOutMinor: 500,
    transactionOrder: 'ascending',
    transactions: [
      { postedAt: '2026-07-02', amountMinor: 2_000, payee: 'Client', description: 'Invoice payment', reference: 'INV-1', balanceAfterMinor: 12_000, sourceLocator: 'CSV row 2' },
      { postedAt: '2026-07-03', amountMinor: -500, payee: 'Supplier', description: 'Subscription', reference: 'CARD', balanceAfterMinor: 11_500, sourceLocator: 'CSV row 3' }
    ],
    notes: []
  };
}

describe('statement import verification', () => {
  it('proves a complete running-balance ledger', () => {
    const result = validateStatementExtraction(balancedStatement());
    expect(result.valid).toBe(true);
    expect(result.proofLevel).toBe('balanced');
    expect(result.netMovementMinor).toBe(1_500);
  });

  it('blocks a partial extraction even when individual rows look valid', () => {
    const statement = balancedStatement();
    statement.transactions.splice(0, 1);
    const result = validateStatementExtraction(statement);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/closing balance|running balances/i);
  });

  it('allows a structurally valid source without pretending it has balance proof', () => {
    const statement = balancedStatement();
    statement.openingBalanceMinor = null;
    statement.closingBalanceMinor = null;
    statement.moneyInMinor = null;
    statement.moneyOutMinor = null;
    statement.transactions = statement.transactions.map(transaction => ({ ...transaction, balanceAfterMinor: null }));
    const result = validateStatementExtraction(statement);
    expect(result.valid).toBe(true);
    expect(result.proofLevel).toBe('structural');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('warns when a source cannot prove which account it belongs to', () => {
    const statement = balancedStatement();
    statement.accountName = '';
    statement.accountIdentifier = '';
    const result = validateStatementExtraction(statement);
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/destination must be confirmed/i);
  });

  it('keeps identical real occurrences distinct and makes a replay stable', async () => {
    const statement = balancedStatement();
    const repeated = { ...statement.transactions[1], balanceAfterMinor: null };
    statement.transactions = [{ ...repeated, sourceLocator: 'PDF page 1 row 1' }, { ...repeated, sourceLocator: 'PDF page 1 row 2' }];
    const first = await addStatementDedupeKeys(statement, 'bank-1');
    const replay = await addStatementDedupeKeys(statement, 'bank-1');
    expect(first.transactions[0].dedupeKey).not.toBe(first.transactions[1].dedupeKey);
    expect(replay.transactions.map(transaction => transaction.dedupeKey)).toEqual(first.transactions.map(transaction => transaction.dedupeKey));
  });

  it('does not make a transaction identity depend on an extracted running balance', async () => {
    const firstRead = balancedStatement();
    const secondRead = structuredClone(firstRead);
    secondRead.transactions[0].balanceAfterMinor = null;
    const first = await addStatementDedupeKeys(firstRead, 'bank-1');
    const second = await addStatementDedupeKeys(secondRead, 'bank-1');
    expect(second.transactions[0].dedupeKey).toBe(first.transactions[0].dedupeKey);
  });

  it('matches a confirmed account by identifier and compares independent reads', () => {
    const statement = balancedStatement();
    expect(statementIdentityMatches(statement, { institution: 'Different label', account_name: '', account_identifier: '60-83-70 · •••• 1234' })).toBe(true);
    expect(sameTransactionSet(statement, structuredClone(statement))).toBe(true);
    const changed = structuredClone(statement);
    changed.transactions[0].amountMinor += 1;
    expect(sameTransactionSet(statement, changed)).toBe(false);
  });
});
