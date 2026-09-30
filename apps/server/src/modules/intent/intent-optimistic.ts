/**
 * Optimistic concurrency for `intent_items` (spec §13, audit gap §2.5).
 *
 * There is no `version` column convention anywhere else on this server, so this
 * is a new one, deliberately expressed as ONE function rather than a pattern
 * every call site re-types:
 *
 *   UPDATE intent_items SET …, version = version + 1
 *   WHERE workspace_id = ? AND id = ? AND version = ?
 *
 * The affected-row count IS the concurrency check. There is no read-then-write
 * anywhere: a read to decide, then a conditional update that fails if the world
 * moved. When it fails, the caller gets the CURRENT version in a typed conflict
 * so a reviewer can re-read exactly what changed instead of guessing (spec §5).
 */
import type { IntentItemAuthority } from '../../generated/prisma/client.js';
import type { IntentTransaction } from './intent-idempotency.js';
import { intentConflict, intentNotFound } from './intent-state-errors.js';
import { IntentErrorCode } from './contract/index.js';

export interface UpdateItemWithVersionArgs {
  workspaceId: string;
  itemId: string;
  /** The version the caller actually read. */
  expectedVersion: number;
  /** Column updates. `version` and `updatedAt` are managed here, never by the caller. */
  data: Record<string, unknown>;
  /** Actor id for `updated_by`. */
  updatedBy: string;
  /** Field path reported on a conflict (e.g. `['decisions', '0', 'expectedVersion']`). */
  path?: string[];
  /**
   * Also require this authority in the same statement. Propose passes
   * `candidate` so a concurrent accept can never be overwritten; review omits
   * it because it writes accepted rows itself.
   */
  requireAuthority?: IntentItemAuthority;
}

/**
 * Apply a versioned update and return the item's NEW version.
 *
 * Throws {@link IntentErrorCode.VersionConflict} (409) when the row exists
 * at a different version, and {@link IntentErrorCode.ItemNotFound} (404)
 * when it does not exist at all — the two are distinguished by a follow-up
 * read, because `updateMany` reports only a count and "0 rows" alone cannot
 * tell a reviewer whether they lost a race or named a ghost.
 */
export async function updateItemWithVersion(tx: IntentTransaction, args: UpdateItemWithVersionArgs): Promise<number> {
  const path = args.path ?? ['expectedVersion'];
  const updated = await tx.intentItem.updateMany({
    where: {
      workspaceId: args.workspaceId,
      id: args.itemId,
      version: args.expectedVersion,
      ...(args.requireAuthority !== undefined ? { authority: args.requireAuthority } : {}),
    },
    data: { ...args.data, updatedBy: args.updatedBy, version: { increment: 1 } },
  });
  if (updated.count === 1) return args.expectedVersion + 1;

  const current = await tx.intentItem.findUnique({
    where: { workspaceId_id: { workspaceId: args.workspaceId, id: args.itemId } },
    select: { version: true, authority: true },
  });
  if (!current) {
    throw intentNotFound(
      IntentErrorCode.ItemNotFound,
      `Intent item '${args.itemId}' does not exist in this workspace`,
      path,
    );
  }
  // Checked before the version: an authority change is terminal for this
  // update, whereas a version conflict invites a re-read and retry.
  if (args.requireAuthority !== undefined && current.authority !== args.requireAuthority) {
    throw intentConflict(
      IntentErrorCode.ItemNoLongerCandidate,
      `Intent item '${args.itemId}' was ${current.authority} while this request was in flight and was left unchanged; propose again to create a successor candidate.`,
      path,
    );
  }
  throw intentConflict(
    IntentErrorCode.VersionConflict,
    `Intent item '${args.itemId}' changed: expected version ${args.expectedVersion}, current version is ${current.version}. Re-read the item and decide again.`,
    path,
  );
}
