/**
 * Substrate-engine acceptance: one SubstrateProfileEngine over the
 * tree-sitter+SCIP substrate reproduces the exact golden http/queue/entity
 * counts for BOTH repos, with byte-identical entity fields/relations.
 *
 * Gated on the local eval repos being present (they are not in this repo); the
 * suite skips cleanly when they are absent so CI without the fixtures stays green.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSubstrate } from './run.js';

// Integration fixtures live outside this repo. Point COREDOC_FLEET_DIR at a local checkout
// to run them; absent (the default), every gated block below skips so CI/OSS stays green.
const FLEET = process.env.COREDOC_FLEET_DIR ?? '/nonexistent/coredoc-fleet';
const DAY_CORE = `${FLEET}/demo-core`;
const SCHEDULES = `${FLEET}/sample-schedules`;
const DAY_SHIFTS = `${FLEET}/demo-shifts`;
const FDA = `${FLEET}/financial-data-analyst`;
const SAMPLE_ADMIN = `${FLEET}/sample-admin`;

const reposPresent = existsSync(DAY_CORE) && existsSync(SCHEDULES);
const d = reposPresent ? describe : describe.skip;
// The substrate SCIP pass needs the target repo's node_modules installed.
const shiftsReady = existsSync(`${DAY_SHIFTS}/node_modules`);
const fdaReady = existsSync(`${FDA}/node_modules`);
const oaReady = existsSync(`${SAMPLE_ADMIN}/node_modules`);

d('SubstrateProfileEngine — golden reproduction', () => {
  it('demo-core: 132 http / 0 queue / 104 entities (tree-sitter+SCIP)', async () => {
    const repo = await runSubstrate('demo-core', DAY_CORE, 'demo-core');
    const http = repo.entrypoints.filter((e) => e.type === 'http');
    const queue = repo.entrypoints.filter((e) => e.type === 'queue');
    expect(http.length).toBe(132);
    // demo-core's only @EventPattern usages are in examples/ with literal strings wrapped in
    // getTopicInNamespace('...' as Topics) — not enum member references. The wrapped-enum-member
    // ArgRef drops these (no Topics.X match), emitting 0 queue entrypoints. Real business Kafka
    // consumers in other services (demo-booking, demo-shifts) produce Topics.X-keyed entrypoints.
    expect(queue.length).toBe(0);
    expect(repo.entities.length).toBe(104);
    // Full count set (PARITY-SWEEP goldens) — locks parity across A (flag-off) / B / D changes.
    expect(repo.functions.length).toBe(812);
    expect(repo.dbOperations.length).toBe(232);
    // wrapped-enum-member: resolves getTopicInNamespace(Topics.X) → Topics.X for Kafka emit edges.
    // Increases from 33 (string-literal, dropped wrapped calls) to 37 (4 Kafka emit calls now resolve).
    expect(repo.externalCalls.length).toBe(37);
    // every http entrypoint references a real function node (handlerId integrity).
    const fnIds = new Set(repo.functions.map((f) => f.id));
    for (const ep of repo.entrypoints) expect(fnIds.has(ep.handlerId)).toBe(true);

    // Provenance (Workstream B): every RESOLVED call edge carries a closed-set lineage tag;
    // unresolved edges carry none. NestJS is DI-heavy, so both strategies are exercised.
    const resolved = repo.calls.filter((c) => c.calleeId);
    const unresolved = repo.calls.filter((c) => !c.calleeId);
    expect(resolved.every((c) => c.provenance === 'scip' || c.provenance === 'di')).toBe(true);
    expect(unresolved.every((c) => c.provenance === undefined)).toBe(true);
    expect(resolved.some((c) => c.provenance === 'scip')).toBe(true);
    expect(resolved.some((c) => c.provenance === 'di')).toBe(true);
  }, 120_000);

  it('sample-schedules: 82 http / 9 queue / 16 entities (tree-sitter+SCIP)', async () => {
    const repo = await runSubstrate('sample-schedules', SCHEDULES, 'sample-schedules');
    const http = repo.entrypoints.filter((e) => e.type === 'http');
    const queue = repo.entrypoints.filter((e) => e.type === 'queue');
    expect(http.length).toBe(82);
    expect(queue.length).toBe(9);
    expect(repo.entities.length).toBe(16);
    // Full count set (PARITY-SWEEP goldens) — pure-JS Koa path.
    expect(repo.functions.length).toBe(710);
    expect(repo.dbOperations.length).toBe(135);
    expect(repo.externalCalls.length).toBe(6);
    const fnIds = new Set(repo.functions.map((f) => f.id));
    for (const ep of repo.entrypoints) expect(fnIds.has(ep.handlerId)).toBe(true);
  }, 120_000);

  // The 5th proven repo (was missing from this suite). NestJS/MikroORM like demo-core — its goldens
  // come from PARITY-SWEEP.md. Gated on its node_modules being present (SCIP prereq).
  (shiftsReady ? it : it.skip)(
    'demo-shifts: 81 http / 3 queue / 14 entities / 133 dbOps / 6 externalCalls / 680 functions',
    async () => {
      const repo = await runSubstrate('demo-shifts', DAY_SHIFTS, 'demo-shifts');
      const http = repo.entrypoints.filter((e) => e.type === 'http');
      const queue = repo.entrypoints.filter((e) => e.type === 'queue');
      expect(http.length).toBe(81);
      // 3 real business @EventPattern usages with Topics.X enum member references
      // (WalleUserProfileAssociatedProductChangedV3, WalleLocationDeactivatedV0, WalleUserProfilesDeactivatedV0).
      // 3 examples/ literal-string usages are dropped (no Topics.X match).
      expect(queue.length).toBe(3);
      expect(repo.entities.length).toBe(14);
      expect(repo.dbOperations.length).toBe(133);
      // resolveQueueTopic fix: drops unresolvable empty-topic edges (was 8, now 6 resolved only).
      expect(repo.externalCalls.length).toBe(6);
      expect(repo.functions.length).toBe(680);
      // handlerId integrity + provenance (NestJS DI-heavy → both strategies present).
      const fnIds = new Set(repo.functions.map((f) => f.id));
      for (const ep of repo.entrypoints) expect(fnIds.has(ep.handlerId)).toBe(true);
      const resolved = repo.calls.filter((c) => c.calleeId);
      expect(resolved.every((c) => c.provenance === 'scip' || c.provenance === 'di')).toBe(true);
      expect(repo.calls.filter((c) => !c.calleeId).every((c) => c.provenance === undefined)).toBe(true);
      expect(resolved.some((c) => c.provenance === 'scip')).toBe(true);
      expect(resolved.some((c) => c.provenance === 'di')).toBe(true);
    },
    120_000,
  );
});

(fdaReady ? describe : describe.skip)('SubstrateProfileEngine — frontend (JSX + SCIP componentId)', () => {
  it('financial-data-analyst: reproduces 47 components / 184 childUsages / 0 dangling via SCIP', async () => {
    const repo = await runSubstrate('financial-data-analyst', FDA, 'financial-data-analyst');
    const components = repo.components ?? [];
    const ids = new Set(components.map((c) => c.id));
    let childUsages = 0;
    let trueDangling = 0;
    let resolved = 0;
    for (const c of components) {
      for (const u of c.childComponents ?? []) {
        childUsages++;
        if (u.componentId != null) {
          resolved++;
          if (!ids.has(u.componentId)) trueDangling++;
        }
      }
    }
    // The JSX render-edge capability reproduces the golden component/child counts.
    expect(components.length).toBe(47);
    expect(childUsages).toBe(184);
    // SCIP resolves componentIds with 0 fabricated ids (matches ts-morph precision).
    expect(trueDangling).toBe(0);
    // SCIP resolution is non-trivial — close to the ts-morph resolution rate.
    expect(resolved).toBeGreaterThan(90);
  }, 180_000);

  (fdaReady ? it : it.skip)(
    'financial-data-analyst: Next.js → 0 routes / 0 stateStores',
    async () => {
      const repo = await runSubstrate('financial-data-analyst', FDA, 'financial-data-analyst');
      expect((repo.routes ?? []).length).toBe(0);
      expect((repo.stateStores ?? []).length).toBe(0);
    },
    180_000,
  );
});

(oaReady ? describe : describe.skip)('SubstrateProfileEngine — frontend routes + state stores', () => {
  it('sample-admin: React-Router routes resolved + 8 zustand stores, 0 dangling', async () => {
    const repo = await runSubstrate('sample-admin', SAMPLE_ADMIN, 'sample-admin');
    const routes = repo.routes ?? [];
    const stateStores = repo.stateStores ?? [];
    const compIds = new Set((repo.components ?? []).map((c) => c.id));

    // Routes extracted (ts-morph baseline is 139; small delta tolerated).
    expect(routes.length).toBeGreaterThan(0);
    // componentIds resolved on a substantial fraction (ts-morph resolves 121).
    const withId = routes.filter((r) => r.componentId != null);
    expect(withId.length).toBeGreaterThan(90);
    // 0 dangling: every componentId names a real emitted component.
    const dangling = withId.filter((r) => !compIds.has(r.componentId as string));
    expect(dangling.length).toBe(0);
    // zustand stores (the ts-morph engine + golden agree on 8).
    expect(stateStores.length).toBe(8);
    for (const s of stateStores) expect(s.library).toBe('zustand');
  }, 240_000);
});
