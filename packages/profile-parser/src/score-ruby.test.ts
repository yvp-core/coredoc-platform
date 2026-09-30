import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rubySourceSignals } from './scoring/ruby-signals.js';
import {
  type CategoryCounts,
  type SourceSignals,
  coverageRedFlags,
  isOverallPass,
  scoreCategories,
} from './scoring/score-core.js';
import type { RubyProfile } from './types.js';

/**
 * B4 — a deterministic coverage gate for the Ruby /author-profile loop. After the Step-4
 * scorer unification, Ruby scoring IS the shared score-core math (no structural checks):
 * scoreCategories + coverageRedFlags + isOverallPass. The entity denominator is PRECISE
 * (schema.rb `create_table` count); http is an order-of-magnitude route-DSL signal;
 * db-ops/externalCalls/queue self-score; entities-but-no-db-ops fails the overall verdict.
 */

const baseProfile = (): RubyProfile => ({ parserId: 'x', substrate: { language: 'ruby', include: [] } });

/** Ruby scoring = score-core with no structural checks (mirrors the Ruby provider path). */
function scoreRuby(emitted: CategoryCounts, signals: SourceSignals) {
  const categories = scoreCategories(emitted, signals);
  const redFlags = coverageRedFlags(emitted, signals);
  return { categories, redFlags, overall: isOverallPass(categories, [], redFlags) };
}

describe('scoreRuby', () => {
  it('passes when emitted meets the source signal across categories', () => {
    const card = scoreRuby(
      { http: 100, queue: 0, entities: 20, dbOperations: 50, externalCalls: 10 },
      { http: 90, entities: 20 },
    );
    expect(card.overall).toBe(true);
    expect(card.categories.find((c) => c.category === 'entities')?.verdict).toBe('PASS');
  });

  it('fails entities coverage when emitted is far below the schema source', () => {
    const card = scoreRuby(
      { http: 10, queue: 0, entities: 2, dbOperations: 5, externalCalls: 0 },
      { http: 10, entities: 20 }, // 20 tables, 2 models → 0.1 → FAIL
    );
    expect(card.categories.find((c) => c.category === 'entities')?.verdict).toBe('FAIL');
    expect(card.overall).toBe(false);
  });

  it('flags entities present but zero dbOperations', () => {
    const card = scoreRuby(
      { http: 5, queue: 0, entities: 10, dbOperations: 0, externalCalls: 0 },
      { http: 5, entities: 10 },
    );
    expect(card.redFlags.some((f) => f.includes('entities present but 0 dbOperations'))).toBe(true);
    expect(card.overall).toBe(false);
  });

  it('treats a category with no source signal as not_applicable (PASS)', () => {
    const card = scoreRuby(
      { http: 0, queue: 0, entities: 0, dbOperations: 0, externalCalls: 0 },
      { http: 0, entities: 0 },
    );
    expect(card.categories.every((c) => c.verdict === 'PASS')).toBe(true);
    expect(card.overall).toBe(true);
  });
});

describe('externalCalls source signal (score-core math)', () => {
  const emittedBase = { http: 10, queue: 0, entities: 5, dbOperations: 5 };
  const signalsBase = { http: 10, entities: 5 };

  it('scores emitted/signal at the coarse 0.5 bar when the signal is present', () => {
    const card = scoreRuby({ ...emittedBase, externalCalls: 3 }, { ...signalsBase, externalCalls: 5 });
    const ext = card.categories.find((c) => c.category === 'externalCalls');
    expect(ext?.source).toBe(5);
    expect(ext?.ratio).toBeCloseTo(0.6);
    // 0.6 clears the coarse 0.5 externalCalls bar (would only be PARTIAL at the default 0.8 bar).
    expect(ext?.verdict).toBe('PASS');
  });

  it('fails an order-of-magnitude miss (2/45)', () => {
    const card = scoreRuby({ ...emittedBase, externalCalls: 2 }, { ...signalsBase, externalCalls: 45 });
    const ext = card.categories.find((c) => c.category === 'externalCalls');
    expect(ext?.verdict).toBe('FAIL');
    expect(card.overall).toBe(false);
  });

  it('passes at exactly the 0.5 boundary — PARTIAL is unreachable for externalCalls', () => {
    const atBoundary = scoreRuby({ ...emittedBase, externalCalls: 5 }, { ...signalsBase, externalCalls: 10 });
    const ext = atBoundary.categories.find((c) => c.category === 'externalCalls');
    expect(ext?.ratio).toBe(0.5);
    expect(ext?.verdict).toBe('PASS');

    // Just below the bar the PARTIAL floor (0.5) coincides with the PASS bar,
    // so the verdict drops straight to FAIL — no PARTIAL band exists here.
    const below = scoreRuby({ ...emittedBase, externalCalls: 4 }, { ...signalsBase, externalCalls: 10 });
    expect(below.categories.find((c) => c.category === 'externalCalls')?.verdict).toBe('FAIL');
  });

  it('keeps legacy self-relative behavior when the signal is undefined', () => {
    const card = scoreRuby({ ...emittedBase, externalCalls: 10 }, signalsBase);
    const ext = card.categories.find((c) => c.category === 'externalCalls');
    expect(ext?.source).toBe(10); // source = emitted → structurally PASS
    expect(ext?.verdict).toBe('PASS');
    expect(card.overall).toBe(true);
  });

  it('red-flags signal >= 5 with zero externalCalls emitted (fails overall)', () => {
    const card = scoreRuby({ ...emittedBase, externalCalls: 0 }, { ...signalsBase, externalCalls: 45 });
    expect(
      card.redFlags.some((f) =>
        f.includes(
          '45 call sites resolve into HTTP-client packages but 0 externalCalls emitted — the profile is missing an egress matcher',
        ),
      ),
    ).toBe(true);
    expect(card.overall).toBe(false);
  });

  it('does not red-flag below the 5-site noise floor', () => {
    const card = scoreRuby({ ...emittedBase, externalCalls: 0 }, { ...signalsBase, externalCalls: 4 });
    expect(card.redFlags.some((f) => f.includes('egress matcher'))).toBe(false);
  });
});

describe('dbOperations operated-entity basis (score-core math)', () => {
  // Schema-mirror shape: 92 mirrored entities, 39 ops touching 10 distinct entities.
  const emitted = { http: 10, queue: 0, entities: 92, dbOperations: 39, externalCalls: 0 };
  const signals = { http: 10, entities: 92 };

  it('scores against the operated-entity denominator and discloses the basis + raw ratio', () => {
    const card = scoreRuby(emitted, { ...signals, dbOperations: 10 });
    const db = card.categories.find((c) => c.category === 'dbOperations');
    expect(db?.source).toBe(10);
    expect(db?.ratio).toBe(1); // 39/10, capped
    expect(db?.verdict).toBe('PASS');
    expect(db?.note).toBe('operated-entity basis (raw 39/92 = 42%)');
  });

  it('keeps the emitted-entities denominator (and no note) when the signal is absent', () => {
    const card = scoreRuby(emitted, signals);
    const db = card.categories.find((c) => c.category === 'dbOperations');
    expect(db?.source).toBe(92);
    expect(db?.verdict).toBe('FAIL'); // 39/92 = 42% < 50%
    expect(db?.note).toBeUndefined();
  });

  it('renders a provider-supplied dbOperationsNote when the operated basis was declined', () => {
    // e.g. the TS provider ignoring schemaMirror for lack of generator evidence.
    const card = scoreRuby(emitted, {
      ...signals,
      dbOperationsNote: 'schemaMirror ignored (no entity-generator dependency found)',
    });
    const db = card.categories.find((c) => c.category === 'dbOperations');
    expect(db?.source).toBe(92); // all-entities basis kept
    expect(db?.note).toBe('schemaMirror ignored (no entity-generator dependency found)');
  });

  it('red-flags the schemaMirror basis when <5% of entities are operated and <10 ops emitted', () => {
    // The red-team shape: 92 mirrored entities, 1 op on 1 entity — the
    // operated basis alone would score ratio 1 (circular). The disparity flag
    // is what makes this fail.
    const gamed = scoreRuby(
      { http: 10, queue: 0, entities: 92, dbOperations: 1, externalCalls: 0 },
      { http: 10, entities: 92, dbOperations: 1 },
    );
    expect(
      gamed.redFlags.some((f) =>
        f.includes(
          'schemaMirror basis with <5% of entities operated and only 1 dbOperations — likely under-extraction, not a schema mirror',
        ),
      ),
    ).toBe(true);
    expect(gamed.overall).toBe(false);
  });

  it('does not flag a genuine schema-mirror shape (10 of 92 operated, 39 ops)', () => {
    const genuine = scoreRuby(emitted, { ...signals, dbOperations: 10 });
    expect(genuine.redFlags.some((f) => f.includes('schemaMirror basis'))).toBe(false);
  });

  it('does not fire the disparity flag when the operated basis is not in effect', () => {
    const noBasis = scoreRuby({ http: 10, queue: 0, entities: 92, dbOperations: 1, externalCalls: 0 }, signals);
    expect(noBasis.redFlags.some((f) => f.includes('schemaMirror basis'))).toBe(false);
  });
});

describe('rubySourceSignals', () => {
  it('counts create_table blocks (entities) and route DSL (http) from disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'score-ruby-'));
    const write = (rel: string, content: string) => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), content);
    };
    write('db/schema.rb', 'create_table "users" do |t|\nend\ncreate_table "teams" do |t|\nend\n');
    write('config/routes.rb', 'Rails.application.routes.draw do\n  resources :users\n  get "health"\nend\n');

    const sig = rubySourceSignals(root, baseProfile());
    expect(sig.entities).toBe(2);
    expect(sig.http).toBeGreaterThanOrEqual(2);
    // Ruby supplies no externalCalls signal → the category stays self-relative.
    expect(sig.externalCalls).toBeUndefined();
  });
});
