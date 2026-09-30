/**
 * The onboarding import's preconditions, readable on their own (spec §8.1).
 *
 * `POST …/intent/import` refuses a non-empty workspace and drops anchors whose
 * repo identity this workspace does not carry. Both facts were only observable
 * by ATTEMPTING the import and reading the failure — which is a one-way
 * authority cutover with a spent idempotency key, so "try it and see" is the
 * wrong instrument. `coredoc intent bootstrap-check` asks for the same facts
 * ahead of time, and it must ask the QUESTIONS THE IMPORT ASKS: a second copy
 * of "is this workspace empty" in the CLI would drift the day the emptiness
 * rule changes, and would answer differently anyway (an item may attach to the
 * product root with no domain, so an empty domain list is not an empty
 * workspace).
 *
 * So the counts live here, `IntentImportService` asserts over them, and the
 * read-only preflight returns them. One rule, two callers, no duplication.
 */
import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { IntentErrorCode } from './contract/index.js';
import { readWorkspaceIntentRepoIdentities, type WorkspaceRepoReader } from './intent-repo-keys.js';
import { intentStateError } from './intent-state-errors.js';

/** The narrowest reader these counts need — a transaction or the client both satisfy it. */
export interface IntentContentReader {
  intentDomain: Pick<Prisma.TransactionClient['intentDomain'], 'count'>;
  intentFeature: Pick<Prisma.TransactionClient['intentFeature'], 'count'>;
  intentItem: Pick<Prisma.TransactionClient['intentItem'], 'count'>;
  intentDimension: Pick<Prisma.TransactionClient['intentDimension'], 'count'>;
}

/**
 * What "already holds intent content" means, enumerated rather than reduced to a
 * boolean: a refusal has to say WHAT is in the way, and the preflight has to
 * show the same numbers.
 */
export interface IntentContentCounts {
  domains: number;
  features: number;
  items: number;
  dimensions: number;
}

export interface IntentImportPreflightResultV1 {
  workspaceId: string;
  /** True when an import would pass its emptiness precondition right now. */
  empty: boolean;
  content: IntentContentCounts;
  /**
   * The durable repo identities this workspace carries, in the same rendering
   * the import's skipped-anchor report uses — including repos registered but
   * not yet bound to a durable key, which is what a maintainer needs to see.
   */
  registeredRepoIdentities: string[];
  /**
   * The bound durable keys alone. The rendering above is for a human; an
   * overlay anchor's `repo` is compared against THIS, and an anchor naming
   * anything outside it is imported without its anchor.
   */
  intentRepoKeys: string[];
}

export async function readIntentContentCounts(
  reader: IntentContentReader,
  workspaceId: string,
): Promise<IntentContentCounts> {
  const [domains, features, items, dimensions] = await Promise.all([
    reader.intentDomain.count({ where: { workspaceId } }),
    reader.intentFeature.count({ where: { workspaceId } }),
    reader.intentItem.count({ where: { workspaceId } }),
    reader.intentDimension.count({ where: { workspaceId } }),
  ]);
  return { domains, features, items, dimensions };
}

export function isWorkspaceIntentEmpty(counts: IntentContentCounts): boolean {
  return presentContent(counts).length === 0;
}

/** The kinds that are actually present, in a stable order, for a message or a detail list. */
function presentContent(counts: IntentContentCounts): Array<[string, number]> {
  return (
    [
      ['domains', counts.domains],
      ['features', counts.features],
      ['items', counts.items],
      ['dimensions', counts.dimensions],
    ] as Array<[string, number]>
  ).filter(([, count]) => count > 0);
}

/**
 * The import's emptiness refusal.
 *
 * 409, not 400: the request was fine, the workspace moved under it — the same
 * class of refusal as a version conflict or a spent idempotency key.
 */
export function assertWorkspaceIntentEmpty(counts: IntentContentCounts): void {
  if (isWorkspaceIntentEmpty(counts)) return;

  const nonEmpty = presentContent(counts);
  throw intentStateError(
    IntentErrorCode.WorkspaceNotEmpty,
    `Workspace already holds intent content (${nonEmpty.map(([kind, count]) => `${kind}: ${count}`).join(', ')}). ` +
      'v1 import requires an empty workspace; merge is out of scope.',
    [],
    HttpStatus.CONFLICT,
    nonEmpty.map(([kind, count]) => ({
      code: IntentErrorCode.WorkspaceNotEmpty,
      message: `Existing ${kind}: ${count}`,
      path: [],
    })),
  );
}

/** Both import preconditions, read-only, in one round trip. */
export async function readIntentImportPreflight(
  reader: IntentContentReader & WorkspaceRepoReader,
  workspaceId: string,
): Promise<IntentImportPreflightResultV1> {
  const [content, identities] = await Promise.all([
    readIntentContentCounts(reader, workspaceId),
    readWorkspaceIntentRepoIdentities(reader, workspaceId),
  ]);
  return {
    workspaceId,
    empty: isWorkspaceIntentEmpty(content),
    content,
    registeredRepoIdentities: identities.enumeration,
    intentRepoKeys: [...identities.graphKeyByDurableKey.keys()].sort(),
  };
}
