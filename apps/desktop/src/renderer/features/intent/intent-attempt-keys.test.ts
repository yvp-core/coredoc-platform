import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntentAttemptKeys, IntentWriteForm } from './intent-attempt-keys';

// The module imports intent-api for the default key minter; the bridge is fully
// mocked and unused here (no real IPC in renderer tests — repo rule).
beforeEach(() => {
  (globalThis as { window?: unknown }).window = { electronAPI: {} };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** A counting minter, so "same key" and "new key" are exact assertions. */
function counting(): { keys: IntentAttemptKeys; minted: () => number } {
  let n = 0;
  const keys = new IntentAttemptKeys(() => `key-${++n}`);
  return { keys, minted: () => n };
}

describe('IntentAttemptKeys', () => {
  it('reuses one key while the attempt is unchanged — a double-click is one write', () => {
    // The defect this closes: every click minted a new key, so the ledger (which
    // dedupes on key + request hash) applied a double-click twice.
    const { keys, minted } = counting();
    const input = { id: 'payments', title: 'Payments' };

    expect(keys.keyFor(IntentWriteForm.CreateDomain, input)).toBe('key-1');
    expect(keys.keyFor(IntentWriteForm.CreateDomain, { ...input })).toBe('key-1');
    expect(minted()).toBe(1);
  });

  it('mints a new key once the input changes — a corrected write is a new attempt', () => {
    // Replaying a corrected body under the old key returns
    // idempotency_request_conflict, so reuse must be content-bound.
    const { keys } = counting();

    expect(keys.keyFor(IntentWriteForm.CreateDomain, { id: 'payments' })).toBe('key-1');
    expect(keys.keyFor(IntentWriteForm.CreateDomain, { id: 'payment' })).toBe('key-2');
    expect(keys.keyFor(IntentWriteForm.CreateDomain, { id: 'payment' })).toBe('key-2');
  });

  it('starts a new attempt after the write settles', () => {
    const { keys } = counting();
    const input = { id: 'refunds', archived: true };

    expect(keys.keyFor(IntentWriteForm.ArchiveFeature, input)).toBe('key-1');
    keys.settle(IntentWriteForm.ArchiveFeature);
    expect(keys.keyFor(IntentWriteForm.ArchiveFeature, input)).toBe('key-2');
  });

  it('keeps forms independent — two surfaces never share an attempt', () => {
    const { keys } = counting();
    const input = { id: 'payments' };

    expect(keys.keyFor(IntentWriteForm.CreateDomain, input)).toBe('key-1');
    expect(keys.keyFor(IntentWriteForm.RenameDomain, input)).toBe('key-2');
    expect(keys.keyFor(IntentWriteForm.CreateDomain, input)).toBe('key-1');
  });

  it('mints fresh every time for an input it cannot fingerprint', () => {
    // An unknown fingerprint must never compare equal: merging two different
    // writes into one attempt is the failure that matters.
    const { keys } = counting();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(keys.keyFor(IntentWriteForm.AddSeed, cyclic)).toBe('key-1');
    expect(keys.keyFor(IntentWriteForm.AddSeed, cyclic)).toBe('key-2');
  });

  it('defaults to a real unique minter', () => {
    const keys = new IntentAttemptKeys();
    const first = keys.keyFor(IntentWriteForm.ReviewBatch, { a: 1 });
    keys.settle(IntentWriteForm.ReviewBatch);
    const second = keys.keyFor(IntentWriteForm.ReviewBatch, { a: 1 });

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(8);
  });
});
