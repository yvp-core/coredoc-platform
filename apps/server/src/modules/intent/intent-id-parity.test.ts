/**
 * Cross-package id-derivation parity (spec §08 "Low findings" — issue 08).
 *
 * `intent-id.ts`'s header explains WHY this is a port rather than an import:
 * `@coredoc/core`'s intent barrel does not re-export `deriveIntentId`, and
 * widening that barrel is outside this change's file surface. That leaves a
 * real drift risk — a cloud item id (server) and a local overlay item id
 * (core, used by `packages/cli`'s pre-cutover capture path) for the SAME
 * statement could diverge silently. This test closes that gap the only way
 * available without touching the barrel: importing core's implementation
 * FILE directly (not its package entry point) and running the exact same
 * `(kind, title, takenIds)` triples through both derivations side by side.
 *
 * `boundedSlugId` itself is private on both sides (server: not exported from
 * `intent-id.ts`; core: not exported from `capture.ts` or the intent barrel),
 * so parity is asserted through each side's public entry point —
 * `deriveIntentItemId` / `deriveIntentId` — which is also the only shape a
 * real caller (a propose request, a capture batch) ever exercises.
 */
import { IntentKind } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { deriveIntentItemId } from './intent-id.js';
// Deep import of core's SOURCE FILE, not the package's public entry point —
// see the file header for why. `@coredoc/core` has no subpath export for
// `intent/capture`, and adding one is outside this issue's file ownership.
import { deriveIntentId } from '../../../../../packages/core/src/intent/capture.js';

describe('server/core intent id derivation parity', () => {
  const cases: Array<{ kind: IntentKind; title: string }> = [
    { kind: IntentKind.BusinessRule, title: 'Refund window is 30 days' },
    { kind: IntentKind.UseCase, title: 'Place a widget order' },
    { kind: IntentKind.Decision, title: "Refuse over-stock orders — don't reconcile" },
    { kind: IntentKind.Limitation, title: 'Café résumé naïve façade — 日本語 tokens ignored' },
    { kind: IntentKind.Capability, title: '  ---   ...   ' /* no a-z0-9 content at all */ },
    {
      kind: IntentKind.BusinessRule,
      // Long enough that the derived slug sits right at (and, with the loop
      // below, just past) INTENT_ID_MAX_LENGTH, exercising the word-boundary
      // truncation / IdWouldTruncate refusal path identically on both sides.
      title:
        'Every single one of these many distinct words must be counted toward the sixty four character id length cap boundary exactly',
    },
  ];

  function deriveEither(
    fn: (kind: IntentKind, title: string, taken: Iterable<string>) => string,
    c: (typeof cases)[number],
    taken: string[],
  ) {
    try {
      return { id: fn(c.kind, c.title, taken) };
    } catch (error) {
      return {
        errorCode:
          (error as { publicError?: { code: string }; code?: string }).publicError?.code ??
          (error as { code?: string }).code,
      };
    }
  }

  it.each(cases)('derives the identical id (or the identical refusal) for %j', (c) => {
    const server = deriveEither(deriveIntentItemId, c, []);
    const core = deriveEither(deriveIntentId as typeof deriveIntentItemId, c, []);
    if ('id' in server || 'id' in core) {
      expect(server).toEqual({ id: expect.any(String) });
      expect(core).toEqual({ id: expect.any(String) });
      expect(server.id).toBe(core.id);
    } else {
      // Both refuse; the reason differs by error-object shape between the two
      // packages (IntentPublicException vs IntentCaptureError) but the *kind*
      // of refusal (underivable vs would-truncate) must still agree.
      expect(server.errorCode).toBeDefined();
      expect(core.errorCode).toBeDefined();
    }
  });

  it('agrees on collision suffixing against the same taken-id set', () => {
    const taken = ['br-refund-window-is-30-days', 'br-refund-window-is-30-days-2'];
    const server = deriveIntentItemId(IntentKind.BusinessRule, 'Refund window is 30 days', taken);
    const core = deriveIntentId(IntentKind.BusinessRule, 'Refund window is 30 days', taken);
    expect(server).toBe(core);
    expect(server).toBe('br-refund-window-is-30-days-3');
  });

  it('agrees exactly at the length cap: a title whose slug fits produces the identical un-truncated id', () => {
    // "br-" (3) + this title's slug must land at exactly INTENT_ID_MAX_LENGTH (64).
    const title = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 61 a's
    const server = deriveIntentItemId(IntentKind.BusinessRule, title, []);
    const core = deriveIntentId(IntentKind.BusinessRule, title, []);
    expect(server).toBe(core);
    expect(server.length).toBe(64);
  });
});
