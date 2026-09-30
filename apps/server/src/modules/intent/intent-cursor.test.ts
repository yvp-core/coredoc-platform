import { describe, expect, it } from 'vitest';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import {
  INTENT_PAGE_LIMITS,
  IntentCursorScope,
  decodeIntentCursor,
  encodeIntentCursor,
  paginate,
  parseIntentPageLimit,
} from './intent-cursor.js';

/** An attacker-supplied cursor: whatever JSON we like, base64url-encoded. */
function handBuilt(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function refusalCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(IntentPublicException);
    return (error as IntentPublicException).publicError.code;
  }
  throw new Error('expected a refusal');
}

describe('intent cursor codec', () => {
  it('round-trips a keyset', () => {
    const cursor = encodeIntentCursor(IntentCursorScope.Items, ['br-refund-window']);
    expect(decodeIntentCursor(cursor, IntentCursorScope.Items, 1)).toEqual(['br-refund-window']);
  });

  it('treats an absent cursor as the first page', () => {
    expect(decodeIntentCursor(undefined, IntentCursorScope.Items, 1)).toBeNull();
    expect(decodeIntentCursor('', IntentCursorScope.Items, 1)).toBeNull();
  });

  it('refuses a cursor issued for a different list', () => {
    const cursor = encodeIntentCursor(IntentCursorScope.Items, ['br-refund-window']);
    expect(refusalCode(() => decodeIntentCursor(cursor, IntentCursorScope.Features, 1))).toBe(
      IntentErrorCode.InvalidCursor,
    );
  });

  it('refuses a hand-built cursor whose keyset arity does not match the endpoint', () => {
    const twoParts = handBuilt({ v: 1, scope: IntentCursorScope.Items, key: ['a', 'b'] });
    const noParts = handBuilt({ v: 1, scope: IntentCursorScope.Items, key: [] });
    for (const raw of [twoParts, noParts]) {
      expect(refusalCode(() => decodeIntentCursor(raw, IntentCursorScope.Items, 1))).toBe(
        IntentErrorCode.InvalidCursor,
      );
    }
  });

  it('treats an endpoint asking for the wrong arity as a server bug, not a caller refusal', () => {
    // The scope alone fixes the keyset now, so a `length` that disagrees means
    // the two declarations of one keyset drifted. That must be loud in a test,
    // never an `invalid_cursor` blamed on the caller.
    const cursor = encodeIntentCursor(IntentCursorScope.Items, ['br-refund-window']);
    expect(() => decodeIntentCursor(cursor, IntentCursorScope.Items, 2)).toThrow(/declares 1 part/);
  });

  it('refuses a mutated or re-encoded variant of a valid cursor', () => {
    const cursor = encodeIntentCursor(IntentCursorScope.Items, ['br-refund-window']);
    const padded = `${cursor}=`;
    const truncated = cursor.slice(0, -2);
    expect(refusalCode(() => decodeIntentCursor(padded, IntentCursorScope.Items, 1))).toBe(
      IntentErrorCode.InvalidCursor,
    );
    expect(refusalCode(() => decodeIntentCursor(truncated, IntentCursorScope.Items, 1))).toBe(
      IntentErrorCode.InvalidCursor,
    );
  });

  it('refuses a hand-built cursor of another version or shape', () => {
    const wrongVersion = Buffer.from(JSON.stringify({ v: 2, scope: 'items', key: ['x'] })).toString('base64url');
    const extraKey = Buffer.from(JSON.stringify({ v: 1, scope: 'items', key: ['x'], extra: 1 })).toString('base64url');
    const nonStringPart = Buffer.from(JSON.stringify({ v: 1, scope: 'items', key: [7] })).toString('base64url');
    for (const raw of [wrongVersion, extraKey, nonStringPart]) {
      expect(refusalCode(() => decodeIntentCursor(raw, IntentCursorScope.Items, 1))).toBe(
        IntentErrorCode.InvalidCursor,
      );
    }
  });

  it('refuses anything that is not a base64url string', () => {
    expect(refusalCode(() => decodeIntentCursor('not a cursor!', IntentCursorScope.Items, 1))).toBe(
      IntentErrorCode.InvalidCursor,
    );
    expect(refusalCode(() => decodeIntentCursor(42, IntentCursorScope.Items, 1))).toBe(IntentErrorCode.InvalidCursor);
  });

  it('refuses garbage that is valid base64url but not JSON', () => {
    const notJson = Buffer.from('this is not json at all', 'utf8').toString('base64url');
    expect(refusalCode(() => decodeIntentCursor(notJson, IntentCursorScope.Items, 1))).toBe(
      IntentErrorCode.InvalidCursor,
    );
  });

  it('refuses valid base64url JSON of the wrong shape', () => {
    for (const payload of [null, 42, 'items', ['items'], { v: 1, scope: 'items' }, { v: 1, key: ['x'] }]) {
      expect(refusalCode(() => decodeIntentCursor(handBuilt(payload), IntentCursorScope.Items, 1))).toBe(
        IntentErrorCode.InvalidCursor,
      );
    }
  });
});

/**
 * The defect these guard: a decoded part used to be checked only for "is a
 * bounded non-empty string", then handed straight to `BigInt()`, `Number()`, or
 * `new Date()` to rebuild a keyset predicate. `BigInt('x')` THROWS, so a
 * hand-written cursor turned a GET on an `intent:read` route into an unhandled
 * 500; `Number('x')` is `NaN`, which reaches Postgres as `NaN::int` and fails
 * there instead. Every one of these must be a §12 `invalid_cursor` with a path.
 */
describe('cursor part kinds are validated at the decode seam', () => {
  const refuse = (scope: IntentCursorScope, key: unknown[], length: number) =>
    expect(refusalCode(() => decodeIntentCursor(handBuilt({ v: 1, scope, key }), scope, length))).toBe(
      IntentErrorCode.InvalidCursor,
    );

  it.each([
    ['x', 'the exact BigInt() crash the reviewer found'],
    ['', 'empty'],
    ['1.5', 'fractional'],
    ['0x10', 'hex'],
    ['1e3', 'exponent'],
    ['007', 'leading zeros, so one row cannot have two cursors'],
    [' 1', 'leading space'],
    ['9'.repeat(40), 'absurdly long'],
    ['Infinity', 'non-finite'],
    ['NaN', 'the value Number() would silently produce'],
  ])('refuses %s as a bigint row-id part (%s)', (part) => {
    refuse(IntentCursorScope.FeatureSeeds, [part], 1);
  });

  it('accepts a real bigint row id, which BigInt() then parses without throwing', () => {
    const decoded = decodeIntentCursor(
      encodeIntentCursor(IntentCursorScope.FeatureSeeds, ['4210987654321']),
      IntentCursorScope.FeatureSeeds,
      1,
    );
    expect(decoded).toEqual(['4210987654321']);
    expect(BigInt(decoded?.[0] as string)).toBe(4210987654321n);
  });

  it('refuses a non-numeric authority rank, which reached raw SQL as NaN::int', () => {
    refuse(IntentCursorScope.Context, ['x', 'br-refund-window'], 2);
    expect(Number.isFinite(Number('x'))).toBe(false);
  });

  it('accepts a real context keyset', () => {
    const cursor = encodeIntentCursor(IntentCursorScope.Context, ['2', 'br-refund-window']);
    expect(decodeIntentCursor(cursor, IntentCursorScope.Context, 2)).toEqual(['2', 'br-refund-window']);
  });

  it('decodes a bound cursor only under the same binding', () => {
    const key = ['2', 'br-refund-window'];
    const bound = encodeIntentCursor(IntentCursorScope.Context, key, 'digest-a');
    expect(decodeIntentCursor(bound, IntentCursorScope.Context, 2, 'digest-a')).toEqual(key);
    const code = IntentErrorCode.InvalidCursor;
    expect(refusalCode(() => decodeIntentCursor(bound, IntentCursorScope.Context, 2, 'digest-b'))).toBe(code);
    expect(refusalCode(() => decodeIntentCursor(bound, IntentCursorScope.Context, 2))).toBe(code);
    const unbound = encodeIntentCursor(IntentCursorScope.Context, key);
    expect(unbound).toBe(handBuilt({ v: 1, scope: IntentCursorScope.Context, key }));
    expect(refusalCode(() => decodeIntentCursor(unbound, IntentCursorScope.Context, 2, 'digest-a'))).toBe(code);
  });

  it.each([
    ['x', 'not a date at all'],
    ['2026-09-01', 'a date with no time — not what toISOString emits'],
    ['2026-09-01T12:00:00Z', 'missing milliseconds'],
    ['2026-13-01T12:00:00.000Z', 'month 13: well-shaped but not a real instant'],
    ['2026-02-31T12:00:00.000Z', '31 February: well-shaped but not a real instant'],
  ])('refuses %s as a transition timestamp part (%s)', (part) => {
    refuse(IntentCursorScope.ItemTransitions, [part, '1'], 2);
  });

  it('refuses a non-numeric transition row id even beside a valid timestamp', () => {
    refuse(IntentCursorScope.ItemTransitions, ['2026-09-01T12:00:00.000Z', 'x'], 2);
  });

  it('accepts the exact pair the transition list issues', () => {
    const createdAt = new Date('2026-09-01T12:00:00.000Z');
    const cursor = encodeIntentCursor(IntentCursorScope.WorkspaceTransitions, [createdAt.toISOString(), '17']);
    const decoded = decodeIntentCursor(cursor, IntentCursorScope.WorkspaceTransitions, 2);
    expect(new Date(decoded?.[0] as string).getTime()).toBe(createdAt.getTime());
    expect(BigInt(decoded?.[1] as string)).toBe(17n);
  });

  it('refuses to ISSUE a cursor whose parts its own decoder would reject', () => {
    // Catches the drift where a list endpoint starts emitting a key of the wrong
    // kind and every caller's next page dead-ends on `invalid_cursor`.
    expect(() => encodeIntentCursor(IntentCursorScope.FeatureSeeds, ['not-a-number'])).toThrow(/keyset kinds/);
    expect(() => encodeIntentCursor(IntentCursorScope.Context, ['1'])).toThrow(/2 part/);
    expect(() => encodeIntentCursor(IntentCursorScope.ItemTransitions, ['whenever', '1'])).toThrow(/keyset kinds/);
  });
});

describe('parseIntentPageLimit', () => {
  it('defaults when absent and accepts an in-range integer', () => {
    expect(parseIntentPageLimit(undefined)).toBe(INTENT_PAGE_LIMITS.default);
    expect(parseIntentPageLimit('10')).toBe(10);
    expect(parseIntentPageLimit(String(INTENT_PAGE_LIMITS.max))).toBe(INTENT_PAGE_LIMITS.max);
  });

  it('refuses zero, an over-max value, and a non-integer', () => {
    for (const raw of ['0', String(INTENT_PAGE_LIMITS.max + 1), '1.5', '-1', 'ten']) {
      expect(refusalCode(() => parseIntentPageLimit(raw))).toBe(IntentErrorCode.InvalidPageLimit);
    }
  });
});

describe('paginate', () => {
  it('issues no cursor when the page is the last one', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(paginate(rows, 2, IntentCursorScope.Items, (row) => [row.id])).toEqual({ page: rows, nextCursor: null });
  });

  it('drops the probe row and issues a cursor pointing at the last returned row', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const { page, nextCursor } = paginate(rows, 2, IntentCursorScope.Items, (row) => [row.id]);
    expect(page.map((row) => row.id)).toEqual(['a', 'b']);
    expect(decodeIntentCursor(nextCursor, IntentCursorScope.Items, 1)).toEqual(['b']);
  });
});
