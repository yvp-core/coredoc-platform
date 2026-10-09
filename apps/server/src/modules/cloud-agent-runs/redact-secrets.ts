/**
 * The server-owned secret-pattern list for run events: common credential
 * shapes are masked before an event is stored, so the run page does not show
 * a credential the agent read. It starts from the intent module's secret
 * pattern. The runner also masks the exact values it holds; what neither
 * catches can still reach the run page, a documented limitation.
 *
 * The text is runner-supplied, so every pattern must run in linear time on
 * hostile input and must mask a secret whole, however long:
 * - a repetition is bounded only where a required literal follows it (a URL
 *   scheme before `://`, a private-key type before `PRIVATE KEY`); a
 *   secret's own run is unbounded, so its tail is never left behind;
 * - private-key blocks are found with indexOf and JWTs by splitting a token
 *   run on its dots, both linear;
 * - each string is cut to the largest event payload first, and a token run
 *   the cut splits is dropped with it.
 */

const MASK = '[REDACTED]';

/** No stored event payload is larger (a withheld workflow diff); the rest would be cut anyway. */
export const MAX_REDACTED_CHARS = 64 * 1024;

/**
 * Credential names whose assigned value is masked (`DB_PASSWORD=…`,
 * `"api_key": "…"`). Matched without a word boundary, so a name of any
 * length is caught by its suffix; the name itself is kept.
 */
const SECRET_NAME =
  '(?:password|passwd|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key)';

/** Each pattern is replaced whole, or keeps the groups named in its replacement. */
const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Credentials in a URL's user-info part. The scheme is bounded (`://` follows it); user-info runs cannot
  // overlap, because each starts after `://` and stops at the next `/`.
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bcdt_[A-Za-z0-9]{16,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b(Bearer[ \t]{1,16})[A-Za-z0-9._~+/-]+=*/g, `$1${MASK}`],
  // `NAME = value`, `NAME: value`, `"name": "value"`; the value runs to a quote, whitespace or separator.
  [new RegExp(`(${SECRET_NAME}["']?[ \\t]{0,16}[:=][ \\t]{0,16}["']?)[^\\s"',;]+`, 'gi'), `$1${MASK}`],
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

/** A maximal run of JWT characters, dots included; it never backtracks. */
const TOKEN_RUN = /[A-Za-z0-9_.-]+/g;

/**
 * Masks JWTs (`eyJ…` header, payload, signature) inside one token run: the
 * run is split on its dots, so each segment is read once.
 */
function maskJwtsInRun(run: string): string {
  if (!run.includes('eyJ')) return run;
  const parts = run.split('.');
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const segment = parts[index]!;
    const at = jwtHeaderStart(segment);
    if (at !== -1 && (parts[index + 1]?.length ?? 0) >= 8 && (parts[index + 2]?.length ?? 0) >= 8) {
      out.push(segment.slice(0, at) + MASK);
      index += 2;
    } else {
      out.push(segment);
    }
  }
  return out.join('.');
}

/** Where a JWT header starts in a dot-free segment: `eyJ` at a word boundary with at least 8 more characters. */
function jwtHeaderStart(segment: string): number {
  for (let at = segment.indexOf('eyJ'); at !== -1; at = segment.indexOf('eyJ', at + 1)) {
    // Inside a segment only `-` ends a word; a later `eyJ` leaves a shorter header, so the first decides.
    if (at === 0 || segment[at - 1] === '-') return segment.length - at >= 11 ? at : -1;
  }
  return -1;
}

/** Cuts a string to the scan cap; a token run the cut splits is dropped whole, not stored half-unredacted. */
function capped(text: string): string {
  if (text.length <= MAX_REDACTED_CHARS) return text;
  let end = MAX_REDACTED_CHARS;
  while (end > 0 && !/\s/.test(text[end]!)) end -= 1;
  return text.slice(0, end);
}

export function redactSecrets(text: string): string {
  let redacted = maskPrivateKeys(capped(text)).replace(TOKEN_RUN, maskJwtsInRun);
  for (const [pattern, replacement] of PATTERNS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

/** A key that names a credential (`password`, `DB_PASSWORD`, `apiKey`): its value is masked whole. */
const SECRET_KEY = new RegExp(`${SECRET_NAME}$`, 'i');

/**
 * Masks each string, and the value of each key that names a credential: once
 * JSON is decoded, `{"password": "…"}` is two strings, which the
 * `name: value` pattern no longer sees together.
 */
function redactStrings<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) && ((typeof item === 'string' && item !== '') || typeof item === 'number')
          ? MASK
          : redactStrings(item, redact),
      ]),
    ) as T;
  }
  return value;
}

/** Masks every string value in an event payload; keys, numbers and booleans are kept. */
export function redactPayload<T>(value: T): T {
  return redactStrings(value, redactSecrets);
}

/** How far back from a window's end a cut is looked for. */
const CUT_LOOKBACK = 8 * 1024;
const TOKEN_CHAR = /[A-Za-z0-9_.~+/=-]/;
/**
 * Where a masked secret can begin inside an unbroken token run: a token
 * pattern's leading literal, or a credential name before its `=`. (URL
 * user-info and `Bearer` contain a character no token run does.)
 */
const SECRET_START = new RegExp(`(?:gh[pousr]_|github_pat_|sk-|cdt_|AKIA|ASIA|xox[abprs]-|${SECRET_NAME})`, 'gi');

/**
 * Where the window starting at `start` ends: after the last newline in its
 * tail, else after whitespace, else after a character no token contains. No
 * pattern but a private-key block spans a newline, and those are masked over
 * the whole text first.
 */
function windowEnd(text: string, start: number): number {
  const end = start + MAX_REDACTED_CHARS;
  if (end >= text.length) return text.length;
  const from = end - CUT_LOOKBACK;
  const newline = text.lastIndexOf('\n', end - 1);
  if (newline >= from) return newline + 1;
  for (let at = end - 1; at >= from; at -= 1) if (/\s/.test(text[at]!)) return at + 1;
  for (let at = end - 1; at >= from; at -= 1) if (!TOKEN_CHAR.test(text[at]!)) return at + 1;
  // One unbroken run: cut before the last place a secret could begin, so the secret stays in one window.
  let last = -1;
  for (const match of text.slice(from, end).matchAll(SECRET_START)) last = from + match.index;
  return last > start ? last : end;
}

/**
 * Masks text of any length without cutting it: private-key blocks over the
 * whole text, the other patterns window by window, each window ending on a
 * boundary no other pattern crosses. Linear, like redactSecrets.
 */
export function redactLongText(text: string): string {
  if (text.length <= MAX_REDACTED_CHARS) return redactSecrets(text);
  const masked = maskPrivateKeys(text);
  let redacted = '';
  for (let start = 0; start < masked.length; ) {
    const end = windowEnd(masked, start);
    redacted += redactSecrets(masked.slice(start, end));
    start = end;
  }
  return redacted;
}

/**
 * Masks one line of a Claude Code transcript (JSONL). A JSON line is masked
 * string by string after decoding, so an escaped newline before a token does
 * not hide it; anything else is masked as text. Nothing is cut.
 */
export function redactTranscriptLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return redactLongText(line);
  }
  return JSON.stringify(redactStrings(parsed, redactLongText));
}
