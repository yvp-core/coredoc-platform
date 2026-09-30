/**
 * UUID predicates, replacing class-validator's `isUUID` when Track B3 retired that dependency
 * (`.scratch/server-structure-cleanup/spec.md`). Same acceptance: any RFC-4122 variant for
 * `isUuid`, version 4 only for `isUuidV4`, case-insensitive, no nil-UUID exception.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}
