/**
 * Deterministic intent item ids (spec §4.4, BR-16/BR-17).
 *
 * Ported from `deriveIntentId` in `packages/core/src/intent/capture.ts` — same
 * algorithm, same guarantees. It is ported rather than imported because the
 * `@coredoc/core` intent barrel exports `IntentCaptureError` and
 * `CaptureItemResult` from that module and nothing else, `@coredoc/core` has no
 * deep-import subpath for it, and widening a cross-package barrel is outside
 * this change's file surface. `intent-id.test.ts` pins the ported behaviour
 * against the same expectations core's `capture.test.ts` states.
 *
 * The two behaviours that matter downstream:
 * - pure and deterministic — the same `(kind, title, takenIds)` always yields
 *   the same id, which is what makes a re-run of a bootstrap packet idempotent;
 * - the collision suffix is rebuilt INSIDE the length cap, never appended to a
 *   full-length id, so every variant still satisfies the `VARCHAR(64)` column
 *   and the `intent_items_id_slug_check` constraint.
 */
import { INTENT_ID_MAX_LENGTH, INTENT_ID_PREFIX_BY_KIND, IntentKind } from '@coredoc/core';
import { intentStateError } from './intent-state-errors.js';
import { IntentErrorCode } from './contract/index.js';

/**
 * Longest id-suffix marker this derivation can append (`-9999`). The scan
 * prefix below is shortened by it so that every collision variant of a title is
 * still covered by one `startsWith` query.
 */
const MAX_SUFFIX_MARKER_CHARS = 5;

/** `a-z0-9` words of a title, in order. Empty when the title carries none. */
function slugWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * `<prefix>-<word>[-<word>…]` bounded by `max`, cut at a word boundary.
 *
 * The first word is never dropped — an id must carry at least one slug word
 * beyond its prefix (BR-16) — so a single over-long word is hard-sliced.
 */
function boundedSlugId(prefix: string, words: string[], max: number): string {
  let out = `${prefix}-${words[0] as string}`;
  if (out.length > max) out = out.slice(0, max);
  for (const word of words.slice(1)) {
    if (out.length + 1 + word.length > max) break;
    out = `${out}-${word}`;
  }
  return out;
}

/**
 * The shortest string every possible derivation of `(kind, title)` starts with.
 *
 * Used to bound the "ids already taken" lookup to one indexed prefix scan
 * instead of loading every id in the workspace. It accounts for the suffix
 * rebuild: `-2`…`-9999` shortens the base, so the common prefix is the first
 * word truncated by the longest marker.
 */
export function intentIdScanPrefix(kind: IntentKind, title: string): string | null {
  const words = slugWords(title);
  if (words.length === 0) return null;
  return boundedSlugId(
    INTENT_ID_PREFIX_BY_KIND[kind],
    [words[0] as string],
    INTENT_ID_MAX_LENGTH - MAX_SUFFIX_MARKER_CHARS,
  );
}

/**
 * Derive the durable slug id of a new item from its title.
 *
 * Throws the §12 structured refusal when the title has no `a-z0-9` content at
 * all (inventing an id there would produce an unsearchable identity, which is
 * the whole reason slugs replaced numeric ids), and when its slug does not FIT
 * the cap: a shortened id is a stub the item would carry forever.
 */
export function deriveIntentItemId(
  kind: IntentKind,
  title: string,
  takenIds: Iterable<string>,
  path: string[] = ['title'],
): string {
  const prefix = INTENT_ID_PREFIX_BY_KIND[kind];
  const words = slugWords(title);
  if (words.length === 0) {
    throw intentStateError(
      IntentErrorCode.UnderivableItemId,
      `No intent id can be derived from this title: it carries no a-z0-9 characters. Supply an explicit '${prefix}-<slug>' id.`,
      path,
    );
  }

  const taken = new Set(takenIds);
  const base = boundedSlugId(prefix, words, INTENT_ID_MAX_LENGTH);
  // A base that does not carry EVERY slug word is a stub, and ids are immutable:
  // an accepted item would keep it forever, so the proposal is refused instead
  // of written. Dropping words is not a safe shortening — a lost 'not' inverts
  // the rule. The collision rebuild below is exempt: shortening there is the
  // price of a distinct id for a title that already derived cleanly.
  if (base !== `${prefix}-${words.join('-')}`) {
    throw intentStateError(
      IntentErrorCode.IdWouldTruncate,
      `This title is too long for an intent id: it would be shortened to '${base}'. Supply a shorter title or an explicit '${prefix}-<slug>' id.`,
      path,
    );
  }
  if (!taken.has(base)) return base;

  for (let suffix = 2; ; suffix++) {
    const marker = `-${suffix}`;
    const candidate = `${boundedSlugId(prefix, words, INTENT_ID_MAX_LENGTH - marker.length)}${marker}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Assert a caller-supplied item id agrees with its kind.
 *
 * The slug SHAPE is already enforced by the operation schema and by
 * `intent_items_id_slug_check`; what a caller can still get wrong is the
 * classification prefix, which `intent_items_id_kind_prefix_check` would
 * otherwise refuse as an opaque database error.
 */
export function assertItemIdMatchesKind(id: string, kind: IntentKind, path: string[]): void {
  const prefix = INTENT_ID_PREFIX_BY_KIND[kind];
  if (id.startsWith(`${prefix}-`)) return;
  throw intentStateError(
    IntentErrorCode.ItemIdKindMismatch,
    `An item of kind '${kind}' must have an id starting with '${prefix}-'`,
    path,
  );
}
