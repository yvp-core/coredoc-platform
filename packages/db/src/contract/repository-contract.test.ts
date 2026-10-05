/**
 * `IGraphReadRepository` parity harness — one golden per read method, run against every backend
 * this suite can stand up in-process.
 *
 * SCOPE: **sqlite and ladybug run everywhere. Neo4j runs only when a maintainer points the suite
 * at a live server** — without `COREDOC_TEST_NEO4J_URI` that arm is not registered, so in CI no
 * golden here executes a single line of `neo4j/repository.ts`.
 *
 * To run the third arm (true three-way parity from these same goldens):
 *
 *     docker run --rm -p 7687:7687 -e NEO4J_AUTH=neo4j/coredoc-contract neo4j:5
 *     COREDOC_TEST_NEO4J_URI=bolt://localhost:7687 NEO4J_PASSWORD=coredoc-contract \
 *       pnpm --filter @coredoc/db test repository-contract
 *
 * `NEO4J_USER` defaults to `neo4j`. The arm WIPES the target database before seeding — point it
 * at a throwaway server, never at anything you care about.
 *
 * What CI therefore leaves unverified, concretely: the Cypher half. Every Neo4j read method is
 * hand-written Cypher whose only correctness signal is review — a renamed stored property, a
 * filter that silently matches nothing, a Cypher syntax error on a branch only some parameters
 * reach is caught by nothing in CI. Treat a Neo4j-only query change as unproven until it is run
 * against a real server.
 *
 * The DTO half is a different story: where a read routes its row→DTO projection through a shared
 * mapper module (`external-call-row.ts` and its siblings), the goldens below exercise that mapper
 * through the sqlite arm, so Neo4j inherits the key-presence and shaping contract for free.
 * Shared mappers and shared constants — not textual parallelism — are what keeps the three arms
 * in step; the entrypoint address-property prefilter key list is one such constant.
 *
 * Goldens compare with `toStrictEqual`, so an optional key present with value `undefined` is NOT
 * equal to that key being absent: backends must omit absent optionals (conditional spread), the
 * convention the shared mappers implement. Cases whose `run` builds an explicit projection object
 * (e.g. `getRepoOverview`, `getCoverageCounts`) fix key presence in the test itself by design —
 * they assert values, and assert presence separately via `hasOwn`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EdgeType,
  GraphApplyMode,
  NodeType,
  type CallerInfo,
  type IGraphReadRepository,
  type IGraphRepository,
} from '../types.js';
import { LadybugDriver } from '../ladybug/driver.js';
import { Neo4jDriver, ensureGraphIndexes } from '../neo4j/driver.js';
import { Neo4jRepository } from '../neo4j/repository.js';
import { LadybugRepository } from '../ladybug/repository.js';
import { SqliteDriver } from '../sqlite/driver.js';
import { SqliteRepository } from '../sqlite/repository.js';
import {
  CONTRACT_BRIDGE_REPO_C,
  CONTRACT_BRIDGE_REPO_D,
  CONTRACT_IDS,
  CONTRACT_OUT_OF_SCOPE_REPO,
  CONTRACT_REPO_A,
  CONTRACT_REPO_B,
  CONTRACT_UNRESOLVED_CALLS_A,
  CONTRACT_UNRESOLVED_CALLS_B,
  seedContractFixture,
} from './repository-contract-fixture.js';

type MethodKey<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof T];

type ReadMethod = MethodKey<IGraphReadRepository>;

interface ContractCase {
  /** Method-local canonicalization only; ordered and paginated surfaces say `exact`. */
  normalization: string;
  run(repository: IGraphReadRepository): Promise<unknown>;
  golden: unknown;
}

const hasOwn = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
/** Synthesis provenance of the synthesized caller, plus whether a declared caller carries the key. */
const synthesisProjection = (rows: readonly CallerInfo[]) => ({
  synthesized: rows.find((row) => row.id === CONTRACT_IDS.synthesizedFunction)?.synthesized,
  declaredHasSynthesized: rows
    .filter((row) => row.id !== CONTRACT_IDS.synthesizedFunction)
    .some((row) => hasOwn(row, 'synthesized')),
});
const ids = <T extends { id: string }>(rows: readonly T[]): string[] => rows.map((row) => row.id);

const invalidLimits = [0, -1, Number.NaN, Number.POSITIVE_INFINITY] as const;
const deadLimitProbeIds = CONTRACT_IDS.limitProbeIds.slice(CONTRACT_IDS.paginationEdgeIds.length);
const deepCallerGolden = CONTRACT_IDS.deepCallNodeIds
  .slice(2, 12)
  .reverse()
  .map((id, index) => ({ id, distance: index + 1 }));
const deepCallTreeGolden = CONTRACT_IDS.deepCallNodeIds.slice(0, 11).map((id, depth) => ({ id, depth }));

function limitBoundaryProjection(actualIds: string[], expectedIds: readonly string[], beyondId: string) {
  return {
    first: actualIds[0],
    last: actualIds.at(-1),
    containsGolden: expectedIds.every((id) => actualIds.includes(id)),
    excludesBeyond: !actualIds.includes(beyondId),
  };
}

async function settled<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/**
 * Criterion 21's lag guard. `satisfies` makes an added read method a type error
 * until it has an executable, non-empty golden case. `runReadOnlyCypher` lives
 * on the separate engine-specific Cypher capability because SQLite deliberately
 * has no Cypher parser. Optional optimized reads are invoked with `!`: the two
 * file engines must implement them.
 */
const contractCases = {
  findCode: {
    normalization: 'unordered membership for an unpaginated search; sort ids only in this case',
    run: async (repository) => {
      const duplicateRows = await repository.findCode(
        { pattern: 'sharedName', types: [NodeType.Function], limit: 10 },
        [CONTRACT_REPO_A],
      );
      const duplicateLimited = await repository.findCode(
        { pattern: 'SHAREDNAME', types: [NodeType.Function], limit: 1 },
        [CONTRACT_REPO_A],
      );
      const unicodeRows = await repository.findCode(
        { pattern: 'Überprüfen_日本', types: [NodeType.Function], limit: 10 },
        [CONTRACT_REPO_A],
      );
      const wildcardRows = await repository.findCode({ pattern: '*shared*', types: [NodeType.Function], limit: 10 }, [
        CONTRACT_REPO_A,
      ]);
      const wildcardUnicodeRows = await repository.findCode(
        { pattern: '*prüfen_日本*', types: [NodeType.Function], limit: 10 },
        [CONTRACT_REPO_A],
      );
      const escapedRows = await repository.findCode(
        { pattern: '*pct%under_score*', types: [NodeType.Function], limit: 10 },
        [CONTRACT_REPO_A],
      );
      const invalid = await Promise.all(
        invalidLimits.map((limit) =>
          settled(
            repository.findCode({ pattern: 'limitProbe*', types: [NodeType.Variable], limit }, [CONTRACT_REPO_A]),
          ),
        ),
      );
      const maximum = await repository.findCode({ pattern: 'limitProbe*', types: [NodeType.Variable], limit: 1000 }, [
        CONTRACT_REPO_A,
      ]);
      const overMaximum = await repository.findCode(
        { pattern: 'limitProbe*', types: [NodeType.Variable], limit: 1001 },
        [CONTRACT_REPO_A],
      );
      return {
        duplicateIds: duplicateRows.map((row) => row.id).sort(),
        duplicateLimitedIds: duplicateLimited.map((row) => row.id),
        duplicateNames: [...new Set(duplicateRows.map((row) => row.name))],
        unicodeIds: unicodeRows.map((row) => row.id),
        excludesOtherRepo: !duplicateRows.some((row) => row.id === CONTRACT_IDS.sharedB),
        wildcardIds: ids(wildcardRows).sort(),
        wildcardUnicodeIds: ids(wildcardUnicodeRows),
        escapedIds: ids(escapedRows),
        invalidLimits: invalid.map((rows) =>
          rows
            ? limitBoundaryProjection(
                ids(rows),
                CONTRACT_IDS.limitProbeIds.slice(0, 50),
                CONTRACT_IDS.limitProbeIds[50] as string,
              )
            : null,
        ),
        maximum: limitBoundaryProjection(
          ids(maximum),
          CONTRACT_IDS.limitProbeIds.slice(0, 1000),
          CONTRACT_IDS.limitProbeIds[1000] as string,
        ),
        overMaximum: limitBoundaryProjection(
          ids(overMaximum),
          CONTRACT_IDS.limitProbeIds.slice(0, 1000),
          CONTRACT_IDS.limitProbeIds[1000] as string,
        ),
      };
    },
    golden: {
      duplicateIds: [CONTRACT_IDS.sharedA1, CONTRACT_IDS.sharedA2].sort(),
      duplicateLimitedIds: [CONTRACT_IDS.sharedA2],
      duplicateNames: ['sharedName'],
      unicodeIds: [CONTRACT_IDS.unicodeFunction],
      excludesOtherRepo: true,
      wildcardIds: [CONTRACT_IDS.sharedA1, CONTRACT_IDS.sharedA2].sort(),
      wildcardUnicodeIds: [CONTRACT_IDS.unicodeFunction],
      escapedIds: [CONTRACT_IDS.escapedSearchFunction],
      invalidLimits: invalidLimits.map(() => ({
        first: CONTRACT_IDS.limitProbeIds[0],
        last: CONTRACT_IDS.limitProbeIds[49],
        containsGolden: true,
        excludesBeyond: true,
      })),
      maximum: {
        first: CONTRACT_IDS.limitProbeIds[0],
        last: CONTRACT_IDS.limitProbeIds[999],
        containsGolden: true,
        excludesBeyond: true,
      },
      overMaximum: {
        first: CONTRACT_IDS.limitProbeIds[0],
        last: CONTRACT_IDS.limitProbeIds[999],
        containsGolden: true,
        excludesBeyond: true,
      },
    },
  },

  listSymbolsInFile: {
    normalization: 'exact API order: startLine then name',
    run: async (repository) =>
      (await repository.listSymbolsInFile('src/path.ts', [CONTRACT_REPO_A])).map((row) => ({
        id: row.id,
        name: row.name,
        startLine: row.startLine,
      })),
    golden: [
      { id: CONTRACT_IDS.pathStart, name: 'pathStart', startLine: 1 },
      { id: CONTRACT_IDS.pathRight, name: 'pathRight', startLine: 2 },
      { id: CONTRACT_IDS.pathLeft, name: 'pathLeft', startLine: 3 },
      { id: CONTRACT_IDS.pathTarget, name: 'pathTarget', startLine: 4 },
    ],
  },

  findFunction: {
    normalization: 'singleton projection; preserve absent summary and qualified-method identity',
    run: async (repository) => {
      const duplicate = await repository.findFunction('sharedName', [CONTRACT_REPO_A], 'secondary.ts');
      const method = await repository.findFunction('run', [CONTRACT_REPO_A], undefined, 'Service');
      const synthesized = await repository.findFunction('employees', [CONTRACT_REPO_A], 'company.rb');
      return {
        duplicateId: duplicate?.id,
        duplicateHasSummary: duplicate ? hasOwn(duplicate, 'summary') : false,
        method: method && { id: method.id, kind: method.kind, className: method.className },
        // Synthesis provenance survives the write/read round-trip, and a DECLARED
        // function leaves the key absent rather than carrying a stored undefined.
        synthesizedProvenance: synthesized?.synthesized,
        declaredHasSynthesized: method ? hasOwn(method, 'synthesized') : true,
      };
    },
    golden: {
      duplicateId: CONTRACT_IDS.sharedA2,
      duplicateHasSummary: false,
      method: { id: CONTRACT_IDS.classMethod, kind: 'method', className: 'Service' },
      synthesizedProvenance: 'ruby-association',
      declaredHasSynthesized: false,
    },
  },

  findClass: {
    normalization: 'singleton projection; source-ordered class properties remain ordered',
    run: async (repository) => {
      const row = await repository.findClass('BaseService', [CONTRACT_REPO_A]);
      return (
        row && {
          id: row.id,
          name: row.name,
          fieldNames: row.properties?.map((field) => field.name),
          exported: row.isExported,
        }
      );
    },
    golden: { id: CONTRACT_IDS.baseClass, name: 'BaseService', fieldNames: ['client'], exported: true },
  },

  findInterface: {
    normalization: 'singleton projection; source-ordered members remain ordered',
    run: async (repository) => {
      const row = await repository.findInterface('Runnable', [CONTRACT_REPO_A]);
      return row && { id: row.id, memberNames: row.members?.map((member) => member.name) };
    },
    golden: { id: CONTRACT_IDS.interfaceNode, memberNames: ['run'] },
  },

  findEnum: {
    normalization: 'singleton projection; enum member list order and numeric/string encodings are exact',
    run: async (repository) => {
      const row = await repository.findEnum('Status', [CONTRACT_REPO_A]);
      return row && { id: row.id, members: row.members };
    },
    golden: {
      id: CONTRACT_IDS.enumNode,
      members: [
        { name: 'Ready', value: 1 },
        { name: 'Paused', value: 'pause' },
      ],
    },
  },

  findTypeAlias: {
    normalization: 'singleton exact text projection',
    run: async (repository) => {
      const row = await repository.findTypeAlias('Identifier', [CONTRACT_REPO_A]);
      return row && { id: row.id, aliasedTypeText: row.aliasedTypeText };
    },
    golden: { id: CONTRACT_IDS.typeAlias, aliasedTypeText: 'string | number' },
  },

  findEntity: {
    normalization: 'singleton; preserve nested list order and values',
    run: async (repository) => {
      const row = await repository.findEntity('users', [CONTRACT_REPO_A]);
      return (
        row && {
          id: row.id,
          tableName: row.tableName,
          fieldNames: row.fields?.map((field) => field.name),
          relationNames: row.relations?.map((relation) => relation.name),
          indexNames: row.indexes?.map((index) => index.name),
        }
      );
    },
    golden: {
      id: CONTRACT_IDS.entity,
      tableName: 'users',
      fieldNames: ['id', 'displayName'],
      relationNames: ['manager'],
      indexNames: ['users_display_name_idx'],
    },
  },

  listEntities: {
    normalization: 'exact API order by entity name',
    run: async (repository) => (await repository.listEntities([CONTRACT_REPO_A])).map((row) => row.id),
    golden: [CONTRACT_IDS.entity],
  },

  listEntrypoints: {
    normalization: 'exact deterministic order and limit boundary; no post-result sorting',
    run: async (repository) => {
      const all = await repository.listEntrypoints({}, [CONTRACT_REPO_A]);
      const limited = await repository.listEntrypoints({ limit: 1 }, [CONTRACT_REPO_A]);
      const routeBoundary = await repository.listEntrypoints({ limit: 6 }, [CONTRACT_REPO_A]);
      const queue = await repository.listEntrypoints({ type: 'queue', system: 'kafka' }, [CONTRACT_REPO_A]);
      // pathPattern matches ANY address the entrypoint has — a queue entrypoint
      // only has a destination, and filtering on fullPath alone returned 0 rows
      // for a destination the unfiltered list happily printed.
      const byDestination = await repository.listEntrypoints({ pathPattern: 'orders' }, [CONTRACT_REPO_A]);
      // An event entrypoint is addressable by BOTH of its stored tokens: the
      // runtime value (`user.created`) and the symbolic name it was declared as
      // (`Events.USER_CREATED`).
      const byEventValue = await repository.listEntrypoints({ pathPattern: 'user.created' }, [CONTRACT_REPO_A]);
      const byEventSymbol = await repository.listEntrypoints({ pathPattern: 'Events.USER_CREATED' }, [CONTRACT_REPO_A]);
      // A mobile entrypoint is reachable both by its type and by its only
      // address token, the component class name stored as `className`.
      const mobile = await repository.listEntrypoints({ type: 'mobile' }, [CONTRACT_REPO_A]);
      const byClassName = await repository.listEntrypoints({ pathPattern: 'MainActivity' }, [CONTRACT_REPO_A]);
      const invalid = await Promise.all(
        invalidLimits.map((limit) => settled(repository.listEntrypoints({ type: 'event', limit }, [CONTRACT_REPO_B]))),
      );
      const maximum = await repository.listEntrypoints({ type: 'event', limit: 1000 }, [CONTRACT_REPO_B]);
      const overMaximum = await repository.listEntrypoints({ type: 'event', limit: 1001 }, [CONTRACT_REPO_B]);
      return {
        all: all.map((row) => row.id),
        limited: limited.map((row) => row.id),
        routeBoundary: routeBoundary.map((row) => row.id),
        queue: queue.map((row) => ({ id: row.id, destination: row.destination, system: row.system })),
        byDestination: byDestination.map((row) => row.id),
        byEventValue: byEventValue.map((row) => row.id),
        byEventSymbol: byEventSymbol.map((row) => row.id),
        mobile: mobile.map((row) => ({ id: row.id, className: row.className, trigger: row.trigger })),
        byClassName: byClassName.map((row) => row.id),
        invalidLimits: invalid.map((rows) =>
          rows
            ? limitBoundaryProjection(
                ids(rows),
                CONTRACT_IDS.entrypointLimitIds.slice(0, 50),
                CONTRACT_IDS.entrypointLimitIds[50] as string,
              )
            : null,
        ),
        maximum: limitBoundaryProjection(
          ids(maximum),
          CONTRACT_IDS.entrypointLimitIds.slice(0, 1000),
          CONTRACT_IDS.entrypointLimitIds[1000] as string,
        ),
        overMaximum: limitBoundaryProjection(
          ids(overMaximum),
          CONTRACT_IDS.entrypointLimitIds.slice(0, 1000),
          CONTRACT_IDS.entrypointLimitIds[1000] as string,
        ),
      };
    },
    golden: {
      all: [
        // Ordered by entrypointType first, so 'event' precedes 'http'.
        CONTRACT_IDS.eventEntrypointA,
        CONTRACT_IDS.deepAllowedEntrypoint,
        CONTRACT_IDS.deepTooFarEntrypoint,
        CONTRACT_IDS.entrypointA,
        CONTRACT_IDS.mobileEntrypointA,
        CONTRACT_IDS.queueEntrypointA,
        CONTRACT_IDS.routeOrderA,
        CONTRACT_IDS.route,
        CONTRACT_IDS.routeOrderZ,
      ],
      limited: [CONTRACT_IDS.eventEntrypointA],
      routeBoundary: [
        CONTRACT_IDS.eventEntrypointA,
        CONTRACT_IDS.deepAllowedEntrypoint,
        CONTRACT_IDS.deepTooFarEntrypoint,
        CONTRACT_IDS.entrypointA,
        CONTRACT_IDS.mobileEntrypointA,
        CONTRACT_IDS.queueEntrypointA,
      ],
      queue: [{ id: CONTRACT_IDS.queueEntrypointA, destination: 'orders.Δ', system: 'kafka' }],
      byDestination: [CONTRACT_IDS.queueEntrypointA],
      byEventValue: [CONTRACT_IDS.eventEntrypointA],
      byEventSymbol: [CONTRACT_IDS.eventEntrypointA],
      mobile: [{ id: CONTRACT_IDS.mobileEntrypointA, className: 'MainActivity', trigger: 'launcher' }],
      byClassName: [CONTRACT_IDS.mobileEntrypointA],
      invalidLimits: invalidLimits.map(() => ({
        first: CONTRACT_IDS.entrypointLimitIds[0],
        last: CONTRACT_IDS.entrypointLimitIds[49],
        containsGolden: true,
        excludesBeyond: true,
      })),
      maximum: {
        first: CONTRACT_IDS.entrypointLimitIds[0],
        last: CONTRACT_IDS.entrypointLimitIds[999],
        containsGolden: true,
        excludesBeyond: true,
      },
      overMaximum: {
        first: CONTRACT_IDS.entrypointLimitIds[0],
        last: CONTRACT_IDS.entrypointLimitIds[999],
        containsGolden: true,
        excludesBeyond: true,
      },
    },
  },

  getRepoOverview: {
    normalization: 'repository rows are an unordered set; nested entrypoint types are repository-sorted',
    run: async (repository) => {
      const rows = await repository.getRepoOverview([CONTRACT_REPO_A, CONTRACT_REPO_B]);
      return rows
        .map((row) => ({
          name: row.name,
          type: row.type,
          entrypointTypes: row.entrypointTypes,
          hasFiles: row.fileCount > 0,
          hasFunctions: row.functionCount > 0,
          gitRemoteUrl: row.gitRemoteUrl,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    golden: [
      {
        name: 'contract-alpha',
        type: 'backend',
        entrypointTypes: ['event', 'http', 'mobile', 'queue'],
        hasFiles: true,
        hasFunctions: true,
        gitRemoteUrl: 'https://example.test/alpha.git',
      },
      {
        name: 'contract-beta',
        type: 'service',
        entrypointTypes: ['event', 'http'],
        hasFiles: true,
        hasFunctions: true,
        gitRemoteUrl: undefined,
      },
    ],
  },

  getCoverageCounts: {
    normalization: 'repository rows unordered; retain named coverage and numeric-encoding predicates',
    run: async (repository) =>
      (await repository.getCoverageCounts([CONTRACT_REPO_A, CONTRACT_REPO_B]))
        .map((row) => ({
          repoName: row.repoName,
          hasFunctions: row.functionCount > 0,
          hasEntityCoverage: row.entitiesWithDbOps > 0,
          hasResolvedExternalCalls: row.resolvedExternalCallCount > 0,
          countsAreNumbers:
            typeof row.functionCount === 'number' &&
            typeof row.entitiesWithDbOps === 'number' &&
            typeof row.resolvedExternalCallCount === 'number',
          hasCallResolution: hasOwn(row, 'callResolution'),
          callResolution: row.callResolution,
          analysis: row.analysis,
          hasDbOpResolution: hasOwn(row, 'dbOpResolution'),
          dbOpResolution: row.dbOpResolution,
        }))
        .sort((a, b) => a.repoName.localeCompare(b.repoName)),
    golden: [
      {
        repoName: 'contract-alpha',
        hasFunctions: true,
        hasEntityCoverage: true,
        hasResolvedExternalCalls: true,
        countsAreNumbers: true,
        hasCallResolution: true,
        callResolution: { callSites: 12, resolvedCalls: 7, outOfScopeCalls: 3 },
        analysis: [{ language: 'csharp', mode: 'basic', compilerReceiverTypes: false, fallback: true }],
        hasDbOpResolution: true,
        dbOpResolution: { dbOpSites: 9, boundDbOps: 5, outOfScopeDbOps: 2 },
      },
      {
        repoName: 'contract-beta',
        hasFunctions: true,
        hasEntityCoverage: false,
        hasResolvedExternalCalls: false,
        countsAreNumbers: true,
        hasCallResolution: false,
        callResolution: undefined,
        analysis: undefined,
        hasDbOpResolution: false,
        dbOpResolution: undefined,
      },
    ],
  },

  listAllRepositories: {
    normalization: 'exact documented order by repository name',
    run: async (repository) =>
      (await repository.listAllRepositories(['contract-beta', 'contract-alpha'])).map((row) => ({
        hash: row.hash,
        name: row.name,
      })),
    golden: [
      { hash: CONTRACT_REPO_A, name: 'contract-alpha' },
      { hash: CONTRACT_REPO_B, name: 'contract-beta' },
    ],
  },

  getRepositoryNames: {
    normalization: 'unordered repository identity set; sort hashes only here',
    run: async (repository) =>
      (await repository.getRepositoryNames([CONTRACT_REPO_B, CONTRACT_REPO_A]))
        .map((row) => ({ hash: row.hash, name: row.name, parserVersion: row.parserVersion }))
        .sort((a, b) => a.hash.localeCompare(b.hash)),
    golden: [
      { hash: CONTRACT_REPO_A, name: 'contract-alpha', parserVersion: 'contract-v1' },
      { hash: CONTRACT_REPO_B, name: 'contract-beta', parserVersion: undefined },
    ],
  },

  getPackages: {
    normalization: 'exact documented order by package name',
    run: async (repository) =>
      (await repository.getPackages([CONTRACT_REPO_A])).map((row) => ({
        id: row.id,
        name: row.name,
        repoId: row.repoId,
        type: row.type,
      })),
    golden: [
      { id: CONTRACT_IDS.packageA1, name: 'alpha-core', repoId: CONTRACT_REPO_A, type: 'workspace' },
      { id: CONTRACT_IDS.packageA2, name: 'alpha-data', repoId: CONTRACT_REPO_A, type: 'workspace' },
    ],
  },

  getEmbeddedNodes: {
    normalization: 'exact deterministic order; vector and provenance numeric/string encodings preserved',
    run: async (repository) =>
      (await repository.getEmbeddedNodes([CONTRACT_REPO_A])).map((row) => ({
        id: row.id,
        embedding: row.embedding,
        provider: row.embeddingProvider,
        model: row.embeddingModel,
        numeric: row.embedding.every((value) => typeof value === 'number'),
      })),
    golden: [
      {
        id: CONTRACT_IDS.embeddedFunction,
        embedding: [0.25, -1.5, 2],
        provider: 'contract-provider',
        model: 'contract-model',
        numeric: true,
      },
    ],
  },

  getDirectCallers: {
    normalization: 'exact caller order and CALLS-over-reference dedup semantics',
    run: async (repository) => ({
      ordinary: (await repository.getDirectCallers(CONTRACT_IDS.cycleB, [CONTRACT_REPO_A])).map((row) => ({
        id: row.id,
        distance: row.distance,
        callSiteLine: row.callSiteLine,
      })),
      cappedIds: (await repository.getDirectCallers(CONTRACT_IDS.directCapTarget, [CONTRACT_REPO_A])).map(
        (row) => row.id,
      ),
      // The CALLER node's synthesis provenance reaches the caller row, so `find_callers`
      // can say the caller is a synthesized association reader rather than written code;
      // a declared caller leaves the key absent. Order-independent on purpose — the
      // ordering contract is `ordinary` above. (Neo4j is out of parity scope, see header.)
      synthesizedCallers: synthesisProjection(
        await repository.getDirectCallers(CONTRACT_IDS.pathTarget, [CONTRACT_REPO_A]),
      ),
    }),
    golden: {
      ordinary: [
        { id: CONTRACT_IDS.componentA, distance: 1, callSiteLine: 100 },
        { id: CONTRACT_IDS.cycleA, distance: 1, callSiteLine: 101 },
      ],
      cappedIds: CONTRACT_IDS.capCallerIds.slice(0, 100),
      synthesizedCallers: { synthesized: 'ruby-association', declaredHasSynthesized: false },
    },
  },

  getTransitiveCallers: {
    normalization: 'exact distance/path order; depth and production LIMIT 100 are contract, never sorted in test',
    run: async (repository) => {
      const depth1 = await repository.getTransitiveCallers(CONTRACT_IDS.cycleB, 1, [CONTRACT_REPO_A]);
      const depth10 = await repository.getTransitiveCallers(CONTRACT_IDS.cycleB, 10, [CONTRACT_REPO_A]);
      const clamped = await repository.getTransitiveCallers(CONTRACT_IDS.cycleB, 99, [CONTRACT_REPO_A]);
      const capped = await repository.getTransitiveCallers(CONTRACT_IDS.capTarget, 1, [CONTRACT_REPO_A]);
      const deepMax = await repository.getTransitiveCallers(CONTRACT_IDS.deepCallNodeIds[12] as string, 10, [
        CONTRACT_REPO_A,
      ]);
      const deepOverMax = await repository.getTransitiveCallers(CONTRACT_IDS.deepCallNodeIds[12] as string, 99, [
        CONTRACT_REPO_A,
      ]);
      const synthesized = await repository.getTransitiveCallers(CONTRACT_IDS.pathTarget, 2, [CONTRACT_REPO_A]);
      return {
        // Same provenance contract as getDirectCallers, on the transitive builder.
        synthesizedCallers: synthesisProjection(synthesized),
        depth1: depth1.map((row) => ({ id: row.id, distance: row.distance })),
        depth10: depth10.map((row) => ({ id: row.id, distance: row.distance })),
        clampMatches: clamped.map((row) => row.id).join('|') === depth10.map((row) => row.id).join('|'),
        cappedIds: capped.map((row) => row.id),
        deepMax: deepMax.map((row) => ({ id: row.id, distance: row.distance })),
        deepOverMax: deepOverMax.map((row) => ({ id: row.id, distance: row.distance })),
      };
    },
    golden: {
      synthesizedCallers: { synthesized: 'ruby-association', declaredHasSynthesized: false },
      depth1: [
        { id: CONTRACT_IDS.componentA, distance: 1 },
        { id: CONTRACT_IDS.cycleA, distance: 1 },
      ],
      depth10: [
        { id: CONTRACT_IDS.componentA, distance: 1 },
        { id: CONTRACT_IDS.cycleA, distance: 1 },
        { id: CONTRACT_IDS.cycleC, distance: 2 },
      ],
      clampMatches: true,
      cappedIds: CONTRACT_IDS.capCallerIds.slice(0, 100),
      deepMax: deepCallerGolden,
      deepOverMax: deepCallerGolden,
    },
  },

  getReachingEntrypoints: {
    normalization: 'exact fullPath order; depth 1, 10, and clamp tested directly',
    run: async (repository) => {
      const depth1 = await repository.getReachingEntrypoints(CONTRACT_IDS.cycleB, 1, [CONTRACT_REPO_A]);
      const depth10 = await repository.getReachingEntrypoints(CONTRACT_IDS.cycleB, 10, [CONTRACT_REPO_A]);
      const clamped = await repository.getReachingEntrypoints(CONTRACT_IDS.cycleB, 99, [CONTRACT_REPO_A]);
      const deepMax = await repository.getReachingEntrypoints(CONTRACT_IDS.deepCallNodeIds[12] as string, 10, [
        CONTRACT_REPO_A,
      ]);
      const deepOverMax = await repository.getReachingEntrypoints(CONTRACT_IDS.deepCallNodeIds[12] as string, 99, [
        CONTRACT_REPO_A,
      ]);
      const capped = await repository.getReachingEntrypoints(CONTRACT_IDS.handlerB1, 1, [CONTRACT_REPO_B]);
      return {
        depth1: depth1.map((row) => row.id),
        depth10: depth10.map((row) => row.id),
        clamped: clamped.map((row) => row.id),
        deepMax: deepMax.map((row) => row.id),
        deepOverMax: deepOverMax.map((row) => row.id),
        cappedIds: capped.map((row) => row.id),
      };
    },
    golden: {
      depth1: [CONTRACT_IDS.entrypointA],
      depth10: [CONTRACT_IDS.entrypointA],
      clamped: [CONTRACT_IDS.entrypointA],
      deepMax: [CONTRACT_IDS.deepAllowedEntrypoint],
      deepOverMax: [CONTRACT_IDS.deepAllowedEntrypoint],
      cappedIds: CONTRACT_IDS.entrypointLimitIds.slice(0, 20),
    },
  },

  findShortestPath: {
    normalization: 'ordered path is semantic; equal-cost tie resolves to lexicographically smaller id path',
    run: async (repository) => ({
      inScope: (
        await repository.findShortestPath(CONTRACT_IDS.pathStart, CONTRACT_IDS.pathTarget, [CONTRACT_REPO_A])
      ).map((row) => row.id),
      maxDepth: (
        await repository.findShortestPath(
          CONTRACT_IDS.deepCallNodeIds[0] as string,
          CONTRACT_IDS.deepCallNodeIds[10] as string,
          [CONTRACT_REPO_A],
        )
      ).map((row) => row.id),
      overMaxDepth: (
        await repository.findShortestPath(
          CONTRACT_IDS.deepCallNodeIds[0] as string,
          CONTRACT_IDS.deepCallNodeIds[12] as string,
          [CONTRACT_REPO_A],
        )
      ).map((row) => row.id),
    }),
    golden: {
      inScope: [CONTRACT_IDS.pathStart, CONTRACT_IDS.pathLeft, CONTRACT_IDS.pathTarget],
      maxDepth: CONTRACT_IDS.deepCallNodeIds.slice(0, 11),
      overMaxDepth: [],
    },
  },

  getCallTree: {
    normalization: 'exact nearest-depth/name order; cycle nodes deduped and depth clamped',
    run: async (repository) => {
      const depth1 = await repository.getCallTree(CONTRACT_IDS.cycleA, 1, [CONTRACT_REPO_A]);
      const depth10 = await repository.getCallTree(CONTRACT_IDS.cycleA, 10, [CONTRACT_REPO_A]);
      const clamped = await repository.getCallTree(CONTRACT_IDS.cycleA, 99, [CONTRACT_REPO_A]);
      const deepMax = await repository.getCallTree(CONTRACT_IDS.deepCallNodeIds[0] as string, 10, [CONTRACT_REPO_A]);
      const deepOverMax = await repository.getCallTree(CONTRACT_IDS.deepCallNodeIds[0] as string, 99, [
        CONTRACT_REPO_A,
      ]);
      const capped = await repository.getCallTree(CONTRACT_IDS.callTreeCapRoot, 1, [CONTRACT_REPO_A]);
      const scopeBarrier = await repository.getCallTree(CONTRACT_IDS.callTreeScopeRoot, 3, [CONTRACT_REPO_A]);
      return {
        depth1: depth1.map((row) => ({ id: row.id, depth: row.depth })),
        depth10: depth10.map((row) => ({ id: row.id, depth: row.depth })),
        clamped: clamped.map((row) => ({ id: row.id, depth: row.depth })),
        deepMax: deepMax.map((row) => ({ id: row.id, depth: row.depth })),
        deepOverMax: deepOverMax.map((row) => ({ id: row.id, depth: row.depth })),
        cappedIds: capped.map((row) => row.id),
        scopeBarrierIds: scopeBarrier.map((row) => row.id),
      };
    },
    golden: {
      depth1: [
        { id: CONTRACT_IDS.cycleA, depth: 0 },
        { id: CONTRACT_IDS.cycleB, depth: 1 },
      ],
      depth10: [
        { id: CONTRACT_IDS.cycleA, depth: 0 },
        { id: CONTRACT_IDS.cycleB, depth: 1 },
        { id: CONTRACT_IDS.cycleC, depth: 2 },
      ],
      clamped: [
        { id: CONTRACT_IDS.cycleA, depth: 0 },
        { id: CONTRACT_IDS.cycleB, depth: 1 },
        { id: CONTRACT_IDS.cycleC, depth: 2 },
      ],
      deepMax: deepCallTreeGolden,
      deepOverMax: deepCallTreeGolden,
      cappedIds: [CONTRACT_IDS.callTreeCapRoot, ...CONTRACT_IDS.callTreeCapNodeIds.slice(0, 199)],
      scopeBarrierIds: [CONTRACT_IDS.callTreeScopeRoot],
    },
  },

  getDirectCallees: {
    normalization: 'exact call-site line order',
    run: async (repository) =>
      (await repository.getDirectCallees(CONTRACT_IDS.pathStart, [CONTRACT_REPO_A])).map((row) => row.id),
    golden: [CONTRACT_IDS.pathLeft, CONTRACT_IDS.pathRight],
  },

  getClassExtensions: {
    normalization: 'exact documented order by class name',
    run: async (repository) =>
      (await repository.getClassExtensions(CONTRACT_IDS.baseClass, [CONTRACT_REPO_A])).map((row) => ({
        id: row.id,
        name: row.name,
      })),
    golden: [{ id: CONTRACT_IDS.childClass, name: 'ChildService' }],
  },

  getInterfaceImplementations: {
    normalization: 'exact documented order by class name',
    run: async (repository) =>
      (await repository.getInterfaceImplementations(CONTRACT_IDS.interfaceNode, [CONTRACT_REPO_A])).map((row) => ({
        id: row.id,
        name: row.name,
      })),
    golden: [{ id: CONTRACT_IDS.implementingClass, name: 'Service' }],
  },

  getEntityConsumers: {
    normalization: 'exact operation/file order and operation predicate',
    run: async (repository) =>
      (await repository.getEntityConsumers('users', [CONTRACT_REPO_A], 'read')).map((row) => ({
        id: row.id,
        operation: row.operation,
        className: row.className,
      })),
    golden: [{ id: CONTRACT_IDS.entityConsumer, operation: 'read', className: 'Service' }],
  },

  getTypeUsages: {
    normalization: 'exact file/start order; boolean and optional-via encoding preserved',
    run: async (repository) =>
      (await repository.getTypeUsages(CONTRACT_IDS.interfaceNode, [CONTRACT_REPO_A])).map((row) => ({
        id: row.id,
        usage: row.usage,
        via: row.via,
        ambiguous: row.ambiguous,
      })),
    golden: [{ id: CONTRACT_IDS.typeUser, usage: 'parameter', via: 'job', ambiguous: false }],
  },

  getEntitiesForFunctions: {
    normalization: 'exact function/entity order plus source-side repo scope predicate',
    run: async (repository) => ({
      inScope: await repository.getEntitiesForFunctions([CONTRACT_IDS.entityConsumer], [CONTRACT_REPO_A]),
    }),
    golden: {
      inScope: [
        {
          functionId: CONTRACT_IDS.entityConsumer,
          entityName: 'User',
          tableName: 'users',
          operation: 'read',
          entityId: CONTRACT_IDS.entity,
        },
      ],
    },
  },

  getExternalCalls: {
    normalization: 'unordered external-call set; sort ids only here, preserve optional field presence',
    run: async (repository) => ({
      filteredByService: (await repository.getExternalCalls([CONTRACT_REPO_A], 'contract-beta'))
        .map((row) => ({
          id: row.id,
          targetService: row.targetService,
          protocol: row.protocol,
          hasSdkName: hasOwn(row, 'sdkName'),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      // Read-time derivation off the persisted resolvedTargetId: a call whose
      // profile cannot name the callee is named by the repo it resolved to, and
      // its unresolved twin stays unnamed.
      resolvedRepoNames: (await repository.getExternalCalls([CONTRACT_REPO_A]))
        .filter(
          (row) =>
            row.id === CONTRACT_IDS.externalCallResolvedUnnamed ||
            row.id === CONTRACT_IDS.externalCallUnresolvedUnnamed ||
            row.id === CONTRACT_IDS.externalCallWithoutEdge,
        )
        .map((row) => ({
          id: row.id,
          serviceName: row.serviceName,
          hasResolvedTargetRepoName: hasOwn(row, 'resolvedTargetRepoName'),
          resolvedTargetRepoName: row.resolvedTargetRepoName,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }),
    golden: {
      filteredByService: [
        { id: CONTRACT_IDS.externalCall1, targetService: 'contract-beta', protocol: 'http', hasSdkName: false },
        { id: CONTRACT_IDS.externalCall2, targetService: 'contract-beta', protocol: 'messaging', hasSdkName: false },
        {
          id: CONTRACT_IDS.externalCallWithoutEdge,
          targetService: 'contract-beta',
          protocol: 'http',
          hasSdkName: false,
        },
        {
          id: CONTRACT_IDS.externalCallResolvedUnnamed,
          targetService: undefined,
          protocol: 'http',
          hasSdkName: false,
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
      resolvedRepoNames: [
        {
          id: CONTRACT_IDS.externalCallResolvedUnnamed,
          serviceName: '',
          hasResolvedTargetRepoName: true,
          resolvedTargetRepoName: 'contract-beta',
        },
        {
          id: CONTRACT_IDS.externalCallUnresolvedUnnamed,
          serviceName: '',
          hasResolvedTargetRepoName: false,
          resolvedTargetRepoName: undefined,
        },
        {
          id: CONTRACT_IDS.externalCallWithoutEdge,
          serviceName: 'contract-beta-client',
          hasResolvedTargetRepoName: false,
          resolvedTargetRepoName: undefined,
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    },
  },

  getExternalCallsWithMessaging: {
    normalization: 'unordered membership; sort ids only here',
    run: async (repository) =>
      (await repository.getExternalCallsWithMessaging([CONTRACT_REPO_A]))
        .map((row) => ({ id: row.id, destination: row.destination, system: row.system }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    golden: [{ id: CONTRACT_IDS.externalCall2, destination: 'orders.Δ', system: 'kafka' }],
  },

  getExternalCallsFrom: {
    normalization: 'unordered membership; sort ids only here',
    run: async (repository) => ({
      fromCycleA: (await repository.getExternalCallsFrom(CONTRACT_IDS.cycleA, [CONTRACT_REPO_A]))
        .map((row) => row.id)
        .sort(),
      // `explain` reads its dependency line from here, so the resolved repo name
      // has to be derived on this projection too, not only on getExternalCalls.
      fromCycleB: (await repository.getExternalCallsFrom(CONTRACT_IDS.cycleB, [CONTRACT_REPO_A]))
        .map((row) => ({ id: row.id, resolvedTargetRepoName: row.resolvedTargetRepoName }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }),
    golden: {
      fromCycleA: [CONTRACT_IDS.externalCall1, CONTRACT_IDS.externalCall2, CONTRACT_IDS.externalCallWithoutEdge].sort(),
      fromCycleB: [
        { id: CONTRACT_IDS.externalCallResolvedUnnamed, resolvedTargetRepoName: 'contract-beta' },
        { id: CONTRACT_IDS.externalCallUnresolvedUnnamed, resolvedTargetRepoName: undefined },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    },
  },

  getNodesByIds: {
    normalization: 'API promises no input-order preservation; sort ids only here and assert repo scoping',
    run: async (repository) =>
      (
        await repository.getNodesByIds(
          [CONTRACT_IDS.sharedA2, CONTRACT_IDS.sharedB, CONTRACT_IDS.sharedA1],
          [CONTRACT_REPO_A],
        )
      )
        .map((row) => ({ id: row.id, repoName: row.repoName }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    golden: [
      { id: CONTRACT_IDS.sharedA1, repoName: 'contract-alpha' },
      { id: CONTRACT_IDS.sharedA2, repoName: 'contract-alpha' },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  },

  getNeighborCounts: {
    normalization: 'unordered grouped rows; sort edgeType+direction only here; retain presence/type predicates',
    run: async (repository) => ({
      inScope: (await repository.getNeighborCounts(CONTRACT_IDS.pathStart, [CONTRACT_REPO_A]))
        .map((row) => ({
          edgeType: row.edgeType,
          direction: row.direction,
          hasNeighbors: row.count > 0,
          countIsNumber: typeof row.count === 'number',
        }))
        .sort((a, b) => `${a.edgeType}:${a.direction}`.localeCompare(`${b.edgeType}:${b.direction}`)),
    }),
    golden: {
      inScope: [
        { edgeType: EdgeType.Calls, direction: 'out', hasNeighbors: true, countIsNumber: true },
        { edgeType: EdgeType.ReferencesVariable, direction: 'out', hasNeighbors: true, countIsNumber: true },
      ].sort((a, b) => `${a.edgeType}:${a.direction}`.localeCompare(`${b.edgeType}:${b.direction}`)),
    },
  },

  getNeighbors: {
    normalization: 'keyset page order and limit boundaries are semantic; assert edge-id prefixes directly',
    run: async (repository) => {
      const page1 = await repository.getNeighbors(
        CONTRACT_IDS.pathStart,
        { direction: 'out', edgeTypes: [EdgeType.Calls], limit: 1 },
        [CONTRACT_REPO_A],
      );
      const page2 = await repository.getNeighbors(
        CONTRACT_IDS.pathStart,
        { direction: 'out', edgeTypes: [EdgeType.Calls], limit: 1, cursor: page1.nextCursor },
        [CONTRACT_REPO_A],
      );
      const probeParams = { direction: 'out' as const, edgeTypes: [EdgeType.ReferencesVariable] };
      const invalid = await Promise.all(
        invalidLimits.map((limit) =>
          settled(repository.getNeighbors(CONTRACT_IDS.pathStart, { ...probeParams, limit }, [CONTRACT_REPO_A])),
        ),
      );
      const maximum = await repository.getNeighbors(CONTRACT_IDS.pathStart, { ...probeParams, limit: 200 }, [
        CONTRACT_REPO_A,
      ]);
      const overMaximum = await repository.getNeighbors(CONTRACT_IDS.pathStart, { ...probeParams, limit: 201 }, [
        CONTRACT_REPO_A,
      ]);
      const emptyCursor = await repository.getNeighbors(
        CONTRACT_IDS.pathStart,
        { ...probeParams, limit: 1, cursor: '' },
        [CONTRACT_REPO_A],
      );
      const terminalCursor = await repository.getNeighbors(
        CONTRACT_IDS.pathStart,
        { ...probeParams, limit: 1, cursor: CONTRACT_IDS.paginationEdgeIds.at(-1) },
        [CONTRACT_REPO_A],
      );
      const project = (value: typeof maximum, expected: readonly string[], beyond: string) => ({
        ...limitBoundaryProjection(ids(value.edges), expected, beyond),
        truncated: value.truncated,
      });
      return {
        page1: {
          nodes: page1.nodes.map((row) => row.id),
          edges: page1.edges.map((row) => row.id),
          nextCursor: page1.nextCursor,
          truncated: page1.truncated,
        },
        page2: {
          nodes: page2.nodes.map((row) => row.id),
          edges: page2.edges.map((row) => row.id),
          nextCursor: page2.nextCursor,
          truncated: page2.truncated,
        },
        invalidLimits: invalid.map((value) =>
          value
            ? project(value, CONTRACT_IDS.paginationEdgeIds.slice(0, 50), CONTRACT_IDS.paginationEdgeIds[50] as string)
            : null,
        ),
        maximum: project(
          maximum,
          CONTRACT_IDS.paginationEdgeIds.slice(0, 200),
          CONTRACT_IDS.paginationEdgeIds[200] as string,
        ),
        overMaximum: project(
          overMaximum,
          CONTRACT_IDS.paginationEdgeIds.slice(0, 200),
          CONTRACT_IDS.paginationEdgeIds[200] as string,
        ),
        emptyCursor: ids(emptyCursor.edges),
        terminalCursor: {
          nodes: ids(terminalCursor.nodes),
          edges: ids(terminalCursor.edges),
          nextCursor: terminalCursor.nextCursor,
          truncated: terminalCursor.truncated,
        },
      };
    },
    golden: {
      page1: {
        nodes: [CONTRACT_IDS.pathLeft],
        edges: [CONTRACT_IDS.neighborEdge1],
        nextCursor: CONTRACT_IDS.neighborEdge1,
        truncated: true,
      },
      page2: {
        nodes: [CONTRACT_IDS.pathRight],
        edges: [CONTRACT_IDS.neighborEdge2],
        nextCursor: undefined,
        truncated: false,
      },
      invalidLimits: invalidLimits.map(() => ({
        first: CONTRACT_IDS.paginationEdgeIds[0],
        last: CONTRACT_IDS.paginationEdgeIds[49],
        containsGolden: true,
        excludesBeyond: true,
        truncated: true,
      })),
      maximum: {
        first: CONTRACT_IDS.paginationEdgeIds[0],
        last: CONTRACT_IDS.paginationEdgeIds[199],
        containsGolden: true,
        excludesBeyond: true,
        truncated: true,
      },
      overMaximum: {
        first: CONTRACT_IDS.paginationEdgeIds[0],
        last: CONTRACT_IDS.paginationEdgeIds[199],
        containsGolden: true,
        excludesBeyond: true,
        truncated: true,
      },
      emptyCursor: [CONTRACT_IDS.paginationEdgeIds[0]],
      terminalCursor: { nodes: [], edges: [], nextCursor: undefined, truncated: false },
    },
  },

  listNodesByType: {
    normalization: 'keyset page order and limit boundaries are semantic; assert node-id prefixes directly',
    run: async (repository) => {
      const page1 = await repository.listNodesByType(NodeType.Variable, { limit: 1 }, [CONTRACT_REPO_A]);
      const page2 = await repository.listNodesByType(NodeType.Variable, { limit: 1, cursor: page1.nextCursor }, [
        CONTRACT_REPO_A,
      ]);
      const invalid = await Promise.all(
        invalidLimits.map((limit) =>
          settled(repository.listNodesByType(NodeType.Variable, { limit }, [CONTRACT_REPO_A])),
        ),
      );
      const maximum = await repository.listNodesByType(NodeType.Variable, { limit: 1000 }, [CONTRACT_REPO_A]);
      const overMaximum = await repository.listNodesByType(NodeType.Variable, { limit: 1001 }, [CONTRACT_REPO_A]);
      const emptyCursor = await repository.listNodesByType(NodeType.Variable, { limit: 1, cursor: '' }, [
        CONTRACT_REPO_A,
      ]);
      const terminalCursor = await repository.listNodesByType(
        NodeType.Variable,
        { limit: 1, cursor: CONTRACT_IDS.variable },
        [CONTRACT_REPO_A],
      );
      const project = (value: typeof maximum, expected: readonly string[], beyond: string) => ({
        ...limitBoundaryProjection(ids(value.nodes), expected, beyond),
        truncated: value.truncated,
      });
      return {
        page1: { ids: page1.nodes.map((row) => row.id), cursor: page1.nextCursor, truncated: page1.truncated },
        page2: { ids: page2.nodes.map((row) => row.id), cursor: page2.nextCursor, truncated: page2.truncated },
        invalidLimits: invalid.map((value) =>
          value
            ? project(value, CONTRACT_IDS.limitProbeIds.slice(0, 50), CONTRACT_IDS.limitProbeIds[50] as string)
            : null,
        ),
        maximum: project(
          maximum,
          CONTRACT_IDS.limitProbeIds.slice(0, 1000),
          CONTRACT_IDS.limitProbeIds[1000] as string,
        ),
        overMaximum: project(
          overMaximum,
          CONTRACT_IDS.limitProbeIds.slice(0, 1000),
          CONTRACT_IDS.limitProbeIds[1000] as string,
        ),
        emptyCursor: ids(emptyCursor.nodes),
        terminalCursor: {
          ids: ids(terminalCursor.nodes),
          cursor: terminalCursor.nextCursor,
          truncated: terminalCursor.truncated,
        },
      };
    },
    golden: {
      page1: { ids: [CONTRACT_IDS.limitProbeIds[0]], cursor: CONTRACT_IDS.limitProbeIds[0], truncated: true },
      page2: { ids: [CONTRACT_IDS.limitProbeIds[1]], cursor: CONTRACT_IDS.limitProbeIds[1], truncated: true },
      invalidLimits: invalidLimits.map(() => ({
        first: CONTRACT_IDS.limitProbeIds[0],
        last: CONTRACT_IDS.limitProbeIds[49],
        containsGolden: true,
        excludesBeyond: true,
        truncated: true,
      })),
      maximum: {
        first: CONTRACT_IDS.limitProbeIds[0],
        last: CONTRACT_IDS.limitProbeIds[999],
        containsGolden: true,
        excludesBeyond: true,
        truncated: true,
      },
      overMaximum: {
        first: CONTRACT_IDS.limitProbeIds[0],
        last: CONTRACT_IDS.limitProbeIds[999],
        containsGolden: true,
        excludesBeyond: true,
        truncated: true,
      },
      emptyCursor: [CONTRACT_IDS.limitProbeIds[0]],
      terminalCursor: { ids: [], cursor: undefined, truncated: false },
    },
  },

  getNodeWithProperties: {
    normalization: 'raw JSON contract: preserve null, absence, Unicode, list order, and numeric encoding',
    run: async (repository) => {
      const row = await repository.getNodeWithProperties(CONTRACT_IDS.unicodeFunction, [CONTRACT_REPO_A]);
      return (
        row && {
          id: row.node.id,
          explicitNull: row.properties.explicitNull,
          hasExplicitNull: hasOwn(row.properties, 'explicitNull'),
          hasAbsent: hasOwn(row.properties, 'absent'),
          unicode: row.properties.unicode,
          orderedList: row.properties.orderedList,
          numeric: row.properties.numeric,
          numericType: typeof row.properties.numeric,
        }
      );
    },
    golden: {
      id: CONTRACT_IDS.unicodeFunction,
      explicitNull: null,
      hasExplicitNull: true,
      hasAbsent: false,
      unicode: 'Привіт 世界',
      orderedList: ['β', 2, null],
      numeric: 7.5,
      numericType: 'number',
    },
  },

  getSubgraph: {
    normalization: 'nodes/edges are sets; depth and node-cap boundaries retain explicit membership goldens',
    run: async (repository) => {
      const depth1 = await repository.getSubgraph(
        CONTRACT_IDS.cycleA,
        { depth: 1, direction: 'out', edgeTypes: [EdgeType.Calls], nodeCap: 10 },
        [CONTRACT_REPO_A],
      );
      const depth10 = await repository.getSubgraph(
        CONTRACT_IDS.cycleA,
        { depth: 10, direction: 'out', edgeTypes: [EdgeType.Calls], nodeCap: 10 },
        [CONTRACT_REPO_A],
      );
      const clamped = await repository.getSubgraph(
        CONTRACT_IDS.cycleA,
        { depth: 99, direction: 'out', edgeTypes: [EdgeType.Calls], nodeCap: 10 },
        [CONTRACT_REPO_A],
      );
      const capped = await repository.getSubgraph(
        CONTRACT_IDS.cycleA,
        { depth: 10, direction: 'out', edgeTypes: [EdgeType.Calls], nodeCap: 1 },
        [CONTRACT_REPO_A],
      );
      const deepMax = await repository.getSubgraph(
        CONTRACT_IDS.deepCallNodeIds[0] as string,
        { depth: 5, direction: 'out', edgeTypes: [EdgeType.Calls], nodeCap: 200 },
        [CONTRACT_REPO_A],
      );
      const deepOverMax = await repository.getSubgraph(
        CONTRACT_IDS.deepCallNodeIds[0] as string,
        { depth: 99, direction: 'out', edgeTypes: [EdgeType.Calls], nodeCap: 200 },
        [CONTRACT_REPO_A],
      );
      const crossScope = await repository.getSubgraph(
        CONTRACT_IDS.scopeTraversalRoot,
        { depth: 2, direction: 'out', edgeTypes: [EdgeType.Calls], nodeCap: 20 },
        [CONTRACT_REPO_A],
      );
      const foreignRoot = await repository.getSubgraph(
        CONTRACT_IDS.scopeTraversalForeign,
        { depth: 1, direction: 'out', edgeTypes: [EdgeType.Calls], nodeCap: 20 },
        [CONTRACT_REPO_A],
      );
      const probeParams = { depth: 1, direction: 'out' as const, edgeTypes: [EdgeType.ReferencesVariable] };
      const invalid = await Promise.all(
        invalidLimits.map((nodeCap) =>
          settled(repository.getSubgraph(CONTRACT_IDS.pathStart, { ...probeParams, nodeCap }, [CONTRACT_REPO_A])),
        ),
      );
      const maximum = await repository.getSubgraph(CONTRACT_IDS.pathStart, { ...probeParams, nodeCap: 200 }, [
        CONTRACT_REPO_A,
      ]);
      const overMaximum = await repository.getSubgraph(CONTRACT_IDS.pathStart, { ...probeParams, nodeCap: 201 }, [
        CONTRACT_REPO_A,
      ]);
      const pick = (value: typeof depth1) => ({
        nodes: value.nodes.map((row) => row.id).sort(),
        edges: value.edges.map((row) => row.id).sort(),
        truncated: value.truncated,
      });
      const projectCap = (value: typeof maximum, expected: readonly string[], beyond: string) => ({
        nodes: limitBoundaryProjection(
          ids(value.nodes).filter((nodeId) => nodeId !== CONTRACT_IDS.pathStart),
          expected,
          beyond,
        ),
        edges: limitBoundaryProjection(
          ids(value.edges),
          expected.map((_, index) => CONTRACT_IDS.paginationEdgeIds[index] as string),
          CONTRACT_IDS.paginationEdgeIds[expected.length] as string,
        ),
        truncated: value.truncated,
      });
      return {
        depth1: pick(depth1),
        depth10: pick(depth10),
        clampMatches: JSON.stringify(pick(clamped)) === JSON.stringify(pick(depth10)),
        capped: pick(capped),
        deepMax: pick(deepMax),
        deepOverMax: pick(deepOverMax),
        crossScope: pick(crossScope),
        foreignRoot: pick(foreignRoot),
        invalidNodeCaps: invalid.map((value) =>
          value
            ? projectCap(value, CONTRACT_IDS.limitProbeIds.slice(0, 50), CONTRACT_IDS.limitProbeIds[50] as string)
            : null,
        ),
        maximumNodeCap: projectCap(
          maximum,
          CONTRACT_IDS.limitProbeIds.slice(0, 200),
          CONTRACT_IDS.limitProbeIds[200] as string,
        ),
        overMaximumNodeCap: projectCap(
          overMaximum,
          CONTRACT_IDS.limitProbeIds.slice(0, 200),
          CONTRACT_IDS.limitProbeIds[200] as string,
        ),
      };
    },
    golden: {
      depth1: {
        nodes: [CONTRACT_IDS.cycleA, CONTRACT_IDS.cycleB].sort(),
        edges: [CONTRACT_IDS.cycleEdgeAB],
        truncated: false,
      },
      depth10: {
        nodes: [CONTRACT_IDS.cycleA, CONTRACT_IDS.cycleB, CONTRACT_IDS.cycleC].sort(),
        edges: [CONTRACT_IDS.cycleEdgeAB, CONTRACT_IDS.cycleEdgeBC, CONTRACT_IDS.cycleEdgeCA].sort(),
        truncated: false,
      },
      clampMatches: true,
      capped: {
        nodes: [CONTRACT_IDS.cycleA, CONTRACT_IDS.cycleB].sort(),
        edges: [CONTRACT_IDS.cycleEdgeAB],
        truncated: true,
      },
      deepMax: {
        nodes: CONTRACT_IDS.deepCallNodeIds.slice(0, 6).sort(),
        edges: CONTRACT_IDS.deepCallEdgeIds.slice(0, 5).sort(),
        truncated: false,
      },
      deepOverMax: {
        nodes: CONTRACT_IDS.deepCallNodeIds.slice(0, 6).sort(),
        edges: CONTRACT_IDS.deepCallEdgeIds.slice(0, 5).sort(),
        truncated: false,
      },
      crossScope: {
        nodes: [CONTRACT_IDS.scopeTraversalRoot],
        edges: [],
        truncated: false,
      },
      foreignRoot: { nodes: [], edges: [], truncated: false },
      invalidNodeCaps: invalidLimits.map(() => ({
        nodes: {
          first: CONTRACT_IDS.limitProbeIds[0],
          last: CONTRACT_IDS.limitProbeIds[49],
          containsGolden: true,
          excludesBeyond: true,
        },
        edges: {
          first: CONTRACT_IDS.paginationEdgeIds[0],
          last: CONTRACT_IDS.paginationEdgeIds[49],
          containsGolden: true,
          excludesBeyond: true,
        },
        truncated: true,
      })),
      maximumNodeCap: {
        nodes: {
          first: CONTRACT_IDS.limitProbeIds[0],
          last: CONTRACT_IDS.limitProbeIds[199],
          containsGolden: true,
          excludesBeyond: true,
        },
        edges: {
          first: CONTRACT_IDS.paginationEdgeIds[0],
          last: CONTRACT_IDS.paginationEdgeIds[199],
          containsGolden: true,
          excludesBeyond: true,
        },
        truncated: true,
      },
      overMaximumNodeCap: {
        nodes: {
          first: CONTRACT_IDS.limitProbeIds[0],
          last: CONTRACT_IDS.limitProbeIds[199],
          containsGolden: true,
          excludesBeyond: true,
        },
        edges: {
          first: CONTRACT_IDS.paginationEdgeIds[0],
          last: CONTRACT_IDS.paginationEdgeIds[199],
          containsGolden: true,
          excludesBeyond: true,
        },
        truncated: true,
      },
    },
  },

  getEdgesAmong: {
    normalization: 'limit order is semantic; assert edge-id boundaries and safe limit normalization',
    run: async (repository) => {
      const smallNodeIds = [CONTRACT_IDS.pathStart, CONTRACT_IDS.pathLeft, CONTRACT_IDS.pathRight];
      const one = await repository.getEdgesAmong(smallNodeIds, [CONTRACT_REPO_A], 1);
      const two = await repository.getEdgesAmong(smallNodeIds, [CONTRACT_REPO_A], 2);
      const probeNodeIds = [CONTRACT_IDS.pathStart, ...CONTRACT_IDS.limitProbeIds.slice(0, 205)];
      const invalid = await Promise.all(
        invalidLimits.map((limit) => settled(repository.getEdgesAmong(probeNodeIds, [CONTRACT_REPO_A], limit))),
      );
      const maximum = await repository.getEdgesAmong(probeNodeIds, [CONTRACT_REPO_A], 10_000);
      const overMaximum = await repository.getEdgesAmong(probeNodeIds, [CONTRACT_REPO_A], 10_001);
      const project = (value: typeof maximum) => ({
        ...limitBoundaryProjection(
          ids(value.edges),
          CONTRACT_IDS.paginationEdgeIds,
          'contract:not-a-planted-pagination-edge',
        ),
        truncated: value.truncated,
      });
      return {
        one: { ids: one.edges.map((row) => row.id), truncated: one.truncated },
        two: { ids: two.edges.map((row) => row.id), truncated: two.truncated },
        invalidLimits: invalid.map((value) => (value ? project(value) : null)),
        maximum: project(maximum),
        overMaximum: project(overMaximum),
      };
    },
    golden: {
      one: { ids: [CONTRACT_IDS.neighborEdge1], truncated: true },
      two: { ids: [CONTRACT_IDS.neighborEdge1, CONTRACT_IDS.neighborEdge2], truncated: false },
      invalidLimits: invalidLimits.map(() => ({
        first: CONTRACT_IDS.paginationEdgeIds[0],
        last: CONTRACT_IDS.paginationEdgeIds.at(-1),
        containsGolden: true,
        excludesBeyond: true,
        truncated: false,
      })),
      maximum: {
        first: CONTRACT_IDS.paginationEdgeIds[0],
        last: CONTRACT_IDS.paginationEdgeIds.at(-1),
        containsGolden: true,
        excludesBeyond: true,
        truncated: false,
      },
      overMaximum: {
        first: CONTRACT_IDS.paginationEdgeIds[0],
        last: CONTRACT_IDS.paginationEdgeIds.at(-1),
        containsGolden: true,
        excludesBeyond: true,
        truncated: false,
      },
    },
  },

  findDeadNodes: {
    normalization: 'keyset page order and limit boundaries are semantic; assert disconnected node-id prefixes',
    run: async (repository) => {
      const page1 = await repository.findDeadNodes({ types: [NodeType.Variable], limit: 1 }, [CONTRACT_REPO_A]);
      const page2 = await repository.findDeadNodes({ types: [NodeType.Variable], limit: 1, cursor: page1.nextCursor }, [
        CONTRACT_REPO_A,
      ]);
      const invalid = await Promise.all(
        invalidLimits.map((limit) =>
          settled(repository.findDeadNodes({ types: [NodeType.Variable], limit }, [CONTRACT_REPO_A])),
        ),
      );
      const maximum = await repository.findDeadNodes({ types: [NodeType.Variable], limit: 200 }, [CONTRACT_REPO_A]);
      const overMaximum = await repository.findDeadNodes({ types: [NodeType.Variable], limit: 201 }, [CONTRACT_REPO_A]);
      const emptyCursor = await repository.findDeadNodes({ types: [NodeType.Variable], limit: 1, cursor: '' }, [
        CONTRACT_REPO_A,
      ]);
      const terminalCursor = await repository.findDeadNodes(
        { types: [NodeType.Variable], limit: 1, cursor: CONTRACT_IDS.variable },
        [CONTRACT_REPO_A],
      );
      const project = (value: typeof maximum, expected: readonly string[], beyond: string) => ({
        ...limitBoundaryProjection(ids(value.nodes), expected, beyond),
        truncated: value.truncated,
      });
      return {
        page1: { ids: page1.nodes.map((row) => row.id), cursor: page1.nextCursor, truncated: page1.truncated },
        page2: { ids: page2.nodes.map((row) => row.id), cursor: page2.nextCursor, truncated: page2.truncated },
        invalidLimits: invalid.map((value) =>
          value ? project(value, deadLimitProbeIds.slice(0, 50), deadLimitProbeIds[50] as string) : null,
        ),
        maximum: project(maximum, deadLimitProbeIds.slice(0, 200), deadLimitProbeIds[200] as string),
        overMaximum: project(overMaximum, deadLimitProbeIds.slice(0, 200), deadLimitProbeIds[200] as string),
        emptyCursor: ids(emptyCursor.nodes),
        terminalCursor: {
          ids: ids(terminalCursor.nodes),
          cursor: terminalCursor.nextCursor,
          truncated: terminalCursor.truncated,
        },
      };
    },
    golden: {
      page1: { ids: [deadLimitProbeIds[0]], cursor: deadLimitProbeIds[0], truncated: true },
      page2: { ids: [deadLimitProbeIds[1]], cursor: deadLimitProbeIds[1], truncated: true },
      invalidLimits: invalidLimits.map(() => ({
        first: deadLimitProbeIds[0],
        last: deadLimitProbeIds[49],
        containsGolden: true,
        excludesBeyond: true,
        truncated: true,
      })),
      maximum: {
        first: deadLimitProbeIds[0],
        last: deadLimitProbeIds[199],
        containsGolden: true,
        excludesBeyond: true,
        truncated: true,
      },
      overMaximum: {
        first: deadLimitProbeIds[0],
        last: deadLimitProbeIds[199],
        containsGolden: true,
        excludesBeyond: true,
        truncated: true,
      },
      emptyCursor: [deadLimitProbeIds[0]],
      terminalCursor: { ids: [], cursor: undefined, truncated: false },
    },
  },

  getCrossRepoBridges: {
    normalization:
      'bridge order and limit boundary are semantic; canonicalize only unordered edge ids within each bridge',
    run: async (repository) => {
      const one = await repository.getCrossRepoBridges({ limit: 1 }, [CONTRACT_REPO_A, CONTRACT_REPO_B]);
      // Limit equal to the seeded bridge count: the boundary this asserts is
      // "a limit that covers every bridge does not report truncation".
      const all = await repository.getCrossRepoBridges({ limit: 3 }, [CONTRACT_REPO_A, CONTRACT_REPO_B]);
      const invalid = await Promise.all(
        invalidLimits.map((limit) =>
          settled(repository.getCrossRepoBridges({ limit }, [CONTRACT_BRIDGE_REPO_C, CONTRACT_BRIDGE_REPO_D])),
        ),
      );
      const maximum = await repository.getCrossRepoBridges({ limit: 200 }, [
        CONTRACT_BRIDGE_REPO_C,
        CONTRACT_BRIDGE_REPO_D,
      ]);
      const overMaximum = await repository.getCrossRepoBridges({ limit: 201 }, [
        CONTRACT_BRIDGE_REPO_C,
        CONTRACT_BRIDGE_REPO_D,
      ]);
      const normalize = (value: typeof one) => ({
        bridges: value.edges
          .filter((edge) => edge.type === EdgeType.ResolvesTo)
          .map((resolvesEdge) => ({
            resolvesEdgeId: resolvesEdge.id,
            edgeIds: value.edges
              .filter(
                (edge) =>
                  edge.id === resolvesEdge.id ||
                  (edge.type === EdgeType.MakesExternalCall && edge.targetId === resolvesEdge.sourceId) ||
                  (edge.type === EdgeType.Handles && edge.sourceId === resolvesEdge.targetId),
              )
              .map((edge) => edge.id)
              .sort(),
          })),
        truncated: value.truncated,
      });
      return {
        one: normalize(one),
        all: normalize(all),
        invalidLimits: invalid.map((value) =>
          value
            ? limitBoundaryProjection(
                ids(value.edges.filter((edge) => edge.type === EdgeType.ResolvesTo)),
                CONTRACT_IDS.bridgeLimitEdgeIds.slice(0, 50),
                CONTRACT_IDS.bridgeLimitEdgeIds[50] as string,
              )
            : null,
        ),
        maximum: limitBoundaryProjection(
          ids(maximum.edges.filter((edge) => edge.type === EdgeType.ResolvesTo)),
          CONTRACT_IDS.bridgeLimitEdgeIds.slice(0, 200),
          CONTRACT_IDS.bridgeLimitEdgeIds[200] as string,
        ),
        overMaximum: limitBoundaryProjection(
          ids(overMaximum.edges.filter((edge) => edge.type === EdgeType.ResolvesTo)),
          CONTRACT_IDS.bridgeLimitEdgeIds.slice(0, 200),
          CONTRACT_IDS.bridgeLimitEdgeIds[200] as string,
        ),
      };
    },
    golden: {
      one: {
        bridges: [
          {
            resolvesEdgeId: CONTRACT_IDS.bridgeEdge1,
            edgeIds: [CONTRACT_IDS.makesExternalEdge1, CONTRACT_IDS.bridgeEdge1, CONTRACT_IDS.handlesB1Edge].sort(),
          },
        ],
        truncated: true,
      },
      all: {
        bridges: [
          {
            resolvesEdgeId: CONTRACT_IDS.bridgeEdge1,
            edgeIds: [CONTRACT_IDS.makesExternalEdge1, CONTRACT_IDS.bridgeEdge1, CONTRACT_IDS.handlesB1Edge].sort(),
          },
          {
            resolvesEdgeId: CONTRACT_IDS.bridgeEdge2,
            edgeIds: [CONTRACT_IDS.makesExternalEdge2, CONTRACT_IDS.bridgeEdge2, CONTRACT_IDS.handlesB2Edge].sort(),
          },
          {
            resolvesEdgeId: CONTRACT_IDS.bridgeEdge4,
            edgeIds: [CONTRACT_IDS.makesExternalEdge4, CONTRACT_IDS.bridgeEdge4, CONTRACT_IDS.handlesB1Edge].sort(),
          },
        ],
        truncated: false,
      },
      invalidLimits: invalidLimits.map(() => ({
        first: CONTRACT_IDS.bridgeLimitEdgeIds[0],
        last: CONTRACT_IDS.bridgeLimitEdgeIds[49],
        containsGolden: true,
        excludesBeyond: true,
      })),
      maximum: {
        first: CONTRACT_IDS.bridgeLimitEdgeIds[0],
        last: CONTRACT_IDS.bridgeLimitEdgeIds[199],
        containsGolden: true,
        excludesBeyond: true,
      },
      overMaximum: {
        first: CONTRACT_IDS.bridgeLimitEdgeIds[0],
        last: CONTRACT_IDS.bridgeLimitEdgeIds[199],
        containsGolden: true,
        excludesBeyond: true,
      },
    },
  },

  getPackageDependencyRollup: {
    normalization: 'exact documented dependency order; retain presence and numeric/boolean predicates',
    run: async (repository) =>
      (await repository.getPackageDependencyRollup([CONTRACT_REPO_A])).map((row) => ({
        sourcePackageId: row.sourcePackageId,
        targetPackageId: row.targetPackageId,
        hasCalls: row.callCount > 0,
        confidenceInRange: row.minConfidence >= 0 && row.minConfidence <= 1,
        isInferred: row.inferred,
        numericEncoding: typeof row.callCount === 'number' && typeof row.minConfidence === 'number',
      })),
    golden: [
      {
        sourcePackageId: CONTRACT_IDS.packageA1,
        targetPackageId: CONTRACT_IDS.packageA2,
        hasCalls: true,
        confidenceInRange: true,
        isInferred: true,
        numericEncoding: true,
      },
    ],
  },

  getComponentGraph: {
    normalization: 'component nodes/edges are unordered sets; sort ids only here; preserve explicit nulls',
    run: async (repository) => {
      const graph = await repository.getComponentGraph([CONTRACT_REPO_A]);
      return {
        nodes: graph.nodes
          .map((row) => ({ id: row.id, filePath: row.filePath, startLine: row.startLine }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        edges: graph.edges
          .map((row) => ({ sourceId: row.sourceId, targetId: row.targetId, type: row.type }))
          .sort((a, b) => `${a.sourceId}:${a.targetId}`.localeCompare(`${b.sourceId}:${b.targetId}`)),
      };
    },
    golden: {
      nodes: [
        { id: CONTRACT_IDS.baseClass, filePath: 'src/service.ts', startLine: 1 },
        { id: CONTRACT_IDS.childClass, filePath: 'src/child.ts', startLine: 1 },
        { id: CONTRACT_IDS.componentA, filePath: null, startLine: null },
        { id: CONTRACT_IDS.deepAllowedEntrypoint, filePath: 'src/deep.ts', startLine: 30 },
        { id: CONTRACT_IDS.deepTooFarEntrypoint, filePath: 'src/deep.ts', startLine: 32 },
        { id: CONTRACT_IDS.entrypointA, filePath: 'src/http.ts', startLine: 1 },
        { id: CONTRACT_IDS.eventEntrypointA, filePath: 'src/events.ts', startLine: 1 },
        {
          id: CONTRACT_IDS.mobileEntrypointA,
          filePath: 'app/src/main/java/com/example/MainActivity.kt',
          startLine: 1,
        },
        { id: CONTRACT_IDS.implementingClass, filePath: 'src/service.ts', startLine: 20 },
        { id: CONTRACT_IDS.queueEntrypointA, filePath: 'src/queue.ts', startLine: 1 },
        { id: CONTRACT_IDS.stateStoreA, filePath: 'src/state.ts', startLine: 1 },
      ].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [{ sourceId: CONTRACT_IDS.childClass, targetId: CONTRACT_IDS.baseClass, type: EdgeType.Extends }],
    },
  },

  getResolvesEdge: {
    normalization: 'singleton exact projection; ordered chain JSON and numeric confidence preserved',
    run: async (repository) => {
      const row = await repository.getResolvesEdge!(CONTRACT_IDS.externalCall1);
      return (
        row && {
          id: row.id,
          sourceId: row.sourceId,
          targetId: row.targetId,
          confidence: row.confidence,
          confidenceType: typeof row.confidence,
          via: row.via,
          chain: row.chain,
        }
      );
    },
    golden: {
      id: CONTRACT_IDS.bridgeEdge1,
      sourceId: CONTRACT_IDS.externalCall1,
      targetId: CONTRACT_IDS.entrypointB1,
      confidence: 0.9,
      confidenceType: 'number',
      via: 'protocol',
      chain: [
        { kind: 'protocol', detail: 'http:GET:/v1/items' },
        { kind: 'entrypoint', detail: 'GET /v1/items' },
      ],
    },
  },

  getMonikeredFunctions: {
    normalization: 'exact deterministic repo/file/line order and nested moniker encoding',
    run: async (repository) =>
      (await repository.getMonikeredFunctions!([CONTRACT_REPO_A])).map((row) => ({
        id: row.id,
        moniker: row.moniker,
      })),
    golden: [
      {
        id: CONTRACT_IDS.monikerFunction,
        moniker: { packageName: '@contract/sdk', descriptor: 'ContractClient.fetch().' },
      },
    ],
  },

  getInternalCallEdges: {
    normalization: 'caller/callee id pair projection in deterministic (callerId, calleeId) order',
    run: (repository) =>
      repository.getInternalCallEdges!([CONTRACT_REPO_A], [CONTRACT_IDS.monikerFunction, CONTRACT_IDS.cycleB]),
    golden: [
      { callerId: CONTRACT_IDS.componentA, calleeId: CONTRACT_IDS.cycleB },
      { callerId: CONTRACT_IDS.cycleA, calleeId: CONTRACT_IDS.cycleB },
      { callerId: CONTRACT_IDS.embeddedFunction, calleeId: CONTRACT_IDS.monikerFunction },
    ],
  },

  getPackageLinkerFacts: {
    normalization: 'minimal package-linker projection with deterministic file and declaration identity',
    run: async (repository) => {
      const facts = await repository.getPackageLinkerFacts!([CONTRACT_REPO_A]);
      return {
        file: facts.files.find((row) => row.id === CONTRACT_IDS.fileSymbols),
        declaration: facts.declarations.find((row) => row.id === CONTRACT_IDS.enumNode),
      };
    },
    golden: {
      file: {
        id: CONTRACT_IDS.fileSymbols,
        path: 'src/symbols.ts',
        packageId: CONTRACT_IDS.packageA1,
        imports: [],
      },
      declaration: {
        id: CONTRACT_IDS.enumNode,
        name: 'Status',
        fileId: CONTRACT_IDS.fileSymbols,
        kind: 'enum',
        isExported: true,
      },
    },
  },

  getAppliedGraphSnapshot: {
    normalization: 'singleton exact metadata; null fields and numeric receipt encodings preserved',
    run: async (repository) => {
      const row = await repository.getAppliedGraphSnapshot(CONTRACT_REPO_A);
      return (
        row && {
          parsedVersion: row.parsedVersion,
          summaryVersion: row.summaryVersion,
          embeddingsVersion: row.embeddingsVersion,
          commitSha: row.commitSha,
          mode: row.mode,
          executionToken: row.executionToken,
          nodeCountIsNumber: typeof row.nodeCount === 'number',
          hasAppliedAt: typeof row.appliedAt === 'string' && row.appliedAt.length > 0,
        }
      );
    },
    golden: {
      parsedVersion: 'contract-parsed-v1',
      summaryVersion: null,
      embeddingsVersion: 'contract-embeddings-v1',
      commitSha: null,
      mode: GraphApplyMode.Full,
      executionToken: 'contract-execution-token',
      nodeCountIsNumber: true,
      hasAppliedAt: true,
    },
  },
  getPendingGraphApply: {
    normalization: 'exact: a completed apply leaves no in-flight mark (atomic backends omit the method)',
    run: async (repository) => ({ pending: (await repository.getPendingGraphApply?.(CONTRACT_REPO_A)) ?? null }),
    golden: { pending: null },
  },
  findUnresolvedCallsByNameTail: {
    normalization: 'exact: (filePath, line) ordering, cap applied after ordering',
    run: async (repository) => ({
      scopedToRepoA: await repository.findUnresolvedCallsByNameTail('emit', [CONTRACT_REPO_A]),
      capped: await repository.findUnresolvedCallsByNameTail('emit', [CONTRACT_REPO_A], { limit: 1 }),
      crossRepo: await repository.findUnresolvedCallsByNameTail('emit', []),
      // `sharedName` is a RESOLVED callee (it has CALLS edges): unresolved-call
      // queries must never surface a resolved call as a boundary candidate.
      resolvedCalleeName: await repository.findUnresolvedCallsByNameTail('sharedName', [CONTRACT_REPO_A]),
      emptyTail: await repository.findUnresolvedCallsByNameTail('', [CONTRACT_REPO_A]),
    }),
    golden: {
      scopedToRepoA: [CONTRACT_UNRESOLVED_CALLS_A[2], CONTRACT_UNRESOLVED_CALLS_A[0]],
      capped: [CONTRACT_UNRESOLVED_CALLS_A[2]],
      crossRepo: [CONTRACT_UNRESOLVED_CALLS_A[2], CONTRACT_UNRESOLVED_CALLS_B[0], CONTRACT_UNRESOLVED_CALLS_A[0]],
      resolvedCalleeName: [],
      emptyTail: [],
    },
  },

  findUnresolvedCallsInFiles: {
    normalization: 'exact: (filePath, line) ordering across the requested files',
    run: async (repository) => ({
      inFile: await repository.findUnresolvedCallsInFiles(['src/dispatch.ts'], [CONTRACT_REPO_A]),
      capped: await repository.findUnresolvedCallsInFiles(['src/dispatch.ts'], [CONTRACT_REPO_A], { limit: 1 }),
      otherRepoFile: await repository.findUnresolvedCallsInFiles(['src/beta-dispatch.ts'], [CONTRACT_REPO_A]),
      noFiles: await repository.findUnresolvedCallsInFiles([], [CONTRACT_REPO_A]),
    }),
    golden: {
      inFile: [CONTRACT_UNRESOLVED_CALLS_A[1], CONTRACT_UNRESOLVED_CALLS_A[0]],
      capped: [CONTRACT_UNRESOLVED_CALLS_A[1]],
      otherRepoFile: [],
      noFiles: [],
    },
  },
} satisfies { [K in ReadMethod]: ContractCase };

type RepoScopedMethod = Exclude<
  ReadMethod,
  'listAllRepositories' | 'getResolvesEdge' | 'getAppliedGraphSnapshot' | 'getPendingGraphApply'
>;

interface RepoScopeCase {
  run(repository: IGraphReadRepository): Promise<unknown>;
  golden: unknown;
}

/** Exhaustive wrong-repository probes, executed inside the existing per-method contract case. */
const wrongRepoScopeCases = {
  findCode: {
    run: (repository) =>
      repository.findCode({ pattern: 'sharedName', types: [NodeType.Function], limit: 10 }, [
        CONTRACT_OUT_OF_SCOPE_REPO,
      ]),
    golden: [],
  },
  listSymbolsInFile: {
    run: (repository) => repository.listSymbolsInFile('src/path.ts', [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  findFunction: {
    run: (repository) => repository.findFunction('sharedName', [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: null,
  },
  findClass: {
    run: (repository) => repository.findClass('BaseService', [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: null,
  },
  findInterface: {
    run: (repository) => repository.findInterface('Runnable', [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: null,
  },
  findEnum: {
    run: (repository) => repository.findEnum('Status', [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: null,
  },
  findTypeAlias: {
    run: (repository) => repository.findTypeAlias('Identifier', [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: null,
  },
  findEntity: {
    run: (repository) => repository.findEntity('users', [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: null,
  },
  listEntities: {
    run: (repository) => repository.listEntities([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  listEntrypoints: {
    run: (repository) => repository.listEntrypoints({ id: CONTRACT_IDS.entrypointA }, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getRepoOverview: {
    run: (repository) => repository.getRepoOverview([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getCoverageCounts: {
    run: (repository) => repository.getCoverageCounts([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getRepositoryNames: {
    run: (repository) => repository.getRepositoryNames([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getPackages: {
    run: (repository) => repository.getPackages([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getEmbeddedNodes: {
    run: (repository) => repository.getEmbeddedNodes([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getDirectCallers: {
    run: (repository) => repository.getDirectCallers(CONTRACT_IDS.cycleB, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getTransitiveCallers: {
    run: (repository) => repository.getTransitiveCallers(CONTRACT_IDS.cycleB, 10, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getReachingEntrypoints: {
    run: (repository) => repository.getReachingEntrypoints(CONTRACT_IDS.cycleB, 10, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  findShortestPath: {
    run: (repository) =>
      repository.findShortestPath(CONTRACT_IDS.pathStart, CONTRACT_IDS.pathTarget, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getCallTree: {
    run: (repository) => repository.getCallTree(CONTRACT_IDS.cycleA, 10, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getDirectCallees: {
    run: (repository) => repository.getDirectCallees(CONTRACT_IDS.pathStart, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getClassExtensions: {
    run: (repository) => repository.getClassExtensions(CONTRACT_IDS.baseClass, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getInterfaceImplementations: {
    run: (repository) =>
      repository.getInterfaceImplementations(CONTRACT_IDS.interfaceNode, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getEntityConsumers: {
    run: (repository) => repository.getEntityConsumers('users', [CONTRACT_OUT_OF_SCOPE_REPO], 'read'),
    golden: [],
  },
  getTypeUsages: {
    run: (repository) => repository.getTypeUsages(CONTRACT_IDS.interfaceNode, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getEntitiesForFunctions: {
    run: (repository) =>
      repository.getEntitiesForFunctions([CONTRACT_IDS.entityConsumer], [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getExternalCalls: {
    run: (repository) => repository.getExternalCalls([CONTRACT_OUT_OF_SCOPE_REPO], 'contract-beta'),
    golden: [],
  },
  getExternalCallsWithMessaging: {
    run: (repository) => repository.getExternalCallsWithMessaging([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getExternalCallsFrom: {
    run: (repository) => repository.getExternalCallsFrom(CONTRACT_IDS.cycleA, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getNodesByIds: {
    run: (repository) => repository.getNodesByIds([CONTRACT_IDS.sharedA1], [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getNeighborCounts: {
    run: (repository) => repository.getNeighborCounts(CONTRACT_IDS.pathStart, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getNeighbors: {
    run: (repository) =>
      repository.getNeighbors(CONTRACT_IDS.pathStart, { direction: 'out', limit: 1 }, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: { nodes: [], edges: [], truncated: false },
  },
  listNodesByType: {
    run: (repository) => repository.listNodesByType(NodeType.Variable, { limit: 1 }, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: { nodes: [], truncated: false },
  },
  getNodeWithProperties: {
    run: (repository) => repository.getNodeWithProperties(CONTRACT_IDS.unicodeFunction, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: null,
  },
  getSubgraph: {
    run: (repository) =>
      repository.getSubgraph(
        CONTRACT_IDS.pathStart,
        { depth: 1, direction: 'out', edgeTypes: [EdgeType.Calls], nodeCap: 1 },
        [CONTRACT_OUT_OF_SCOPE_REPO],
      ),
    golden: { nodes: [], edges: [], truncated: false },
  },
  getEdgesAmong: {
    run: (repository) =>
      repository.getEdgesAmong([CONTRACT_IDS.pathStart, CONTRACT_IDS.pathLeft], [CONTRACT_OUT_OF_SCOPE_REPO], 1),
    golden: { edges: [], truncated: false },
  },
  findDeadNodes: {
    run: (repository) => repository.findDeadNodes({ limit: 1 }, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: { nodes: [], truncated: false, lowCoverageRepos: [] },
  },
  getCrossRepoBridges: {
    run: (repository) => repository.getCrossRepoBridges({ limit: 1 }, [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: { nodes: [], edges: [], truncated: false },
  },
  getPackageDependencyRollup: {
    run: (repository) => repository.getPackageDependencyRollup([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getComponentGraph: {
    run: (repository) => repository.getComponentGraph([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: { nodes: [], edges: [] },
  },
  getMonikeredFunctions: {
    run: (repository) => repository.getMonikeredFunctions!([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  getPackageLinkerFacts: {
    run: (repository) => repository.getPackageLinkerFacts!([CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: { files: [], declarations: [] },
  },
  getInternalCallEdges: {
    run: (repository) => repository.getInternalCallEdges!([CONTRACT_OUT_OF_SCOPE_REPO], [CONTRACT_IDS.monikerFunction]),
    golden: [],
  },
  findUnresolvedCallsByNameTail: {
    run: (repository) => repository.findUnresolvedCallsByNameTail('emit', [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
  findUnresolvedCallsInFiles: {
    run: (repository) => repository.findUnresolvedCallsInFiles(['src/dispatch.ts'], [CONTRACT_OUT_OF_SCOPE_REPO]),
    golden: [],
  },
} satisfies { [K in RepoScopedMethod]: RepoScopeCase };

interface BackendHandle {
  repository: IGraphRepository;
  close(): Promise<void>;
}

async function openSqlite(): Promise<BackendHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'coredoc-contract-sqlite-'));
  const driver = new SqliteDriver(`file:${join(dir, 'graph.db')}`);
  await driver.initialize();
  return {
    repository: new SqliteRepository(driver),
    close: async () => {
      await driver.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function openLadybug(): Promise<BackendHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'coredoc-contract-ladybug-'));
  const driver = new LadybugDriver(join(dir, 'graph.db'), { readOnly: false });
  await driver.initialize();
  return {
    repository: new LadybugRepository(driver),
    close: async () => {
      await driver.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The live-server arm, gated by `COREDOC_TEST_NEO4J_URI` (see the file header for the
 * `docker run` line). Absent — the CI case — the arm is never registered and nothing here runs.
 */
const NEO4J_TEST_URI = process.env.COREDOC_TEST_NEO4J_URI;

async function openNeo4j(): Promise<BackendHandle> {
  // The driver reads its connection from NEO4J_* (module singleton, lazy). The gate variable is
  // separate on purpose: a developer with NEO4J_URI already exported for a real graph does not
  // get their database wiped by running the test suite.
  process.env.NEO4J_URI = NEO4J_TEST_URI;
  const driver = new Neo4jDriver();
  await driver.initialize();
  // A server persists between runs; every golden below assumes a graph holding only the fixture.
  await driver.withWriteTransaction((tx) => tx.run('MATCH (n) DETACH DELETE n'));
  await ensureGraphIndexes();
  return { repository: new Neo4jRepository(driver), close: () => driver.close() };
}

const caseEntries = Object.entries(contractCases) as Array<[ReadMethod, ContractCase]>;

const backendArms: Array<[string, () => Promise<BackendHandle>]> = [
  ['sqlite', openSqlite],
  ['ladybug', openLadybug],
  ...(NEO4J_TEST_URI ? ([['neo4j', openNeo4j]] as Array<[string, () => Promise<BackendHandle>]>) : []),
];

describe.each(backendArms)('IGraphReadRepository criterion-21 contract — %s', (_engine, open) => {
  let handle: BackendHandle;

  // Opening + seeding takes ~3s alone but has hit 30s on a saturated CI runner
  // where every package's vitest runs concurrently.
  beforeAll(async () => {
    handle = await open();
    await seedContractFixture(handle.repository);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  });

  it.each(caseEntries)('%s returns its non-empty golden contract', async (method, contractCase) => {
    const actual = await contractCase.run(handle.repository);
    expect(actual).toStrictEqual(contractCase.golden);
    expect(actual).not.toBeNull();
    expect(actual).not.toEqual([]);
    if (method in wrongRepoScopeCases) {
      const scopeCase = wrongRepoScopeCases[method as RepoScopedMethod];
      expect(await scopeCase.run(handle.repository)).toStrictEqual(scopeCase.golden);
    }
  });
});
