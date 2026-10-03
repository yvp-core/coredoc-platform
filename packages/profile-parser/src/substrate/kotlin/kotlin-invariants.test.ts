/**
 * Whole-output invariant suite for the Kotlin substrate (AC-8).
 *
 * `kotlin-fixture.test.ts` asserts exact nodes on a hand-written repository; a walker that only
 * understood those shapes would still pass it. This file asserts PROPERTIES over a REAL Android
 * app: id uniqueness and parseability, every join resolving, honest stats, closed-set triggers
 * and provenances, well-formed path templates and determinism across two parses.
 *
 * The repository is external and is NEVER named here — a client repository name in shared code
 * is a leak, so there is no sibling-directory fallback: the suite is gated on
 * `COREDOC_KOTLIN_FIXTURE_REPO` (one path, or several comma-separated) and PRINTS its skip
 * reason, because a suite that can silently vanish is not evidence.
 *
 * It RECORDS rather than gates the grammar's ERROR-file list, the per-tier histogram and the
 * call-resolution rate: those are measurements of a third-party app, not a contract it owes us.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type KotlinParseStats, type ParsedRepo, StableIdGenerator } from '@coredoc/core';
import type { MobileEntrypointDetails } from '@coredoc/core/types';
import { TreeSitterLoader } from '../../tree-sitter/tree-sitter-loader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkReferentialIntegrity } from '../../integrity/referential-integrity.js';
import { kotlinProvider } from '../../providers/kotlin.js';
import type { KotlinProfile } from '../../types/kotlin-profile.js';
import { discoverKotlinFileScope } from './kotlin-parser.js';

/** The Kotlin substrate always emits these; `ParsedRepo` types them optional. */
type KotlinRepo = ParsedRepo &
  Required<Pick<ParsedRepo, 'components' | 'routes'>> & { stats: { kotlin: KotlinParseStats } };

const CONFIGURED = (process.env.COREDOC_KOTLIN_FIXTURE_REPO ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter((p) => p.length > 0);
const REPOS = CONFIGURED.filter((p) => existsSync(p));

if (REPOS.length === 0) {
  console.warn(
    '[kotlin-invariants] SKIPPED: set COREDOC_KOTLIN_FIXTURE_REPO to an Android checkout ' +
      '(or several, comma-separated) to run the whole-output invariants. ' +
      (CONFIGURED.length > 0 ? `None of the configured paths exist: ${CONFIGURED.join(', ')}.` : 'It is unset.'),
  );
}

/** The four tiers plus the sole-implementation retarget; anything else is another language's edge. */
const KOTLIN_PROVENANCE = new Set(['kt-local', 'kt-member', 'kt-import', 'kt-type', 'iface-impl']);
/** `MobileEntrypointDetails.trigger`, the closed set (D-4). */
const TRIGGERS = new Set([
  'launcher',
  'deep-link',
  'push',
  'broadcast',
  'background-work',
  'service',
  'content-provider',
]);
/** The default Retrofit verb set the substrate ships; a profile may replace it, this suite does not. */
const VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'HTTP']);

const REPO_NAME = 'kotlin-fixture';
const profile: KotlinProfile = {
  parserId: 'kotlin-fixture',
  substrate: { language: 'kotlin', include: ['**/*.kt'] },
  // Both ORMs cannot be read in one pass; `room` is the one the invariants below are ORM-agnostic about.
  entities: { orm: 'room' },
};

describe.skipIf(REPOS.length === 0)('kotlin substrate — whole-output invariants on a real app', () => {
  for (const root of REPOS) {
    describe(root, () => {
      const idGen = new StableIdGenerator(root, REPO_NAME);
      let repo: KotlinRepo;
      let heapMb = 0;

      // The parse belongs to `beforeAll`, not to the first `it`: every assertion below reads
      // `repo`, so a suite run with `-t`, in a shuffled order or with that one test filtered out
      // would otherwise fail on an undefined repository rather than on what it asserts.
      beforeAll(async () => {
        const started = Date.now();
        repo = (await kotlinProvider.parse(profile, {
          repoRoot: root,
          repoName: REPO_NAME,
          repoKey: REPO_NAME,
        })) as KotlinRepo;
        heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        console.info(
          `[kotlin-invariants] ${root}: files=${repo.files.length} packages=${repo.packages.length} ` +
            `classes=${repo.classes.length} functions=${repo.functions.length} calls=${repo.calls.length} ` +
            `entrypoints=${repo.entrypoints.length} components=${repo.components.length} routes=${repo.routes.length} ` +
            `entities=${repo.entities.length} dbOps=${repo.dbOperations.length} egress=${repo.externalCalls.length} ` +
            `skipped=${repo.stats.skippedFiles} wallMs=${Date.now() - started} heapMb=${heapMb}`,
        );
      }, 900_000);

      it('parses the repository and reports its shape', () => {
        expect(repo.files.length).toBeGreaterThan(0);
        expect(repo.functions.length).toBeGreaterThan(0);
        // The default Node heap: a parse that needed `--max-old-space-size` would be a defect,
        // and web-tree-sitter's own heap is capped at 2 GB regardless.
        expect(heapMb).toBeLessThan(4096);
      });

      it('mints every id uniquely, including call edges and routes, under this repo hash', () => {
        const ids = [
          ...repo.packages,
          ...repo.files,
          ...repo.functions,
          ...repo.classes,
          ...repo.interfaces,
          ...repo.enums,
          ...repo.variables,
          ...repo.typeAliases,
          ...repo.imports,
          ...repo.calls,
          ...repo.entrypoints,
          ...repo.entities,
          ...repo.dbOperations,
          ...repo.externalCalls,
          ...repo.components,
          ...repo.routes,
        ].map((n) => n.id);
        const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
        expect(duplicates).toEqual([]);
        // Called out by AC-8 because both are minted from a site, not from a declaration: a
        // key that forgets the line (calls) or the file (routes) collapses two edges into one.
        const callIds = repo.calls.map((c) => c.id);
        expect(new Set(callIds).size).toBe(callIds.length);
        const routeIds = repo.routes.map((r) => r.id);
        expect(new Set(routeIds).size).toBe(routeIds.length);
        for (const id of ids) {
          const parsed = idGen.parseId(id);
          expect(parsed, id).not.toBeNull();
          expect(parsed?.repoHash, id).toBe(repo.id);
          expect(idGen.belongsToRepo(id), id).toBe(true);
        }
      });

      it('resolves every structural join to an emitted node', () => {
        const fileIds = new Set(repo.files.map((f) => f.id));
        const packageIds = new Set(repo.packages.map((p) => p.id));
        const classIds = new Set([...repo.classes, ...repo.interfaces, ...repo.enums].map((c) => c.id));
        const functionIds = new Set(repo.functions.map((f) => f.id));
        const componentIds = new Set(repo.components.map((c) => c.id));
        const routeIds = new Set(repo.routes.map((r) => r.id));
        const entityIds = new Set(repo.entities.map((e) => e.id));

        for (const f of repo.files) expect(packageIds.has(f.packageId ?? ''), f.path).toBe(true);
        for (const node of [...repo.classes, ...repo.interfaces, ...repo.enums, ...repo.entities, ...repo.components])
          expect(fileIds.has(node.fileId), node.id).toBe(true);
        for (const fn of repo.functions) {
          expect(fileIds.has(fn.fileId), fn.id).toBe(true);
          if (fn.classId !== undefined) expect(classIds.has(fn.classId), fn.id).toBe(true);
        }
        for (const call of repo.calls) {
          expect(functionIds.has(call.callerId), call.id).toBe(true);
          expect(functionIds.has(call.calleeId ?? ''), call.id).toBe(true);
        }
        for (const edge of repo.externalCalls) expect(functionIds.has(edge.callerId), edge.id).toBe(true);
        for (const op of repo.dbOperations) {
          expect(functionIds.has(op.performerId), op.id).toBe(true);
          if (op.entityId !== undefined) expect(entityIds.has(op.entityId), op.id).toBe(true);
        }
        for (const entrypoint of repo.entrypoints)
          expect(functionIds.has(entrypoint.handlerId ?? ''), entrypoint.id).toBe(true);
        for (const edge of repo.imports) {
          expect(fileIds.has(edge.sourceFileId), edge.id).toBe(true);
          if (edge.targetFileId !== undefined) expect(fileIds.has(edge.targetFileId), edge.id).toBe(true);
        }
        for (const component of repo.components) {
          for (const child of component.childComponents ?? [])
            expect(componentIds.has(child.componentId ?? ''), `${component.id} -> ${child.componentName}`).toBe(true);
        }
        for (const route of repo.routes) {
          if (route.componentId !== undefined) expect(componentIds.has(route.componentId), route.id).toBe(true);
          if (route.parentRouteId !== undefined) expect(routeIds.has(route.parentRouteId), route.id).toBe(true);
        }
        for (const entity of repo.entities) {
          for (const relation of entity.relations) {
            if (relation.targetEntityId !== undefined)
              expect(entityIds.has(relation.targetEntityId), `${entity.id} -> ${relation.name}`).toBe(true);
          }
        }
      });

      it('splits the repository into more than one package and does not pin every file to one', () => {
        expect(repo.packages.length).toBeGreaterThan(1);
        expect(new Set(repo.packages.map((p) => p.id)).size).toBe(repo.packages.length);
        // A `packageId` that never varies is the signature of a fallback that ate the real value.
        expect(new Set(repo.files.map((f) => f.packageId)).size).toBeGreaterThan(1);
      });

      it('reports stats that match the collections they count', () => {
        expect(repo.stats.parsedFiles).toBe(repo.files.length);
        expect(repo.stats.kotlin.filesParsed).toBe(repo.files.length);
        expect(repo.stats.kotlin.resolvedCalls).toBe(repo.calls.length);
        expect(repo.stats.kotlin.callSites).toBeGreaterThanOrEqual(
          repo.stats.kotlin.resolvedCalls + repo.stats.kotlin.ambiguousCalls,
        );
        // The FULL invariant: a resolved site and an out-of-scope one are both SITES, so the two
        // partitions together can never exceed the denominator. The `>= resolved + ambiguous`
        // form alone stayed green while one site per chained call was being erased from it.
        expect(repo.stats.kotlin.callSites).toBeGreaterThanOrEqual(
          repo.stats.kotlin.resolvedCalls + repo.stats.kotlin.outOfScopeCalls,
        );
        expect(Object.values(repo.stats.kotlin.byTier).reduce((a, b) => a + b, 0)).toBe(
          repo.stats.kotlin.resolvedCalls,
        );
        expect(repo.stats.kotlin.egressCallSites).toBe(repo.externalCalls.length);
      });

      it('labels every call edge with one of the five Kotlin provenances', () => {
        const strays = [...new Set(repo.calls.map((c) => c.provenance ?? '<none>'))].filter(
          (p) => !KOTLIN_PROVENANCE.has(p),
        );
        expect(strays).toEqual([]);
      });

      it('emits only mobile entrypoints, each with a closed-set trigger and a unique (class, trigger)', () => {
        const keys = repo.entrypoints.map((e) => {
          const d = e.details as MobileEntrypointDetails;
          expect(e.type, e.id).toBe('mobile');
          expect(d.platform, e.id).toBe('android');
          expect(TRIGGERS.has(d.trigger), `${e.id}: ${d.trigger}`).toBe(true);
          expect(d.className.trim().length, e.id).toBeGreaterThan(0);
          return `${d.className}:${d.trigger}`;
        });
        expect([...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))]).toEqual([]);
      });

      it('names every route, entity and db operation it emits', () => {
        for (const route of repo.routes) expect(route.path.trim().length, route.id).toBeGreaterThan(0);
        for (const entity of repo.entities) expect(entity.tableName.trim().length, entity.id).toBeGreaterThan(0);
        for (const op of repo.dbOperations) expect(op.entityName.trim().length, op.id).toBeGreaterThan(0);
      });

      it('emits well-formed HTTP egress: a configured verb and a single-slashed path template', () => {
        for (const edge of repo.externalCalls) {
          expect(VERBS.has(edge.method ?? ''), `${edge.id}: ${edge.method}`).toBe(true);
          const template = edge.targetDescriptor?.http?.pathTemplate;
          if (template === undefined) continue; // a dynamic (`@Url`) endpoint carries no http block
          expect(template.startsWith('/'), `${edge.id}: ${template}`).toBe(true);
          expect(template.includes('//'), `${edge.id}: ${template}`).toBe(false);
        }
      });

      it('passes referential integrity as a full ParsedRepo', () => {
        const report = checkReferentialIntegrity(repo);
        expect(report.violations).toEqual([]);
        expect(report.danglingRefs).toBe(0);
      });

      it('is deterministic: a second parse yields the identical id set', async () => {
        const again = (await kotlinProvider.parse(profile, {
          repoRoot: root,
          repoName: REPO_NAME,
          repoKey: REPO_NAME,
        })) as KotlinRepo;
        const idsOf = (r: KotlinRepo) =>
          [
            ...r.packages,
            ...r.files,
            ...r.functions,
            ...r.classes,
            ...r.interfaces,
            ...r.enums,
            ...r.variables,
            ...r.typeAliases,
            ...r.imports,
            ...r.calls,
            ...r.entrypoints,
            ...r.entities,
            ...r.dbOperations,
            ...r.externalCalls,
            ...r.components,
            ...r.routes,
          ]
            .map((n) => n.id)
            .sort();
        expect(idsOf(again)).toEqual(idsOf(repo));
        expect(again.id).toBe(repo.id);
      }, 900_000);

      it('records (does not gate) the resolution rate and the per-tier histogram', () => {
        const { callSites, resolvedCalls, ambiguousCalls, byTier } = repo.stats.kotlin;
        console.info(
          `[kotlin-invariants] calls: sites=${callSites} resolved=${resolvedCalls} ambiguous=${ambiguousCalls} ` +
            `rate=${((resolvedCalls / Math.max(callSites, 1)) * 100).toFixed(1)}% byTier=${JSON.stringify(byTier)}`,
        );
        console.info(
          `[kotlin-invariants] egress: endpointsDefined=${repo.stats.kotlin.endpointsDefined} ` +
            `callSites=${repo.stats.kotlin.egressCallSites} ` +
            `entrypointsWithoutHandler=${repo.stats.kotlin.entrypointsWithoutHandler} ` +
            `unparsedDaoQueries=${repo.stats.kotlin.unparsedDaoQueries}`,
        );
        expect(resolvedCalls).toBe(repo.calls.length);
      });

      it('records (does not gate) the files the bundled grammar cannot fully parse', async () => {
        const parser = await TreeSitterLoader.getInstance().getParser('kotlin');
        const scope = discoverKotlinFileScope(root, profile.substrate.include, profile.substrate.exclude ?? []);
        const withErrors: string[] = [];
        for (const rel of scope.included) {
          let source: string;
          try {
            source = readFileSync(join(root, rel), 'utf-8');
          } catch {
            continue;
          }
          const tree = parser.parse(source);
          if (tree.rootNode.hasError) withErrors.push(rel);
          tree.delete?.();
        }
        console.info(
          `[kotlin-invariants] grammar: ${withErrors.length}/${scope.included.length} files contain an ERROR node` +
            (withErrors.length > 0 ? `\n[kotlin-invariants] ERROR files: ${withErrors.join('\n  ')}` : ''),
        );
        expect(repo.stats.kotlin.filesWithSyntaxErrors).toBeLessThanOrEqual(scope.included.length);
      }, 900_000);
    });
  }
});
