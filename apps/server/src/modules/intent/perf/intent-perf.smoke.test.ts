/**
 * Intent performance smoke — the §15 GATE, not a spec number.
 *
 * WHAT THIS IS FOR. Spec §16 names one residual risk: "derivation cost on large
 * graphs is unproven". This lane makes that cost a measured, committed number
 * instead of something discovered in production. It drives the REAL endpoints
 * (Nest controllers, real guards, real Postgres, a real Ladybug snapshot)
 * against a generated workspace shaped like a mature multi-repo team product,
 * and records per-workload latency percentiles plus SQL and graph query counts
 * into `apps/server/perf/intent-baseline.json`.
 *
 * WHAT IT ASSERTS, AND WHAT IT DOES NOT. There are no absolute latency budgets:
 * the timings depend on the machine, and the compose Postgres runs on tmpfs, so
 * an absolute threshold here would be a number about a laptop. What IS asserted:
 *
 *  1. Every workload still produces the answer it claims to measure (a fast
 *     empty result is not a fast result).
 *  2. QUERY COUNTS never rise above the committed baseline. Query count is
 *     shape, not speed — it is deterministic, and an increase means a read
 *     acquired a round trip, which is the regression that actually compounds.
 *
 * Latency is REPORTED against the baseline (ratios printed) and never fails the
 * run. Read the printed table; a p95 that doubled on the same machine is worth
 * a look even though this lane will not stop you.
 *
 * NOT PART OF `pnpm test` OR `pnpm test:postgres`. It is env-gated the way every
 * Postgres suite here is (`INTENT_PERF_TEST_DATABASE_URL`), it is absent from the
 * `scripts/test-postgres-integration.sh` allowlist, and it has its own runner:
 *
 *   apps/server/scripts/perf-intent-smoke.sh                 # compare to baseline
 *   INTENT_PERF_UPDATE_BASELINE=1 apps/server/scripts/perf-intent-smoke.sh
 *
 * Pool `forks` (the server vitest config sets it): the Ladybug native module.
 */
import 'dotenv/config';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { openIntentGraphFixture, type OpenedIntentGraphFixture } from '@coredoc/db/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard } from '../../../auth/auth.guard.js';
import { ControlPlaneService, type WorkspaceRepo } from '../../../database/control-plane.service.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { PrismaClient } from '../../../generated/prisma/client.js';
import { WorkspaceMcpContextService } from '../../../mcp/workspace-mcp-context.service.js';
import { IntentAuthorizingSourceKind, IntentReviewAction } from '../contract/index.js';
import { IntentMatchReason } from '../derivation/derivation-contract.js';
import { IntentDerivationService } from '../derivation/intent-derivation.service.js';
import { IntentContextController } from '../intent-context.controller.js';
import { IntentContextService } from '../intent-context.service.js';
import { IntentReviewController } from '../intent-review.controller.js';
import { IntentReviewService } from '../intent-review.service.js';
import { IntentTransitionsService } from '../intent-transitions.service.js';
import { BASELINE_PATH, PerfWorkloadName, writePerfArtifact } from './intent-perf-baseline.js';
import {
  PERF_LEXICAL_PHRASE,
  PERF_WORKSPACE_SHAPE,
  buildPerfGraphFixture,
  clearPerfWorkspaceRows,
  perfReviewCandidateId,
  seedPerfWorkspaceRows,
  type PerfGraphFixture,
  type PerfWorkspaceRows,
} from './intent-perf-fixture.test-support.js';

const TEST_DATABASE_URL = process.env.INTENT_PERF_TEST_DATABASE_URL ?? '';
const UPDATE_BASELINE = process.env.INTENT_PERF_UPDATE_BASELINE === '1';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };

/** Iterations per workload. Warm-ups are discarded: the first request pays JIT and pool warm-up. */
const WARMUP_ITERATIONS = 3;
const MEASURED_ITERATIONS = 25;
/** Decisions per review batch — `INTENT_CONTRACT_LIMITS.batch`, the contract maximum. */
const REVIEW_BATCH_SIZE = 10;
/** Per-workload budget: 28 real requests each, and the node workloads walk the whole graph. */
const WORKLOAD_TIMEOUT_MS = 300_000;
/** `INTENT_CONTEXT_LIMITS.max` — the largest answer a context-mode read may return. */
const CONTEXT_LIMIT = '20';
/** `INTENT_CONTEXT_READ_LIMITS.intentIds` — the largest exact-id selector the contract accepts. */
const EXACT_ID_SELECTOR_SIZE = 50;

/** One measured workload. Shape of a row in the baseline artifact. */
interface WorkloadReport {
  name: string;
  request: string;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  /** SQL statements the request issued, counted at the pg transport. */
  sqlQueries: number;
  /** Graph reads the request issued against the Ladybug snapshot. */
  graphQueries: number;
  /** What the request returned — proof the timing is not of an empty answer. */
  resultSize: number;
  /** Whether a §6.1 derivation bound tripped, and which. */
  derivationTruncated?: boolean;
  derivationLimits?: string[];
}

interface PerfReport {
  generatedAt: string;
  environment: Record<string, unknown>;
  shape: typeof PERF_WORKSPACE_SHAPE;
  fixture: Record<string, unknown>;
  iterations: { warmup: number; measured: number };
  workloads: WorkloadReport[];
}

function percentile(sorted: readonly number[], fraction: number): number {
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return Math.round((sorted[rank - 1] as number) * 100) / 100;
}

/**
 * A pg pool that counts every statement it issues.
 *
 * Counted at the TRANSPORT rather than through Prisma's logging events: this
 * sees `BEGIN`/`COMMIT` and every statement a transaction fans out into, which
 * is exactly what "did this read acquire a round trip" means.
 */
function countingPool(connectionString: string): { pool: pg.Pool; counter: { count: number } } {
  const pool = new pg.Pool({ connectionString });
  const counter = { count: 0 };
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      counter.count += 1;
      return query(...args);
    }) as typeof client.query;
  });
  return { pool, counter };
}

/** Count every graph read the request makes, without changing what the repository does. */
function countingRepository<T extends object>(repository: T, counter: { count: number }): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        counter.count += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe.skipIf(!TEST_DATABASE_URL)('intent performance smoke (PostgreSQL + Ladybug)', () => {
  let prisma: PrismaClient;
  let pool: pg.Pool;
  let sqlCounter: { count: number };
  let graphCounter: { count: number };
  let previousDatabaseUrl: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let directory: string;
  let graph: PerfGraphFixture;
  let rows: PerfWorkspaceRows;
  let opened: OpenedIntentGraphFixture;
  const workloads: WorkloadReport[] = [];

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const counting = countingPool(TEST_DATABASE_URL);
    pool = counting.pool;
    sqlCounter = counting.counter;
    graphCounter = { count: 0 };
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as never);
    await prisma.$connect();

    directory = mkdtempSync(join(tmpdir(), 'coredoc-intent-perf-'));
    graph = await buildPerfGraphFixture(join(directory, 'workspace.ladybug'));
    opened = await openIntentGraphFixture(graph.path, { readOnly: true });

    const workspace = await prisma.workspace.create({
      data: { name: `intent-perf-${RUN}`, slug: `intent-perf-${RUN}` },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: OWNER.id, email: OWNER.email, role: 'owner' },
    });
    rows = await seedPerfWorkspaceRows(prisma, workspaceId, OWNER.id, graph);
    const repos = (await prisma.workspaceRepo.findMany({ where: { workspaceId } })) as unknown as WorkspaceRepo[];
    const repository = countingRepository(opened.repository as unknown as object, graphCounter);

    const moduleRef = await Test.createTestingModule({
      controllers: [IntentContextController, IntentReviewController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        IntentDerivationService,
        IntentContextService,
        IntentReviewService,
        IntentTransitionsService,
        {
          provide: WorkspaceMcpContextService,
          useValue: {
            async withContextByWorkspaceId(_workspaceId: string, callback: (context: never) => Promise<unknown>) {
              return callback({
                repository,
                scope: {},
                repos,
                versionId: 'v-perf-smoke',
                graphBackend: 'file_snapshot',
              } as never);
            },
          },
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = OWNER;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // Keep one loopback listener for the batch; per-request Supertest listeners
    // race Node's keep-alive reuse and intermittently reset a measured request.
    await app.listen(0, '127.0.0.1');
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    await opened?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    if (workspaceId) {
      await clearPerfWorkspaceRows(prisma, workspaceId);
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    await pool?.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }, 120_000);

  function base() {
    return `/api/v1/workspaces/${workspaceId}/intent`;
  }

  /**
   * Run one workload and record it.
   *
   * `run` returns the response body of a single request; the LAST measured
   * iteration supplies the counters and the result size, because both are
   * deterministic while the timings are not.
   */
  async function measure(
    name: PerfWorkloadName,
    requestDescription: string,
    run: (iteration: number) => Promise<Record<string, unknown>>,
    describeResult: (body: Record<string, unknown>) => { resultSize: number },
  ): Promise<Record<string, unknown>> {
    for (let index = 0; index < WARMUP_ITERATIONS; index += 1) await run(index);

    const timings: number[] = [];
    let body: Record<string, unknown> = {};
    let sqlQueries = 0;
    let graphQueries = 0;
    for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
      sqlCounter.count = 0;
      graphCounter.count = 0;
      const started = performance.now();
      body = await run(WARMUP_ITERATIONS + index);
      timings.push(performance.now() - started);
      sqlQueries = sqlCounter.count;
      graphQueries = graphCounter.count;
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const graphInfo = body.graph as { truncated?: boolean; limits?: string[] } | undefined;
    workloads.push({
      name,
      request: requestDescription,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      minMs: percentile(sorted, 0),
      maxMs: percentile(sorted, 1),
      sqlQueries,
      graphQueries,
      ...describeResult(body),
      ...(graphInfo
        ? { derivationTruncated: graphInfo.truncated === true, derivationLimits: graphInfo.limits ?? [] }
        : {}),
    });
    return body;
  }

  async function read(query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer()).get(`${base()}/context`).query(query);
    // The body carries the structured refusal; a bare status assertion would
    // hide which selector the endpoint rejected.
    if (response.status !== 200) {
      // `body` is `{}` whenever the response was not JSON (an unmatched route,
      // a crash below the filter), which says nothing about what went wrong —
      // so the raw text rides along.
      throw new Error(
        `context read ${response.status}: ${JSON.stringify(response.body)} ${response.text?.slice(0, 400) ?? ''}`,
      );
    }
    return response.body;
  }

  const matchCount = (body: Record<string, unknown>) => ({
    resultSize: (body.matches as unknown[] | undefined)?.length ?? 0,
  });

  /* ------------------------------------------------------------ reads --- */

  it(
    'feature-scoped context read',
    async () => {
      const feature = graph.features[0]?.featureId as string;
      const body = await measure(
        PerfWorkloadName.ContextFeatureScope,
        `GET intent/context?feature=${feature}&limit=20`,
        () => read({ feature, limit: CONTEXT_LIMIT }),
        matchCount,
      );
      expect((body.matches as unknown[]).length).toBeGreaterThan(0);
      expect(body.evidence).toMatchObject({ available: true });
    },
    WORKLOAD_TIMEOUT_MS,
  );

  it(
    'node-selector context read with derivation, unscoped — the worst case',
    async () => {
      const feature = graph.features[0];
      const body = await measure(
        PerfWorkloadName.ContextNodeIdsUnscoped,
        'GET intent/context?nodeIds=<feature handler>&limit=20',
        () => read({ nodeIds: feature?.handlerNodeId as string, limit: CONTEXT_LIMIT }),
        matchCount,
      );
      // The guard case must actually fire, or this is timing a row lookup.
      const derived = (body.matches as Array<{ derivedReasons?: string[] }>).some((match) =>
        match.derivedReasons?.includes(IntentMatchReason.AnchorCalledByArea),
      );
      expect(derived).toBe(true);
    },
    WORKLOAD_TIMEOUT_MS,
  );

  it(
    'node-selector context read with derivation, scoped to the feature',
    async () => {
      const feature = graph.features[0];
      const body = await measure(
        PerfWorkloadName.ContextNodeIdsFeatureScoped,
        'GET intent/context?feature=<f>&nodeIds=<feature handler>&limit=20',
        () =>
          read({
            feature: feature?.featureId as string,
            nodeIds: feature?.handlerNodeId as string,
            limit: CONTEXT_LIMIT,
          }),
        matchCount,
      );
      expect(body.matchedFeatureIds as string[]).toContain(feature?.featureId);
    },
    WORKLOAD_TIMEOUT_MS,
  );

  it(
    'task fusion with text and code constraints',
    async () => {
      const feature = graph.features[0];
      const body = await measure(
        PerfWorkloadName.ContextTask,
        'GET intent/context?task=<task>&nodeIds=<handler>&limit=20',
        () => read({ task: PERF_LEXICAL_PHRASE, nodeIds: feature?.handlerNodeId as string, limit: CONTEXT_LIMIT }),
        matchCount,
      );
      const matches = body.matches as Array<{ id: string; matchReasons?: string[]; derivedReasons?: string[] }>;
      expect(matches.some((match) => match.matchReasons?.includes('text'))).toBe(true);
      expect(matches.some((match) => match.derivedReasons?.includes(IntentMatchReason.AnchorCalledByArea))).toBe(true);
      expect(new Set(matches.map((match) => match.id)).size).toBe(matches.length);
    },
    WORKLOAD_TIMEOUT_MS,
  );

  it(
    'lexical search',
    async () => {
      const body = await measure(
        PerfWorkloadName.ContextLexicalSearch,
        `GET intent/context?query="${PERF_LEXICAL_PHRASE}"&limit=20`,
        () => read({ query: PERF_LEXICAL_PHRASE, limit: CONTEXT_LIMIT }),
        matchCount,
      );
      expect((body.matches as unknown[]).length).toBeGreaterThan(0);
    },
    WORKLOAD_TIMEOUT_MS,
  );

  it(
    'exact-id fetch',
    async () => {
      // The selector carries the contract maximum; the ANSWER is capped at 20 by
      // `INTENT_CONTEXT_LIMITS.max`, so this measures the full 50-id lookup and a
      // bounded response, which is what a real handoff re-fetch does.
      const ids = rows.acceptedItemIds.slice(0, EXACT_ID_SELECTOR_SIZE);
      const body = await measure(
        PerfWorkloadName.ContextExactIds,
        `GET intent/context?intentIds=<${EXACT_ID_SELECTOR_SIZE} ids>&limit=${CONTEXT_LIMIT}`,
        () => read({ intentIds: ids.join(','), limit: CONTEXT_LIMIT }),
        matchCount,
      );
      expect(body.unknownIntentIds).toEqual([]);
      expect((body.matches as unknown[]).length).toBe(Number(CONTEXT_LIMIT));
    },
    WORKLOAD_TIMEOUT_MS,
  );

  /* ----------------------------------------------------------- review --- */

  it(
    'review batch',
    async () => {
      const body = await measure(
        PerfWorkloadName.ReviewBatch,
        'POST intent/items/review with 10 accept decisions',
        async (iteration) => {
          const offset = iteration * REVIEW_BATCH_SIZE;
          const response = await request(app.getHttpServer())
            .post(`${base()}/items/review`)
            .send({
              idempotencyKey: `perf-review-${RUN}-${iteration}`,
              authorizingSource: {
                kind: IntentAuthorizingSourceKind.Spec,
                ref: 'spec/perf',
                revision: 'fixture-v1',
                localId: `PERF-${iteration}`,
              },
              decisions: Array.from({ length: REVIEW_BATCH_SIZE }, (_unused, index) => ({
                itemId: perfReviewCandidateId(offset + index),
                expectedVersion: 1,
                action: IntentReviewAction.Accept,
                reason: 'Accepted by the performance smoke.',
              })),
            })
            .expect(201);
          return response.body;
        },
        (body) => ({ resultSize: (body.decisions as unknown[] | undefined)?.length ?? 0 }),
      );
      const decisions = body.decisions as Array<{ outcome: string }>;
      expect(decisions).toHaveLength(REVIEW_BATCH_SIZE);
      expect(decisions.every((decision) => decision.outcome === 'accepted')).toBe(true);
    },
    WORKLOAD_TIMEOUT_MS,
  );

  /* --------------------------------------------------- report and gate --- */

  it('writes the report and compares it to the committed baseline', () => {
    const report: PerfReport = {
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: cpus().length,
        // Recorded because it is why these numbers are FLOOR values, not
        // production latency: the compose Postgres keeps its data on tmpfs and
        // the Ladybug snapshot is a warm local file in one process.
        postgres: 'docker compose postgres:16-alpine (tmpfs data volume)',
        graph: 'local .ladybug file, read-only handle, same process',
      },
      shape: PERF_WORKSPACE_SHAPE,
      fixture: {
        graphNodes: graph.nodeCount,
        graphEdges: graph.edgeCount,
        graphBuildMs: graph.buildMs,
        repos: graph.repoKeys.length,
        ...rows.counts,
      },
      iterations: { warmup: WARMUP_ITERATIONS, measured: MEASURED_ITERATIONS },
      workloads,
    };

    // Throws rather than writing when an UPDATE run is missing a workload:
    // the report omits workloads whose test failed, and a baseline written from
    // one loses that workload's query-count gate silently.
    const target = writePerfArtifact(report, { update: UPDATE_BASELINE });
    process.stdout.write(`\nintent perf smoke → ${target}\n`);

    let baseline: PerfReport | undefined;
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as PerfReport;
    } catch {
      baseline = undefined;
    }
    if (UPDATE_BASELINE || !baseline) {
      process.stdout.write(
        UPDATE_BASELINE
          ? 'baseline UPDATED — commit it\n'
          : 'no baseline to compare against; run with INTENT_PERF_UPDATE_BASELINE=1\n',
      );
      for (const workload of workloads) {
        process.stdout.write(
          `  ${workload.name}: p50 ${workload.p50Ms}ms p95 ${workload.p95Ms}ms ` +
            `sql ${workload.sqlQueries} graph ${workload.graphQueries} results ${workload.resultSize}\n`,
        );
      }
      return;
    }

    const regressions: string[] = [];
    for (const workload of workloads) {
      const previous = baseline.workloads.find((candidate) => candidate.name === workload.name);
      if (!previous) {
        process.stdout.write(`  ${workload.name}: NEW workload, no baseline row\n`);
        continue;
      }
      const ratio = previous.p95Ms > 0 ? workload.p95Ms / previous.p95Ms : 1;
      process.stdout.write(
        `  ${workload.name}: p95 ${workload.p95Ms}ms vs ${previous.p95Ms}ms (${ratio.toFixed(2)}×) ` +
          `sql ${workload.sqlQueries}/${previous.sqlQueries} graph ${workload.graphQueries}/${previous.graphQueries}\n`,
      );
      // Query counts are the gate: deterministic, and an extra round trip is
      // the regression that compounds with workspace size.
      if (workload.sqlQueries > previous.sqlQueries) {
        regressions.push(`${workload.name}: SQL ${previous.sqlQueries} → ${workload.sqlQueries}`);
      }
      if (workload.graphQueries > previous.graphQueries) {
        regressions.push(`${workload.name}: graph ${previous.graphQueries} → ${workload.graphQueries}`);
      }
    }
    expect(regressions, `query-count regressions against ${BASELINE_PATH}`).toEqual([]);
  });
});
