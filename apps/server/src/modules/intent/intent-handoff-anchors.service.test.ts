/**
 * Unit coverage for the audit trail `applyItem` now writes alongside CI anchor
 * create/update/delete — issue 08 ("Low findings"): "CI anchor writes audited",
 * the same shape manual writes get in `intent-anchor.service.ts`. This is a
 * mocked-`tx` unit test (no postgres): `applyPrepared`'s DB shape is duck-typed
 * against `Prisma.TransactionClient`, so a plain object with the methods this
 * path calls exercises the real `applyItem` code, including `lockCurrentState`.
 */
import { describe, expect, it, vi } from 'vitest';
import { IntentHandoffAnchorsService } from './intent-handoff-anchors.service.js';
import type { HandoffSnapshot } from './intent-handoff.operations.js';
import type { ResolvedMapping } from '@coredoc/core';

const WORKSPACE_ID = 'ws_1';
const REPO_KEY = 'repo:acme/orders-api';

function snapshot(): HandoffSnapshot {
  return { repoKey: REPO_KEY, graphVersionId: 'v1', graphCommit: 'a'.repeat(40), branch: 'main' };
}

/** A `tx` covering exactly the calls `applyPrepared` / `lockCurrentState` / `applyItem` make. */
function mockTx() {
  const auditCreate = vi.fn().mockResolvedValue({});
  const existing = [
    {
      id: 1n,
      workspaceId: WORKSPACE_ID,
      repoKey: REPO_KEY,
      itemId: 'br-x',
      nodeId: 'old-keep',
      nodeType: 'file',
      capturedVersionedId: 'v1',
      source: 'ci',
      disabledAt: null,
    },
    {
      id: 2n,
      workspaceId: WORKSPACE_ID,
      repoKey: REPO_KEY,
      itemId: 'br-x',
      nodeId: 'old-remove',
      nodeType: 'file',
      capturedVersionedId: 'v1',
      source: 'ci',
      disabledAt: null,
    },
  ];

  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
    workspaceRepo: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ intentRepoKey: REPO_KEY, productionBranch: 'main' }),
    },
    workspace: { findUniqueOrThrow: vi.fn().mockResolvedValue({ activeGraphVersionId: 'v1' }) },
    intentItem: { findUnique: vi.fn().mockResolvedValue({ authority: 'accepted', version: 1 }) },
    intentAnchor: {
      findMany: vi.fn().mockResolvedValue(existing),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: bigint }; data: object }) => ({
        ...existing.find((a) => a.id === where.id),
        ...data,
      })),
      create: vi.fn().mockImplementation(async ({ data }: { data: object }) => ({ id: 3n, ...data })),
    },
    intentAuditEvent: { create: auditCreate },
  };
  return { tx, auditCreate };
}

describe('IntentHandoffAnchorsService — CI anchor writes are audited', () => {
  it('writes one audit row per create, update and delete, in the same transaction', async () => {
    const service = new IntentHandoffAnchorsService({} as never, {} as never);
    const { tx, auditCreate } = mockTx();

    const mapping: ResolvedMapping = {
      itemId: 'br-x',
      kind: 'mapped',
      replaceNodeIds: ['old-keep', 'old-remove'],
      targets: [
        { nodeId: 'old-keep', nodeType: 'file', capturedVersionedId: 'v2', filePath: 'a' },
        { nodeId: 'new-node', nodeType: 'file', capturedVersionedId: 'v3', filePath: 'b' },
      ],
    };

    const results = await service.applyPrepared(tx as never, WORKSPACE_ID, snapshot(), [mapping]);

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe('mapped');

    // One delete audit (old-remove), one update audit (old-keep), one create audit (new-node).
    expect(auditCreate).toHaveBeenCalledTimes(3);
    const rows = auditCreate.mock.calls.map((call) => call[0].data);

    const deleteRow = rows.find((r) => r.operation === 'delete');
    expect(deleteRow).toMatchObject({
      workspaceId: WORKSPACE_ID,
      entityKind: 'anchor',
      entityId: '2',
      actorId: 'system:intent-handoff',
      actorRole: 'system',
      before: { nodeId: 'old-remove', itemId: 'br-x', repoKey: REPO_KEY, capturedVersionedId: 'v1' },
    });
    expect(deleteRow.after).toBeUndefined();

    const updateRow = rows.find((r) => r.operation === 'update');
    expect(updateRow).toMatchObject({
      entityId: '1',
      before: { nodeId: 'old-keep', capturedVersionedId: 'v1' },
      after: { nodeId: 'old-keep', capturedVersionedId: 'v2' },
    });

    const createRow = rows.find((r) => r.operation === 'create');
    expect(createRow).toMatchObject({
      entityId: '3',
      after: { nodeId: 'new-node', capturedVersionedId: 'v3' },
    });
    expect(createRow.before).toBeUndefined();

    // The row write and its audit share the exact same transaction handle.
    expect(tx.intentAnchor.deleteMany).toHaveBeenCalled();
    expect(tx.intentAnchor.update).toHaveBeenCalled();
    expect(tx.intentAnchor.create).toHaveBeenCalled();
  });

  it('skips the update and its audit row when the re-map is a no-op', async () => {
    const service = new IntentHandoffAnchorsService({} as never, {} as never);
    const { tx, auditCreate } = mockTx();

    const mapping: ResolvedMapping = {
      itemId: 'br-x',
      kind: 'mapped',
      replaceNodeIds: ['old-keep'],
      // Same nodeType and capturedVersionedId as the existing `old-keep` row.
      targets: [{ nodeId: 'old-keep', nodeType: 'file', capturedVersionedId: 'v1', filePath: 'a' }],
    };

    const results = await service.applyPrepared(tx as never, WORKSPACE_ID, snapshot(), [mapping]);

    expect(results).toHaveLength(1);
    expect(results[0]?.nodeIds).toEqual(['old-keep']);
    expect(tx.intentAnchor.update).not.toHaveBeenCalled();
    expect(tx.intentAnchor.create).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
