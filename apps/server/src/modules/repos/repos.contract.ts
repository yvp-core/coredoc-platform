/**
 * Request bodies for connecting and updating a workspace repo.
 */
import { z } from 'zod';
import { oneOfField, stringField } from '../../common/validators/field.js';
import { IntentReleaseTrigger } from '../../generated/prisma/client.js';

export const ConnectRepoSchema = z.object({
  repoKey: stringField('repoKey', { notEmpty: true }),
  repoName: stringField('repoName', { notEmpty: true }),
  gitUrl: stringField('gitUrl').optional(),
  repoType: stringField('repoType').optional(),
  /**
   * Optional per-repo URL prefix (e.g. '/v1/public/api-gateway'). Threaded into the cloud
   * resolver so entrypoints index under both raw and prefix-stripped paths — gateway-naive SDK
   * callers still match. Mirrors `RepoConfig.httpPrefix` from the CLI's coredoc.config.json.
   *
   * This POST creates the row with whatever value is provided (or null when omitted). To CHANGE
   * httpPrefix on an already-connected repo, use `PATCH /workspaces/:workspaceId/repos/:repoKey`,
   * which supports the tri-state semantics for partial updates.
   */
  httpPrefix: stringField('httpPrefix').nullable().optional(),
  /**
   * Durable repo identity that intent anchors and feature seeds address this repository by
   * (spec §6.5) — the exact string the graph ids were minted from (`repos[].key` in the CLI
   * config). Optional: when omitted, `repoName` is used if it reproduces `repoKey`, and the row
   * stays unbound otherwise. A value that does not reproduce `repoKey` is refused (400).
   */
  intentRepoKey: stringField('intentRepoKey').optional(),
});

/**
 * Partial update for an already-connected workspace repo.
 *
 * Tri-state per field: `undefined` (omitted) leaves the stored value alone; `null` clears it; a
 * string sets it.
 *
 * `repoName` and `repoKey` are intentionally NOT updatable — they are identity fields (repoKey is
 * the node-id hash). Renaming a repo or changing its key goes through disconnect + reconnect so
 * stale graph rows are cleaned up.
 */
export const UpdateRepoSchema = z.object({
  gitUrl: stringField('gitUrl').nullable().optional(),
  repoType: stringField('repoType').nullable().optional(),
  httpPrefix: stringField('httpPrefix').nullable().optional(),
  /**
   * Durable intent repo identity (spec §6.5). Trust on first use: the first write binds it, a
   * repeat is a no-op, and a value that would REBIND the row to a different identity is refused
   * (409) — existing anchors and seeds would silently start addressing another repository's
   * graph. Not tri-state: explicit `null` is treated as "say nothing", because clearing a bound
   * identity is the rebind this gate exists to prevent.
   */
  intentRepoKey: stringField('intentRepoKey').optional(),
  /**
   * Branch a merge/deploy into counts as production for intent releases (amendment §2).
   * Tri-state: `null` restores the fallback — the default branch the delivery connector reports.
   */
  productionBranch: stringField('productionBranch').nullable().optional(),
  /** Null restores the workspace default. */
  intentReleaseTrigger: oneOfField('intentReleaseTrigger', Object.values(IntentReleaseTrigger)).nullable().optional(),
});

export type ConnectRepoInput = z.infer<typeof ConnectRepoSchema>;
export type UpdateRepoInput = z.infer<typeof UpdateRepoSchema>;
