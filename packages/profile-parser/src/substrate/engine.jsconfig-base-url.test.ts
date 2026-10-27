/**
 * A plain-JS repo with no tsconfig.json declares its module root in jsconfig.json
 * (`baseUrl: "./"`) and requires files by root-relative specifier: `require("app/lib/f")`.
 * scip-typescript reads only tsconfig.json, so the synthetic config must carry the jsconfig's
 * baseUrl, or every such call stays unbound.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function writeFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pp-jsconfig-')));
  const write = (rel: string, body: string): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  // scip-typescript's prerequisite check is the presence of node_modules.
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  write('package.json', JSON.stringify({ name: 'acme-jsconfig', version: '1.0.0' }));
  // JSONC with trailing commas, as the field repos write it.
  write('jsconfig.json', '{\n  "compilerOptions": {\n    "module": "commonjs",\n    "baseUrl": "./",\n  },\n}\n');
  write('app/lib/f.js', 'function f(x) {\n  return x + 1;\n}\nmodule.exports = f;\n');
  write(
    'app/caller.js',
    'const f = require("app/lib/f");\nfunction caller(n) {\n  return f(n);\n}\nmodule.exports = caller;\n',
  );
  return root;
}

describe('call graph — jsconfig baseUrl in a repo without tsconfig', () => {
  it('binds a root-relative require through the jsconfig baseUrl', async () => {
    dir = writeFixture();
    const { repo } = await runProfile(
      { parserId: 'test-jsconfig-base-url', substrate: { language: 'js', include: ['app/**/*.js'] } },
      dir,
      'jsconfig-base-url',
    );
    const nameById = new Map(repo.functions.map((f) => [f.id, f.name]));
    const edges = repo.calls
      .filter((c) => c.calleeId)
      .map((c) => `${nameById.get(c.callerId)}->${nameById.get(c.calleeId as string)}`);
    expect(edges).toContain('caller->f');
  });
});
