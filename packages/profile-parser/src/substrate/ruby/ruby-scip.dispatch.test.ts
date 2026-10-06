/**
 * Integration test for the Ruby Tier-A dispatch — the host→loadScip→hooks→toEdges→union path
 * that the unit tests don't cover end-to-end. Deterministic: the optional-index host hands back a
 * checked-in fixture index.scip (real scip-ruby output, see __fixtures__/sample-app), so it runs
 * everywhere with no Ruby toolchain. The live-toolchain counterpart is ruby-scip.e2e.test.ts (CI only).
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { rubyProvider } from '../../providers/ruby.js';
import type { RubyProfile } from '../../types/ruby-profile.js';
import { withOptionalIndexHost } from '../../facts/scip/index-host.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/sample-app');
const PROFILE: RubyProfile = { parserId: 'ruby-test', substrate: { language: 'ruby', include: [] } };
const OPTS = { repoRoot: FIXTURE, repoName: 'sample-app', repoKey: 'sample-app' };
const parse = (profile: RubyProfile = PROFILE) => rubyProvider.parse(profile, OPTS);

describe('ruby Tier-A dispatch (integration)', () => {
  it('basic never requests tools and the host decision controls enhanced parsing', async () => {
    const prepare = vi.fn().mockResolvedValue({ path: join(FIXTURE, 'index.scip') });
    await withOptionalIndexHost(prepare, () =>
      parse({ parserId: 'basic', substrate: { language: 'ruby', include: ['**/*.rb'], analysis: { mode: 'basic' } } }),
    );
    expect(prepare).not.toHaveBeenCalled();
    const result = await withOptionalIndexHost(prepare, () => parse());
    expect(prepare).toHaveBeenCalledWith({ language: 'ruby', fallback: true });
    expect(result.stats.analysis?.[0]?.mode).toBe('enhanced');
    prepare.mockResolvedValueOnce({ basic: true });
    const basic = await withOptionalIndexHost(prepare, () => parse());
    expect(basic.stats.analysis?.[0]?.mode).toBe('basic');
  });

  it('strict enhanced rejects a missing tool and cancellation never falls back', async () => {
    await expect(
      withOptionalIndexHost(
        () => Promise.reject(new Error('missing tool')),
        () =>
          parse({
            parserId: 'strict',
            substrate: { language: 'ruby', include: ['**/*.rb'], analysis: { fallback: false } },
          }),
      ),
    ).rejects.toThrow('missing tool');
    await expect(
      withOptionalIndexHost(
        () => Promise.reject(new DOMException('cancelled', 'AbortError')),
        () => parse(),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('unions scip-provenance edges from the injected index into calls', async () => {
    const ruby = await withOptionalIndexHost(
      async () => ({ path: join(FIXTURE, 'index.scip') }),
      () => parse(),
    );

    expect(ruby.stats.analysis).toEqual([
      { language: 'ruby', mode: 'enhanced', compilerReceiverTypes: false, fallback: false },
    ]);
    const nameById = new Map(ruby.functions.map((f) => [f.id, f.name]));
    const scipEdges = ruby.calls.filter((e) => e.provenance === 'scip');
    const pairs = new Set(scipEdges.map((e) => `${nameById.get(e.callerId)}->${nameById.get(e.calleeId)}`));

    // The fixture's bare self-sends — resolvable only by Sorbet, not the Tier-B heuristic.
    expect(scipEdges.length).toBeGreaterThanOrEqual(3);
    expect(pairs.has('build->validate!')).toBe(true);
    expect(pairs.has('validate!->normalize')).toBe(true);
    expect(pairs.has('validate!->name')).toBe(true);
    // Canonical ids: every scip edge endpoint is a real def node in the function set.
    for (const e of scipEdges) {
      expect(nameById.has(e.callerId)).toBe(true);
      expect(nameById.has(e.calleeId ?? '')).toBe(true);
    }
  });

  it('keeps enhanced analysis when the repo has rake tasks scip-ruby does not index', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ruby-rake-'));
    try {
      cpSync(FIXTURE, work, { recursive: true });
      mkdirSync(join(work, 'lib/tasks'), { recursive: true });
      writeFileSync(join(work, 'lib/tasks/seed.rake'), 'task :seed do\n  puts 1\nend\n');
      const ruby = await withOptionalIndexHost(
        async () => ({ path: join(work, 'index.scip') }),
        () => rubyProvider.parse(PROFILE, { ...OPTS, repoRoot: work }),
      );
      expect(ruby.stats.analysis?.[0]).toMatchObject({ mode: 'enhanced', fallback: false });
      expect(ruby.calls.some((e) => e.provenance === 'scip')).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('falls back to Tier-B with no throw and no scip edges when the indexer degrades', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ruby = await withOptionalIndexHost(
      () => Promise.reject(new Error('simulated: scip-ruby unavailable')),
      () => parse(),
    );
    expect(ruby.stats.analysis).toEqual([
      { language: 'ruby', mode: 'basic', compilerReceiverTypes: false, fallback: true },
    ]);
    expect(ruby.calls.some((e) => e.provenance === 'scip')).toBe(false);
    expect(warn).toHaveBeenCalled(); // opted-in-but-failed → warns, never throws
    warn.mockRestore();
  });
});
