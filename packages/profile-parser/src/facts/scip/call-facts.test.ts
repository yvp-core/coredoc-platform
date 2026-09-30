import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { mergeScipCallFacts } from './call-facts.js';

it('accepts a matching file without callable declarations, but refuses unsupported compiler coordinates', () => {
  const file = {
    path: 'types.py',
    source: 'VALUE = 1',
    defaultPositionEncoding: 1 as const,
    definitions: [],
    calls: [],
  };
  const stats = { callSites: 0, resolvedCalls: 0, ambiguousCalls: 0, outOfScopeCalls: 0 };
  expect(
    mergeScipCallFacts(
      {
        projectRoot: '',
        sourceHashes: { [file.path]: createHash('sha256').update(file.source).digest('hex') },
        documents: [{ relativePath: file.path, occurrences: [], positionEncoding: 1 }],
      },
      [file],
      [],
      stats,
    ).calls,
  ).toEqual([]);
  expect(() =>
    mergeScipCallFacts(
      {
        projectRoot: '',
        sourceHashes: { [file.path]: createHash('sha256').update(file.source).digest('hex') },
        documents: [{ relativePath: file.path, occurrences: [], positionEncoding: 3 }],
      },
      [file],
      [],
      stats,
    ),
  ).toThrow('Unsupported compiler position encoding');
});

it('rejects an index for a different source root instead of attesting enhanced analysis', () => {
  expect(() =>
    mergeScipCallFacts(
      { projectRoot: '', sourceHashes: {}, documents: [{ relativePath: 'other/main.go', occurrences: [] }] },
      [{ path: 'main.go', source: 'package main', defaultPositionEncoding: 1, definitions: [], calls: [] }],
      [],
      { callSites: 0, resolvedCalls: 0, ambiguousCalls: 0, outOfScopeCalls: 0 },
    ),
  ).toThrow(/covers 0\/1 target files/i);
});
