/**
 * The server-owned secret-pattern list for run events: common credential
 * shapes are masked before an event is stored, so the run page does not show
 * a credential the agent read. It starts from the intent module's secret
 * pattern. The runner also masks the exact values it holds; what neither
 * catches can still reach the run page (SF-001, Limitations and risks).
 *
 * The text is runner-supplied, so every pattern must run in linear time on
 * hostile input: each quantifier is bounded, private-key blocks are found with
 * indexOf, and each string is cut to the largest event payload first.
 */

const MASK = '[REDACTED]';

/** No stored event payload is larger (a withheld workflow diff); the rest would be cut anyway. */
export const MAX_REDACTED_CHARS = 64 * 1024;

/** Credential names whose assigned value is masked (`password=…`, `"api_key": "…"`). */
const SECRET_NAME =
  '[A-Za-z0-9_.-]{0,64}(?:password|passwd|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)';

/** Each pattern is replaced whole, or keeps the groups named in its replacement. */
const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Credentials in a URL's user-info part.
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/gi, `$1${MASK}@`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,255}/g, MASK],
  [/\bcdt_[A-Za-z0-9]{16,255}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,255}/g, MASK],
  // A JWT: the header always starts with `eyJ`. Segments are bounded, so hostile runs cost O(length × bound).
  [/\beyJ[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,1024}/g, MASK],
  [/\b(Bearer[ \t]{1,16})[A-Za-z0-9._~+/-]{1,1024}={0,4}/g, `$1${MASK}`],
  // `NAME = value`, `NAME: value`, `"name": "value"`; the value runs to a quote, whitespace or separator.
  [new RegExp(`(\\b${SECRET_NAME}["']?[ \\t]{0,16}[:=][ \\t]{0,16}["']?)[^\\s"',;]{1,512}`, 'gi'), `$1${MASK}`],
];

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/y;
const PRIVATE_KEY_END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/y;

/** The index where a marker found by `sticky` starts at or after `from`, and where it ends; null if none. */
function findMarker(text: string, prefix: string, sticky: RegExp, from: number): [number, number] | null {
  for (let at = text.indexOf(prefix, from); at !== -1; at = text.indexOf(prefix, at + 1)) {
    sticky.lastIndex = at;
    if (sticky.test(text)) return [at, sticky.lastIndex];
  }
  return null;
}

/** Masks each private-key block; a block without its end marker is masked to the end of the text. */
function maskPrivateKeys(text: string): string {
  let result = '';
  let from = 0;
  for (;;) {
    const begin = findMarker(text, '-----BEGIN ', PRIVATE_KEY_BEGIN, from);
    if (!begin) return result + text.slice(from);
    const end = findMarker(text, '-----END ', PRIVATE_KEY_END, begin[1]);
    result += text.slice(from, begin[0]) + MASK;
    if (!end) return result;
    from = end[1];
  }
}

export function redactSecrets(text: string): string {
  let redacted = maskPrivateKeys(text.length > MAX_REDACTED_CHARS ? text.slice(0, MAX_REDACTED_CHARS) : text);
  for (const [pattern, replacement] of PATTERNS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

/** Masks every string value in an event payload; keys, numbers and booleans are kept. */
export function redactPayload<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactPayload(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPayload(item)])) as T;
  }
  return value;
}
