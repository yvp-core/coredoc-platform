// evals/harness/grounding.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCodeRefs, checkGrounding } from './grounding.js';

describe('extractCodeRefs', () => {
  it('separates backticked file paths from symbols', () => {
    const spec = 'Modify `src/foo/bar.ts` and update `createBulk()` plus `ShiftsService.deleteBulk`.';
    const { paths, symbols } = extractCodeRefs(spec);
    expect(paths).toContain('src/foo/bar.ts');
    expect(symbols).toEqual(expect.arrayContaining(['createBulk', 'ShiftsService.deleteBulk']));
  });
});

describe('checkGrounding', () => {
  it('counts a referenced path that exists as grounded and a missing one as hallucinated', () => {
    const root = mkdtempSync(join(tmpdir(), 'ground-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/real.ts'), 'export function realFn() {}\n');
    const spec = 'Touch `src/real.ts` and the imaginary `src/nope.ts`.';
    const g = checkGrounding(spec, root);
    expect(g.pathRefs).toBe(2);
    expect(g.pathsExisting).toBe(1);
    expect(g.missing).toContain('src/nope.ts');
    expect(g.precision).toBeGreaterThan(0);
    expect(g.precision).toBeLessThan(1);
  });

  it('grounds a repo-relative path that lives inside a subdirectory repo (cross-repo suffix match)', () => {
    // Workspace layout:
    //   <root>/repoX/src/deep/thing.ts   ← real file, nested under a repo subdir
    // Spec cites bare `src/deep/thing.ts` (repo-relative, NOT root-relative).
    // The current root-only check fails; the suffix match must ground it.
    const root = mkdtempSync(join(tmpdir(), 'ground-cross-'));
    mkdirSync(join(root, 'repoX/src/deep'), { recursive: true });
    writeFileSync(join(root, 'repoX/src/deep/thing.ts'), 'export const x = 1;\n');

    const specHit = 'Modify `src/deep/thing.ts` to add the new field.';
    const gHit = checkGrounding(specHit, root);
    expect(gHit.pathsExisting).toBeGreaterThanOrEqual(1);
    expect(gHit.missing).not.toContain('src/deep/thing.ts');

    const specMiss = 'Modify `src/deep/nope.ts` to add the new field.';
    const gMiss = checkGrounding(specMiss, root);
    expect(gMiss.pathsExisting).toBe(0);
    expect(gMiss.missing).toContain('src/deep/nope.ts');
  });
});
