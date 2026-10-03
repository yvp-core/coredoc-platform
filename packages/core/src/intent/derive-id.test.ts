import { describe, expect, it } from 'vitest';
import { IntentIdDerivationError, IntentIdDerivationErrorCode, deriveIntentId } from './derive-id.js';
import { INTENT_ID_MAX_LENGTH, IntentKind } from './types.js';

// AC-15 / BR-16 / BR-17 — derived slug ids
describe('deriveIntentId — deterministic slug derivation', () => {
  it('derives a kind-prefixed slug from the title', () => {
    expect(deriveIntentId(IntentKind.BusinessRule, 'Refund window is 30 days', [])).toBe('br-refund-window-is-30-days');
    expect(deriveIntentId(IntentKind.UseCase, 'Place a widget order', [])).toBe('uc-place-a-widget-order');
    expect(deriveIntentId(IntentKind.Decision, "Refuse over-stock orders — don't reconcile", [])).toBe(
      'dec-refuse-over-stock-orders-don-t-reconcile',
    );
  });

  it('resolves collisions with a deterministic numeric suffix', () => {
    const taken = ['br-refund-window'];
    expect(deriveIntentId(IntentKind.BusinessRule, 'Refund window', taken)).toBe('br-refund-window-2');
    expect(deriveIntentId(IntentKind.BusinessRule, 'Refund window', [...taken, 'br-refund-window-2'])).toBe(
      'br-refund-window-3',
    );
    // Same inputs, same output — a re-run of the same batch cannot drift.
    expect(deriveIntentId(IntentKind.BusinessRule, 'Refund window', taken)).toBe(
      deriveIntentId(IntentKind.BusinessRule, 'Refund window', taken),
    );
  });

  it('refuses a title whose slug does not fit the id cap, naming the stub it would have written', () => {
    const long = 'Orders beyond the available stock of the addressed warehouse are refused immediately';
    try {
      deriveIntentId(IntentKind.BusinessRule, long, []);
      throw new Error('expected a derivation refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentIdDerivationError);
      // Ids are immutable, so a silently shortened id is carried forever — and
      // a dropped word can invert the rule ('are not' -> 'are').
      expect((error as IntentIdDerivationError).code).toBe(IntentIdDerivationErrorCode.IdWouldTruncate);
      expect((error as IntentIdDerivationError).message).toContain('br-orders-beyond-the-available-stock');
    }
  });

  it('still rebuilds a shorter base for the collision suffix of a title that does fit', () => {
    const fits = 'Orders beyond the available stock of the addressed warehouse';
    const derived = deriveIntentId(IntentKind.BusinessRule, fits, []);
    expect(derived).toBe('br-orders-beyond-the-available-stock-of-the-addressed-warehouse');
    expect(derived.length).toBeLessThanOrEqual(INTENT_ID_MAX_LENGTH);

    // The suffix must fit INSIDE the cap, so the base drops its last word here —
    // the one shortening that is legitimate, because the title itself derived.
    const suffixed = deriveIntentId(IntentKind.BusinessRule, fits, [derived]);
    expect(suffixed).toBe('br-orders-beyond-the-available-stock-of-the-addressed-2');
    expect(suffixed.length).toBeLessThanOrEqual(INTENT_ID_MAX_LENGTH);
  });

  it('refuses a title that carries no sluggable characters', () => {
    try {
      deriveIntentId(IntentKind.Capability, '—— ???', []);
      throw new Error('expected a derivation refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentIdDerivationError);
      expect((error as IntentIdDerivationError).code).toBe(IntentIdDerivationErrorCode.UnderivableItemId);
    }
  });
});
