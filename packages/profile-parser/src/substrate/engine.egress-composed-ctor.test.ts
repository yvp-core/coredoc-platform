/**
 * Composed-constructor SDK egress — the Octokit plugin idiom, measured absent in supabase:
 *
 *   import { Octokit } from '@octokit/core';
 *   const RetryOctokit = Octokit.plugin(retry);
 *   const client = new RetryOctokit({…});
 *   client.request('GET /repos/{owner}/{repo}/contents/{path}', {…});
 *
 * All three existing detector paths skip it by design — `matchRegistrySdk` rejects a
 * named-import receiver (`Octokit.plugin()` is composition, not egress),
 * `registryNewExternals` sees a ctor with no import, and the call receiver is a local
 * binding — so GitHub egress was entirely missing while the registry row was right there.
 * ONE bounded lineage hop (same file, source order, no flow analysis) restores it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const PROFILE: ExtractionProfile = {
  parserId: 'test-composed-ctor-egress',
  substrate: { language: 'ts', include: ['lib/**/*.ts'], exclude: ['**/node_modules/**'] },
};

async function run(source: string): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-composed-ctor-'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib/github.ts'), source);
  const { repo } = await runProfile(PROFILE, dir, 'composed-ctor-test');
  return repo;
}

/** `[serviceName, sdkName, method]` per emitted egress edge, sorted — order-independent. */
function edges(repo: ParsedRepo): [string, string, string][] {
  return repo.externalCalls
    .map((e): [string, string, string] => [e.serviceName, e.sdkName ?? '?', e.method])
    .sort((a, b) => a.join().localeCompare(b.join()));
}

describe('egress — composed SDK constructor (Octokit.plugin lineage)', () => {
  it('carries the registry identity through the plugin ctor to construction AND method calls', async () => {
    const repo = await run(`import { Octokit } from '@octokit/core';
import { retry } from '@octokit/plugin-retry';

const RetryOctokit = Octokit.plugin(retry);

export async function readFile(owner: string, repo: string, path: string) {
  const client = new RetryOctokit({ auth: 'token' });
  return await client.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path });
}
`);

    expect(edges(repo)).toEqual([
      ['GitHub', '@octokit/core', 'new'],
      ['GitHub', '@octokit/core', 'request'],
    ]);
  });

  it('reads a nested method chain off the instance (octokit.graphql.paginate)', async () => {
    const repo = await run(`import { Octokit } from '@octokit/core';
import { paginateGraphql } from '@octokit/plugin-paginate-graphql';

export const ExtendedOctokit = Octokit.plugin(paginateGraphql);

export async function fetchDiscussions() {
  const octokit = new ExtendedOctokit({ auth: 'token' });
  return await octokit.graphql.paginate('query { viewer { login } }');
}
`);

    expect(edges(repo)).toEqual([
      ['GitHub', '@octokit/core', 'graphql.paginate'],
      ['GitHub', '@octokit/core', 'new'],
    ]);
  });

  it('follows the plugin chain and the module-level `let` assignment form', async () => {
    // supabase's actual shape: a lazily built singleton assigned to a module-level `let`.
    const repo = await run(`import { Octokit } from '@octokit/core';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

const RetryOctokit = Octokit.plugin(retry).plugin(throttling);
let instance: unknown;

export function client() {
  instance = new RetryOctokit({ auth: 'token' });
  return instance;
}
`);

    expect(edges(repo)).toEqual([['GitHub', '@octokit/core', 'new']]);
  });

  it('does not classify the composition call itself as egress', async () => {
    // `Octokit.plugin(retry)` is construction-time wiring at module scope; only the
    // `new`/instance sites are egress, and neither exists here.
    const repo = await run(`import { Octokit } from '@octokit/core';
import { retry } from '@octokit/plugin-retry';

export const RetryOctokit = Octokit.plugin(retry);
`);

    expect(edges(repo)).toEqual([]);
  });

  it('claims nothing when the composed receiver is not a registry package', async () => {
    const repo = await run(`import { Widget } from 'some-unknown-widget-lib';

const ConfiguredWidget = Widget.configure({});

export function build() {
  const w = new ConfiguredWidget();
  return w.render('x');
}
`);

    expect(edges(repo)).toEqual([]);
  });
});
