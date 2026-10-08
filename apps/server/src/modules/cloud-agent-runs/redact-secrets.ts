/**
 * The server-owned secret-pattern list for run events: common credential
 * shapes are masked before an event is stored, so the run page does not show
 * a credential the agent read. It starts from the intent module's secret
 * pattern. The runner also masks the exact values it holds; what neither
 * catches can still reach the run page (SF-001, Limitations and risks).
 */

const MASK = '[REDACTED]';

/** Credential names whose assigned value is masked (`password=…`, `"api_key": "…"`). */
const SECRET_NAME =
  '[A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)';

/** Each pattern is replaced whole, or keeps the groups named in its replacement. */
const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // Credentials in a URL's user-info part.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bcdt_[A-Za-z0-9]{16,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, `$1${MASK}`],
  // `NAME = value`, `NAME: value`, `"name": "value"`; the value runs to a quote, whitespace or separator.
  [new RegExp(`(\\b${SECRET_NAME}["']?\\s*[:=]\\s*["']?)[^\\s"',;]+`, 'gi'), `$1${MASK}`],
];

export function redactSecrets(text: string): string {
  let redacted = text;
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
