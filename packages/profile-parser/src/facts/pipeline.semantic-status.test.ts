import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import { IndexSchema } from '@scip-code/scip';
import { runScipTypescript } from './scip/run-indexer.js';
import { buildBaseline } from './pipeline.js';

vi.mock('./scip/run-indexer.js', () => ({ runScipTypescript: vi.fn() }));
let root: string;
afterEach(() => {
  vi.resetAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

it.each([true, false])('reports incomplete semantics only for failed projects (failed=%s)', async (failed) => {
  root = mkdtempSync(join(tmpdir(), 'partial-semantics-'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'main.ts'), 'export const value = 1;');
  const index = join(root, 'fixture.scip');
  writeFileSync(
    index,
    toBinary(
      IndexSchema,
      create(IndexSchema, {
        documents: [{ relativePath: 'main.ts', occurrences: [] }],
      }),
    ),
  );
  vi.mocked(runScipTypescript).mockResolvedValue({
    ok: true,
    scipPath: index,
    partialReason: failed ? 'second project failed' : 'recovered OOM',
    projectOutcomes: [
      { project: '.', ok: true },
      { project: 'second', ok: !failed },
    ],
  });
  const baseline = await buildBaseline({ repoRoot: root, repoName: 'fixture' });
  expect(baseline.scip).toBeDefined();
  expect(baseline.scipIncomplete).toBe(failed);
  expect(baseline.errors.some((error) => error.severity === 'error')).toBe(failed);
});
