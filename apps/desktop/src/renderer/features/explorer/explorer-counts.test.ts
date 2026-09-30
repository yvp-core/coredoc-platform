import { describe, expect, it } from 'vitest';
import type { GraphOverview } from '../../../shared/ipc-types';
import { CHIP_NODE_TYPES, chipCounts, chipDisclosure, seedShare } from './explorer-counts.js';

const overview = (repos: Array<[string, Record<string, number>]>): GraphOverview => ({
  repos: repos.map(([name, countsByType]) => ({ name, countsByType })),
});

const countOf = (r: ReturnType<typeof chipCounts>, type: string) => r.chips.find((c) => c.type === type)?.count;

describe('chipCounts', () => {
  it('sums a type across every repo in scope', () => {
    const r = chipCounts(
      overview([
        ['api', { function: 10 }],
        ['web', { function: 5 }],
      ]),
      ['api', 'web'],
    );
    expect(countOf(r, 'function')).toBe(15);
    expect(r.countedRepos).toBe(2);
  });

  it('reports null, not zero, while the query is unresolved', () => {
    const r = chipCounts(undefined, ['api']);
    expect(r.chips.every((c) => c.count === null)).toBe(true);
    expect(r.countedRepos).toBe(0);
  });

  it('reports a real zero for a type a counted repo genuinely lacks', () => {
    // The GROUP BY covers every node row, so an absent key means none exist.
    const r = chipCounts(overview([['api', { function: 3 }]]), ['api']);
    expect(countOf(r, 'entity')).toBe(0);
  });

  it('excludes a workspace repo missing from the graph and flags the gap', () => {
    const r = chipCounts(overview([['api', { function: 4 }]]), ['api', 'not-pushed']);
    expect(countOf(r, 'function')).toBe(4);
    expect(r.countedRepos).toBe(1);
    expect(r.knownRepos).toBe(2);
    expect(r.missingRepos).toEqual(['not-pushed']);
  });

  it('falls back to null when nothing in scope is in the graph', () => {
    // Zero would claim the graph is empty; it is actually unmeasured.
    const r = chipCounts(overview([]), ['api']);
    expect(countOf(r, 'function')).toBeNull();
  });

  it('narrows to the selected repos', () => {
    const data = overview([
      ['api', { function: 10 }],
      ['web', { function: 5 }],
    ]);
    expect(countOf(chipCounts(data, ['api', 'web'], ['web']), 'function')).toBe(5);
  });

  it('treats an empty selection as all repos', () => {
    const data = overview([
      ['api', { function: 10 }],
      ['web', { function: 5 }],
    ]);
    expect(countOf(chipCounts(data, ['api', 'web'], []), 'function')).toBe(15);
  });

  it('emits every designed chip in a stable order and drops undesigned types', () => {
    const r = chipCounts(overview([['api', { function: 1, file: 99, repository: 7 }]]), ['api']);
    expect(r.chips.map((c) => c.type)).toEqual([...CHIP_NODE_TYPES]);
  });

  it('dedupes repeated workspace repo names', () => {
    const r = chipCounts(overview([['api', { function: 2 }]]), ['api', 'api']);
    expect(r.knownRepos).toBe(1);
    expect(countOf(r, 'function')).toBe(2);
  });
});

describe('seedShare', () => {
  it('gives one repo the whole budget', () => {
    expect(seedShare(1000, 1)).toBe(1000);
  });

  it('splits the budget instead of granting it per repo', () => {
    // The regression this guards: three repos each pulling 1000 put 3000+ nodes
    // on the canvas and rendering slowed to a crawl.
    expect(seedShare(1000, 3)).toBe(333);
    expect(seedShare(1000, 3) * 3).toBeLessThanOrEqual(1000);
  });

  it('never asks for zero, however many repos are selected', () => {
    expect(seedShare(1000, 5000)).toBe(1);
  });

  it('treats an empty selection as one scope', () => {
    // Stands for the unscoped fetch a graph with no repo names gets.
    expect(seedShare(1000, 0)).toBe(1000);
  });
});

describe('chipDisclosure', () => {
  it('reports what the canvas holds when the chip is on', () => {
    expect(chipDisclosure(true, 333, 1200)).toEqual({ shown: 333, truncated: true });
  });

  it('claims nothing while the type is toggled off', () => {
    // The reported bug in its second form: a chip reading "1,000 shown" while
    // its type was hidden and the canvas rendered none of it.
    expect(chipDisclosure(false, 1000, 3000)).toEqual({ shown: null, truncated: false });
  });

  it('drops the truncation notice once the canvas holds them all', () => {
    expect(chipDisclosure(true, 1200, 1200)).toEqual({ shown: 1200, truncated: false });
  });

  it('will not infer truncation from an unknown tally', () => {
    // Per ADR-20260724-explicit-degrade-no-silent-zeros: null is "not measured",
    // which cannot prove the canvas is short.
    expect(chipDisclosure(true, 40, null)).toEqual({ shown: 40, truncated: false });
  });

  it('shows a real zero when the selected repos hold none of the type', () => {
    // Distinct from the toggled-off case above: this one is measured.
    expect(chipDisclosure(true, 0, 1200)).toEqual({ shown: 0, truncated: true });
  });
});
