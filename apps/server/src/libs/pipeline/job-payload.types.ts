/** Discriminated union for PushJob.payload (JSONB column). */
export type PushJobPayload = PushPayload | ResolvePayload | ConnectorSyncPayload | RenormalizePayload;

export interface PushPayload {
  /** Server-generated idempotency key retained across every retry. */
  executionToken?: string;
  /** Incremental path: server downloads ParsedRepo from R2 by version. */
  parsedVersion?: string;
  summaryVersion?: string;
  embeddingsVersion?: string;
  /** Explicit exclusion; omitted means preserve manifest-current metadata. */
  excludeSummaries?: boolean;
  /** Explicit exclusion; omitted means preserve manifest-current metadata. */
  excludeEmbeddings?: boolean;
  commitSha?: string | null;
  /**
   * When true, the worker skips the per-push workspace resolver — the caller
   * is responsible for triggering a separate `resolve` job (typically at end
   * of a batch, as `coredoc sync` does). When false/undefined, the worker
   * runs the resolver inline so direct API callers still get fresh cross-
   * repo edges without a follow-up call.
   */
  deferResolution?: boolean;
  /**
   * Skip the incremental diff and replace the repo's graph wholesale.
   *
   * The explicit path for the cases the diff engine deliberately refuses: a
   * parse that legitimately extracted no code (a repo emptied down to docs),
   * or a graph corrupted badly enough that diffing against it is meaningless.
   * Mirrors the local CLI's `--rebuild`.
   */
  rebuild?: boolean;
}

export interface ResolvePayload {
  /** Server-generated idempotency key retained across every retry. */
  executionToken?: string;
  /**
   * Repositories to re-pin in this one candidate. Absent (or empty) keeps the
   * historical behavior — recompute resolution over the current composition.
   *
   * Present, it makes a resolve the finalizer of a batch: a client that has
   * already uploaded every artifact names them all here and gets one build and
   * one published object instead of one per repository.
   */
  targets?: ResolveTargetPayload[];
}

export interface ResolveTargetPayload {
  repoName: string;
  parsedVersion: string;
  /** `undefined` preserves the pinned selection; `null` explicitly excludes it. */
  summaryVersion?: string | null;
  /** `undefined` preserves the pinned selection; `null` explicitly excludes it. */
  embeddingsVersion?: string | null;
  commitSha?: string | null;
}

export interface ConnectorSyncPayload {
  /** DeliveryConnector.id to sync (also stored as PushJob.repoName for dedup). */
  connectorId: string;
}

export interface RenormalizePayload {
  /** Optional DeliveryConnector.id to scope the renormalize to one connector's raw rows. */
  connectorId?: string;
}
