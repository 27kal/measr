import { describe, expect, it } from 'vitest';
import { handbookEntryNamesFromThread } from '../../supabase/functions/_shared/agent-propagation-history';

describe('handbook propagation source detection', () => {
  it('finds and deduplicates handbook writes in nested Agents SDK history', () => {
    const thread = {
      history: [
        { type: 'function_call', name: 'upsert_handbook_entry', arguments: '{"name":"tracey-small-professional-fees","content":"rule"}' },
        { type: 'function_call_result', name: 'upsert_handbook_entry', output: '{"saved":"tracey-small-professional-fees"}' },
        { wrapper: { type: 'tool_call', name: 'upsert_handbook_entry', args: { name: 'tracey-small-professional-fees' } } },
        { type: 'function_call', name: 'read_handbook_entry', arguments: '{"name":"unrelated"}' }
      ]
    };

    expect(handbookEntryNamesFromThread(thread)).toEqual(['tracey-small-professional-fees']);
  });

  it('ignores malformed or unsafe entry names', () => {
    const thread = { history: [
      { type: 'function_call', name: 'upsert_handbook_entry', arguments: 'not json' },
      { type: 'function_call', name: 'upsert_handbook_entry', arguments: '{"name":"../escape"}' }
    ] };

    expect(handbookEntryNamesFromThread(thread)).toEqual([]);
  });
});
