import { describe, expect, it } from 'vitest';
import { IntentErrorCode, parseContract, type IntentPublicException } from './contract/index.js';
import { INTENT_CONTRACT_LIMITS } from './contract/intent-primitives.js';
import {
  automaticIdempotencyKey,
  defaultReleaseReason,
  isAutomaticRecord,
  PlanIntentReleaseSchema,
  AutomaticRecordIntentReleaseSchema,
  HumanRecordIntentReleaseSchema,
  RollbackIntentReleaseSchema,
  ChangeIntentPlanSchema,
  type ReleaseCommand,
} from './intent-release.operations.js';

const HASH = 'a'.repeat(64);
const automatic = {
  kind: 'release' as const,
  repoKey: 'github.com/acme/orders-api',
  deliveredRef: 'v1.2.3',
  deployId: '9911',
  deployedAt: '2026-09-11T10:00:00.000Z',
  trailers: { delivers: [{ itemId: 'cap-a', version: 2 }], retires: [{ itemId: 'lim-b', version: 1 }] },
};
const human = { idempotencyKey: 'key-1', deliveredRef: 'v1.2.3', included: [{ itemId: 'cap-a', contentHash: HASH }] };

function refusalOf(body: unknown): IntentPublicException['publicError'] {
  try {
    parseContract(AutomaticRecordIntentReleaseSchema, body);
  } catch (error) {
    return (error as IntentPublicException).publicError;
  }
  throw new Error('expected a refusal');
}

describe('record release — two bodies, one command', () => {
  it('keeps the human body exactly as it was, including its defaults', () => {
    expect(parseContract(HumanRecordIntentReleaseSchema, { ...human, reason: 'Verified' })).toEqual({
      ...human,
      reason: 'Verified',
      kind: 'release',
      expectedHeadSeq: 0,
      retired: [],
    });
  });

  it('accepts only structured internal declarations', () => {
    const parsed = parseContract(AutomaticRecordIntentReleaseSchema, automatic);
    expect(isAutomaticRecord(parsed)).toBe(true);
    expect(parsed).toEqual({
      ...automatic,
      trailers: { delivers: [{ itemId: 'cap-a', version: 2 }], retires: [{ itemId: 'lim-b', version: 1 }] },
    });
  });

  it('rejects PR prose as a declaration source', () => {
    expect(refusalOf({ ...automatic, trailers: 'Coredoc-Intent-Delivers: cap-a' }).code).toBe(
      IntentErrorCode.SchemaViolation,
    );
  });

  it.each([
    ['a head sequence the CI step could not know', { ...automatic, expectedHeadSeq: 3 }],
    ['hand-picked content beside the trailers', { ...automatic, included: human.included }],
    ['a deployedAt that is not an instant', { ...automatic, deployedAt: 'yesterday' }],
  ])('refuses %s', (_case, body) => {
    expect(refusalOf(body).code).toBe(IntentErrorCode.SchemaViolation);
  });

  it('composes the delivery identity from the deployment, not from the attempt', () => {
    expect(automaticIdempotencyKey(automatic)).toBe('github.com/acme/orders-api:v1.2.3:9911');
  });

  it('keys each PR of one deploy apart, including when the identity is folded', () => {
    const pr = (number: number) => ({ repoKey: automatic.repoKey, number });
    expect(automaticIdempotencyKey({ ...automatic, pr: pr(7) })).toBe('github.com/acme/orders-api:v1.2.3:9911:7');
    const long = { repoKey: 'r'.repeat(150), deliveredRef: 'a'.repeat(40), deployId: 'b'.repeat(40) };
    expect(automaticIdempotencyKey({ ...long, pr: pr(1) })).not.toBe(automaticIdempotencyKey({ ...long, pr: pr(2) }));
  });

  /**
   * The column is VARCHAR(200) and a real identity can exceed it (a 120-character repo
   * key plus two 40-character shas is 202). The REST schema used to refuse those, but the
   * connector calls the service directly, so the FIT belongs to the key function itself.
   */
  describe('idempotency key length', () => {
    /** `<repoKey>:<sha>:<sha>` of exactly `length` characters. */
    const identity = (length: number) => ({
      repoKey: 'r'.repeat(length - 2 - 80),
      deliveredRef: 'a'.repeat(40),
      deployId: 'b'.repeat(40),
    });

    it.each([199, 200])('composes %i characters verbatim', (length) => {
      const input = identity(length);
      expect(automaticIdempotencyKey(input)).toBe(`${input.repoKey}:${input.deliveredRef}:${input.deployId}`);
    });

    it('folds an over-long identity into a deterministic key that fits', () => {
      const input = identity(201);
      const key = automaticIdempotencyKey(input);
      expect(key.length).toBeLessThanOrEqual(INTENT_CONTRACT_LIMITS.id);
      expect(key).toBe(automaticIdempotencyKey({ ...input }));
      expect(key.startsWith(input.repoKey.slice(0, 100))).toBe(true);
      // A different deployment of the same repository never collides with it.
      expect(automaticIdempotencyKey({ ...input, deployId: 'c'.repeat(40) })).not.toBe(key);
    });

    it('keeps two long repo keys apart when only the truncated tail differs', () => {
      const shared = 'r'.repeat(167);
      const delivery = { deliveredRef: 'a'.repeat(40), deployId: 'b'.repeat(40) };
      const one = automaticIdempotencyKey({ repoKey: `${shared}${'x'.repeat(13)}`, ...delivery });
      const other = automaticIdempotencyKey({ repoKey: `${shared}${'y'.repeat(13)}`, ...delivery });
      expect(one).not.toBe(other);
    });

    it('accepts an over-long identity through the schema rather than refusing it', () => {
      const input = identity(320);
      expect(() =>
        parseContract(AutomaticRecordIntentReleaseSchema, {
          ...automatic,
          ...input,
          repoKey: input.repoKey.slice(0, 200),
        }),
      ).not.toThrow();
    });
  });
});

describe('reason — required only where it carries information', () => {
  it('accepts a record and a plan change without one', () => {
    expect(parseContract(HumanRecordIntentReleaseSchema, human)).not.toHaveProperty('reason');
    expect(parseContract(ChangeIntentPlanSchema, { idempotencyKey: 'k', itemId: 'cap-a' })).not.toHaveProperty(
      'reason',
    );
    expect(parseContract(AutomaticRecordIntentReleaseSchema, automatic)).not.toHaveProperty('reason');
  });

  it.each([
    ['plan', PlanIntentReleaseSchema, { idempotencyKey: 'k', itemId: 'cap-a', expectedVersion: 1 }],
    ['rollback', RollbackIntentReleaseSchema, { idempotencyKey: 'k', releaseSeq: 1 }],
  ])('still refuses %s without one', (_case, schema, body) => {
    expect(() => parseContract(schema, body)).toThrow();
  });

  it('fills the system default from the most specific identity the command carries', () => {
    const deployed = parseContract(AutomaticRecordIntentReleaseSchema, automatic);
    expect(defaultReleaseReason(deployed)).toBe('deploy v1.2.3');
    expect(
      defaultReleaseReason(
        parseContract(AutomaticRecordIntentReleaseSchema, {
          ...automatic,
          pr: { repoKey: 'github.com/acme/orders-api', number: 42 },
        }),
      ),
    ).toBe('PR github.com/acme/orders-api#42');
    expect(defaultReleaseReason(parseContract(HumanRecordIntentReleaseSchema, human))).toBe('manual');
    expect(defaultReleaseReason({ ...deployed, reason: 'Typed by a maintainer' } as ReleaseCommand)).toBe(
      'Typed by a maintainer',
    );
  });
});
