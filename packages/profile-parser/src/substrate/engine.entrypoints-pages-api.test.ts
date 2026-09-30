/**
 * Acceptance for the `next-pages-api` file-convention ENTRYPOINT rule: every module
 * under `<routeRoot>/api/**` is one HTTP entrypoint with method `ALL` (the served
 * verbs are not statically declared), the path is derived from the file path, and the
 * handler is the file's `export default` when that resolves to a function in the file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSyntheticHandlerId } from '../integrity/referential-integrity.js';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  // Function-declaration default export → real handler id.
  'apps/studio/pages/api/health.ts': 'export default function handler(req, res) {\n  res.status(200);\n}\n',
  // Nested + dynamic segments.
  'apps/studio/pages/api/projects/[ref]/settings.ts':
    'export default function settingsHandler(req, res) {\n  res.status(200);\n}\n',
  // index → the parent path.
  'apps/studio/pages/api/platform/index.ts':
    'export default function listPlatform(req, res) {\n  res.status(200);\n}\n',
  // Wrapped default export: the any-case peel reaches the ONE locally declared function
  // the wrapper expression names (`handler`), so the endpoint links to a real node.
  'apps/studio/pages/api/v1/projects.ts':
    'const handler = (req, res) => res.status(200);\nexport default withAuth(handler);\n',
  // Wrapped default export naming nothing declared HERE — still an endpoint, synthetic handler.
  'apps/studio/pages/api/v1/imported.ts':
    'import { handler } from "../../lib/handler";\nexport default withAuth(handler);\n',
  // Framework internals under api/ are not endpoints.
  'apps/studio/pages/api/_utils/db.ts': 'export function connect() {\n  return 1;\n}\n',
  'apps/studio/pages/api/_middleware.ts': 'export default function mw(req, res) {\n  return res;\n}\n',
  // A page, not an endpoint.
  'apps/studio/pages/index.tsx': 'export default function HomePage() {\n  return <div />;\n}\n',
  // A nested `api` directory outside the pages root is untouched.
  'apps/studio/components/api/client.ts': 'export function call() {\n  return 1;\n}\n',
};

const PROFILE: ExtractionProfile = {
  parserId: 'test-pages-api-entrypoints',
  substrate: { language: 'ts', include: ['**/*.ts', '**/*.tsx'], exclude: ['**/node_modules/**'] },
  entrypoints: [{ kind: 'http', via: 'file-convention', framework: 'next-pages-api', routeRoot: 'pages' }],
};

async function parseFixture(profile: ExtractionProfile, slug: string) {
  dir = mkdtempSync(join(tmpdir(), `pp-${slug}-`));
  for (const [rel, source] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return runProfile(profile, dir, `${slug}-test`);
}

describe('entrypoints — next-pages-api file convention', () => {
  it('emits one ALL entrypoint per api module, path-derived, internals excluded', async () => {
    const { repo } = await parseFixture(PROFILE, 'pages-api');
    const rows = repo.entrypoints
      .filter((e) => e.type === 'http')
      .map((e) => [e.details.method, e.details.path, e.location.filePath])
      .sort();

    expect(rows).toEqual([
      ['ALL', '/api/health', 'apps/studio/pages/api/health.ts'],
      ['ALL', '/api/platform', 'apps/studio/pages/api/platform/index.ts'],
      ['ALL', '/api/projects/{ref}/settings', 'apps/studio/pages/api/projects/[ref]/settings.ts'],
      ['ALL', '/api/v1/imported', 'apps/studio/pages/api/v1/imported.ts'],
      ['ALL', '/api/v1/projects', 'apps/studio/pages/api/v1/projects.ts'],
    ]);

    // One entrypoint per FILE — never a per-verb fan-out off a req.method switch.
    expect(new Set(repo.entrypoints.map((e) => e.id)).size).toBe(5);

    const settings = repo.entrypoints.find((e) => e.details.path === '/api/projects/{ref}/settings');
    expect(settings?.details.pathParams).toEqual(['ref']);
    expect(repo.entrypoints.find((e) => e.details.path === '/api/health')?.details.pathParams).toBeUndefined();
  });

  it('links the default-exported function as handler, and degrades to a synthetic id otherwise', async () => {
    const { repo } = await parseFixture(PROFILE, 'pages-api-handler');
    const functionIds = new Set(repo.functions.map((f) => f.id));
    const byPath = new Map(repo.entrypoints.map((e) => [e.details.path, e]));

    const health = byPath.get('/api/health');
    expect(health).toBeDefined();
    expect(functionIds.has(health?.handlerId ?? '')).toBe(true);
    expect(health?.location.startLine).toBeGreaterThan(0);

    // `export default withAuth(handler)` where `handler` IS declared here: the any-case
    // peel links the real function (this is the S2 follow-up — it used to be synthetic).
    const wrapped = byPath.get('/api/v1/projects');
    expect(wrapped).toBeDefined();
    expect(functionIds.has(wrapped?.handlerId ?? '')).toBe(true);

    // The same wrapper naming an IMPORTED handler resolves nothing locally: the endpoint
    // still exists, with the documented synthetic handler id.
    const imported = byPath.get('/api/v1/imported');
    expect(imported).toBeDefined();
    const importedHandler = imported?.handlerId ?? '';
    expect(functionIds.has(importedHandler)).toBe(false);
    expect(isSyntheticHandlerId(importedHandler)).toBe(true);
  });

  it('matches routeRoot as a path SEGMENT, so one entry covers every app root', async () => {
    const { repo } = await parseFixture(
      { ...PROFILE, entrypoints: [{ ...PROFILE.entrypoints![0], routeRoot: 'apps/studio/pages' } as never] },
      'pages-api-segment',
    );
    // The frontend `routeDir` prefix form matches nothing here — the two fields differ.
    expect(repo.entrypoints).toEqual([]);
  });
});
