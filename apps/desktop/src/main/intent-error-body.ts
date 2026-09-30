/**
 * Recovery of the intent module's structured error body from a failed HTTP
 * response (spec §12).
 *
 * Its own module, with no imports, so it stays testable without dragging in
 * `server-api.ts` → `auth-manager.ts`, which reads Electron's `app.getPath` at
 * module load.
 */

import type { IntentErrorDetail, IntentErrorEnvelope } from '../shared/intent-types.js';

/** A wire string, or `''` when the field is absent or of another type. */
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A wire path, always an array — non-string segments are dropped, not rendered. */
const asPath = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * Normalize the `details` list into TOTAL entries.
 *
 * THE CRASH THIS CLOSES: the list used to be forwarded verbatim whenever it was
 * an array, so an entry that omitted `path` — legal on the wire, the type here
 * is only a promise — reached the renderer, which calls `detail.path.join('.')`
 * and threw inside render. A malformed error body must never be able to take the
 * window down, so every entry leaves this module with all three fields present.
 *
 * Entries carrying neither a code nor a message say nothing and are dropped
 * rather than rendered as an empty row.
 */
function normalizeDetails(value: unknown): IntentErrorDetail[] {
  if (!Array.isArray(value)) return [];
  const entries: IntentErrorDetail[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const partial = entry as Partial<IntentErrorDetail>;
    const code = asString(partial.code);
    const message = asString(partial.message);
    if (code === '' && message === '') continue;
    entries.push({ code, message, path: asPath(partial.path) });
  }
  return entries;
}

/**
 * Only a body that actually carries the contract's `code` + `message` is
 * accepted; anything else (an HTML proxy page, a plain Nest error, a scalar)
 * yields `undefined` and the caller falls back to the transport message.
 * Guessing a shape here would put invented field paths in front of a reviewer.
 *
 * Everything the parser DOES accept, it makes total: `path` is always an array
 * and every `details` entry carries all three fields, because the renderer joins
 * those paths while rendering and a missing one crashed it (spec §12 surfaces
 * the body verbatim — verbatim must still be a shape).
 */
export function parseIntentError(body: string): IntentErrorEnvelope | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const candidate = parsed as Partial<IntentErrorEnvelope>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return undefined;
  const details = normalizeDetails(candidate.details);
  return {
    statusCode: typeof candidate.statusCode === 'number' ? candidate.statusCode : 0,
    timestamp: typeof candidate.timestamp === 'string' ? candidate.timestamp : '',
    ...(typeof candidate.requestPath === 'string' ? { requestPath: candidate.requestPath } : {}),
    code: candidate.code,
    message: candidate.message,
    path: asPath(candidate.path),
    ...(details.length > 0 ? { details } : {}),
  };
}
