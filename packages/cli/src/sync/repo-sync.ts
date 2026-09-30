/**
 * Per-repo sync: load parsed + optional summary/embeddings, delta-check
 * against the cloud, upsert the repo, upload, and finalize the push.
 *
 * Flow: `uploadResult` → optional `uploadSummaries` → optional `uploadEmbeddings` → `pushByVersion`
 *
 * All HTTP and filesystem reads flow through `api` and `fs` so tests can inject
 * mocks without touching the network or the real disk.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { StableIdGenerator } from '@coredoc/core';
import type { ParsedRepo, RepoConfig, RuntimeConfig, SummaryOutput, EmbeddingsOutput } from '@coredoc/core/types';
import { parsedRepoFile } from '@coredoc/core/utils';
import {
  connectRepo as defaultConnectRepo,
  getRepoState as defaultGetRepoState,
  updateRepo as defaultUpdateRepo,
  type ConnectRepoBody,
  type ConnectRepoResponse,
  type RepoStateResponse,
  type UpdateRepoBody,
} from './workspace-api.js';
import {
  uploadResult as defaultUploadResult,
  uploadSummaries as defaultUploadSummaries,
  uploadEmbeddings as defaultUploadEmbeddings,
  pushByVersion as defaultPushByVersion,
  type UploadResultResponse,
} from '../push/remote.js';
import { findSummariesFile, findEmbeddingsFile, loadSummaries, loadEmbeddings } from '../push/helpers.js';

export interface RepoSyncApi {
  getRepoState: (workspaceId: string, repoName: string) => Promise<RepoStateResponse | null>;
  connectRepo: (workspaceId: string, body: ConnectRepoBody) => Promise<ConnectRepoResponse>;
  /** PATCH on an existing repo. Called after connectRepo returns alreadyConnected=true. */
  updateRepo: (workspaceId: string, repoKey: string, body: UpdateRepoBody) => Promise<void>;
  uploadResult: (opts: {
    workspaceId: string;
    repoName: string;
    parsedRepo: ParsedRepo;
  }) => Promise<UploadResultResponse>;
  uploadSummaries: (opts: {
    workspaceId: string;
    repoName: string;
    summaryOutput: SummaryOutput;
  }) => Promise<{ version: string }>;
  uploadEmbeddings: (opts: {
    workspaceId: string;
    repoName: string;
    embeddingsOutput: EmbeddingsOutput;
  }) => Promise<{ version: string }>;
  pushByVersion: (opts: {
    workspaceId: string;
    repoName: string;
    parsedVersion: string;
    summaryVersion?: string;
    embeddingsVersion?: string;
    commitSha?: string;
    defer?: boolean;
    sync?: boolean;
  }) => Promise<unknown>;
}

export const defaultRepoSyncApi: RepoSyncApi = {
  getRepoState: defaultGetRepoState,
  connectRepo: defaultConnectRepo,
  updateRepo: defaultUpdateRepo,
  uploadResult: defaultUploadResult,
  uploadSummaries: defaultUploadSummaries,
  uploadEmbeddings: defaultUploadEmbeddings,
  pushByVersion: defaultPushByVersion,
};

export type RepoSyncStep = 'load' | 'delta' | 'upsert' | 'upload' | 'push';

export interface RepoSyncOk {
  status: 'pushed' | 'skipped';
  repoName: string;
  parsedVersion?: string;
  summaryVersion?: string;
  /** Returned by the async push path; absent when the server processed inline. */
  jobId?: string;
  reason?: string;
  /**
   * Set in batch mode instead of `jobId`: the artifacts are uploaded and this
   * is the selection the batch resolve must pin. Nothing is published for this
   * repository until that resolve runs.
   */
  batchTarget?: {
    repoName: string;
    parsedVersion: string;
    summaryVersion?: string;
    embeddingsVersion?: string;
    commitSha?: string;
  };
}

export interface RepoSyncFail {
  status: 'failed';
  repoName: string;
  step: RepoSyncStep;
  error: string;
}

export type RepoSyncResult = RepoSyncOk | RepoSyncFail;

export interface RepoSyncInput {
  projectId: string;
  repo: RepoConfig;
  workspaceId: string;
  config: RuntimeConfig;
  force: boolean;
  includeSummaries: boolean;
  includeEmbeddings: boolean;
  /**
   * When true, server skips its per-push workspace-wide cross-repo resolver
   * run. The orchestrator triggers one explicit resolve after the batch.
   */
  defer?: boolean;
  /**
   * Upload the artifacts but do not push this repository on its own. The
   * caller collects every `batchTarget` and publishes them in one resolve —
   * one graph build and one stored object for the whole sync instead of one
   * per repository.
   */
  batch?: boolean;
  api?: RepoSyncApi;
  log?: (line: string) => void;
}

const hash16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * The connect and PATCH bodies for one repo, identity included.
 *
 * THE DEFECT THIS CLOSES: the server accepts `intentRepoKey` on both routes,
 * and no client ever produced it. Binding therefore happened only through the
 * server's `hash(repoName) === repoKey` fallback, so any repo carrying an
 * explicit `repos[].key` different from its name stayed unbound forever — every
 * intent anchor, seed and import against it failing `unknown_repo_key` with no
 * client-side remedy.
 *
 * The key is sent only when it PROVES the graph key, using core's own hashing
 * (not a copy of it). A stale parsed artifact — one whose `id` was minted from
 * a since-changed `repos[].key` — would otherwise turn every push into a 400;
 * the identity it would register is wrong anyway, so it is reported and omitted
 * rather than sent.
 */
export function buildRepoUpsertBodies(
  repo: RepoConfig,
  repoKey: string,
  log: (line: string) => void = () => {},
  gitUrl?: string,
): { connect: ConnectRepoBody; patch: UpdateRepoBody } {
  const durableKey = repo.key ?? repo.name;
  const proves = new StableIdGenerator('', durableKey).getRepoHash() === repoKey;
  if (!proves) {
    log(
      `  ! ${repo.name}: durable intent key "${durableKey}" does not reproduce the parsed repo id "${repoKey}" — ` +
        'sending no intent identity. Re-run `coredoc parse` after changing `repos[].key`.',
    );
  }
  const identity = proves ? { intentRepoKey: durableKey } : {};
  const trimmedUrl = gitUrl?.trim();
  // Sent unchanged (https and ssh forms alike): the server's `parseGithubRepo`
  // accepts both. Omitted entirely when unknown so a PATCH never clears a URL
  // the server already has.
  const git = trimmedUrl ? { gitUrl: trimmedUrl } : {};
  return {
    connect: {
      repoKey,
      repoName: repo.name,
      repoType: repo.type,
      ...(repo.httpPrefix !== undefined ? { httpPrefix: repo.httpPrefix } : {}),
      ...git,
      ...identity,
    },
    patch: {
      ...(repo.type !== undefined ? { repoType: repo.type } : {}),
      ...(repo.httpPrefix !== undefined ? { httpPrefix: repo.httpPrefix } : {}),
      ...git,
      ...identity,
    },
  };
}

export async function syncRepo(input: RepoSyncInput): Promise<RepoSyncResult> {
  const api = input.api ?? defaultRepoSyncApi;
  const log = input.log ?? (() => {});
  const {
    projectId,
    repo,
    workspaceId,
    config,
    force,
    includeSummaries,
    includeEmbeddings,
    defer = false,
    batch = false,
  } = input;

  // Step 1: load parsed JSON
  const parsedPath = parsedRepoFile(config.resolvedOutputDir, projectId, repo.name);
  if (!fs.existsSync(parsedPath)) {
    return { status: 'failed', repoName: repo.name, step: 'load', error: `Parsed JSON not found: ${parsedPath}` };
  }
  let parsedRepo: ParsedRepo;
  try {
    parsedRepo = JSON.parse(fs.readFileSync(parsedPath, 'utf-8')) as ParsedRepo;
  } catch (err) {
    return { status: 'failed', repoName: repo.name, step: 'load', error: `Invalid JSON: ${(err as Error).message}` };
  }

  // Step 2: load optional artifacts
  let summaryOutput: SummaryOutput | null = null;
  if (includeSummaries) {
    const sumPath = findSummariesFile(projectId, repo.name, config);
    if (sumPath) summaryOutput = loadSummaries(sumPath) as SummaryOutput | null;
  }
  let embeddingsOutput: EmbeddingsOutput | null = null;
  if (includeEmbeddings) {
    const embPath = findEmbeddingsFile(projectId, repo.name, config);
    if (embPath) embeddingsOutput = loadEmbeddings(embPath) as EmbeddingsOutput | null;
  }

  // Step 3: delta check
  if (!force) {
    try {
      const remoteState = await api.getRepoState(workspaceId, repo.name);
      if (remoteState) {
        const localParseHash = hash16(JSON.stringify(parsedRepo));
        const localSummaryHash = summaryOutput ? `sum_${hash16(JSON.stringify(summaryOutput))}` : null;
        const localEmbeddingsHash = embeddingsOutput ? `emb_${hash16(JSON.stringify(embeddingsOutput))}` : null;
        const parseMatch = remoteState.lastParseHash === localParseHash;
        const summaryMatch = !localSummaryHash || remoteState.currentSummaryVersion === localSummaryHash;
        const embeddingsMatch = !localEmbeddingsHash || remoteState.currentEmbeddingsVersion === localEmbeddingsHash;
        if (parseMatch && summaryMatch && embeddingsMatch) {
          log(`  ↺ ${repo.name}: up-to-date`);
          return { status: 'skipped', repoName: repo.name, reason: 'up-to-date' };
        }
      }
    } catch (err) {
      return { status: 'failed', repoName: repo.name, step: 'delta', error: (err as Error).message };
    }
  }

  // Step 4: upsert. POST /repos is create-only on the server. When the repo
  // already exists (alreadyConnected=true, server returned 409), follow up
  // with PATCH to push any changed mutable fields (httpPrefix, repoType).
  // Without this, e.g. a new httpPrefix in coredoc.config.json never reaches
  // the control plane, leaving the cross-repo resolver with stale routing.
  const repoKey = parsedRepo.id ?? repo.name;
  try {
    log(`  → upserting ${repo.name}...`);
    // The `origin` URL the parse already captured — the only thing the delivery
    // importer can link this repo's PRs by. Absent on artifacts parsed before
    // remote capture existed, or in a repo with no remote: say so once, and send
    // no gitUrl rather than a guess.
    const gitUrl = parsedRepo.git?.remoteUrl;
    if (!gitUrl) {
      log(
        `  ! ${repo.name}: no git remote in the parsed artifact — pull requests cannot be linked to this repo. ` +
          'Configure an `origin` remote and re-run `coredoc parse`.',
      );
    }
    const { connect, patch } = buildRepoUpsertBodies(repo, repoKey, log, gitUrl);
    const connectResp = await api.connectRepo(workspaceId, connect);
    if (connectResp.alreadyConnected && Object.keys(patch).length > 0) {
      log(`  → patching ${repo.name} metadata...`);
      await api.updateRepo(workspaceId, repoKey, patch);
    }
  } catch (err) {
    return { status: 'failed', repoName: repo.name, step: 'upsert', error: (err as Error).message };
  }

  // Step 5: incremental push (upload artifacts → push by version)
  try {
    log(`  → uploadResult...`);
    const upload = await api.uploadResult({ workspaceId, repoName: repo.name, parsedRepo });

    let summaryVersion: string | undefined;
    if (summaryOutput) {
      log(`  → uploadSummaries...`);
      const sumUp = await api.uploadSummaries({ workspaceId, repoName: repo.name, summaryOutput });
      summaryVersion = sumUp.version;
    }

    let embeddingsVersion: string | undefined;
    if (embeddingsOutput) {
      log(`  → uploadEmbeddings...`);
      const embUp = await api.uploadEmbeddings({ workspaceId, repoName: repo.name, embeddingsOutput });
      embeddingsVersion = embUp.version;
    }

    if (batch) {
      return {
        status: 'pushed',
        repoName: repo.name,
        parsedVersion: upload.version,
        summaryVersion,
        batchTarget: {
          repoName: repo.name,
          parsedVersion: upload.version,
          summaryVersion,
          embeddingsVersion,
          commitSha: parsedRepo.git?.commitHash,
        },
      };
    }

    log(`  → pushByVersion...`);
    const pushResp = (await api.pushByVersion({
      workspaceId,
      repoName: repo.name,
      parsedVersion: upload.version,
      summaryVersion,
      embeddingsVersion,
      commitSha: parsedRepo.git?.commitHash,
      defer,
    })) as unknown;

    let jobId: string | undefined;
    if (
      pushResp &&
      typeof pushResp === 'object' &&
      'jobId' in pushResp &&
      typeof (pushResp as { jobId?: unknown }).jobId === 'string'
    ) {
      jobId = (pushResp as { jobId: string }).jobId;
    }

    return { status: 'pushed', repoName: repo.name, parsedVersion: upload.version, summaryVersion, jobId };
  } catch (err) {
    return { status: 'failed', repoName: repo.name, step: 'push', error: (err as Error).message };
  }
}
