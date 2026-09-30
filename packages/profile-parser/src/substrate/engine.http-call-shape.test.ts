/**
 * Acceptance for call-shape HTTP routes — the functional/Express registration shape
 * (`app.get('/x', handler)`), as opposed to decorator routes.
 *
 * This path had no dispatch branch at all: `extractEntrypoints` handled only
 * class-decorator and method-decorator for `kind: 'http'`, and the handler-table pass
 * only covers `handler.via === 'handler-table'`. A profile declaring Express routes
 * therefore loaded, matched nothing, and reported a repo with zero endpoints. Runs
 * through `runProfile` (the real tree-sitter + SCIP path) like the other engine tests.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** An Express-shaped rule for one verb. */
function verbRule(callee: string): NonNullable<ExtractionProfile['entrypoints']>[number] {
  return {
    kind: 'http',
    detect: { via: 'call-shape', callee },
    method: 'from-callee',
    methodPath: { arg: 0, as: 'string-literal' },
    paramSyntax: 'colon',
    handler: { arg: 1 },
  };
}

async function run(source: string, entrypoints: ExtractionProfile['entrypoints']): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-http-cs-'));
  writeFileSync(join(dir, 'api.ts'), source);
  const profile: ExtractionProfile = {
    parserId: 'test-http-call-shape',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    callGraph: { resolveAnonCallbacks: true },
    entrypoints,
  };
  const { repo } = await runProfile(profile, dir, 'http-cs-test');
  return repo;
}

/** method + canonicalized full path, sorted, for order-independent comparison. */
function routes(repo: ParsedRepo): string[] {
  return repo.entrypoints
    .filter((e) => e.type === 'http')
    .map((e) => {
      const d = e.details as { method: string; fullPath: string };
      return `${d.method} ${d.fullPath}`;
    })
    .sort();
}

const SRC = `import express from 'express';

export function namedHandler(req: any, res: any) {
  res.json({ ok: true });
}

export function createApp() {
  const app = express();

  app.get('/api/heartbeat', (_req, res) => {
    res.json({ alive: true });
  });

  app.get('/api/repo/:id', async (req, res) => {
    res.json(await load(req.params.id));
  });

  app.post('/api/query', namedHandler);

  app.delete('/api/repo/:id', (req, res) => {
    res.status(204).end();
  });

  return app;
}
`;

describe('call-shape http routes', () => {
  it('emits one entrypoint per registration, including inline arrow handlers', async () => {
    const repo = await run(SRC, [verbRule('app.get'), verbRule('app.post'), verbRule('app.delete')]);
    expect(routes(repo)).toEqual([
      'DELETE /api/repo/{id}',
      'GET /api/heartbeat',
      'GET /api/repo/{id}',
      'POST /api/query',
    ]);
  });

  it('binds every handlerId to a real function node', async () => {
    const repo = await run(SRC, [verbRule('app.get'), verbRule('app.post'), verbRule('app.delete')]);
    const fnIds = new Set(repo.functions.map((f) => f.id));
    const http = repo.entrypoints.filter((e) => e.type === 'http');
    expect(http).toHaveLength(4);
    for (const ep of http) expect(fnIds.has(ep.handlerId)).toBe(true);
  });

  it('resolves a bare handler reference to the declared function, not a synthesized node', async () => {
    const repo = await run(SRC, [verbRule('app.post')]);
    const post = repo.entrypoints.find((e) => e.type === 'http');
    const named = repo.functions.find((f) => f.name === 'namedHandler');
    expect(named).toBeDefined();
    expect(post?.handlerId).toBe(named?.id);
  });

  it('records path params off the colon syntax', async () => {
    const repo = await run(SRC, [verbRule('app.get')]);
    const withParam = repo.entrypoints.find((e) => (e.details as { fullPath?: string }).fullPath === '/api/repo/{id}');
    expect((withParam?.details as { pathParams?: string[] }).pathParams).toEqual(['id']);
  });

  it('skips a registration whose path is not a literal', async () => {
    // A regex SPA fallback has no stable route to key an entrypoint on.
    const repo = await run(
      `const app = express();\nconst FALLBACK = /^(?!\\/api).*$/;\napp.get(FALLBACK, (_req, res) => res.send('ok'));\napp.get('/real', (_req, res) => res.send('ok'));\n`,
      [verbRule('app.get')],
    );
    expect(routes(repo)).toEqual(['GET /real']);
  });

  it('does not double-emit when the rule resolves through a handler table', async () => {
    // handler-table rules are owned by the handler-table pass; this one has no table
    // registered, so the correct outcome is zero routes rather than two per site.
    const repo = await run(SRC, [
      {
        kind: 'http',
        detect: { via: 'call-shape', callee: 'app.get' },
        method: 'from-callee',
        methodPath: { arg: 0, as: 'string-literal' },
        paramSyntax: 'colon',
        handler: { via: 'handler-table', table: 'absent', arg: 1 },
      },
    ]);
    expect(routes(repo)).toEqual([]);
  });
});
