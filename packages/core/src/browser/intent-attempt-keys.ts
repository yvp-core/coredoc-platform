/**
 * Idempotency keys, one per logical write ATTEMPT.
 *
 * THE DEFECT THIS CLOSES: every tree control minted a fresh key at click time,
 * so a double-click sent two different keys for the same intended write and the
 * ledger — which dedupes on `(key, request hash)` — applied both. Two domains,
 * two seeds, two archives.
 *
 * THE RULE, and why it is not just "mint once and keep it": the ledger answers a
 * replay of the SAME key with a DIFFERENT body as `idempotency_request_conflict`.
 * So the key is bound to the attempt's content, not merely to the form:
 *
 * - press again with the same input (a retry after a transport error, or a
 *   double-click) → the same key → the server replays its own first answer;
 * - correct the input and press again → a different attempt → a fresh key, no
 *   request conflict;
 * - after the write lands, {@link IntentAttemptKeys.settle} drops it, so the
 *   next write from the same form is a new attempt.
 *
 * Pure and DOM-free so all of that is pinned by unit tests.
 */

/**
 * Mint one idempotency key. Callers do not call this per click — they go through
 * {@link IntentAttemptKeys}, which reuses a key while the attempt's content is
 * unchanged (so a double-click or a retry replays instead of writing twice) and
 * mints a new one once the input changes, because the ledger keys on
 * `(key, request hash)` and a corrected body under the old key comes back as
 * `idempotency_request_conflict`.
 */
export function newIntentIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `intent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The write surfaces that each own an attempt. One in flight per form at a time. */
export enum IntentWriteForm {
  CreateDomain = 'create-domain',
  CreateFeature = 'create-feature',
  RenameDomain = 'rename-domain',
  RenameFeature = 'rename-feature',
  ArchiveDomain = 'archive-domain',
  ArchiveFeature = 'archive-feature',
  DeleteDomain = 'delete-domain',
  DeleteFeature = 'delete-feature',
  AddSeed = 'add-seed',
  RemoveSeed = 'remove-seed',
  /** One anchor's baseline re-capture; the attempt's input is the anchor itself. */
  RefreshAnchor = 'refresh-anchor',
  ReviewBatch = 'review-batch',
  AddComment = 'add-comment',
  ReplyComment = 'reply-comment',
  CommentStatus = 'comment-status',
  /** One release-ledger record (delivery, baseline, rollback or a plan change) from a prepared dialog. */
  Release = 'release',
}

/**
 * The attempt's content, as a comparable string. An input that cannot be
 * serialized yields `null`, which forces a fresh key: mistaking two different
 * writes for one attempt is the failure that matters here, so an unknown
 * fingerprint must never compare equal.
 */
function fingerprint(input: unknown): string | null {
  try {
    return JSON.stringify(input) ?? null;
  } catch {
    return null;
  }
}

export class IntentAttemptKeys {
  private readonly attempts = new Map<IntentWriteForm, { fingerprint: string; key: string }>();

  constructor(private readonly mint: () => string = newIntentIdempotencyKey) {}

  /** The key for this attempt: the pending one when the input is unchanged, a fresh one otherwise. */
  keyFor(form: IntentWriteForm, input: unknown): string {
    const current = fingerprint(input);
    const pending = this.attempts.get(form);
    if (pending !== undefined && current !== null && pending.fingerprint === current) return pending.key;
    const key = this.mint();
    if (current !== null) this.attempts.set(form, { fingerprint: current, key });
    else this.attempts.delete(form);
    return key;
  }

  /** The attempt landed — the next write from this form starts a new one. */
  settle(form: IntentWriteForm): void {
    this.attempts.delete(form);
  }
}
