const BUCKET = 'agent-artifacts';

type StorageClient = {
  storage: {
    from: (bucket: string) => {
      download: (path: string) => Promise<{ data: Blob | null; error: { message: string } | null }>;
      upload: (path: string, body: Blob, options: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
      list: (path: string, options?: Record<string, unknown>) => Promise<{ data: Array<{ name: string }> | null; error: { message: string } | null }>;
    };
  };
};

export const artifactPaths = {
  handbookIndex: (companyId: string) => `${companyId}/handbook/SKILL.md`,
  handbookEntry: (companyId: string, name: string) => `${companyId}/handbook/entries/${name}.md`,
  historySummary: (companyId: string) => `${companyId}/history/xero-summary.json`,
  bootstrapThread: (companyId: string) => `${companyId}/threads/bootstrap/latest.json`,
  lineThread: (companyId: string, lineId: string) => `${companyId}/threads/${lineId}/latest.json`,
  companyChatThread: (companyId: string, chatId: string) => `${companyId}/chats/${chatId}/latest.json`,
  analysisSnapshot: (companyId: string, batchId: string) => `${companyId}/analysis-batches/${batchId}/snapshot.json`,
  propagation: (companyId: string, sourceRunId: string) => `${companyId}/propagation/${sourceRunId}.json`
};

export async function readText(service: StorageClient, path: string): Promise<string | null> {
  const { data, error } = await service.storage.from(BUCKET).download(path);
  if (error) {
    if (/not found|object not found/i.test(error.message)) return null;
    throw new Error(`Could not read agent artifact: ${error.message}`);
  }
  return data ? await data.text() : null;
}

export async function writeText(service: StorageClient, path: string, value: string, contentType: string): Promise<void> {
  const { error } = await service.storage.from(BUCKET).upload(path, new Blob([value], { type: contentType }), { upsert: true, contentType });
  if (error) throw new Error(`Could not write agent artifact: ${error.message}`);
}

export async function readJson<T>(service: StorageClient, path: string): Promise<T | null> {
  const text = await readText(service, path);
  return text ? JSON.parse(text) as T : null;
}

export async function writeJson(service: StorageClient, path: string, value: unknown): Promise<void> {
  await writeText(service, path, JSON.stringify(value, null, 2), 'application/json');
}

function archivePath(latestPath: string, artifact: { createdAt?: unknown; runId?: unknown }): string {
  const timestamp = typeof artifact.createdAt === 'string' ? artifact.createdAt.replace(/[^0-9A-Za-z-]/g, '-') : new Date().toISOString().replace(/[^0-9A-Za-z-]/g, '-');
  const runId = typeof artifact.runId === 'string' ? artifact.runId : 'legacy';
  return latestPath.replace(/\/latest\.json$/, `/runs/${timestamp}-${runId}.json`);
}

export async function writeThreadRun(service: StorageClient, latestPath: string, value: { createdAt?: unknown; runId?: unknown }): Promise<void> {
  await writeJson(service, archivePath(latestPath, value), value);
}

export async function publishLatestThread(service: StorageClient, latestPath: string, value: { createdAt?: unknown; runId?: unknown }): Promise<void> {
  const previous = await readJson<{ createdAt?: unknown; runId?: unknown } & Record<string, unknown>>(service, latestPath);
  if (previous) await writeThreadRun(service, latestPath, previous);
  await writeJson(service, latestPath, value);
}

export async function writeThreadArtifact(service: StorageClient, latestPath: string, value: { createdAt?: unknown; runId?: unknown }): Promise<void> {
  await writeThreadRun(service, latestPath, value);
  await publishLatestThread(service, latestPath, value);
}

export async function readThreadLineage<T extends { createdAt?: string; runId?: string }>(service: StorageClient, latestPath: string): Promise<T[]> {
  const runsPath = latestPath.replace(/\/latest\.json$/, '/runs');
  const { data, error } = await service.storage.from(BUCKET).list(runsPath, { limit: 100, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw new Error(`Could not list agent runs: ${error.message}`);
  const loaded = await Promise.all((data ?? []).filter(item => item.name.endsWith('.json')).map(item => readJson<T>(service, `${runsPath}/${item.name}`)));
  const runs: T[] = [];
  for (const run of loaded) if (run) runs.push(run as T);
  const unique = new Map<string, T>();
  for (const run of runs) unique.set(String(run.runId ?? run.createdAt ?? unique.size), run);
  return [...unique.values()].sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
}

const handbookIndex = `# Workbench bookkeeping memory

This is the company-specific, editable operating memory used by the bookkeeping agent.

## Working protocol

- Read the index and relevant entries before acting.
- Store one durable concept per entry in \`entries/<lowercase-kebab-name>.md\`.
- Record observed patterns and provenance; do not turn one-off guesses into rules.
- Never silently rename or delete an existing concept.
- End every entry with a \`Related: ...\` line. Use \`Related: none\` when appropriate.
- This memory can evolve as the company, Xero data and model capabilities evolve.
`;

export async function ensureHandbook(service: StorageClient, companyId: string): Promise<string> {
  const path = artifactPaths.handbookIndex(companyId);
  const current = await readText(service, path);
  if (current) return current;
  await writeText(service, path, handbookIndex, 'text/markdown');
  return handbookIndex;
}

export async function listHandbookEntries(service: StorageClient, companyId: string): Promise<string[]> {
  const { data, error } = await service.storage.from(BUCKET).list(`${companyId}/handbook/entries`, { limit: 100, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw new Error(`Could not list handbook entries: ${error.message}`);
  return (data ?? []).map(item => item.name).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3));
}

export async function upsertHandbookEntry(service: StorageClient, companyId: string, name: string, content: string): Promise<void> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Handbook entry name must be lowercase kebab-case');
  if (!/\nRelated:\s*.+\s*$/i.test(content.trim())) throw new Error('Handbook entry must end with a Related: line');
  await writeText(service, artifactPaths.handbookEntry(companyId, name), `${content.trim()}\n`, 'text/markdown');
}
