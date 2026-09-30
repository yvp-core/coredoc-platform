import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IGraphRepository } from '@coredoc/db';
import type { Target } from './types.js';

export function f1(
  cited: string[],
  truth: string[],
): { precision: number; recall: number; f1: number } {
  if (cited.length === 0) return { precision: 0, recall: 0, f1: 0 };
  const truthSet = new Set(truth.map((t) => t.toLowerCase()));
  const citedSet = new Set(cited.map((c) => c.toLowerCase()));
  const tp = [...citedSet].filter((c) => truthSet.has(c)).length;
  const precision = tp / citedSet.size;
  const recall = truthSet.size === 0 ? 0 : tp / truthSet.size;
  const denom = precision + recall;
  return {
    precision,
    recall,
    f1: denom === 0 ? 0 : (2 * precision * recall) / denom,
  };
}

/** Lowercase and drop `./` / leading-slash noise so citations compare uniformly. */
export function normalizePathForMatch(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

/**
 * The single path-equivalence rule every file-list verifier uses.
 *
 * Agents legitimately cite a path with a different leading prefix than the
 * truth set carries: `acme/acme-packages/src/x.ts` (workspace-qualified, which
 * blast-radius' own prompt asks for) vs `acme-packages/src/x.ts`, or a
 * repo-relative `src/modules/a/b.ts` vs a monorepo-relative
 * `services/api-gateway/src/modules/a/b.ts`. Exact equality scored all of those
 * as misses.
 *
 * Two paths match when one is a whole-segment suffix of the other. The `/`
 * in the `endsWith` check is what anchors on segment boundaries, so
 * `foo/index.ts` never matches `bar/index.ts`, and requiring a slash in the
 * shorter form keeps a bare basename (`index.ts`) from matching everything.
 */
export function matchesPath(cited: string, truth: string): boolean {
  const a = normalizePathForMatch(cited);
  const b = normalizePathForMatch(truth);
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.includes('/') && longer.endsWith(`/${shorter}`);
}

export interface FilePathScore {
  precision: number;
  recall: number;
  f1: number;
  matchedTruth: string[];
  matchedCited: string[];
}

/** Precision/recall/F1 over file-path lists using {@link matchesPath}. */
export function scoreFilePaths(cited: string[], truth: string[]): FilePathScore {
  if (truth.length === 0) {
    return { precision: 0, recall: 0, f1: 0, matchedTruth: [], matchedCited: [] };
  }
  const matchedTruth = truth.filter((t) => cited.some((c) => matchesPath(c, t)));
  const matchedCited = cited.filter((c) => truth.some((t) => matchesPath(c, t)));
  const precision = cited.length === 0 ? 0 : matchedCited.length / cited.length;
  const recall = matchedTruth.length / truth.length;
  const denom = precision + recall;
  return {
    precision,
    recall,
    f1: denom === 0 ? 0 : (2 * precision * recall) / denom,
    matchedTruth,
    matchedCited,
  };
}

export function scoreFromExistence(flags: boolean[]): number {
  if (flags.length === 0) return 0;
  return Math.round((flags.filter(Boolean).length / flags.length) * 100);
}

export function checkPathsExist(target: Target, paths: string[]): boolean[] {
  return paths.map((p) => existsSync(resolve(target.path, p)));
}

/** Map a repoKey to the hash @coredoc/db queries expect. */
export async function repoHashFor(repoKey: string): Promise<string> {
  const { generateRepoHash } = await import('@coredoc/mcp');
  return generateRepoHash(repoKey);
}

let evalRepositoryPromise: Promise<IGraphRepository> | null = null;

/**
 * Open the project graph for read-only verifier queries.
 *
 * Verifiers used to call `@coredoc/db`'s `getRepository()`, a low-level
 * process singleton that unconditionally acquires an EXCLUSIVE write lease on
 * ladybug. `run.ts` runs withMcp/withoutMcp pipelines concurrently, so that
 * lease collided with the MCP subprocess's own (shared, read-mode) lease.
 * This mirrors `packages/mcp/src/server.ts`'s `projectReadOptions()` /
 * `openProjectDatabase(configDir, projectId, { mode: 'read', ... })` path
 * instead, which only ever takes a shared reader lease — same semantics the
 * MCP server itself uses to answer these tools.
 *
 * Memoized: verifiers run sequentially within one harness process, and each
 * pipeline is bound to the same (configDir, projectId), so one open per
 * process is correct and avoids re-opening per case.
 */
export async function getEvalRepository(): Promise<IGraphRepository> {
  if (!evalRepositoryPromise) {
    const configDir = process.env.COREDOC_EVAL_CONFIG_DIR;
    const projectId = process.env.COREDOC_EVAL_PROJECT;
    if (!configDir || !projectId) {
      throw new Error(
        'getEvalRepository: COREDOC_EVAL_CONFIG_DIR and COREDOC_EVAL_PROJECT must be set ' +
          '(run.ts sets both before invoking any verifier).',
      );
    }
    evalRepositoryPromise = (async () => {
      const { getConfiguredBackend, openProjectDatabase } = await import('@coredoc/db');
      const options =
        getConfiguredBackend() === 'ladybug'
          ? ({ mode: 'read', backend: 'ladybug' } as const)
          : ({ mode: 'read' } as const);
      const db = await openProjectDatabase(configDir, projectId, options);
      return db.graph;
    })();
  }
  return evalRepositoryPromise;
}
