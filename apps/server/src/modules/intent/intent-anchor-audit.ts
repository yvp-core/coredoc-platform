import { IntentAuditEntityKind } from '../../generated/prisma/client.js';
import type { IntentAuditOperation, IntentAuditRecord } from './intent-idempotency.js';

interface AuditedAnchor {
  itemId: string;
  repoKey: string;
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
}

/**
 * The audit row of an anchor write, manual or CI alike: the trail tells them
 * apart only by actor. Projections are identity and the drift baseline, never a
 * row dump.
 */
export function anchorAuditRecord(
  id: bigint,
  operation: IntentAuditOperation,
  after: AuditedAnchor | null,
  before: AuditedAnchor | null,
): IntentAuditRecord {
  return {
    entityKind: IntentAuditEntityKind.anchor,
    entityId: id.toString(),
    operation,
    ...(before ? { before: projectionOf(before) } : {}),
    ...(after ? { after: projectionOf(after) } : {}),
  };
}

function projectionOf(anchor: AuditedAnchor): Record<string, unknown> {
  return {
    itemId: anchor.itemId,
    repoKey: anchor.repoKey,
    nodeId: anchor.nodeId,
    nodeType: anchor.nodeType,
    capturedVersionedId: anchor.capturedVersionedId,
  };
}
