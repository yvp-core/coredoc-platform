/**
 * Remote Push - Push parsed data to workspace server
 *
 * Incremental flow: upload artifacts to R2 → push by version reference
 */

import { gzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { authHeaders, getServerUrl } from '../auth.js';
import { getJob, JobRequestError } from '../sync/workspace-api.js';
import { stripSourceCode, stripEmbeddingInputText } from '@coredoc/db';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { parseStructuredServerError } from '../structured-error.js';
import type { ParsedRepo, SummaryOutput, EmbeddingsOutput } from '@coredoc/core/types';

// =============================================================================
// Types
// =============================================================================

export interface UploadResultResponse {
  version: string;
  sizeBytes: number;
  uploadedAt: string;
  duplicate: boolean;
}

// =============================================================================
// Incremental Push (upload → push by version)
// =============================================================================

/**
 * Artifact uploads go gzipped: a large ParsedRepo is 100 MB+ of highly
 * repetitive JSON, and reverse proxies commonly cap raw request bodies at
 * 100 MB. Express inflates `Content-Encoding: gzip` before the JSON parser.
 */
function gzipUpload(json: string, auth: { Authorization: string }): { body: Buffer; headers: Record<string, string> } {
  return {
    body: gzipSync(json),
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      ...auth,
    },
  };
}

/**
 * Upload ParsedRepo to R2 versioned storage.
 * Returns version key for subsequent push call.
 */
export async function uploadResult(options: {
  workspaceId: string;
  repoName: string;
  parsedRepo: ParsedRepo;
}): Promise<UploadResultResponse> {
  const auth = await authHeaders();

  const serverUrl = await getServerUrl();
  const url = `${serverUrl}/api/v1/workspaces/${options.workspaceId}/repos/${options.repoName}/results/upload`;

  // Source-in-graph opt-in (on-prem): when ALLOW_SOURCES_IN_GRAPH is set, push the
  // ParsedRepo as-is so source reaches the graph. Default OFF: strip source — it
  // must never leave the client on the cloud/SaaS path.
  const { parsed: bodyRepo, strippedCount } = allowSourcesInGraph()
    ? { parsed: options.parsedRepo, strippedCount: 0 }
    : stripSourceCode(options.parsedRepo);
  if (strippedCount > 0) {
    console.log(`Stripped sourceCode from ${strippedCount} nodes before push`);
  }

  const jsonBody = JSON.stringify(bodyRepo);
  console.log(
    `Uploading result for ${options.repoName} (${(Buffer.byteLength(jsonBody) / 1024 / 1024).toFixed(1)} MB)...`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  let response: Response;
  try {
    const upload = gzipUpload(jsonBody, auth);
    response = await fetch(url, {
      method: 'POST',
      headers: upload.headers,
      body: upload.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upload failed (${response.status}): ${error}`);
  }

  return response.json() as Promise<UploadResultResponse>;
}

/**
 * Trigger push by version reference (incremental).
 * Server reads ParsedRepo from R2, diffs against previous, applies delta.
 */
export async function pushByVersion(options: {
  workspaceId: string;
  repoName: string;
  parsedVersion: string;
  summaryVersion?: string;
  embeddingsVersion?: string;
  /** Explicitly skip both an upload and the server's manifest-current fallback. */
  excludeSummaries?: boolean;
  /** Explicitly skip both an upload and the server's manifest-current fallback. */
  excludeEmbeddings?: boolean;
  commitSha?: string;
  /**
   * When true, server skips the per-push workspace-wide cross-repo resolver
   * run. Callers batching multiple pushes (e.g. `coredoc sync`) trigger one
   * explicit resolve at the end of the batch.
   */
  defer?: boolean;
  /**
   * When true, the server replaces the repo's graph instead of diffing against
   * the previous version — the remote counterpart of the local `--rebuild`.
   * Required for a parse the diff engine refuses to apply on its own (a repo
   * legitimately emptied of code is indistinguishable from a degraded parse).
   */
  rebuild?: boolean;
}): Promise<unknown> {
  const auth = await authHeaders();

  const serverUrl = await getServerUrl();
  const params = new URLSearchParams();
  if (options.defer) params.set('defer', 'true');
  if (options.rebuild) params.set('rebuild', 'true');
  const queryString = params.toString();
  const url = `${serverUrl}/api/v1/workspaces/${options.workspaceId}/repos/${options.repoName}/push${
    queryString ? `?${queryString}` : ''
  }`;

  const jsonBody = JSON.stringify({
    parsedVersion: options.parsedVersion,
    ...(options.summaryVersion ? { summaryVersion: options.summaryVersion } : {}),
    ...(options.embeddingsVersion ? { embeddingsVersion: options.embeddingsVersion } : {}),
    ...(options.excludeSummaries ? { excludeSummaries: true } : {}),
    ...(options.excludeEmbeddings ? { excludeEmbeddings: true } : {}),
    ...(options.commitSha ? { commitSha: options.commitSha } : {}),
  });

  console.log(`Pushing ${options.repoName} by version ${options.parsedVersion}...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...auth,
      },
      body: jsonBody,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Push failed (${response.status}): ${error}`);
  }

  const result = await response.json();
  console.log(`Push successful: ${JSON.stringify(result)}`);
  return result;
}

// =============================================================================
// Async push jobs (enqueue → poll)
// =============================================================================

/** Public job status vocabulary of `GET /workspaces/:id/jobs/:jobId`. */
export type PushJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface PushJobSnapshot {
  id: string;
  status: PushJobStatus;
  lastError: string | null;
  result: unknown;
}

/** Total client-side wait before the CLI stops watching a queued push. */
export const DEFAULT_PUSH_JOB_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_PUSH_JOB_POLL_INTERVAL_MS = 5000;

/**
 * The job did not finish inside the CLI's watch window. The push itself is
 * neither known to have failed nor to have succeeded — it keeps running on the
 * server — so callers must report it as unfinished, not as a failed push.
 */
export class PushJobTimeoutError extends Error {
  readonly name = 'PushJobTimeoutError';
  constructor(
    readonly jobId: string,
    readonly waitedMs: number,
  ) {
    super(
      `Push job ${jobId} did not finish within ${Math.round(waitedMs / 1000)}s. ` +
        'The push is still running server-side and may yet succeed — this is not a push failure. ' +
        `Check it with: coredoc sync-status ${jobId}`,
    );
  }
}

export class PushJobFailedError extends Error {
  readonly name = 'PushJobFailedError';
  constructor(
    readonly jobId: string,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A failed poll attempt that says nothing about the job: the transport broke
 * (network error, abort) or the server itself faltered (5xx). A 401/403/404 is
 * a real answer and stays terminal.
 */
function isTransientPollError(error: unknown): boolean {
  if (error instanceof JobRequestError) return error.status >= 500;
  return error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
}

/** Consecutive transport failures tolerated before the watch gives up as inconclusive. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/**
 * Watch a queued push job to a terminal state.
 *
 * The push runs in the server's worker, so no proxy sits on an open connection
 * for the duration: the CLI enqueues and polls. Waiting is a client-side
 * courtesy — the job outlives this process either way.
 *
 * A poll that fails in transport (network error, abort, 5xx) says nothing about
 * the job, so it is retried; only a real answer from the server is terminal.
 *
 * @throws PushJobFailedError when the job reaches `failed`.
 * @throws PushJobTimeoutError when `timeoutMs` elapses first, or after
 *   `MAX_CONSECUTIVE_POLL_FAILURES` transport failures in a row — inconclusive
 *   either way.
 * @throws Error on a non-5xx HTTP answer (401/403/404).
 */
export async function waitForPushJob(
  workspaceId: string,
  jobId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PushJobSnapshot> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUSH_JOB_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_PUSH_JOB_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  let consecutiveFailures = 0;

  for (;;) {
    let job: PushJobSnapshot | null;
    try {
      job = await getJob(workspaceId, jobId);
      consecutiveFailures = 0;
    } catch (error) {
      if (!isTransientPollError(error)) throw error;
      consecutiveFailures += 1;
      const remaining = deadline - Date.now();
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES || remaining <= 0) {
        throw new PushJobTimeoutError(jobId, timeoutMs);
      }
      await sleep(Math.min(intervalMs, remaining));
      continue;
    }
    if (!job) throw new Error(`Push job ${jobId} not found in workspace ${workspaceId}`);
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed') {
      // The worker persists a structured error under `result.error`; `lastError`
      // is the plain-text fallback for jobs that failed without one.
      const structured = parseStructuredServerError((job.result as { error?: unknown } | null)?.error);
      const detail = job.lastError ?? structured?.code ?? 'no error detail reported';
      throw new PushJobFailedError(
        jobId,
        structured?.code ?? null,
        `Push job ${jobId} failed${structured?.code ? ` (${structured.code})` : ''}: ${detail}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PushJobTimeoutError(jobId, timeoutMs);
    await sleep(Math.min(intervalMs, remaining));
  }
}

/** The jobId of a 202-queued push, or null when the server answered inline. */
export function queuedPushJobId(pushResponse: unknown): string | null {
  if (!pushResponse || typeof pushResponse !== 'object') return null;
  const { jobId } = pushResponse as { jobId?: unknown };
  return typeof jobId === 'string' ? jobId : null;
}

/**
 * Fetch the latest summaries for a repo from the server.
 * Returns null if no summaries exist (404).
 */
export async function fetchSummaries(options: {
  workspaceId: string;
  repoName: string;
}): Promise<SummaryOutput | null> {
  const auth = await authHeaders();

  const serverUrl = await getServerUrl();
  const url = `${serverUrl}/api/v1/workspaces/${options.workspaceId}/repos/${options.repoName}/summaries/latest`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 1000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        ...auth,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Fetch summaries failed (${response.status}): ${error}`);
  }

  const result = (await response.json()) as {
    mode: 'redirect' | 'inline';
    url?: string;
    version: string;
    summaryOutput?: SummaryOutput;
    uploadedAt: string;
  };

  // Server returns a presigned R2 URL when available — download directly from R2
  if (result.mode === 'redirect' && result.url) {
    const r2Response = await fetch(result.url);
    if (!r2Response.ok) {
      throw new Error(`R2 download failed (${r2Response.status})`);
    }
    return r2Response.json() as Promise<SummaryOutput>;
  }

  // Fallback: server served the data inline (local dev)
  return result.summaryOutput ?? null;
}

/**
 * Upload summaries for a repo to the server.
 * Returns the version key for the uploaded summaries.
 */
export async function uploadSummaries(options: {
  workspaceId: string;
  repoName: string;
  summaryOutput: SummaryOutput;
}): Promise<{ version: string }> {
  const auth = await authHeaders();

  const serverUrl = await getServerUrl();
  const url = `${serverUrl}/api/v1/workspaces/${options.workspaceId}/repos/${options.repoName}/summaries/upload`;

  const jsonBody = JSON.stringify(options.summaryOutput);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60 * 1000);

  let response: Response;
  try {
    const upload = gzipUpload(jsonBody, auth);
    response = await fetch(url, {
      method: 'POST',
      headers: upload.headers,
      body: upload.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upload summaries failed (${response.status}): ${error}`);
  }

  return response.json() as Promise<{ version: string }>;
}

/**
 * Upload embeddings for a repo to the server.
 * Returns the version key for the uploaded embeddings.
 */
export async function uploadEmbeddings(options: {
  workspaceId: string;
  repoName: string;
  embeddingsOutput: EmbeddingsOutput;
}): Promise<{ version: string }> {
  const auth = await authHeaders();

  const serverUrl = await getServerUrl();
  const url = `${serverUrl}/api/v1/workspaces/${options.workspaceId}/repos/${options.repoName}/embeddings/upload`;

  // Source-in-graph opt-in (on-prem): when ALLOW_SOURCES_IN_GRAPH is set, push the
  // embeddings as-is. Default OFF: strip `inputText` — with `-i source|both` it
  // holds raw source, and the server's graph never reads it (only the vector,
  // checksum, and strategy), so it must not leave the client on the cloud/SaaS path.
  const { embeddings: bodyEmbeddings, strippedCount } = allowSourcesInGraph()
    ? { embeddings: options.embeddingsOutput, strippedCount: 0 }
    : stripEmbeddingInputText(options.embeddingsOutput);
  if (strippedCount > 0) {
    console.log(`Stripped inputText from ${strippedCount} embeddings before push`);
  }

  const jsonBody = JSON.stringify(bodyEmbeddings);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60 * 1000);

  let response: Response;
  try {
    const upload = gzipUpload(jsonBody, auth);
    response = await fetch(url, {
      method: 'POST',
      headers: upload.headers,
      body: upload.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upload embeddings failed (${response.status}): ${error}`);
  }

  return response.json() as Promise<{ version: string }>;
}
