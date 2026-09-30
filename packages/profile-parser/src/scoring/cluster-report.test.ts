import type { SourceLocation } from '@coredoc/core/types';
import { describe, expect, it } from 'vitest';
import { type SignalHit, unclaimedClusters } from './cluster-report.js';

const hit = (file: string, line: number, text: string): SignalHit => ({ file, line, text });
const loc = (filePath: string, startLine: number, endLine = startLine): SourceLocation => ({
  filePath,
  startLine,
  endLine,
});

describe('unclaimedClusters — residue matching', () => {
  it('excludes hits claimed by an emitted location span with ±2-line tolerance', () => {
    const emitted = [loc('src/a.ts', 10, 12)];
    const hits = [
      hit('src/a.ts', 8, '@Get()'), // startLine-2 → claimed
      hit('src/a.ts', 7, '@Get()'), // startLine-3 → residue
      hit('src/a.ts', 11, '@Get()'), // inside the span → claimed
      hit('src/a.ts', 14, '@Get()'), // endLine+2 → claimed
      hit('src/a.ts', 15, '@Get()'), // endLine+3 → residue
    ];
    const clusters = unclaimedClusters(hits, emitted);
    expect(clusters).toEqual([{ shape: '@Get(', count: 2, sample: 'src/a.ts:7: @Get()' }]);
  });

  it('does not let a location in one file claim a hit in another', () => {
    const clusters = unclaimedClusters([hit('src/b.ts', 10, '@Get()')], [loc('src/a.ts', 10)]);
    expect(clusters).toEqual([{ shape: '@Get(', count: 1, sample: 'src/b.ts:10: @Get()' }]);
  });

  it('returns [] when every hit is claimed and when there are no hits', () => {
    expect(unclaimedClusters([hit('src/a.ts', 10, '@Get()')], [loc('src/a.ts', 10)])).toEqual([]);
    expect(unclaimedClusters([], [])).toEqual([]);
  });
});

describe('unclaimedClusters — shape grouping', () => {
  it('groups decorator hits by decorator name', () => {
    const clusters = unclaimedClusters(
      [
        hit('a.ts', 1, "@EventPattern('x')"),
        hit('b.ts', 2, '@EventPattern("y")'),
        hit('c.ts', 3, "@MessagePattern('z')"),
      ],
      [],
    );
    expect(clusters.map((c) => [c.shape, c.count])).toEqual([
      ['@EventPattern(', 2],
      ['@MessagePattern(', 1],
    ]);
  });

  it('groups constructor hits as `new Name(`', () => {
    const clusters = unclaimedClusters(
      [hit('a.ts', 1, 'const c = new BillingClient(url)'), hit('b.ts', 2, 'this.api = new BillingClient(cfg)')],
      [],
    );
    expect(clusters).toEqual([expect.objectContaining({ shape: 'new BillingClient(', count: 2 })]);
  });

  it('keeps the LAST TWO segments of a receiver chain', () => {
    const clusters = unclaimedClusters(
      [
        hit('a.ts', 1, 'await this.em.getRepository(User).findOne({ id })'),
        hit('b.ts', 2, 'this.em.getRepository(Team)'),
      ],
      [],
    );
    expect(clusters).toEqual([expect.objectContaining({ shape: 'em.getRepository(', count: 2 })]);
  });

  it('falls back to the first word when no decorator/constructor/chain shape matches', () => {
    const clusters = unclaimedClusters([hit('a.ts', 1, '  HandleFunc("/x", handler)')], []);
    expect(clusters).toEqual([expect.objectContaining({ shape: 'HandleFunc', count: 1 })]);
  });
});

describe('unclaimedClusters — output', () => {
  it('caps the report at the top 5 clusters, ordered by count descending', () => {
    const hits: SignalHit[] = [];
    // Shapes A..F with 1..6 hits each — A (count 1) must be dropped.
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach((name, i) => {
      for (let n = 0; n <= i; n++) hits.push(hit(`src/${name}${n}.ts`, n + 1, `@${name}('${n}')`));
    });
    const clusters = unclaimedClusters(hits, []);
    expect(clusters).toHaveLength(5);
    expect(clusters.map((c) => [c.shape, c.count])).toEqual([
      ['@F(', 6],
      ['@E(', 5],
      ['@D(', 4],
      ['@C(', 3],
      ['@B(', 2],
    ]);
  });

  it('formats the sample as `file:line: text` from the FIRST residue hit, text trimmed to ≤100 chars', () => {
    const long = `await this.em.getRepository(User).${'x'.repeat(200)}`;
    const clusters = unclaimedClusters(
      [hit('src/users.service.ts', 42, `  ${long}  `), hit('src/teams.service.ts', 7, 'this.em.getRepository(Team)')],
      [],
    );
    expect(clusters).toHaveLength(1);
    const { sample } = clusters[0];
    expect(sample.startsWith('src/users.service.ts:42: await this.em.getRepository(User).')).toBe(true);
    expect(sample.length).toBe('src/users.service.ts:42: '.length + 100);
  });
});
