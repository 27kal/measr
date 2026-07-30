import { describe, expect, it } from 'vitest';
import { writeThreadArtifact } from '../../supabase/functions/_shared/agent-artifacts';

function fakeStorage() {
  const objects = new Map<string, string>();
  const blobText = (body: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(body);
  });
  return {
    objects,
    service: {
      storage: {
        from: () => ({
          download: async (path: string) => objects.has(path)
            ? { data: { text: async () => objects.get(path)! }, error: null }
            : { data: null, error: { message: 'Object not found' } },
          upload: async (path: string, body: Blob) => { objects.set(path, await blobText(body)); return { error: null }; },
          list: async () => ({ data: [], error: null })
        })
      }
    }
  };
}

describe('agent thread artifacts', () => {
  it('keeps immutable run copies while updating the latest pointer', async () => {
    const { service, objects } = fakeStorage();
    const latest = 'company/threads/line/latest.json';
    const first = { runId: 'run-one', createdAt: '2026-07-27T10:00:00.000Z', finalOutput: { summary: 'first' } };
    const second = { runId: 'run-two', createdAt: '2026-07-27T10:01:00.000Z', finalOutput: { summary: 'second' } };

    await writeThreadArtifact(service as never, latest, first);
    await writeThreadArtifact(service as never, latest, second);

    expect([...objects.keys()].filter(path => path.includes('/runs/'))).toHaveLength(2);
    expect(JSON.parse(objects.get(latest)!)).toEqual(second);
    expect([...objects.values()].some(value => value.includes('"summary": "first"'))).toBe(true);
  });
});
