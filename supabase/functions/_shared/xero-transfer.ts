export type TransferStatementLine = {
  id: string;
  bank_account_id: string;
  amount_minor: number;
  posted_at: string;
};

export function transferShape(lines: TransferStatementLine[]): { source: TransferStatementLine; destination: TransferStatementLine } {
  if (lines.length !== 2) throw new Error('A transfer must link exactly two statement lines');
  const source = lines.find(line => Number(line.amount_minor) < 0);
  const destination = lines.find(line => Number(line.amount_minor) > 0);
  if (!source || !destination || Number(source.amount_minor) + Number(destination.amount_minor) !== 0) {
    throw new Error('Transfer statement lines must have equal and opposite signed amounts');
  }
  if (source.posted_at !== destination.posted_at) throw new Error('Transfer statement lines must have the same posting date');
  if (source.bank_account_id === destination.bank_account_id) throw new Error('Transfer statement lines must belong to different bank accounts');
  return { source, destination };
}
