/**
 * Reparse safety for the repo-local intent overlay (`.coredoc/intent.json`).
 *
 * The spec names the misleading green directly: "Parse tests pass while reparse
 * deletes or rewrites the sidecar → hash `intent.json` before and after a real
 * parse/reparse". A discovery-layer unit test does not close that, because it
 * never runs the enumeration + parse pipeline that actually touches the tree.
 *
 * So this drives `runProfile`, the same real parse entry `run.test.ts` uses,
 * over a temp fixture repo that contains both source and the sidecar, and
 * checks the two independent obligations of BR-10/AC-13:
 *
 * - the sidecar bytes are untouched by a parse and by a reparse, and
 * - nothing under `.coredoc/` enters the parse output as source.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

const TS_ONLY: ExtractionProfile = {
  parserId: 'test-intent-sidecar',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
};

const INTENT_JSON = `${JSON.stringify(
  {
    schemaVersion: 1,
    projectId: 'fixture-project',
    items: [
      {
        id: 'BR-1',
        kind: 'business_rule',
        title: 'Requests are handled once',
        statement: 'A request is handled exactly once.',
        authority: 'accepted',
        payload: { condition: 'A request arrives', requiredOutcome: 'It is handled once', observer: 'api' },
        sources: [{ kind: 'spec', ref: 'spec/api', localId: 'BR-1' }],
      },
    ],
    relations: [],
  },
  null,
  2,
)}\n`;

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function createFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'pp-intent-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export function handle(id: string) {\n  return id;\n}\n');
  mkdirSync(join(root, '.coredoc'), { recursive: true });
  writeFileSync(join(root, '.coredoc', 'intent.json'), INTENT_JSON);
  // Adversarial neighbour: a file the language filter WOULD accept, so the
  // `.coredoc` exclusion has to do real work here. `intent.json` alone proves
  // less than it looks — an unknown extension is dropped anyway.
  writeFileSync(join(root, '.coredoc', 'sidecar.ts'), 'export function sidecarOnly() { return 1; }\n');
  return root;
}

function hashIntentFile(root: string): string {
  return createHash('sha256')
    .update(readFileSync(join(root, '.coredoc', 'intent.json')))
    .digest('hex');
}

describe('runProfile — repo-local intent sidecar (BR-10, AC-13)', () => {
  it('leaves .coredoc/intent.json byte-identical across a parse and a reparse', async () => {
    dir = createFixtureRepo();
    const before = hashIntentFile(dir);

    const first = await runProfile(TS_ONLY, dir, 'api', 'api');
    expect(hashIntentFile(dir)).toBe(before);

    // Reparse: the graph is rebuildable, the sidecar is not.
    const second = await runProfile(TS_ONLY, dir, 'api', 'api');
    expect(hashIntentFile(dir)).toBe(before);

    // Sanity: the parse really ran over the fixture's source.
    expect(first.repo.functions.some((fn) => fn.name === 'handle')).toBe(true);
    expect(second.repo.functions.some((fn) => fn.name === 'handle')).toBe(true);
  });

  it('emits no file node for anything under .coredoc/', async () => {
    dir = createFixtureRepo();

    const { repo } = await runProfile(TS_ONLY, dir, 'api', 'api');

    expect(repo.files.length).toBeGreaterThan(0);
    expect(repo.files.filter((file) => file.path.includes('.coredoc'))).toEqual([]);
    expect(repo.files.map((file) => file.path)).toContain('src/a.ts');
  });

  it('excludes a .coredoc file the include glob and language filter both accept', async () => {
    dir = createFixtureRepo();

    const { repo } = await runProfile(TS_ONLY, dir, 'api', 'api');

    // `.coredoc/sidecar.ts` matches `**/*.ts` and is a known language, so only
    // the directory exclusion can keep it out — and nothing inside it may
    // become a symbol either.
    expect(repo.files.map((file) => file.path)).not.toContain('.coredoc/sidecar.ts');
    expect(repo.functions.some((fn) => fn.name === 'sidecarOnly')).toBe(false);
  });
});
