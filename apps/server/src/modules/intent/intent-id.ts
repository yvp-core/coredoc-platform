/**
 * Deterministic intent item ids (spec §4.4, BR-16/BR-17), derived by core's
 * `deriveIntentId`; this module turns its refusals into §12 public errors and
 * adds the server-only helpers around it.
 */
import {
  INTENT_ID_MAX_LENGTH,
  INTENT_ID_PREFIX_BY_KIND,
  IntentIdDerivationError,
  IntentIdDerivationErrorCode,
  deriveIntentId,
  type IntentKind,
} from '@coredoc/core';
import { intentStateError } from './intent-state-errors.js';
import { IntentErrorCode } from './contract/index.js';

/**
 * Longest id-suffix marker the derivation can append (`-9999`). The scan
 * prefix below is shortened by it so that every collision variant of a title is
 * still covered by one `startsWith` query.
 */
const MAX_SUFFIX_MARKER_CHARS = 5;

/**
 * The shortest string every possible derivation of `(kind, title)` starts with:
 * `<prefix>-<first slug word>`, cut short by the longest collision marker,
 * because a suffix rebuild shortens the base. Bounds the "ids already taken"
 * lookup to one indexed prefix scan.
 */
export function intentIdScanPrefix(kind: IntentKind, title: string): string | null {
  const first = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((word) => word.length > 0);
  if (first === undefined) return null;
  return `${INTENT_ID_PREFIX_BY_KIND[kind]}-${first}`.slice(0, INTENT_ID_MAX_LENGTH - MAX_SUFFIX_MARKER_CHARS);
}

/** Derive the durable slug id of a new item from its title, refusing as a §12 error. */
export function deriveIntentItemId(
  kind: IntentKind,
  title: string,
  takenIds: Iterable<string>,
  path: string[] = ['title'],
): string {
  try {
    return deriveIntentId(kind, title, takenIds);
  } catch (error) {
    if (!(error instanceof IntentIdDerivationError)) throw error;
    const prefix = INTENT_ID_PREFIX_BY_KIND[kind];
    throw error.code === IntentIdDerivationErrorCode.UnderivableItemId
      ? intentStateError(
          IntentErrorCode.UnderivableItemId,
          `No intent id can be derived from this title: it carries no a-z0-9 characters. Supply an explicit '${prefix}-<slug>' id.`,
          path,
        )
      : intentStateError(
          IntentErrorCode.IdWouldTruncate,
          `This title is too long for an intent id: it would be shortened to '${error.shortenedId}'. Supply a shorter title or an explicit '${prefix}-<slug>' id.`,
          path,
        );
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
