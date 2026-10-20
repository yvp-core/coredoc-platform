import type { ParsedRepo } from '@coredoc/core/types';
import { describe, expect, it } from 'vitest';
import { diffParsedRepos } from './graph-diff.js';

type Fn = ParsedRepo['functions'][number];
type Call = ParsedRepo['calls'][number];

const fn = (id: string, name: string, start: number, end: number): Fn =>
  ({ id, name, kind: 'function', location: { filePath: 'a.ts', startLine: start, endLine: end } }) as Fn;
const call = (callerId: string, calleeId: string, line: number, expr: string): Call =>
  ({ id: `${callerId}>${calleeId}@${line}`, callerId, calleeId, calleeExpression: expr, location: { filePath: 'a.ts', startLine: line, endLine: line } }) as Call;
const repo = (functions: Fn[], calls: Call[], extra: Partial<ParsedRepo> = {}): ParsedRepo =>
  ({
    name: 'r',
    functions,
    calls,
    classes: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    externalCalls: [],
    stats: {},
    ...extra,
  }) as unknown as ParsedRepo;

// `run` (1–10) calls `helper` (2–4) and `log`; `helper` calls `load` (20–22).
const RUN = fn('r:run', 'run', 1, 10);
const HELPER = fn('r:helper', 'helper', 2, 4);
const LOAD = fn('r:load', 'load', 20, 22);
const BEFORE = repo([RUN, HELPER, LOAD], [call('r:run', 'r:helper', 5, 'helper'), call('r:helper', 'r:load', 3, 'load')]);

describe('diffParsedRepos', () => {
  it('passes a fold: the nested function and calls to it go, its own calls move to the host', () => {
    const after = repo([RUN, LOAD], [call('r:run', 'r:load', 3, 'load')]);
    const d = diffParsedRepos(BEFORE, after);
    expect(d.failures).toEqual([]);
    expect(d.nodes.folded.count).toBe(1);
    expect(d.calls.lostToFold.count).toBe(1); // run → helper
    // load() now attributed to run, the function helper was folded into: neither lost nor moved.
    expect([d.calls.lost.count, d.calls.callerChanged.count]).toEqual([0, 0]);
  });

  it('fails when a resolved call disappears for no structural reason', () => {
    const after = repo([RUN, HELPER, LOAD], [call('r:run', 'r:helper', 5, 'helper')]);
    const d = diffParsedRepos(BEFORE, after, { maxLostEdgeRate: 0 });
    expect(d.calls.lost.count).toBe(1);
    expect(d.failures).toEqual(['1 resolved call edges lost (> 0.0% of 2)']);
  });

  it('fails when an entrypoint disappears', () => {
    const ep = { id: 'r:ep:1', handlerId: 'r:run', location: { filePath: 'a.ts', startLine: 1, endLine: 1 } };
    const d = diffParsedRepos(
      repo([RUN, HELPER, LOAD], BEFORE.calls, { entrypoints: [ep] as ParsedRepo['entrypoints'] }),
      repo([RUN, HELPER, LOAD], BEFORE.calls),
    );
    expect(d.failures).toEqual(['1 entrypoints missing']);
  });
});
