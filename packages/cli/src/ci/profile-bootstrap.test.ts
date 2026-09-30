import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runCi } from './run.js';

const originalCwd = process.cwd();
let checkout: string | undefined;
afterEach(() => {
  process.chdir(originalCwd);
  if (checkout) rmSync(checkout, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('parses a fresh checkout with the documented profile and no cloud parser', async () => {
  checkout = mkdtempSync(join(tmpdir(), 'coredoc-profile-bootstrap-'));
  execFileSync('git', ['init', '-q', checkout]);
  mkdirSync(join(checkout, '.coredoc'));
  mkdirSync(join(checkout, 'src'));
  // This fixture has no package dependencies; ordinary CI installs its own.
  mkdirSync(join(checkout, 'node_modules'));
  writeFileSync(join(checkout, '.gitignore'), '.coredoc-ci/\n');
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'bootstrap-fixture', version: '1.0.0' }));
  writeFileSync(
    join(checkout, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['src'] }),
  );
  writeFileSync(join(checkout, 'src', 'index.ts'), 'export function twice(n: number): number { return n * 2; }');
  const guide = readFileSync(new URL('../../../../docs/intent-loop-setup.md', import.meta.url), 'utf8');
  const profile = guide.match(/```ts\n([\s\S]*?)\n```/)?.[1];
  expect(profile).toBeDefined();
  writeFileSync(join(checkout, '.coredoc', 'profile.ts'), profile as string);
  process.chdir(checkout);
  vi.stubEnv('COREDOC_TOKEN', 'cdt_test');
  vi.stubEnv('COREDOC_WORKSPACE_ID', 'ws_test');
  vi.stubEnv('COREDOC_SERVER_URL', 'https://api.test');
  vi.stubEnv('COREDOC_LLM_API_KEY', '');
  vi.stubEnv('COREDOC_PROFILE_PATH', '.coredoc/profile.ts');
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/results/upload')) return new Response(JSON.stringify({ version: 'parsed_1' }));
      if (url.endsWith('/push')) return new Response(JSON.stringify({ jobId: 'push_1' }), { status: 202 });
      if (url.includes('/jobs/push_1')) return new Response(JSON.stringify({ id: 'push_1', status: 'succeeded' }));
      throw new Error(`Unexpected cloud request: ${url}`);
    }),
  );
  const result = await runCi({ repo: 'bootstrap-fixture', pushTimeoutMs: 1000 });
  expect(result).toMatchObject({ status: 'success', files: 1, functions: 1 });
  expect(urls.some((url) => url.includes('/parsers/'))).toBe(false);
  expect(urls.some((url) => url.endsWith('/push'))).toBe(true);
});
