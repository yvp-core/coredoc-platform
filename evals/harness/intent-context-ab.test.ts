import { describe, expect, it } from 'vitest';
import { assessContextRead, contextScaleDecoys, type ContextAbCase, type ContextAbResponse } from './intent-context-ab.js';

const scenario: ContextAbCase = {
  id: 'shared', task: 'Change shared code', query: {}, criticalIds: ['br-critical'], applicableIds: ['br-helpful'],
};
const response = (ids: string[], available = true): ContextAbResponse => ({
  matches: ids.map((id) => ({ id, version: 1 })), evidence: { available },
  truncated: false, scanTruncated: false, unknownIntentIds: [],
});

describe('context-first retrieval assessment', () => {
  it('does not count applicable noncritical rules as noise or claim full agent success', () => {
    const result = assessContextRead(scenario, response(['br-critical', 'br-helpful', 'br-decoy', 'br-other']), new Set(['br-decoy']));
    expect(result.verdict).toBe('retrieval_pass');
    expect(result.irrelevantIds).toEqual(['br-decoy']);
    expect(result.unclassifiedIds).toEqual(['br-other']);
  });
  it('records missing rules even when a truncated response claims matches exist', () => {
    const result = assessContextRead(scenario, { ...response(['br-decoy']), truncated: true }, new Set(['br-decoy']));
    expect(result.verdict).toBe('fail');
    expect(result.missingCriticalIds).toEqual(['br-critical']);
    expect(result.truncated).toBe(true);
  });
  it('does not treat unavailable graph evidence as an ordinary successful comparison', () => {
    expect(assessContextRead(scenario, response(['br-critical'], false), new Set()).verdict).toBe('inconclusive');
  });
  it('keeps scale decoys distinct, with 300 similar and 3000 unrelated items', () => {
    const { domains, items } = contextScaleDecoys();
    expect(domains).toHaveLength(32);
    expect(items).toHaveLength(3300);
    expect(new Set(items.map((item) => item.id)).size).toBe(3300);
    expect(items.filter((item) => item.domainId.startsWith('scale-similar-'))).toHaveLength(300);
  });
});
