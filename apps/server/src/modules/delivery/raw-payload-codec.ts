/**
 * Raw-payload codec — gzip-at-rest for delivery_raw_payloads.
 *
 * Connector payloads (Jira issues, GitHub PRs + sub-resources) are stored gzipped
 * as `{ z: "<base64>" }` in the `payload` Json column. Compression is transparent to
 * every downstream stage (only `renormalize` reads raw), typically shrinks the
 * envelope ~5-10x, and is what keeps the audit trail affordable at SaaS scale.
 *
 * The truncation cap is applied to the UNCOMPRESSED envelope (unchanged from before
 * gzip): a record whose serialized full envelope exceeds it keeps only a caller-supplied
 * minimal issue/PR identity envelope with `truncated: true`, so a
 * pathological single record can never dominate the table. gzip is purely the storage
 * form of whatever survives that cap.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

/** Max UNCOMPRESSED serialized raw-payload size (chars) before it truncates to the envelope. */
export const RAW_PAYLOAD_MAX_BYTES = 262_144;

type Json = Record<string, unknown>;

/**
 * Compress a raw-payload envelope for storage. Returns the stored `{ z }` shape and the
 * truncation flag: when the full envelope's serialized size exceeds the cap, `minimal`
 * is stored instead (gzipped) and `truncated` is true.
 */
export function packRawPayload(full: Json, minimal: Json): { payload: Json; truncated: boolean } {
  const raw = JSON.stringify(full);
  const truncated = raw.length > RAW_PAYLOAD_MAX_BYTES;
  const buf = gzipSync(Buffer.from(truncated ? JSON.stringify(minimal) : raw, 'utf8'));
  return { payload: { z: buf.toString('base64') }, truncated };
}

/**
 * Inverse of {@link packRawPayload}. Back-compatible: legacy uncompressed rows (a plain
 * envelope object with no `z` key, written before gzip-at-rest) are returned as-is, so
 * `renormalize` reads old and new rows uniformly.
 */
export function unpackRawPayload(stored: unknown): Json {
  if (stored && typeof stored === 'object' && typeof (stored as Json).z === 'string') {
    return JSON.parse(gunzipSync(Buffer.from((stored as { z: string }).z, 'base64')).toString('utf8')) as Json;
  }
  return stored && typeof stored === 'object' ? (stored as Json) : {};
}
