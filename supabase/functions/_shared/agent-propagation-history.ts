function visit(value: unknown, visitor: (item: Record<string, unknown>) => void) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, visitor);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  visitor(item);
  for (const nested of Object.values(item)) visit(nested, visitor);
}

function parsedArguments(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function handbookEntryNamesFromThread(thread: Record<string, any>): string[] {
  const names = new Set<string>();
  visit(thread.history, item => {
    const isCall = item.type === 'function_call' || item.type === 'tool_call' || item.name === 'upsert_handbook_entry';
    if (!isCall || item.name !== 'upsert_handbook_entry') return;
    const args = parsedArguments(item.arguments ?? item.args ?? item.input);
    const name = String(args?.name ?? '').trim();
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) names.add(name);
  });
  return [...names];
}
