/**
 * Acceptance for the interaction of the two call-resolution corrections that share a
 * call SITE key (`callerId|file|line`):
 *
 *   const { doWork: work } = await import('./lib.js');
 *   return work(n) + this.calc.compute(n);        // ← same line, two calls
 *
 * The dynamic-import upgrade exempts its edge from the callee-name precision gate (an
 * aliased binding legitimately calls `work` while the node is named `doWork`). The DI
 * correction is keyed by line only, so it can REPLACE the callee of that same edge — the
 * exemption must not travel with the replacement, or a `work(...)` expression ends up
 * pointing at `compute`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const LIB = `export function doWork(n: number): number {
  return n + 1;
}
`;

const SVC = `export class Calculator {
  compute(n: number): number {
    return n * 2;
  }
}
`;

const CONSUMER = `import type { Calculator } from './svc.js';

export class Runner {
  constructor(private readonly calc: Calculator) {}

  async run(n: number): Promise<number> {
    const { doWork: work } = await import('./lib.js');
    return work(n) + this.calc.compute(n);
  }
}
`;

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pp-dyn-import-di-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  // scip-typescript's prerequisite check is the presence of node_modules.
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'dyn-import-di-fixture', version: '1.0.0', type: 'module' }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src'],
    }),
  );
  writeFileSync(join(root, 'src', 'lib.ts'), LIB);
  writeFileSync(join(root, 'src', 'svc.ts'), SVC);
  writeFileSync(join(root, 'src', 'consumer.ts'), CONSUMER);
  return root;
}

const PROFILE: ExtractionProfile = {
  parserId: 'test-dynamic-import-di-correction',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/node_modules/**'] },
  // The DI correction only runs for a constructor-type profile — without it the call
  // site at issue never gets a second, competing resolution.
  di: { style: 'constructor-type' },
};

describe('call graph — DI correction on a dynamic-import call site', () => {
  it('never keeps the dynamic-import name exemption for a DI-corrected callee', async () => {
    dir = writeFixture();
    const { repo } = await runProfile(PROFILE, dir, 'dyn-import-di');
    const nameById = new Map(repo.functions.map((f) => [f.id, f.name]));

    const fabricated = repo.calls.filter(
      (c) => c.calleeId && c.calleeExpression === 'work' && nameById.get(c.calleeId) !== 'doWork',
    );
    expect(fabricated.map((c) => `work->${nameById.get(c.calleeId as string)}`)).toEqual([]);
  });
});
