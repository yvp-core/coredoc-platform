/**
 * Integration test for the Tier-A dispatch in parseRubyRepo — the prereq→run→loadScip→hooks→
 * toEdges→union path that the unit tests don't cover end-to-end. Deterministic: it injects a
 * `runScip` that returns a checked-in fixture index.scip (real scip-ruby output, see
 * __fixtures__/sample-app), so it runs everywhere with no Ruby toolchain. The live-toolchain
 * counterpart is ruby-scip.e2e.test.ts (CI only).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseRubyRepo, toFullParsedRepo } from './ruby-parser.js';
import { withOptionalIndexHost } from '../../facts/scip/index-host.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/sample-app');

describe('parseRubyRepo Tier-A dispatch (integration)', () => {
  it('basic never requests tools and the host decision controls enhanced parsing', async () => {
    const prepare = vi.fn().mockResolvedValue({ path: join(FIXTURE, 'index.scip') });
    await withOptionalIndexHost(prepare, () =>
      parseRubyRepo(
        FIXTURE,
        'sample-app',
        {},
        {
          parserId: 'basic',
          substrate: { language: 'ruby', include: ['**/*.rb'], analysis: { mode: 'basic' } },
        },
      ),
    );
    expect(prepare).not.toHaveBeenCalled();
    const result = await withOptionalIndexHost(prepare, () => parseRubyRepo(FIXTURE, 'sample-app'));
    expect(prepare).toHaveBeenCalledWith({ language: 'ruby', fallback: true });
    expect(result.parseStats.analysis?.mode).toBe('enhanced');
    prepare.mockResolvedValueOnce({ basic: true });
    const basic = await withOptionalIndexHost(prepare, () => parseRubyRepo(FIXTURE, 'sample-app'));
    expect(basic.parseStats.analysis?.mode).toBe('basic');
  });

  it('strict enhanced rejects a missing tool and cancellation never falls back', async () => {
    await expect(
      parseRubyRepo(
        FIXTURE,
        'sample-app',
        { runScip: () => ({ ok: false, degradeReason: 'missing tool' }) },
        {
          parserId: 'strict',
          substrate: { language: 'ruby', include: ['**/*.rb'], analysis: { fallback: false } },
        },
      ),
    ).rejects.toThrow('missing tool');
    await expect(
      withOptionalIndexHost(
        () => Promise.reject(new DOMException('cancelled', 'AbortError')),
        () => parseRubyRepo(FIXTURE, 'sample-app'),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('unions scip-provenance edges from the injected index into calls', async () => {
    const ruby = await parseRubyRepo(FIXTURE, 'sample-app', {
      repoKey: 'sample-app',
      runScip: () => ({ ok: true, scipPath: join(FIXTURE, 'index.scip') }),
    });

    expect(toFullParsedRepo(ruby, FIXTURE, 'ruby-test', new Date().toISOString()).stats.analysis).toEqual([
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

  it('falls back to Tier-B with no throw and no scip edges when the indexer degrades', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ruby = await parseRubyRepo(FIXTURE, 'sample-app', {
      repoKey: 'sample-app',
      runScip: () => ({ ok: false, degradeReason: 'simulated: scip-ruby unavailable' }),
    });
    expect(toFullParsedRepo(ruby, FIXTURE, 'ruby-test', new Date().toISOString()).stats.analysis).toEqual([
      { language: 'ruby', mode: 'basic', compilerReceiverTypes: false, fallback: true },
    ]);
    expect(ruby.calls.some((e) => e.provenance === 'scip')).toBe(false);
    expect(warn).toHaveBeenCalled(); // opted-in-but-failed → warns, never throws
    warn.mockRestore();
  });
});
