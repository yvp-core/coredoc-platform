import { describe, expect, it } from 'vitest';
import { IntentAttemptKeys, IntentWriteForm } from '@coredoc/core/browser/intent-attempt-keys';
import { IntentWriteBusyError, IntentWriter } from './intent-writer.js';

const counter = () => {
  let n = 0;
  return new IntentWriter(new IntentAttemptKeys(() => `key-${++n}`));
};

describe('IntentWriter', () => {
  it('refuses a second write while one is in flight', async () => {
    const writer = counter();
    let release: () => void = () => undefined;
    const first = writer.run(IntentWriteForm.CreateDomain, { id: 'a' }, () => new Promise<void>((r) => (release = r)));
    expect(writer.busy).toBe(true);
    await expect(writer.run(IntentWriteForm.CreateDomain, { id: 'b' }, async () => undefined)).rejects.toBeInstanceOf(
      IntentWriteBusyError,
    );
    release();
    await first;
    expect(writer.busy).toBe(false);
  });

  it('replays the same key after a failure and mints a new one once the write lands', async () => {
    const writer = counter();
    const keys: string[] = [];
    const fail = (body: { idempotencyKey: string }) => {
      keys.push(body.idempotencyKey);
      return Promise.reject(new Error('Connection lost'));
    };
    const land = async (body: { idempotencyKey: string }) => {
      keys.push(body.idempotencyKey);
    };
    await expect(writer.run(IntentWriteForm.AddSeed, { id: 'a' }, fail)).rejects.toThrow('Connection lost');
    expect(writer.busy).toBe(false);
    await writer.run(IntentWriteForm.AddSeed, { id: 'a' }, land);
    await writer.run(IntentWriteForm.AddSeed, { id: 'a' }, land);
    expect(keys).toEqual(['key-1', 'key-1', 'key-2']);
  });

  it('gives a corrected input, or a reset form, a new attempt', async () => {
    const writer = counter();
    const keys: string[] = [];
    const fail = (body: { idempotencyKey: string }) => {
      keys.push(body.idempotencyKey);
      return Promise.reject(new Error('refused'));
    };
    await writer.run(IntentWriteForm.Release, { reason: 'a' }, fail).catch(() => undefined);
    await writer.run(IntentWriteForm.Release, { reason: 'b' }, fail).catch(() => undefined);
    writer.reset(IntentWriteForm.Release);
    await writer.run(IntentWriteForm.Release, { reason: 'b' }, fail).catch(() => undefined);
    expect(keys).toEqual(['key-1', 'key-2', 'key-3']);
  });
});
