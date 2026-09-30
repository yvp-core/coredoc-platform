import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { packRawPayload, unpackRawPayload, RAW_PAYLOAD_MAX_BYTES } from './raw-payload-codec.js';

describe('raw-payload-codec', () => {
  it('round-trips a full envelope through pack/unpack', () => {
    const full = { pr: { number: 5, title: 'x' }, files: [{ filename: 'a.ts' }], repo: 'o/r' };
    const { payload, truncated } = packRawPayload(full, { pr: full.pr });
    expect(truncated).toBe(false);
    expect(Object.keys(payload)).toEqual(['z']); // stored gzipped, not as the plain envelope
    expect(unpackRawPayload(payload)).toEqual(full);
  });

  it('stores gzipped — the persisted blob is smaller than the raw JSON for real payloads', () => {
    const full = { pr: { body: 'the quick brown fox '.repeat(500) }, files: [] };
    const { payload } = packRawPayload(full, { pr: {} });
    const stored = Buffer.byteLength((payload as { z: string }).z, 'base64');
    expect(stored).toBeLessThan(JSON.stringify(full).length);
  });

  it('truncates to the minimal envelope when the full envelope exceeds the cap', () => {
    const big = 'x'.repeat(RAW_PAYLOAD_MAX_BYTES + 1);
    const full = { issue: { key: 'PROD-1' }, extraChangelog: [{ blob: big }] };
    const { payload, truncated } = packRawPayload(full, { issue: full.issue });
    expect(truncated).toBe(true);
    expect(unpackRawPayload(payload)).toEqual({ issue: { key: 'PROD-1' } });
  });

  it('reads legacy uncompressed rows unchanged (back-compat)', () => {
    const legacy = { pr: { number: 9 }, reviews: [], files: [], commits: [], repo: 'o/r' };
    expect(unpackRawPayload(legacy)).toEqual(legacy);
  });

  it('unpacks a hand-built gzip blob (format is plain gzip(JSON), base64)', () => {
    const obj = { issue: { key: 'PROD-7' } };
    const z = gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64');
    expect(unpackRawPayload({ z })).toEqual(obj);
  });

  it('degrades non-object / null payloads to an empty envelope', () => {
    expect(unpackRawPayload(null)).toEqual({});
    expect(unpackRawPayload('nope')).toEqual({});
    expect(unpackRawPayload(undefined)).toEqual({});
  });
});
