/**
 * The workspace import's emptiness precondition (`POST …/intent/import/workspace`).
 *
 * An item may attach to the product root with no domain, so an empty domain
 * list is not an empty workspace: every content kind is counted.
 */
import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { IntentErrorCode } from './contract/index.js';
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
 * boolean: a refusal has to say WHAT is in the way.
 */
export interface IntentContentCounts {
  domains: number;
  features: number;
  items: number;
  dimensions: number;
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
