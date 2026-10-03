/**
 * The ported derivation must behave EXACTLY like core's `deriveIntentId`, so
 * these expectations are the ones `packages/core/src/intent/derive-id.test.ts`
 * states, re-run against the port.
 */
import { INTENT_ID_MAX_LENGTH, IntentKind } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import { assertItemIdMatchesKind, deriveIntentItemId, intentIdScanPrefix } from './intent-id.js';

function refusalCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(IntentPublicException);
    return (error as IntentPublicException).publicError.code;
  }
  throw new Error('expected a refusal');
}

describe('deriveIntentItemId', () => {
  it('derives a kind-prefixed slug from the title', () => {
    expect(deriveIntentItemId(IntentKind.BusinessRule, 'Refund window is 30 days', [])).toBe(
      'br-refund-window-is-30-days',
    );
    expect(deriveIntentItemId(IntentKind.UseCase, 'Place a widget order', [])).toBe('uc-place-a-widget-order');
    expect(deriveIntentItemId(IntentKind.Decision, "Refuse over-stock orders — don't reconcile", [])).toBe(
      'dec-refuse-over-stock-orders-don-t-reconcile',
    );
  });

  it('resolves collisions with a deterministic numeric suffix', () => {
    const taken = ['br-refund-window'];
    expect(deriveIntentItemId(IntentKind.BusinessRule, 'Refund window', taken)).toBe('br-refund-window-2');
    expect(deriveIntentItemId(IntentKind.BusinessRule, 'Refund window', [...taken, 'br-refund-window-2'])).toBe(
      'br-refund-window-3',
    );
    // Same inputs, same output — a re-run of one bootstrap packet cannot drift.
    expect(deriveIntentItemId(IntentKind.BusinessRule, 'Refund window', taken)).toBe(
      deriveIntentItemId(IntentKind.BusinessRule, 'Refund window', taken),
    );
  });

  it('refuses a title whose slug does not fit the id cap, naming the stub it would have written', () => {
    const long = 'Orders beyond the available stock of the addressed warehouse are refused immediately';
    expect(refusalCode(() => deriveIntentItemId(IntentKind.BusinessRule, long, []))).toBe(
      IntentErrorCode.IdWouldTruncate,
    );
    // A single over-long word is the same refusal: the hard slice loses content
    // just as a dropped word does, and the id it would write is immutable.
    expect(
      refusalCode(() =>
        deriveIntentItemId(
          IntentKind.BusinessRule,
          'Ordersbeyondtheavailablestockoftheaddressedwarehousearerefusedimmediately',
          [],
        ),
      ),
    ).toBe(IntentErrorCode.IdWouldTruncate);
  });

  it('still rebuilds a shorter base for the collision suffix of a title that does fit', () => {
    const fits = 'Orders beyond the available stock of the addressed warehouse';
    const derived = deriveIntentItemId(IntentKind.BusinessRule, fits, []);
    expect(derived).toBe('br-orders-beyond-the-available-stock-of-the-addressed-warehouse');

    // The suffix must fit INSIDE the cap, so the base drops its last word here —
    // the one shortening that is legitimate, because the title itself derived.
    const suffixed = deriveIntentItemId(IntentKind.BusinessRule, fits, [derived]);
    expect(suffixed).toBe('br-orders-beyond-the-available-stock-of-the-addressed-2');
    expect(suffixed.length).toBeLessThanOrEqual(INTENT_ID_MAX_LENGTH);
  });

  it('refuses a title that carries no sluggable characters', () => {
    expect(refusalCode(() => deriveIntentItemId(IntentKind.Capability, '—— ???', []))).toBe(
      IntentErrorCode.UnderivableItemId,
    );
  });
});

describe('intentIdScanPrefix', () => {
  it('covers every derivation of a title, including its collision variants', () => {
    const prefix = intentIdScanPrefix(IntentKind.BusinessRule, 'Refund window is 30 days') as string;
    const base = deriveIntentItemId(IntentKind.BusinessRule, 'Refund window is 30 days', []);
    const suffixed = deriveIntentItemId(IntentKind.BusinessRule, 'Refund window is 30 days', [base]);
    expect(base.startsWith(prefix)).toBe(true);
    expect(suffixed.startsWith(prefix)).toBe(true);
  });

  it('covers the variants of a title long enough that its collision suffix shortens the base', () => {
    const long = 'Orders beyond the available stock of the addressed warehouse';
    const prefix = intentIdScanPrefix(IntentKind.BusinessRule, long) as string;
    const base = deriveIntentItemId(IntentKind.BusinessRule, long, []);
    const suffixed = deriveIntentItemId(IntentKind.BusinessRule, long, [base]);
    expect(base.startsWith(prefix)).toBe(true);
    expect(suffixed.startsWith(prefix)).toBe(true);
  });

  it('reports a title with no sluggable content rather than inventing a prefix', () => {
    expect(intentIdScanPrefix(IntentKind.Capability, '—— ???')).toBeNull();
  });
});

describe('assertItemIdMatchesKind', () => {
  it('accepts an id carrying its kind prefix', () => {
    expect(() => assertItemIdMatchesKind('br-refund-window', IntentKind.BusinessRule, ['id'])).not.toThrow();
  });

  it('refuses an id whose prefix belongs to another kind', () => {
    expect(refusalCode(() => assertItemIdMatchesKind('uc-refund-window', IntentKind.BusinessRule, ['id']))).toBe(
      IntentErrorCode.ItemIdKindMismatch,
    );
  });

  it('refuses a prefix that only looks like one (no hyphen boundary)', () => {
    expect(refusalCode(() => assertItemIdMatchesKind('brand-new-rule', IntentKind.BusinessRule, ['id']))).toBe(
      IntentErrorCode.ItemIdKindMismatch,
    );
  });
});
