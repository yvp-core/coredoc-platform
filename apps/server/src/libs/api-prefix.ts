/**
 * The one place the versioned API prefix is spelled out.
 *
 * `main.ts` passes it to `setGlobalPrefix` and `LicenseGuard` matches request
 * paths against it. Two hand-written copies of the same string would let the
 * guard silently stop gating the API the day the prefix changes, so this is a
 * dependency-free module both can import (spa-serving.ts owns ROOT_ROUTES — the
 * routes served OUTSIDE this prefix — and importing it from main.ts as well as
 * from a guard would drag SPA-serving code into the request path).
 */
export const API_PREFIX = '/api/v1';
