import { describe, expect, it } from 'vitest';
import {
  GRAPH_FILE_FORMAT_COMPATIBILITY,
  heritageIdentityIsVerifiable,
  withHeritageIdentityDowngrade,
} from './graph-format.js';
import { NodeType } from '@coredoc/core/types';
import type { TypeUsage } from './types.js';

/**
 * The `ambiguous` flag on a heritage row changed MEANING at phase4: it used to say
 * "one same-named declaration existed", it now says "identity was proved". Published
 * snapshots are immutable, so a workspace can hold both vintages at once and the
 * reader is the only thing that can tell them apart.
 */
function rows(): TypeUsage[] {
  const base = { id: 'h:class:src/a.ts:A', name: 'A', type: NodeType.Class, filePath: 'src/a.ts', startLine: 1 };
  return [
    { ...base, usage: 'extends', ambiguous: false },
    { ...base, usage: 'implements', ambiguous: false },
    { ...base, usage: 'parameter', ambiguous: false },
    { ...base, usage: 'extends', ambiguous: true },
  ];
}

function reader(captured: string[][] = []) {
  return {
    getTypeUsages: async (typeId: string, repoHashes: string[]) => {
      captured.push([typeId, ...repoHashes]);
      return rows();
    },
  };
}

describe('heritageIdentityIsVerifiable', () => {
  it('accepts only the current builder version', () => {
    expect(heritageIdentityIsVerifiable(GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion)).toBe(true);
  });

  // Fail closed: a reader that cannot establish the vintage must not claim proof.
  it.each([
    ['phase3-v1'],
    ['phase2-v1'],
    ['something-unknown'],
    [''],
    [null],
    [undefined],
  ])('refuses to claim verification for %s', (version) => {
    expect(heritageIdentityIsVerifiable(version as string | null | undefined)).toBe(false);
  });
});

describe('withHeritageIdentityDowngrade', () => {
  it('returns the repository untouched on a current snapshot', async () => {
    const source = reader();
    const wrapped = withHeritageIdentityDowngrade(source, GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion);

    expect(wrapped).toBe(source);
    expect((await wrapped.getTypeUsages('t', ['h'])).map((r) => r.ambiguous)).toEqual([false, false, false, true]);
  });

  it.each([['phase3-v1'], [undefined], [null]])('downgrades heritage rows on a %s snapshot', async (version) => {
    const wrapped = withHeritageIdentityDowngrade(reader(), version as string | null | undefined);
    const out = await wrapped.getTypeUsages('t', ['h']);

    // extends + implements become unverified…
    expect(out.filter((r) => r.usage === 'extends' || r.usage === 'implements').every((r) => r.ambiguous)).toBe(true);
    // …and every other usage kind keeps its meaning, which did NOT change.
    expect(out.find((r) => r.usage === 'parameter')!.ambiguous).toBe(false);
  });

  it('passes arguments through and leaves every other method alone', async () => {
    const captured: string[][] = [];
    const source = { ...reader(captured), findClass: async () => 'untouched' };
    const wrapped = withHeritageIdentityDowngrade(source, 'phase3-v1');

    await wrapped.getTypeUsages('type-1', ['hash-a', 'hash-b']);

    expect(captured).toEqual([['type-1', 'hash-a', 'hash-b']]);
    expect(await (wrapped as typeof source).findClass()).toBe('untouched');
  });

  it('does not mutate the rows the underlying repository returned', async () => {
    const original = rows();
    const wrapped = withHeritageIdentityDowngrade({ getTypeUsages: async () => original }, 'phase3-v1');

    await wrapped.getTypeUsages('t', ['h']);

    expect(original[0]!.ambiguous).toBe(false);
  });
});
