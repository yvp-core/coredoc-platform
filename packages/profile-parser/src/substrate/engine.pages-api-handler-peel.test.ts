/**
 * camelCase-tolerant default-export resolution for API handlers (the S2 follow-up).
 *
 * `peelHocToDeclaredName` was written for page COMPONENTS and accepts only PascalCase, so
 * `export default handler` and `export default (req, res) => apiWrapper(req, res, handler)`
 * — 44 supabase files — named nothing (or, worse, a `NextApiResponse` type annotation) and
 * every one of those endpoints fell back to a synthetic handler id, severing the call graph
 * at the BFF boundary. The pages-api lane now asks for the any-case reading; the frontend
 * page-component lane keeps the PascalCase one (asserted below, since loosening the bias
 * for both surfaces is the failure mode this must avoid).
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
  // `export default handler` — the plain camelCase binding (function declaration).
  'pages/api/health.ts': 'async function handler(req, res) {\n  res.status(200);\n}\nexport default handler;\n',
  // The arrow-wrapper idiom: the handler is an ARGUMENT of the wrapper call.
  'pages/api/projects/[ref]/settings.ts':
    'import { apiWrapper } from "~/lib/api";\n' +
    'export default (req, res) => apiWrapper(req, res, handler, { withAuth: true });\n' +
    'async function handler(req, res) {\n  res.status(200);\n}\n',
  // A camelCase const bound to the wrapper — the exported binding IS the handler node.
  'pages/api/content/index.ts':
    'import { apiWrapper } from "~/lib/api";\n' +
    'const wrappedHandler = (req, res) => apiWrapper(req, res, handler);\n' +
    'async function handler(req, res) {\n  res.status(200);\n}\n' +
    'export default wrappedHandler;\n',
  // Ambiguous: TWO locally declared functions in the expression → no guess.
  'pages/api/ambiguous.ts':
    'const outer = (req, res) => inner(req, res);\n' +
    'function inner(req, res) {\n  return res;\n}\n' +
    'export default (req, res) => outer(req, res) || inner(req, res);\n',
  // A PAGE (not an API route): its default export must still read as the PascalCase component.
  'pages/dashboard.tsx': 'function DashboardPage() {\n  return <div />;\n}\nexport default DashboardPage;\n',
};

const PROFILE: ExtractionProfile = {
  parserId: 'test-pages-api-handler-peel',
  substrate: { language: 'ts', include: ['**/*.ts', '**/*.tsx'], exclude: ['**/node_modules/**'] },
  entrypoints: [{ kind: 'http', via: 'file-convention', framework: 'next-pages-api', routeRoot: 'pages' }],
  components: { framework: 'react', functionalInExtensions: ['.tsx'], imports: {} },
  routes: { fileConvention: [{ framework: 'next-pages', routeDir: 'pages' }] },
};

async function parseFixture() {
  dir = mkdtempSync(join(tmpdir(), 'pp-pages-api-peel-'));
  for (const [rel, source] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return runProfile(PROFILE, dir, 'pages-api-peel-test');
}

describe('pages-api handler linkage — camelCase-tolerant default export', () => {
  it('links camelCase handlers, including the arrow-wrapper idiom, to real function nodes', async () => {
    const { repo } = await parseFixture();
    const functionIds = new Set(repo.functions.map((f) => f.id));
    const byPath = new Map(repo.entrypoints.map((e) => [e.details.path, e]));
    const idOf = (file: string, name: string) =>
      repo.functions.find((f) => f.location.filePath === file && f.name === name)?.id;

    // `export default handler`
    expect(byPath.get('/api/health')?.handlerId).toBe(idOf('pages/api/health.ts', 'handler'));

    // `export default (req, res) => apiWrapper(req, res, handler, …)` — the ONE identifier in
    // the expression that names a function declared in the same file.
    expect(byPath.get('/api/projects/{ref}/settings')?.handlerId).toBe(
      idOf('pages/api/projects/[ref]/settings.ts', 'handler'),
    );

    // `export default wrappedHandler` — the exported binding itself is a function node.
    expect(byPath.get('/api/content')?.handlerId).toBe(idOf('pages/api/content/index.ts', 'wrappedHandler'));

    for (const path of ['/api/health', '/api/projects/{ref}/settings', '/api/content']) {
      expect(functionIds.has(byPath.get(path)?.handlerId ?? '')).toBe(true);
      expect(byPath.get(path)?.location.startLine).toBeGreaterThan(0);
    }
  });

  it('degrades to the synthetic id when two local functions make the expression ambiguous', async () => {
    const { repo } = await parseFixture();
    const ambiguous = repo.entrypoints.find((e) => e.details.path === '/api/ambiguous');
    expect(ambiguous).toBeDefined();
    expect(isSyntheticHandlerId(ambiguous?.handlerId ?? '')).toBe(true);
  });

  it('does not shift page-component resolution (the PascalCase reading is untouched)', async () => {
    const { repo } = await parseFixture();
    const page = (repo.routes ?? []).find((r) => r.path === '/dashboard');
    const component = (repo.components ?? []).find((c) => c.name === 'DashboardPage');
    expect(page?.componentName).toBe('DashboardPage');
    expect(page?.componentId).toBe(component?.id);
  });
});
