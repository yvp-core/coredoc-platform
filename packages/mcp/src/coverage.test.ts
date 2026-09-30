/**
 * Tests for the extraction-coverage helper module (density math, thresholds,
 * trust-guidance lines, and the low-coverage caveat used by empty results).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GRAPH_READ_CAPABILITY_IDENTITY } from '@coredoc/db';
import {
  EXTERNAL_RESOLUTION_LOW_THRESHOLD,
  COVERAGE_CACHE_TTL_MS,
  appendLowCoverageCaveat,
  computeCoverageStats,
  lowCoverageCaveat,
  resetCoverageCaveatCache,
  DYNAMIC_DISPATCH_CAVEAT,
  STRUCTURALLY_BLIND_CATEGORIES,
  STRUCTURALLY_BLIND_HEADING,
  structurallyBlindCategoriesFor,
  structurallyBlindGuidanceLines,
} from './coverage.js';
import * as coverageModule from './coverage.js';
import { debug } from './debug-logger.js';
import type { McpResponse } from './types.js';
import { createMockRepository, createMockCoverageCounts } from './__tests__/fixtures/mock-repository.js';

// Spy on the debug logger so the advisory catch's observability is testable
// without flipping MCP_DEBUG (its gate is evaluated at module load).
vi.mock('./debug-logger.js', () => ({ debug: vi.fn() }));

const HASHES = ['abc123def456'];

// The caveat-path memo is module-level state — reset it so each test sees the
// counts its own mock repository returns.
beforeEach(() => {
  resetCoverageCaveatCache();
});

// externalResolution is the only category with a threshold: call resolution and
// entity operations are reported as counts, never as a verdict.
describe('threshold constants', () => {
  it('keep externalResolution as the only LOW threshold', () => {
    expect(EXTERNAL_RESOLUTION_LOW_THRESHOLD).toBe(0.2);
    expect(Object.keys(coverageModule).filter((k) => k.endsWith('_LOW_THRESHOLD'))).toEqual([
      'EXTERNAL_RESOLUTION_LOW_THRESHOLD',
    ]);
  });
});

// The registry is the honesty layer for categories with NO edge at all: no
// density can flag them, so the list is declared and each entry must name the
// issue that retires it (an entry outliving its gap is the opposite-direction
// false signal).
describe('structurally blind categories registry', () => {
  it('is non-empty (a silent registry is the failure mode it exists to prevent)', () => {
    expect(STRUCTURALLY_BLIND_CATEGORIES.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = STRUCTURALLY_BLIND_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every entry a non-empty shape, guidance and retiredBy', () => {
    for (const category of STRUCTURALLY_BLIND_CATEGORIES) {
      expect(category.id.length).toBeGreaterThan(0);
      expect(category.shape.length).toBeGreaterThan(0);
      expect(category.guidance.length).toBeGreaterThan(0);
      expect(category.retiredBy.length).toBeGreaterThan(0);
    }
  });

  it('no longer lists enum member-value references (the gap closed; the entry retired with it)', () => {
    const ids = STRUCTURALLY_BLIND_CATEGORIES.map((c) => c.id);
    expect(ids).not.toContain('enum-member-value-references');
  });

  it('points every retiredBy at a numbered roadmap issue', () => {
    for (const category of STRUCTURALLY_BLIND_CATEGORIES) {
      expect(category.retiredBy).toMatch(/roadmap issue \d{2} \(/);
    }
  });

  it('keeps profile-dependent gaps conditional instead of claiming a global absence', () => {
    const conditional = STRUCTURALLY_BLIND_CATEGORIES.filter(
      (c) => c.id === 'test-callback-calls' || c.id === 'dynamic-queue-destinations',
    );

    expect(conditional).toHaveLength(2);
    for (const category of conditional) {
      expect(category.guidance).toContain("unless the repo's profile");
    }
  });

  it('no longer lists the declaration hierarchy (the gap closed; the entry retired with it)', () => {
    const ids = STRUCTURALLY_BLIND_CATEGORIES.map((c) => c.id);
    expect(ids).not.toContain('interface-dispatch-hierarchy');
    expect(DYNAMIC_DISPATCH_CAVEAT).toContain('CALLS edges cover statically resolvable dispatch only');
  });

  it('narrows the dispatch caveat to what is still blind after interface-dispatch binding', () => {
    // The TS/JS call half closed for the SOLE-implementation case only, and the binding it emits
    // is inferred rather than proven — the caveat must say both, or it turns from a false
    // "nothing is bound" into a false "everything is proven".
    expect(DYNAMIC_DISPATCH_CAVEAT).toContain('typed by an in-repo interface IS bound');
    expect(DYNAMIC_DISPATCH_CAVEAT).toContain('exactly one declaration in scope implements that interface');
    // The exception is a SHAPE (a declared supertype), not a language: Kotlin emits the same
    // `iface-impl` provenance, so wording that scopes it to TS/JS understates what is bound.
    expect(DYNAMIC_DISPATCH_CAVEAT).toContain('Kotlin supertype list');
    expect(DYNAMIC_DISPATCH_CAVEAT).not.toContain('in TypeScript/JavaScript, a call');
    // Densities are gone from this surface; the caveat must not resurrect the word.
    expect(DYNAMIC_DISPATCH_CAVEAT).toContain('applies at any resolution rate');
    expect(DYNAMIC_DISPATCH_CAVEAT).not.toContain('density');
    expect(DYNAMIC_DISPATCH_CAVEAT).toContain('inferred (stored at reduced confidence)');
    expect(DYNAMIC_DISPATCH_CAVEAT).toContain('two or more implementations stays unresolved');
    // Still the category's headline claim: everything else in it remains absent.
    expect(DYNAMIC_DISPATCH_CAVEAT).toContain('proxies, DI containers, handler registries or reflection');
  });

  // The hierarchy gap closed for the TS/JS substrate ONLY: other substrates populate heritage
  // NAMES and never bind them, so enumerating implementors there is still structurally empty. A
  // globally retired entry made that read as completeness on exactly those repos.
  it('re-states hierarchy blindness for a substrate proven non-TS/JS', () => {
    const ids = structurallyBlindCategoriesFor({ languages: ['ruby'] }).map((c) => c.id);

    expect(ids).toContain('non-ts-declaration-hierarchy');
  });

  it('stays silent about hierarchy for a TS/JS substrate and for an unreported one', () => {
    for (const context of [{ languages: ['typescript', 'javascript'] }, { languages: [] }, undefined]) {
      const ids = structurallyBlindCategoriesFor(context).map((c) => c.id);
      expect(ids).not.toContain('non-ts-declaration-hierarchy');
    }
  });

  it('names the substrate condition in the conditional entry, not a framework', () => {
    const entry = structurallyBlindCategoriesFor({ languages: ['python'] }).find(
      (c) => c.id === 'non-ts-declaration-hierarchy',
    )!;

    expect(entry.guidance).toContain('TypeScript/JavaScript substrate');
    expect(entry.guidance).toContain('grep');
  });

  it('tells the agent what to do instead of trusting the empty result', () => {
    for (const category of STRUCTURALLY_BLIND_CATEGORIES) {
      expect(category.guidance).toContain('grep');
    }
  });

  it('does not promise the heading claim unconditionally', () => {
    expect(STRUCTURALLY_BLIND_HEADING).toContain('not modelled — at all, or under common profiles');
  });

  it('renders one guidance line per APPLICABLE entry, carrying its shape', () => {
    const applicable = structurallyBlindCategoriesFor({ languages: ['ruby'] });
    const lines = structurallyBlindGuidanceLines({ languages: ['ruby'] });

    expect(lines).toHaveLength(applicable.length);
    for (const [index, category] of applicable.entries()) {
      expect(lines[index]).toContain(category.shape);
      expect(lines[index]).toContain(category.guidance);
    }
    // Without a context only the unconditional entries render.
    expect(structurallyBlindGuidanceLines()).toHaveLength(
      STRUCTURALLY_BLIND_CATEGORIES.filter((c) => !c.appliesWhen).length,
    );
  });
});

describe('computeCoverageStats', () => {
  it('passes the raw counts and the call-resolution record through', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([
        createMockCoverageCounts({
          repoName: 'svc',
          entityCount: 10,
          entitiesWithDbOps: 5,
          functionCount: 100,
          functionsWithCalls: 40,
          externalCallCount: 20,
          resolvedExternalCallCount: 15,
          callResolution: { callSites: 300, resolvedCalls: 180, outOfScopeCalls: 60 },
        }),
      ]),
    });

    const stats = await computeCoverageStats(repo, HASHES);

    expect(repo.getCoverageCounts).toHaveBeenCalledWith(HASHES);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      repoName: 'svc',
      entityCount: 10,
      entitiesWithDbOps: 5,
      functionCount: 100,
      functionsWithCalls: 40,
      externalResolutionRate: 0.75,
      callResolution: { callSites: 300, resolvedCalls: 180, outOfScopeCalls: 60 },
    });
    expect(stats[0]).not.toHaveProperty('dbOpDensity');
    expect(stats[0]).not.toHaveProperty('callDensity');
    expect(stats[0]!.guidance).toEqual([]);
  });

  it('leaves callResolution undefined when the graph carries no record (never 0/0/0)', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([createMockCoverageCounts({ repoName: 'svc' })]),
    });

    const [stats] = await computeCoverageStats(repo, HASHES);

    expect(stats!.callResolution).toBeUndefined();
  });

  it('attributes each repo its dominant package language (the substrate signal blind entries gate on)', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([createMockCoverageCounts({ repoName: 'api' })]),
      getRepositoryNames: vi.fn().mockResolvedValue([{ hash: 'abc123def456', name: 'api' }]),
      getPackages: vi.fn().mockResolvedValue([
        { name: 'app', path: '.', language: 'ruby', repoId: 'abc123def456' },
        { name: 'lib', path: 'lib', language: 'ruby', repoId: 'abc123def456' },
        { name: 'tooling', path: 'tooling', language: 'typescript', repoId: 'abc123def456' },
      ]),
    });

    const [stats] = await computeCoverageStats(repo, HASHES);

    expect(stats!.primaryLanguage).toBe('ruby');
  });

  it('leaves the language unset when the graph reports none, and when the lookup fails', async () => {
    const silent = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([createMockCoverageCounts()]),
    });
    const failing = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([createMockCoverageCounts()]),
      getPackages: vi.fn().mockRejectedValue(new Error('backend down')),
    });

    // Unknown must never be guessed as TS/JS or as non-TS: both would be a claim the graph
    // does not support, and the conditional blind entry only fires on a proven language.
    expect((await computeCoverageStats(silent, HASHES))[0]!.primaryLanguage).toBeUndefined();
    expect((await computeCoverageStats(failing, HASHES))[0]!.primaryLanguage).toBeUndefined();
  });

  it('treats a zero external denominator as rate 0 (never NaN)', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([
        createMockCoverageCounts({
          entityCount: 0,
          entitiesWithDbOps: 0,
          functionCount: 0,
          functionsWithCalls: 0,
          externalCallCount: 0,
          resolvedExternalCallCount: 0,
        }),
      ]),
    });

    const stats = await computeCoverageStats(repo, HASHES);

    expect(stats[0]!.externalResolutionRate).toBe(0);
  });

  it('flags externalResolution even with nothing else extracted', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([
        createMockCoverageCounts({
          // No entities / no functions: "LOW 0% of entities" would be nonsense.
          entityCount: 0,
          entitiesWithDbOps: 0,
          functionCount: 0,
          functionsWithCalls: 0,
          // 0 extracted external calls IS the suspicious case — still flagged.
          externalCallCount: 0,
          resolvedExternalCallCount: 0,
        }),
      ]),
    });

    const [stats] = await computeCoverageStats(repo, HASHES);

    expect(stats!.guidance).toHaveLength(1);
    expect(stats!.guidance[0]).toContain('external-call resolution LOW');
  });

  it('emits ONLY the externalResolution LOW line — sparse calls and entities are never a verdict', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([
        createMockCoverageCounts({
          entityCount: 100,
          entitiesWithDbOps: 12,
          functionCount: 100,
          functionsWithCalls: 25,
          externalCallCount: 100,
          resolvedExternalCallCount: 10, // 10% < 0.20
          callResolution: { callSites: 1000, resolvedCalls: 100, outOfScopeCalls: 100 },
        }),
      ]),
    });

    const [stats] = await computeCoverageStats(repo, HASHES);

    expect(stats!.guidance).toHaveLength(1);
    expect(stats!.guidance[0]).toContain('external-call resolution LOW (10% of external calls');
    expect(stats!.guidance[0]).toContain('list_service_dependencies');
  });

  it('an external rate exactly AT its threshold is healthy (LOW means strictly below)', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([
        createMockCoverageCounts({
          entityCount: 10,
          entitiesWithDbOps: 2,
          functionCount: 10,
          functionsWithCalls: 3,
          externalCallCount: 10,
          resolvedExternalCallCount: 2, // exactly 0.20
        }),
      ]),
    });

    const [stats] = await computeCoverageStats(repo, HASHES);

    expect(stats!.guidance).toEqual([]);
  });
});

const measured = (over: { callSites: number; resolvedCalls: number; outOfScopeCalls: number; repoName?: string }) =>
  createMockCoverageCounts({
    repoName: over.repoName ?? 'test-service',
    callResolution: {
      callSites: over.callSites,
      resolvedCalls: over.resolvedCalls,
      outOfScopeCalls: over.outOfScopeCalls,
    },
  });

const dbMeasured = (over: { dbOpSites: number; boundDbOps: number; outOfScopeDbOps: number; repoName?: string }) =>
  createMockCoverageCounts({
    repoName: over.repoName ?? 'test-service',
    dbOpResolution: {
      dbOpSites: over.dbOpSites,
      boundDbOps: over.boundDbOps,
      outOfScopeDbOps: over.outOfScopeDbOps,
    },
  });

describe('lowCoverageCaveat — call category (counts, never a density)', () => {
  it('states the unbound in-repo sites for a single measured repo', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([measured({ callSites: 120, resolvedCalls: 60, outOfScopeCalls: 20 })]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'call')).toBe(
      'Note: 40 of 100 counted in-repo call sites are unbound across 1 measured repo(s) — an empty result here may be an unbound call, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  it('returns null only when every repo in scope is measured and nothing is unbound', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([measured({ callSites: 100, resolvedCalls: 80, outOfScopeCalls: 20 })]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'call')).toBeNull();
  });

  it('names the unmeasured repos of a mixed scope instead of summing them as complete', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([
          measured({ repoName: 'a', callSites: 60, resolvedCalls: 30, outOfScopeCalls: 10 }),
          createMockCoverageCounts({ repoName: 'legacy' }),
        ]),
    });

    expect(await lowCoverageCaveat(repo, ['aaa', 'bbb'], 'call')).toBe(
      'Note: 20 of 50 counted in-repo call sites are unbound across 1 measured repo(s); not measured for legacy — an empty result here may be an unbound call, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  it('still speaks up for an unmeasured repo when the measured ones are fully bound', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([
          measured({ repoName: 'a', callSites: 100, resolvedCalls: 80, outOfScopeCalls: 20 }),
          createMockCoverageCounts({ repoName: 'legacy' }),
        ]),
    });

    expect(await lowCoverageCaveat(repo, ['aaa', 'bbb'], 'call')).toContain('not measured for legacy');
  });

  // A record whose out-of-scope count exceeds its call sites cannot be true. It used to be
  // CLAMPED into the "all out of scope" sentence, which reports a corrupt record as a measured
  // fact; it must name itself as broken instead — and still never print a negative count.
  it('names an inconsistent record as inconsistent when out-of-scope exceeds the call sites', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([measured({ callSites: 10, resolvedCalls: 0, outOfScopeCalls: 40 })]),
    });

    const caveat = await lowCoverageCaveat(repo, HASHES, 'call');
    expect(caveat).not.toMatch(/-\d/);
    expect(caveat).toBe(
      'Note: inconsistent call-resolution record — re-parse and re-push (0 bound, 40 out of scope over 10 counted sites) — an empty result here may be an unbound call, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  // Resolved above the in-scope denominator is the other impossible record; same treatment.
  it('names an inconsistent record when more calls are bound than are in scope', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([measured({ callSites: 100, resolvedCalls: 150, outOfScopeCalls: 0 })]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'call')).toContain('inconsistent call-resolution record');
  });

  // A MEASURED all-zero record (the engine really emits it for a repo with no call site) is not
  // "all out of scope" — there was nothing to put in or out of scope.
  it('says no call site was counted for a measured all-zero record', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([measured({ callSites: 0, resolvedCalls: 0, outOfScopeCalls: 0 })]),
    });

    const caveat = await lowCoverageCaveat(repo, HASHES, 'call');
    expect(caveat).toBe(
      'Note: no call site was counted for this scope — an empty result here may be an unbound call, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
    expect(caveat).not.toContain('all out of scope');
  });

  // The unmeasured list qualifies the caveat; on a wide scope it must not BE the caveat.
  it('caps the named unmeasured repos at three', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([
          measured({ repoName: 'a', callSites: 100, resolvedCalls: 60, outOfScopeCalls: 0 }),
          createMockCoverageCounts({ repoName: 'l1' }),
          createMockCoverageCounts({ repoName: 'l2' }),
          createMockCoverageCounts({ repoName: 'l3' }),
          createMockCoverageCounts({ repoName: 'l4' }),
          createMockCoverageCounts({ repoName: 'l5' }),
        ]),
    });

    const caveat = await lowCoverageCaveat(repo, ['aaa'], 'call');
    expect(caveat).toContain('not measured for l1, l2, l3 and 2 more');
    expect(caveat).not.toContain('l4');
  });

  // Everything the measured repos counted points outward: "0 of 0 unbound" would read as a
  // measured, perfect graph. Say what is actually true, and still name the unmeasured repo.
  it('says nothing is in scope when every measured site is out of scope', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([
          measured({ repoName: 'a', callSites: 12, resolvedCalls: 0, outOfScopeCalls: 12 }),
          createMockCoverageCounts({ repoName: 'legacy' }),
        ]),
    });

    expect(await lowCoverageCaveat(repo, ['aaa', 'bbb'], 'call')).toBe(
      'Note: no counted call site names a declaration in this repository (12 counted sites, all out of scope); not measured for legacy — an empty result here may be an unbound call, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  it('says not measured when no repo in scope carries the record', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([createMockCoverageCounts()]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'call')).toBe(
      'Note: call resolution is not measured for this scope (re-parse and re-push to measure) — an empty result may be a gap, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  it('never prints a density percent', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([measured({ callSites: 120, resolvedCalls: 60, outOfScopeCalls: 20 })]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'call')).not.toContain('%');
  });
});

describe('lowCoverageCaveat — dbOp and externalResolution', () => {
  it('states the unbound counted db-operation sites for a single measured repo', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([dbMeasured({ dbOpSites: 120, boundDbOps: 60, outOfScopeDbOps: 20 })]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'dbOp')).toBe(
      'Note: 40 of 100 counted db-operation sites are unbound across 1 measured repo(s) — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  it('returns null only when every repo in scope is measured and nothing is unbound', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([dbMeasured({ dbOpSites: 100, boundDbOps: 80, outOfScopeDbOps: 20 })]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'dbOp')).toBeNull();
  });

  it('names the unmeasured repos of a mixed scope instead of summing them as complete', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([
          dbMeasured({ repoName: 'a', dbOpSites: 60, boundDbOps: 30, outOfScopeDbOps: 10 }),
          createMockCoverageCounts({ repoName: 'legacy' }),
        ]),
    });

    expect(await lowCoverageCaveat(repo, ['aaa', 'bbb'], 'dbOp')).toBe(
      'Note: 20 of 50 counted db-operation sites are unbound across 1 measured repo(s); not measured for legacy — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  it('says nothing is in scope when every measured site is out of scope', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([
          dbMeasured({ repoName: 'a', dbOpSites: 12, boundDbOps: 0, outOfScopeDbOps: 12 }),
          createMockCoverageCounts({ repoName: 'legacy' }),
        ]),
    });

    const caveat = await lowCoverageCaveat(repo, ['aaa', 'bbb'], 'dbOp');
    expect(caveat).not.toMatch(/-\d/);
    expect(caveat).toBe(
      'Note: no counted db-operation site names an entity or table declared in this repository (12 counted sites, all out of scope); not measured for legacy — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  // Previously this record (more out of scope than counted) was clamped into the sentence above,
  // reporting an impossible record as a measured fact.
  it('names an inconsistent db-operation record as inconsistent', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([dbMeasured({ repoName: 'a', dbOpSites: 12, boundDbOps: 0, outOfScopeDbOps: 40 })]),
    });

    const caveat = await lowCoverageCaveat(repo, ['aaa'], 'dbOp');
    expect(caveat).not.toMatch(/-\d/);
    expect(caveat).toBe(
      'Note: inconsistent db-operation-resolution record — re-parse and re-push (0 bound, 40 out of scope over 12 counted sites) — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  it('says no db-operation site was counted for a measured all-zero record', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([dbMeasured({ dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 })]),
    });

    const caveat = await lowCoverageCaveat(repo, HASHES, 'dbOp');
    expect(caveat).toBe(
      'Note: no db-operation site was counted for this scope — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
    expect(caveat).not.toContain('all out of scope');
  });

  it('says not measured when no repo in scope carries the record, even with no entities', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([createMockCoverageCounts({ entityCount: 0, entitiesWithDbOps: 0 })]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'dbOp')).toBe(
      'Note: db-operation resolution is not measured for this scope (re-parse and re-push to measure) — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  it('never prints a density percent', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([dbMeasured({ dbOpSites: 120, boundDbOps: 60, outOfScopeDbOps: 20 })]),
    });

    const caveat = await lowCoverageCaveat(repo, HASHES, 'dbOp');

    expect(caveat).toContain('40 of 100 counted db-operation sites');
    expect(caveat).not.toContain('%');
  });

  it('uses the external resolution rate for the externalResolution category (unchanged)', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([createMockCoverageCounts({ externalCallCount: 100, resolvedExternalCallCount: 10 })]),
    });

    const caveat = await lowCoverageCaveat(repo, HASHES, 'externalResolution');

    expect(caveat).toContain("this repo's external-call extraction density is low (10%)");
  });

  it('returns null for a healthy external resolution rate (unchanged)', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([createMockCoverageCounts()]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'externalResolution')).toBeNull();
  });

  it('aggregates counted db-operation sites across a multi-repo scope', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([
          dbMeasured({ repoName: 'a', dbOpSites: 20, boundDbOps: 5, outOfScopeDbOps: 0 }),
          dbMeasured({ repoName: 'b', dbOpSites: 10, boundDbOps: 5, outOfScopeDbOps: 0 }),
        ]),
    });

    expect(await lowCoverageCaveat(repo, ['aaa', 'bbb'], 'dbOp')).toContain(
      '20 of 30 counted db-operation sites are unbound across 2 measured repo(s)',
    );
  });

  it('returns null when no repository matched the scope (nothing to judge)', async () => {
    const repo = createMockRepository({ getCoverageCounts: vi.fn().mockResolvedValue([]) });

    expect(await lowCoverageCaveat(repo, HASHES, 'dbOp')).toBeNull();
  });

  // "No entity to cover" is NOT the same fact as "this parser never counted db-operation sites",
  // so an unmeasured empty scope still says not measured (spec BR-6).
  it('says not measured for dbOp when the scope has no entities and no record', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([createMockCoverageCounts({ entityCount: 0 })]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'dbOp')).toBe(
      'Note: db-operation resolution is not measured for this scope (re-parse and re-push to measure) — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.',
    );
  });

  it('keeps the externalResolution caveat when 0 external calls were extracted (0/0 is suspicious)', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([createMockCoverageCounts({ externalCallCount: 0, resolvedExternalCallCount: 0 })]),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'externalResolution')).toContain(
      'external-call extraction density is low (0%)',
    );
  });

  it('returns null (documented advisory fallback) when the counts query fails, logging the error', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockRejectedValue(new Error('db exploded')),
    });

    expect(await lowCoverageCaveat(repo, HASHES, 'dbOp')).toBeNull();
    expect(debug).toHaveBeenCalledWith('lowCoverageCaveat', expect.stringContaining('db exploded'));
  });
});

describe('lowCoverageCaveat memoization (caveat path only)', () => {
  const lowDbOpCounts = () =>
    vi.fn().mockResolvedValue([dbMeasured({ dbOpSites: 100, boundDbOps: 60, outOfScopeDbOps: 20 })]);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves repeat caveat calls within the TTL from the memo (one counts query)', async () => {
    const repo = createMockRepository({ getCoverageCounts: lowDbOpCounts() });

    const first = await lowCoverageCaveat(repo, HASHES, 'dbOp');
    const second = await lowCoverageCaveat(repo, HASHES, 'dbOp');
    // Same scope, different category — the memo stores COUNTS, not the line.
    await lowCoverageCaveat(repo, HASHES, 'call');

    expect(repo.getCoverageCounts).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('re-queries once the TTL has expired', async () => {
    vi.useFakeTimers();
    const repo = createMockRepository({ getCoverageCounts: lowDbOpCounts() });

    await lowCoverageCaveat(repo, HASHES, 'dbOp');
    vi.setSystemTime(Date.now() + COVERAGE_CACHE_TTL_MS + 1);
    await lowCoverageCaveat(repo, HASHES, 'dbOp');

    expect(repo.getCoverageCounts).toHaveBeenCalledTimes(2);
  });

  it('keys the memo on the repo-hash SET (order-insensitive; other scopes miss)', async () => {
    const repo = createMockRepository({ getCoverageCounts: lowDbOpCounts() });

    await lowCoverageCaveat(repo, ['aaa', 'bbb'], 'dbOp');
    await lowCoverageCaveat(repo, ['bbb', 'aaa'], 'dbOp');
    expect(repo.getCoverageCounts).toHaveBeenCalledTimes(1);

    await lowCoverageCaveat(repo, ['ccc'], 'dbOp');
    expect(repo.getCoverageCounts).toHaveBeenCalledTimes(2);
  });

  it('never reuses counts across repository identities with the same repo hashes', async () => {
    const versionN = createMockRepository({ getCoverageCounts: lowDbOpCounts() });
    const versionN1 = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([dbMeasured({ dbOpSites: 100, boundDbOps: 10, outOfScopeDbOps: 20 })]),
    });

    expect(await lowCoverageCaveat(versionN, HASHES, 'dbOp')).toContain('20 of 80 counted db-operation sites');
    expect(await lowCoverageCaveat(versionN1, HASHES, 'dbOp')).toContain('70 of 80 counted db-operation sites');
    expect(versionN.getCoverageCounts).toHaveBeenCalledTimes(1);
    expect(versionN1.getCoverageCounts).toHaveBeenCalledTimes(1);
  });

  it('reuses counts across scoped facades with one opaque graph capability identity', async () => {
    const identity = Object.freeze({});
    const firstFacade = createMockRepository({ getCoverageCounts: lowDbOpCounts() });
    const secondFacade = createMockRepository({ getCoverageCounts: lowDbOpCounts() });
    Object.defineProperty(firstFacade, GRAPH_READ_CAPABILITY_IDENTITY, { value: identity });
    Object.defineProperty(secondFacade, GRAPH_READ_CAPABILITY_IDENTITY, { value: identity });

    expect(await lowCoverageCaveat(firstFacade, HASHES, 'dbOp')).toContain('20 of 80 counted db-operation sites');
    expect(await lowCoverageCaveat(secondFacade, HASHES, 'dbOp')).toContain('20 of 80 counted db-operation sites');
    expect(firstFacade.getCoverageCounts).toHaveBeenCalledOnce();
    expect(secondFacade.getCoverageCounts).not.toHaveBeenCalled();
  });

  it('does not memoize a failed counts query (the next call retries)', async () => {
    const getCoverageCounts = vi
      .fn()
      .mockRejectedValueOnce(new Error('db exploded'))
      .mockResolvedValue([dbMeasured({ dbOpSites: 100, boundDbOps: 60, outOfScopeDbOps: 20 })]);
    const repo = createMockRepository({ getCoverageCounts });

    expect(await lowCoverageCaveat(repo, HASHES, 'dbOp')).toBeNull();
    expect(await lowCoverageCaveat(repo, HASHES, 'dbOp')).toContain('20 of 80 counted db-operation sites');
    expect(getCoverageCounts).toHaveBeenCalledTimes(2);
  });

  it('computeCoverageStats (the get_extraction_coverage tool path) stays uncached', async () => {
    const repo = createMockRepository({ getCoverageCounts: lowDbOpCounts() });

    await computeCoverageStats(repo, HASHES);
    await computeCoverageStats(repo, HASHES);

    expect(repo.getCoverageCounts).toHaveBeenCalledTimes(2);
  });
});

describe('appendLowCoverageCaveat', () => {
  const lowDbOpRepo = () =>
    createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([dbMeasured({ dbOpSites: 100, boundDbOps: 60, outOfScopeDbOps: 20 })]),
    });

  const metadata = {} as McpResponse<unknown>['metadata'];

  it('puts the caveat before a summary and preserves it in metadata', async () => {
    const response: McpResponse<unknown> = { data: "Entity 'Ghost' not found in scope", metadata };

    await appendLowCoverageCaveat(response, lowDbOpRepo(), HASHES, 'dbOp');

    expect(response.data).toBe(
      "Note: 20 of 80 counted db-operation sites are unbound across 1 measured repo(s) — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.\n\nEntity 'Ghost' not found in scope",
    );
  });

  it('preserves raw result data and attaches the evidence limit to metadata', async () => {
    const repo = lowDbOpRepo();
    const response: McpResponse<unknown> = { data: [], metadata };

    await appendLowCoverageCaveat(response, repo, HASHES, 'dbOp');

    expect(response.data).toEqual([]);
    expect(repo.getCoverageCounts).toHaveBeenCalledWith(HASHES);
    expect(response.metadata.warnings?.[0]).toContain('20 of 80 counted db-operation sites');
  });

  it('appends nothing when every repo is measured and no in-repo call site is unbound', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([
        createMockCoverageCounts({
          callResolution: { callSites: 100, resolvedCalls: 80, outOfScopeCalls: 20 },
        }),
      ]),
    });
    const response: McpResponse<unknown> = { data: 'No consumers found', metadata };

    await appendLowCoverageCaveat(response, repo, HASHES, 'call');

    expect(response.data).toBe('No consumers found');
  });

  it('never throws — a failed counts query leaves the response as-is', async () => {
    const repo = createMockRepository({
      getCoverageCounts: vi.fn().mockRejectedValue(new Error('db exploded')),
    });
    const response: McpResponse<unknown> = { data: 'No consumers found', metadata };

    await expect(appendLowCoverageCaveat(response, repo, HASHES, 'dbOp')).resolves.toBeUndefined();
    expect(response.data).toBe('No consumers found');
  });
});
