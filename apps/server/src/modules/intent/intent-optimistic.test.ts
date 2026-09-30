/**
 * The version-conflict helper, exercised against a stub transaction.
 *
 * What matters is the DECISION the affected-row count drives — apply, conflict,
 * or not-found — and that a conflict carries the current version. The SQL
 * itself is proven end-to-end by `intent-module.postgres.integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import type { IntentTransaction } from './intent-idempotency.js';
import { updateItemWithVersion } from './intent-optimistic.js';
import { IntentItemAuthority } from '../../generated/prisma/client.js';

function stubTx(count: number, current: { version: number; authority?: IntentItemAuthority } | null) {
  const updateMany = vi.fn().mockResolvedValue({ count });
  const findUnique = vi.fn().mockResolvedValue(current);
  return { tx: { intentItem: { updateMany, findUnique } } as unknown as IntentTransaction, updateMany, findUnique };
}

const ARGS = {
  workspaceId: 'ws-1',
  itemId: 'br-refund-window',
  expectedVersion: 3,
  updatedBy: 'user-1',
  data: { title: 'Refund window' },
};

describe('updateItemWithVersion', () => {
  it('guards on the expected version and increments it in the same statement', async () => {
    const { tx, updateMany, findUnique } = stubTx(1, null);
    await expect(updateItemWithVersion(tx, ARGS)).resolves.toBe(4);

    expect(updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', id: 'br-refund-window', version: 3 },
      data: { title: 'Refund window', updatedBy: 'user-1', version: { increment: 1 } },
    });
    // No read-then-write: the conditional update is the whole check.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('reports a version conflict naming the current version', async () => {
    const { tx } = stubTx(0, { version: 5 });
    try {
      await updateItemWithVersion(tx, ARGS);
      throw new Error('expected a conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentPublicException);
      const published = (error as IntentPublicException).publicError;
      expect(published.code).toBe(IntentErrorCode.VersionConflict);
      expect(published.message).toContain('current version is 5');
      expect((error as IntentPublicException).getStatus()).toBe(409);
    }
  });

  it('distinguishes a missing item from a lost race', async () => {
    const { tx } = stubTx(0, null);
    try {
      await updateItemWithVersion(tx, ARGS);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentPublicException);
      expect((error as IntentPublicException).publicError.code).toBe(IntentErrorCode.ItemNotFound);
      expect((error as IntentPublicException).getStatus()).toBe(404);
    }
  });

  it('reports the conflict on the caller-supplied field path', async () => {
    const { tx } = stubTx(0, { version: 9 });
    try {
      await updateItemWithVersion(tx, { ...ARGS, path: ['decisions', '0', 'expectedVersion'] });
      throw new Error('expected a conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentPublicException);
      expect((error as IntentPublicException).publicError.path).toEqual(['decisions', '0', 'expectedVersion']);
    }
  });

  it('adds the authority guard to the same statement only when asked', async () => {
    const { tx, updateMany } = stubTx(1, null);
    await updateItemWithVersion(tx, { ...ARGS, requireAuthority: IntentItemAuthority.candidate });
    expect(updateMany.mock.calls[0]?.[0].where).toEqual({
      workspaceId: 'ws-1',
      id: 'br-refund-window',
      version: 3,
      authority: IntentItemAuthority.candidate,
    });
  });

  it('reports an authority change as its own conflict, even when the version also moved', async () => {
    const { tx } = stubTx(0, { version: 4, authority: IntentItemAuthority.accepted });
    try {
      await updateItemWithVersion(tx, { ...ARGS, requireAuthority: IntentItemAuthority.candidate });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentPublicException);
      const published = (error as IntentPublicException).publicError;
      expect(published.code).toBe(IntentErrorCode.ItemNoLongerCandidate);
      expect(published.message).toContain('was accepted');
      expect((error as IntentPublicException).getStatus()).toBe(409);
    }
  });

  it('keeps the version conflict when the required authority still holds', async () => {
    const { tx } = stubTx(0, { version: 5, authority: IntentItemAuthority.candidate });
    await expect(
      updateItemWithVersion(tx, { ...ARGS, requireAuthority: IntentItemAuthority.candidate }),
    ).rejects.toMatchObject({ publicError: { code: IntentErrorCode.VersionConflict } });
  });
});
