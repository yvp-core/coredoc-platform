/** Deterministic intent item ids (BR-16/BR-17). */
import { INTENT_ID_MAX_LENGTH, INTENT_ID_PREFIX_BY_KIND, type IntentKind } from './types.js';

export enum IntentIdDerivationErrorCode {
  /** No slug could be derived from the title and no id was supplied. */
  UnderivableItemId = 'underivable_item_id',
  /** The title's slug does not fit the id cap, so the derived id would drop words. */
  IdWouldTruncate = 'id_would_truncate',
}

export class IntentIdDerivationError extends Error {
  constructor(
    readonly code: IntentIdDerivationErrorCode,
    message: string,
    /** For `IdWouldTruncate`: the stub id the title would have been cut to. */
    readonly shortenedId?: string,
  ) {
    super(message);
    this.name = 'IntentIdDerivationError';
  }
}

/**
 * Derive the durable slug id of a new item from its title (BR-17 / AC-15).
 *
 * Pure and deterministic: the same `(kind, title, takenIds)` always yields the
 * same id. The title is lowercased and split into `a-z0-9` words, the kind's
 * fixed prefix is prepended, the result is truncated at a WORD boundary to
 * {@link INTENT_ID_MAX_LENGTH}, and a collision takes the first free `-2`,
 * `-3`, … suffix rather than overwriting anything.
 *
 * Throws when the title has no `a-z0-9` content at all (inventing an id there
 * would produce an unsearchable identity, which is the whole reason slugs
 * replaced numeric ids), and when its slug does not FIT the cap: a shortened id
 * is a stub the item would carry forever.
 */
export function deriveIntentId(kind: IntentKind, title: string, takenIds: Iterable<string>): string {
  const prefix = INTENT_ID_PREFIX_BY_KIND[kind];
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    throw new IntentIdDerivationError(
      IntentIdDerivationErrorCode.UnderivableItemId,
      `no intent id can be derived from title '${title}': it carries no a-z0-9 characters; supply an explicit '${prefix}-<slug>' id`,
    );
  }

  const taken = new Set(takenIds);
  const base = boundedSlugId(prefix, words, INTENT_ID_MAX_LENGTH);
  // A base that does not carry EVERY slug word is a stub, and ids are immutable:
  // an accepted item would keep it forever, so the item is refused instead of
  // written. Dropping words is not a safe shortening — `-are-not` carries the
  // rule's polarity. The collision rebuild below is exempt: shortening there is
  // the price of a distinct id for a title that already derived cleanly.
  if (base !== `${prefix}-${words.join('-')}`) {
    throw new IntentIdDerivationError(
      IntentIdDerivationErrorCode.IdWouldTruncate,
      `title '${title}' does not fit an intent id: its slug is longer than ${INTENT_ID_MAX_LENGTH} characters, so the ` +
        `id would be shortened to '${base}' and lose words; supply a shorter title or an explicit '${prefix}-<slug>' id`,
      base,
    );
  }
  if (!taken.has(base)) return base;

  // The suffix must fit INSIDE the cap, so the base is rebuilt against the
  // room the suffix leaves rather than appended to a full-length id.
  for (let suffix = 2; ; suffix++) {
    const marker = `-${suffix}`;
    const candidate = `${boundedSlugId(prefix, words, INTENT_ID_MAX_LENGTH - marker.length)}${marker}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * `<prefix>-<word>[-<word>…]` bounded by `max`, cut at a word boundary.
 *
 * The first word is never dropped — an id must carry at least one slug word
 * beyond its prefix (BR-16) — so a single over-long word is hard-sliced rather
 * than removed.
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
