import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assemble, buildBaseline, indexerPartialSeverity, scipCoverageGaps, scipIndexSources } from './pipeline.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('buildBaseline + assemble (structural-only)', () => {
  it('produces a valid ParsedRepo with nodes when SCIP is unavailable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cg-'));
    writeFileSync(join(dir, 'a.ts'), 'export function foo() { return bar(); }\nfunction bar() { return 1; }\n');
    const opts = { repoRoot: dir, repoName: 'fixture', repoKey: 'fixture' };
    const base = await buildBaseline(opts, { runScip: false });
    const repo = assemble(base.graph, opts, base.errors, 0, base.plan);
    expect(repo.functions.map((f) => f.name).sort()).toEqual(['bar', 'foo']);
    expect(repo.parserId).toBe('coredoc-code-graph-tsjs-v1');
    expect(repo.stats.totalFunctions).toBe(2);
    // structural call edge foo->bar present (unresolved without SCIP)
    expect(repo.calls.some((c) => c.calleeExpression === 'bar')).toBe(true);
  });
});

describe('buildBaseline', () => {
  it('returns a populated graph, structuralFiles, and resolver', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cg-base-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { koa: '^2.0.0' } }));
    writeFileSync(join(dir, 'a.ts'), 'export const TOPIC = "orders";\nexport function foo() { return 1; }\n');
    const base = await buildBaseline({ repoRoot: dir, repoName: 'b', repoKey: 'b' }, { runScip: false });
    expect(base.graph.functions.size).toBeGreaterThan(0);
    expect(base.structuralFiles.some((f) => f.path === 'a.ts')).toBe(true);
    expect(base.resolver.resolve('TOPIC', 'a.ts')).toBe('orders');
    expect(base.packageId).toBeTruthy();
  });
});

describe('scipCoverageGaps', () => {
  const doc = (relativePath: string) => ({ relativePath, occurrences: [] });
  const scip = (paths: string[]) => ({ projectRoot: 'file:///repo', documents: paths.map(doc) });

  it('is silent when SCIP covered (almost) every discovered TS/JS file', () => {
    const files = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
    expect(scipCoverageGaps(scip(files.slice(0, 96)), files)).toEqual([]);
  });

  it('warns and names the top uncovered directories when whole projects are missing', () => {
    const covered = Array.from({ length: 50 }, (_, i) => `packages/ui/src/f${i}.ts`);
    const missed = Array.from({ length: 40 }, (_, i) => `apps/www/pages/p${i}.ts`);
    const gaps = scipCoverageGaps(scip(covered), [...covered, ...missed]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].severity).toBe('warning');
    expect(gaps[0].message).toContain('40/90 discovered TS/JS files (44%)');
    expect(gaps[0].message).toContain('apps/www/pages (40)');
  });

  it('is silent on a repo with no TS/JS files at all', () => {
    expect(scipCoverageGaps(scip([]), [])).toEqual([]);
  });

  describe('classified by cause (per-project outcomes available)', () => {
    const outcomes = [
      { project: '.', ok: true },
      { project: 'apps/server', ok: true },
      { project: 'apps/web', ok: false, reason: 'out of memory: …' },
    ];

    it('separates tsconfig-excluded files, orphan roots, and files lost to a failed project', () => {
      const covered = Array.from({ length: 100 }, (_, i) => `apps/server/src/f${i}.ts`);
      const excluded = Array.from({ length: 12 }, (_, i) => `apps/server/src/f${i}.test.ts`);
      const orphans = Array.from({ length: 7 }, (_, i) => `plugins/workflows/scripts/s${i}.ts`);
      const lost = Array.from({ length: 5 }, (_, i) => `apps/web/src/w${i}.ts`);
      const [gap] = scipCoverageGaps(scip(covered), [...covered, ...excluded, ...orphans, ...lost], outcomes);
      expect(gap.message).toContain('24/124 discovered TS/JS files (19%)');
      expect(gap.message).toContain('12 sit inside a project that indexed fine');
      expect(gap.message).toContain('apps/server (12)');
      expect(gap.message).toContain('7 are under NO tsconfig project');
      expect(gap.message).toContain('plugins/workflows (7)');
      expect(gap.message).toContain('5 belong to a project whose index FAILED');
    });

    it('attributes a file to its DEEPEST containing project, not the root project', () => {
      const covered = Array.from({ length: 100 }, (_, i) => `apps/server/src/f${i}.ts`);
      const excluded = Array.from({ length: 20 }, (_, i) => `apps/server/e2e/e${i}.ts`);
      const [gap] = scipCoverageGaps(scip(covered), [...covered, ...excluded], outcomes);
      expect(gap.message).toContain('apps/server (20)');
      expect(gap.message).not.toContain('. (20)');
    });

    it('does not let the umbrella root project swallow orphans as a false exclusion', () => {
      // `.` is a prefix of everything; in a monorepo it is a solution tsconfig that reaches
      // none of these, so root-level scripts are orphans, not "excluded by the root project".
      const covered = Array.from({ length: 100 }, (_, i) => `apps/server/src/f${i}.ts`);
      const missed = Array.from({ length: 10 }, (_, i) => `scripts/s${i}.mjs`);
      const [gap] = scipCoverageGaps(scip(covered), [...covered, ...missed], outcomes);
      expect(gap.message).toContain('10 are under NO tsconfig project');
      expect(gap.message).not.toContain('indexed fine');
    });

    it('points orphan roots at a committable tsconfig, which the indexer now discovers', () => {
      const covered = Array.from({ length: 100 }, (_, i) => `apps/server/src/f${i}.ts`);
      const missed = Array.from({ length: 10 }, (_, i) => `plugins/workflows/s${i}.mjs`);
      const [gap] = scipCoverageGaps(scip(covered), [...covered, ...missed], outcomes);
      expect(gap.message).toContain('Committing a tsconfig.json at these roots IS the whole fix');
      expect(gap.message).not.toContain("the repo-root tsconfig's include");
    });

    it('does not ask for a second tsconfig at the repo root when the orphans are root-level files', () => {
      const covered = Array.from({ length: 100 }, (_, i) => `apps/server/src/f${i}.ts`);
      const missed = Array.from({ length: 10 }, (_, i) => `vitest.config${i}.ts`);
      const [gap] = scipCoverageGaps(scip(covered), [...covered, ...missed], outcomes);
      expect(gap.message).toContain('. (10)');
      expect(gap.message).toContain("except the `.` root, where the fix is the repo-root tsconfig's include");
    });

    it('does credit the root project in a single-project repo, where it IS the container', () => {
      const covered = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
      const missed = Array.from({ length: 10 }, (_, i) => `src/f${i}.test.ts`);
      const [gap] = scipCoverageGaps(scip(covered), [...covered, ...missed], [{ project: '.', ok: true }]);
      expect(gap.message).toContain('10 sit inside a project that indexed fine');
      expect(gap.message).not.toContain('NO tsconfig project');
    });
  });
});

describe('scipIndexSources', () => {
  it('tags each per-project index with the project that produced it', () => {
    const sources = scipIndexSources({
      ok: true,
      scipPaths: ['/out/root.scip', '/out/server.scip'],
      projectOutcomes: [
        { project: '.', ok: true, scipPath: '/out/root.scip' },
        { project: 'apps/server', ok: true, scipPath: '/out/server.scip' },
        { project: 'apps/web', ok: false, reason: 'boom' },
      ],
    });
    expect(sources).toEqual([
      { scipPath: '/out/root.scip', project: '.' },
      { scipPath: '/out/server.scip', project: 'apps/server' },
    ]);
  });

  it('leaves the project unset for the single/combined index (no per-project identity)', () => {
    expect(scipIndexSources({ ok: true, scipPath: '/out/index.scip' })).toEqual([{ scipPath: '/out/index.scip' }]);
    expect(scipIndexSources({ ok: false, degradeReason: 'no indexer' })).toEqual([]);
  });
});

describe('indexerPartialSeverity', () => {
  it('keeps a fully recovered OOM split advisory when it leaves no residue', () => {
    expect(
      indexerPartialSeverity({
        ok: true,
        partialReason: 'OOM recovered by split',
        projectOutcomes: [{ project: '.', ok: true, split: { subProjects: 2, residueFiles: 0 } }],
      }),
    ).toBe('warning');
  });

  it.each([
    {
      label: 'failed project',
      projectOutcomes: [{ project: 'apps/web', ok: false, reason: 'out of memory' }],
    },
    {
      label: 'split residue',
      projectOutcomes: [{ project: '.', ok: true, split: { subProjects: 2, residueFiles: 3 } }],
    },
    { label: 'combined partial without structured outcomes', projectOutcomes: undefined },
  ])('marks a $label as a blocking extraction error', ({ projectOutcomes }) => {
    expect(indexerPartialSeverity({ ok: true, partialReason: 'partial index', projectOutcomes })).toBe('error');
  });
});
