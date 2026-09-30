import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const PROFILE: ExtractionProfile = {
  parserId: 'test-package-local-next-entrypoints',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
  entrypoints: [
    { kind: 'http', via: 'file-convention', framework: 'next-app-router', routeRoot: 'app' },
    { kind: 'http', via: 'file-convention', framework: 'next-pages-api', routeRoot: 'pages' },
  ],
};

function write(rel: string, source: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, source);
}

describe('Next.js entrypoints use the owning package boundary', () => {
  it('extracts App and Pages API routes when their package is also named app/pages', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-next-package-boundary-'));
    write('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*'] }));
    write('apps/app/package.json', JSON.stringify({ name: 'app', dependencies: { next: '^15.0.0' } }));
    write('apps/pages/package.json', JSON.stringify({ name: 'pages', dependencies: { next: '^15.0.0' } }));
    write('apps/app/app/api/health/route.ts', 'export function GET() {\n  return new Response("ok");\n}\n');
    write(
      'apps/pages/pages/api/status.ts',
      'export default function handler(req, res) {\n  res.status(200).json({ ok: true });\n}\n',
    );

    const { repo } = await runProfile(PROFILE, dir, 'next-package-boundary');
    const entrypoints = repo.entrypoints
      .map((entrypoint) => [entrypoint.details.method, entrypoint.details.path, entrypoint.location.filePath])
      .sort();

    expect(entrypoints).toEqual([
      ['ALL', '/api/status', 'apps/pages/pages/api/status.ts'],
      ['GET', '/api/health', 'apps/app/app/api/health/route.ts'],
    ]);
  });
});
