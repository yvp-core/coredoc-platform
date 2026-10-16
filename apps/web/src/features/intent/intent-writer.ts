/**
 * One write at a time, each under its attempt's idempotency key.
 *
 * Every intent write surface used to carry the same two pieces by hand — a
 * `writeInFlight` ref and an {@link IntentAttemptKeys} — threaded through props
 * as mutable refs. {@link IntentWriter} owns both, so a caller only says which
 * form it writes from, with what input, and how to send it.
 *
 * The latch is a plain field, not React state: two clicks dispatched in the same
 * frame would both read a stale `false` from state, and two writes is exactly the
 * defect being closed. Callers that show their own busy state check {@link
 * IntentWriter.busy} first; the check and the latch run in the same tick.
 */

import { useState } from 'react';
import { IntentAttemptKeys, type IntentWriteForm } from '@coredoc/core/browser/intent-attempt-keys';

/** {@link IntentWriter.run} was refused because another write holds the latch. */
export class IntentWriteBusyError extends Error {
  constructor() {
    super('Another write is still running.');
    this.name = 'IntentWriteBusyError';
  }
}

export class IntentWriter {
  private inFlight = false;

  constructor(private readonly keys: IntentAttemptKeys = new IntentAttemptKeys()) {}

  /** A write (or an {@link exclusive} section) is running. */
  get busy(): boolean {
    return this.inFlight;
  }

  /**
   * Hold the latch for `section`. Throws {@link IntentWriteBusyError} without
   * calling it when the latch is taken.
   */
  async exclusive<R>(section: () => Promise<R>): Promise<R> {
    if (this.inFlight) throw new IntentWriteBusyError();
    this.inFlight = true;
    try {
      return await section();
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Send one keyed write while the caller already holds the latch (a batch loop
   * inside {@link exclusive}). The SAME key goes out for a repeated attempt with
   * the same input; it is settled only once the write lands, so a retry after a
   * failure replays rather than writing twice.
   */
  async send<T extends object, R>(
    form: IntentWriteForm,
    input: T,
    write: (body: T & { idempotencyKey: string }) => Promise<R>,
  ): Promise<R> {
    const result = await write({ ...input, idempotencyKey: this.keys.keyFor(form, input) });
    this.keys.settle(form);
    return result;
  }

  /** {@link send} under the latch: one write, at most one in flight. */
  run<T extends object, R>(
    form: IntentWriteForm,
    input: T,
    write: (body: T & { idempotencyKey: string }) => Promise<R>,
  ): Promise<R> {
    return this.exclusive(() => this.send(form, input, write));
  }

  /** Forget the pending attempt for `form`: the next write from it starts fresh. */
  reset(form: IntentWriteForm): void {
    this.keys.settle(form);
  }
}

/** One writer for the component's lifetime; share it to share the latch. */
export function useIntentWriter(): IntentWriter {
  const [writer] = useState(() => new IntentWriter());
  return writer;
}
