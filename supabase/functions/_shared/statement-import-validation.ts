export type ExtractedTransaction = {
  postedAt: string;
  amountMinor: number;
  payee: string;
  description: string;
  reference: string;
  balanceAfterMinor: number | null;
  sourceLocator: string;
  dedupeKey?: string;
  occurrence?: number;
};

export type StatementExtraction = {
  institution: string;
  accountName: string;
  accountIdentifier: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
  moneyInMinor: number | null;
  moneyOutMinor: number | null;
  transactionOrder: 'ascending' | 'descending';
  transactions: ExtractedTransaction[];
  notes: string[];
};

export type StatementValidation = {
  valid: boolean;
  proofLevel: 'balanced' | 'cross_checked' | 'structural';
  errors: string[];
  warnings: string[];
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  transactionCount: number;
  netMovementMinor: number;
};

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
}

function addCheck(checks: StatementValidation['checks'], errors: string[], name: string, passed: boolean, passedDetail: string, failedDetail: string) {
  checks.push({ name, passed, detail: passed ? passedDetail : failedDetail });
  if (!passed) errors.push(failedDetail);
}

export function validateStatementExtraction(extraction: StatementExtraction): StatementValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: StatementValidation['checks'] = [];
  const transactions = Array.isArray(extraction.transactions) ? extraction.transactions : [];
  addCheck(checks, errors, 'currency', extraction.currency.toUpperCase() === 'GBP', 'Statement currency is GBP.', `Expected a GBP statement, found ${extraction.currency || 'no currency'}.`);
  addCheck(checks, errors, 'transactions', transactions.length > 0, `${transactions.length} posted bank transactions were extracted.`, 'No posted bank transactions were extracted.');
  addCheck(checks, errors, 'period', validIsoDate(extraction.periodStart) && validIsoDate(extraction.periodEnd) && extraction.periodStart <= extraction.periodEnd, `Statement period is ${extraction.periodStart} to ${extraction.periodEnd}.`, 'The statement period is missing or invalid.');
  if (!extraction.accountIdentifier.trim() && !extraction.accountName.trim()) warnings.push('This file does not print an account identity, so its destination must be confirmed.');

  const locators = new Set<string>();
  for (const [index, transaction] of transactions.entries()) {
    const label = transaction.sourceLocator || `transaction ${index + 1}`;
    if (!validIsoDate(transaction.postedAt)) errors.push(`${label} has an invalid posting date.`);
    if (!Number.isSafeInteger(transaction.amountMinor) || transaction.amountMinor === 0) errors.push(`${label} does not have a non-zero amount in pence.`);
    if (!transaction.description.trim()) errors.push(`${label} has no transaction description.`);
    if (validIsoDate(transaction.postedAt) && validIsoDate(extraction.periodStart) && validIsoDate(extraction.periodEnd)
      && (transaction.postedAt < extraction.periodStart || transaction.postedAt > extraction.periodEnd)) errors.push(`${label} falls outside the statement period.`);
    if (!label.trim()) errors.push(`Transaction ${index + 1} has no source location.`);
    else if (locators.has(normalized(label))) errors.push(`Source location ${label} was extracted more than once.`);
    else locators.add(normalized(label));
    if (transaction.balanceAfterMinor !== null && !Number.isSafeInteger(transaction.balanceAfterMinor)) errors.push(`${label} has an invalid running balance.`);
  }

  const netMovementMinor = transactions.reduce((sum, transaction) => sum + transaction.amountMinor, 0);
  const moneyInMinor = transactions.reduce((sum, transaction) => sum + Math.max(0, transaction.amountMinor), 0);
  const moneyOutMinor = transactions.reduce((sum, transaction) => sum + Math.max(0, -transaction.amountMinor), 0);
  let controlChecks = 0;
  if (extraction.openingBalanceMinor !== null && extraction.closingBalanceMinor !== null) {
    controlChecks += 1;
    addCheck(
      checks,
      errors,
      'statement_totals',
      extraction.openingBalanceMinor + netMovementMinor === extraction.closingBalanceMinor,
      'Opening balance plus extracted movement equals the closing balance.',
      `Opening balance plus extracted movement does not equal the closing balance (${extraction.openingBalanceMinor} + ${netMovementMinor} != ${extraction.closingBalanceMinor} pence).`
    );
  } else {
    warnings.push('The source does not expose both opening and closing balances.');
  }
  if (extraction.moneyInMinor !== null) {
    controlChecks += 1;
    addCheck(checks, errors, 'money_in', extraction.moneyInMinor === moneyInMinor, 'Extracted money in matches the statement summary.', `Extracted money in does not match the statement summary (${moneyInMinor} != ${extraction.moneyInMinor} pence).`);
  }
  if (extraction.moneyOutMinor !== null) {
    controlChecks += 1;
    addCheck(checks, errors, 'money_out', extraction.moneyOutMinor === moneyOutMinor, 'Extracted money out matches the statement summary.', `Extracted money out does not match the statement summary (${moneyOutMinor} != ${extraction.moneyOutMinor} pence).`);
  }

  const allRunningBalances = transactions.length > 0 && transactions.every(transaction => transaction.balanceAfterMinor !== null);
  if (allRunningBalances) {
    const chronological = extraction.transactionOrder === 'ascending' ? transactions : [...transactions].reverse();
    let chainPassed = true;
    if (extraction.openingBalanceMinor !== null && chronological[0].balanceAfterMinor !== extraction.openingBalanceMinor + chronological[0].amountMinor) chainPassed = false;
    for (let index = 1; index < chronological.length; index += 1) {
      if (chronological[index - 1].balanceAfterMinor! + chronological[index].amountMinor !== chronological[index].balanceAfterMinor) chainPassed = false;
    }
    if (extraction.closingBalanceMinor !== null && chronological.at(-1)!.balanceAfterMinor !== extraction.closingBalanceMinor) chainPassed = false;
    controlChecks += 1;
    addCheck(checks, errors, 'running_balances', chainPassed, 'The extracted running balances form a continuous ledger.', 'The extracted running balances do not form a continuous ledger.');
  } else {
    warnings.push('Not every transaction has a running balance, so row-by-row continuity cannot be proved.');
  }

  return {
    valid: errors.length === 0,
    proofLevel: errors.length === 0 && controlChecks > 0 ? 'balanced' : 'structural',
    errors,
    warnings,
    checks,
    transactionCount: transactions.length,
    netMovementMinor
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function addStatementDedupeKeys(extraction: StatementExtraction, bankAccountId: string): Promise<StatementExtraction> {
  const occurrences = new Map<string, number>();
  const transactions: ExtractedTransaction[] = [];
  for (const transaction of extraction.transactions) {
    const signature = [
      bankAccountId,
      transaction.postedAt,
      transaction.amountMinor,
      normalized(transaction.payee),
      normalized(transaction.description),
      normalized(transaction.reference)
    ].join('|');
    const occurrence = (occurrences.get(signature) ?? 0) + 1;
    occurrences.set(signature, occurrence);
    transactions.push({ ...transaction, occurrence, dedupeKey: await sha256(`${signature}|${occurrence}`) });
  }
  return { ...extraction, transactions };
}

export function sameTransactionSet(left: StatementExtraction, right: StatementExtraction): boolean {
  const key = (transaction: ExtractedTransaction) => JSON.stringify({
    postedAt: transaction.postedAt,
    amountMinor: transaction.amountMinor,
    payee: normalized(transaction.payee),
    description: normalized(transaction.description),
    reference: normalized(transaction.reference),
    balanceAfterMinor: transaction.balanceAfterMinor
  });
  return left.transactions.length === right.transactions.length
    && left.transactions.map(key).sort().every((value, index) => value === right.transactions.map(key).sort()[index]);
}

export function statementIdentityMatches(
  extraction: Pick<StatementExtraction, 'institution' | 'accountName' | 'accountIdentifier'>,
  profile: { institution: string; account_name: string; account_identifier: string }
): boolean {
  const identifier = normalized(extraction.accountIdentifier);
  const profileIdentifier = normalized(profile.account_identifier);
  if (identifier && profileIdentifier) return identifier === profileIdentifier;
  const institution = normalized(extraction.institution);
  const accountName = normalized(extraction.accountName);
  return Boolean(institution && accountName && institution === normalized(profile.institution) && accountName === normalized(profile.account_name));
}
