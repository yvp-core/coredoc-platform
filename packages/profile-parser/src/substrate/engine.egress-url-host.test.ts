/**
 * Where an egress URL's HOST came from decides whether the edge survives, and this is the
 * end-to-end proof of it — driven through `runProfile`, not through the helper.
 *
 * The distinction only exists upstream of normalization: an in-repo const host is inlined
 * into the URL before any gate sees it, at which point `http://host/api/info` is
 * indistinguishable from the same string typed at the call site. A unit test on the helper
 * can hand it whichever `siteArgText` it likes and pass while the real pipeline hands it
 * something else — which is exactly how this inverted once, dropping every const-hosted
 * edge (the case it was meant to keep) and keeping nothing. So the cases below assert on
 * the assembled ParsedRepo.
 *
 * Contract:
 *  - host from an in-repo const → path survives, absolute URL kept on `targetPattern`
 *  - host written at the call site → third-party, edge stays unresolved
 *  - host unresolvable → path tail survives (nothing was learned, nothing is lost)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalCallEdge, ParsedRepo } from '@coredoc/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Run one source file through the engine with a bare-callee fetch/wrapper matcher pair. */
async function run(source: string): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-egress-host-'));
  mkdirSync(join(dir, 'web'), { recursive: true });
  writeFileSync(join(dir, 'web/client.ts'), source);
  const profile: ExtractionProfile = {
    parserId: 'test-egress-url-host',
    substrate: { language: 'ts', include: ['web/**/*.ts'], exclude: ['**/node_modules/**'] },
    externalCalls: [
      { kind: 'http', bareCallee: 'fetch', url: { arg: 0, as: 'string-literal' }, serviceName: 'backend' },
    ],
  };
  const { repo } = await runProfile(profile, dir, 'egress-host-test');
  return repo;
}

/** `[path, targetPattern]` per emitted edge, sorted — order-independent. */
function edges(repo: ParsedRepo): [string | undefined, string | undefined][] {
  return repo.externalCalls
    .map((e: ExternalCallEdge): [string | undefined, string | undefined] => [
      e.targetDescriptor?.http?.pathTemplate,
      e.targetPattern,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

describe('egress URL host provenance', () => {
  it('keeps the path when the host resolved from an in-repo const, and retains the absolute URL', async () => {
    const repo = await run(`const BASE = 'http://localhost:4747';

export async function getInfo() {
  return await fetch(\`\${BASE}/api/info\`);
}
`);
    expect(edges(repo)).toEqual([['/api/info', 'http://localhost:4747/api/info']]);
  });

  it('drops an edge whose host was written at the call site — a third-party URL', async () => {
    // Stripping the host here would yield a bare `/v1/charges` that the linker's unscoped
    // tier can bind to any workspace repo's `GET /v1/:_`.
    const repo = await run(`export async function charge() {
  return await fetch('https://api.stripe.com/v1/charges', { method: 'POST' });
}
`);
    expect(repo.externalCalls).toEqual([]);
  });

  it('drops a site-literal host written as a template literal too', async () => {
    const repo = await run(`export async function send(id: string) {
  return await fetch(\`https://api.stripe.com/v1/charges/\${id}\`);
}
`);
    expect(repo.externalCalls).toEqual([]);
  });

  it('keeps the path tail when the host const is not resolvable', async () => {
    // Nothing was learned about the host, so nothing is lost by keeping the route tail —
    // this is the behaviour const-hosted URLs must match, not diverge from.
    const repo = await run(`const BASE = process.env.API_URL ?? computeBase();

export async function getInfo() {
  return await fetch(\`\${BASE}/api/info\`);
}
`);
    expect(edges(repo)).toEqual([['/api/info', undefined]]);
  });

  it('leaves a relative URL alone', async () => {
    const repo = await run(`export async function list() {
  return await fetch('/api/repos');
}
`);
    expect(edges(repo)).toEqual([['/api/repos', undefined]]);
  });

  it('emits nothing for a host-only URL — no synthetic root path', async () => {
    const repo = await run(`const BASE = 'http://localhost:4747';

export async function ping() {
  return await fetch(\`\${BASE}\`);
}
`);
    expect(repo.externalCalls).toEqual([]);
  });
});
