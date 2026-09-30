import type { ParsedRepo } from '@coredoc/core/types';
import { describe, expect, it } from 'vitest';
import { type CategoryCounts, type SourceSignals, emittedCountsFromRepo, scoreCategories } from './score-core.js';

/**
 * Scoring wiring for the cli/grpc/graphql entrypoint kinds: counted off a ParsedRepo
 * like http, scored against a profile-supplied source signal when present, and kept
 * optional/not_applicable when absent (the queue policy). The base five categories
 * stay unchanged so unrelated repos are unaffected.
 */
const baseEmitted: CategoryCounts = { http: 0, queue: 0, entities: 0, dbOperations: 0, externalCalls: 0 };
const baseSignals: SourceSignals = { http: 0, entities: 0 };

describe('entrypoint-kind scoring (cli/grpc/graphql)', () => {
  it('adds no row when the kind is neither declared nor emitted', () => {
    const cats = scoreCategories(baseEmitted, baseSignals);
    expect(cats.map((c) => c.category)).toEqual(['http', 'queue', 'entities', 'dbOperations', 'externalCalls']);
  });

  it('adds a self-relative PASS row when the kind is emitted but no source signal is supplied', () => {
    const cli = scoreCategories({ ...baseEmitted, cli: 4 }, baseSignals).find((c) => c.category === 'cli');
    expect(cli).toMatchObject({ source: 4, emitted: 4, status: 'required', verdict: 'PASS' });
  });

  it('scores emitted against the source signal like http when the profile supplies one', () => {
    const pass = scoreCategories({ ...baseEmitted, grpc: 8 }, { ...baseSignals, grpc: 10 });
    expect(pass.find((c) => c.category === 'grpc')).toMatchObject({ ratio: 0.8, verdict: 'PASS' });

    const fail = scoreCategories({ ...baseEmitted, graphql: 4 }, { ...baseSignals, graphql: 10 });
    expect(fail.find((c) => c.category === 'graphql')).toMatchObject({ ratio: 0.4, verdict: 'FAIL' });
  });

  it('shows a not_applicable (PASS) row when the profile declares the kind but the repo has none', () => {
    const grpc = scoreCategories(baseEmitted, { ...baseSignals, grpc: 0 }).find((c) => c.category === 'grpc');
    expect(grpc).toMatchObject({ status: 'not_applicable', verdict: 'PASS' });
  });

  it('counts the new entrypoint kinds off a ParsedRepo', () => {
    const parsed = {
      entrypoints: [{ type: 'http' }, { type: 'cli' }, { type: 'cli' }, { type: 'grpc' }, { type: 'graphql' }],
      entities: [],
      dbOperations: [],
      externalCalls: [],
    } as unknown as ParsedRepo;
    expect(emittedCountsFromRepo(parsed)).toMatchObject({ http: 1, cli: 2, grpc: 1, graphql: 1 });
  });
});
