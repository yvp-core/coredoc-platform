/**
 * The request fingerprint. Its only job is to make "the same request" and "a
 * different request" decidable, so a replay returns the stored response and a
 * key reused for something else is refused (spec §4.8).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { IntentItemAuthority, Prisma } from '../../generated/prisma/client.js';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import {
  IntentOperation,
  canonicalJson,
  hashIntentRequest,
  translateMutationFailure,
  updateItemWithVersion,
  type IntentTransaction,
} from './intent-idempotency.js';

describe('canonicalJson', () => {
  it('is stable under key order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });

  it('preserves array order, which is meaningful in a propose batch', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined members so an omitted optional field hashes like an absent one', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe('hashIntentRequest', () => {
  const request = { id: 'ordering', title: 'Ordering' };

  it('is equal for equal requests regardless of key order', () => {
    expect(hashIntentRequest(IntentOperation.DomainCreate, request)).toBe(
      hashIntentRequest(IntentOperation.DomainCreate, { title: 'Ordering', id: 'ordering' }),
    );
  });

  it('changes when the request body changes', () => {
    expect(hashIntentRequest(IntentOperation.DomainCreate, request)).not.toBe(
      hashIntentRequest(IntentOperation.DomainCreate, { ...request, title: 'Order management' }),
    );
  });

  it('changes when the operation changes, so one body cannot look like a replay of another call', () => {
    expect(hashIntentRequest(IntentOperation.DomainCreate, request)).not.toBe(
      hashIntentRequest(IntentOperation.DomainUpdate, request),
    );
  });

  /**
   * FROZEN DIGESTS. `intent_mutation_requests.request_hash` is persisted, so the
   * hash function is a storage format, not an implementation detail: any change
   * to the separator, the canonical JSON, or the digest silently orphans every
   * spent key in every workspace — replays stop matching and re-run mutations
   * that already happened.
   *
   * These values were computed from the shipped implementation BEFORE the
   * separator was rewritten from a raw 0x00 byte to the `\0` escape, and they
   * are unchanged by it. That is the whole point: the edit was cosmetic in the
   * source and a no-op at runtime.
   */
  it.each([
    [IntentOperation.DomainCreate, {}, '5bc508e96e70f23d47c2ac757f67bfe808543507404c6f6526ab5dcef35a31e4'],
    [IntentOperation.DomainCreate, { b: 1, a: 2 }, '1f9e496fd9cfcd4573ce3ee19eeec666f25aeaef1c794064e34eb5ba89d35539'],
    [
      IntentOperation.OverlayImport,
      { localRevision: 'r1', overlay: { schemaVersion: 2, items: [{ id: 'b' }, { id: 'a' }] } },
      '23bb50ae02741f784676e0d12a52eca825000a1fac03f6ea374b79d9b3aec64d',
    ],
    [IntentOperation.ItemsPropose, null, '1a2da9acf9b38b4be803e83ae6b85dc88a331e24aeb3390a7e56e93dff2be6f3'],
    [
      IntentOperation.AnchorAdd,
      { repo: 'x', nodeId: 'y' },
      '7eda1caa70d8982c979e2d7f9f9513dad8e3491c20ad02de4e9877f844d3248b',
    ],
  ])('is byte-stable: %s hashes to its stored digest', (operation, body, digest) => {
    expect(hashIntentRequest(operation, body)).toBe(digest);
  });

  it('separates the operation from the body with a NUL, so no pair can straddle into another', () => {
    // Without a separator no operation value may occur in, `domain.create` +
    // `"x"` and `domain` + `create"x"` would digest identically. A NUL cannot
    // appear in an IntentOperation, which is what makes the encoding injective.
    expect(hashIntentRequest(IntentOperation.DomainCreate, 'x')).not.toBe(
      createHash('sha256').update(`${IntentOperation.DomainCreate}"x"`).digest('hex'),
    );
  });
});

describe('translateMutationFailure', () => {
  const uniqueViolation = (target: unknown) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target },
    });

  const codeOf = (error: unknown) => (error as IntentPublicException).publicError.code as unknown as string;

  it('maps a race on the ledger primary key to the retryable in-flight refusal', () => {
    const translated = translateMutationFailure(uniqueViolation(['workspaceId', 'idempotencyKey']));
    expect(translated).toBeInstanceOf(IntentPublicException);
    expect(codeOf(translated)).toBe(IntentErrorCode.IdempotencyInFlight);
    expect((translated as IntentPublicException).publicError.path).toEqual(['idempotencyKey']);
  });

  it('accepts the ledger key columns in either order, since Prisma does not promise one', () => {
    expect(codeOf(translateMutationFailure(uniqueViolation(['idempotencyKey', 'workspaceId'])))).toBe(
      IntentErrorCode.IdempotencyInFlight,
    );
  });

  /**
   * The defect this guards: EVERY P2002 used to become `idempotency_in_flight`,
   * telling a caller whose domain id simply already exists to "retry to read its
   * result" — a retry that can never succeed, because there is no concurrent
   * winner to read. The answer has to be a different, non-retryable code.
   */
  it.each([
    ['a duplicate tree node id', ['workspaceId', 'id']],
    ['a repeated anchor identity', ['workspaceId', 'itemId', 'repoKey', 'nodeId']],
    ['a repeated source identity', ['workspaceId', 'itemId', 'ref', 'localId']],
  ])('does not claim in-flight for %s', (_label, target) => {
    const translated = translateMutationFailure(uniqueViolation(target));
    expect(codeOf(translated)).toBe(IntentErrorCode.UniqueConstraintViolation);
    // The refusal has to be actionable, so it names the constraint it hit.
    expect((translated as IntentPublicException).publicError.message).toContain((target as string[]).join(', '));
  });

  it('does not claim in-flight for a unique violation Prisma could not name', () => {
    for (const target of [undefined, 42, { column: 'id' }]) {
      expect(codeOf(translateMutationFailure(uniqueViolation(target)))).toBe(IntentErrorCode.UniqueConstraintViolation);
    }
  });

  it('accepts the single-string target shape non-Postgres connectors report', () => {
    expect(codeOf(translateMutationFailure(uniqueViolation('intent_domains_pkey')))).toBe(
      IntentErrorCode.UniqueConstraintViolation,
    );
  });

  /**
   * P2028 (transaction timed out) and P2034 (write conflict / deadlock) both
   * mean NOTHING COMMITTED — so the ledger row was never written and the key is
   * still unspent. Left as raw Prisma errors these were 500s, which told the
   * caller nothing about whether their write landed and made the documented
   * "rerun the same key" recovery look like an infinite loop.
   */
  it.each([
    ['P2028', 'time budget'],
    ['P2034', 'concurrent write'],
  ])('maps %s to a retryable transaction conflict', (code, fragment) => {
    const translated = translateMutationFailure(
      new Prisma.PrismaClientKnownRequestError('failed', { code, clientVersion: 'test' }),
    );
    expect(codeOf(translated)).toBe(IntentErrorCode.TransactionConflict);
    expect((translated as IntentPublicException).publicError.message).toContain(fragment);
    expect((translated as IntentPublicException).publicError.message).toContain('same idempotency key');
  });

  it('passes anything that is not a translated Prisma failure straight through', () => {
    const boom = new Error('connection reset');
    expect(translateMutationFailure(boom)).toBe(boom);

    const otherPrisma = new Prisma.PrismaClientKnownRequestError('not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    expect(translateMutationFailure(otherPrisma)).toBe(otherPrisma);
  });
});

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
