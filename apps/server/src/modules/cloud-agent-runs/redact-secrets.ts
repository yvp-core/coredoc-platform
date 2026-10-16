/**
 * The text is runner-supplied, so every pattern must run in linear time on
 * hostile input and mask a secret whole: a repetition is bounded only where a
 * required literal follows it, so a secret's own run is never cut short;
 * private-key blocks and JWTs are found without regex backtracking.
 */

const MASK = '[REDACTED]';

/** The largest stored event payload (a withheld workflow diff). */
export const MAX_REDACTED_CHARS = 64 * 1024;

/** Matched without a word boundary, so `DB_PASSWORD` is caught by its suffix. */
const SECRET_NAME =
  '(?:password|passwd|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key)';

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // URL user-info: the scheme is bounded because `://` follows it, and user-info runs cannot overlap.
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

function findMarker(text: string, prefix: string, sticky: RegExp, from: number): [number, number] | null {
  for (let at = text.indexOf(prefix, from); at !== -1; at = text.indexOf(prefix, at + 1)) {
    sticky.lastIndex = at;
    if (sticky.test(text)) return [at, sticky.lastIndex];
  }
  return null;
}

/** A block without its end marker is masked to the end of the text. */
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

const TOKEN_RUN = /[A-Za-z0-9_.-]+/g;

/** Splits the run on its dots so each segment is read once. */
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

const SECRET_KEY = new RegExp(`${SECRET_NAME}$`, 'i');

/** Decoded `{"password": "…"}` is two strings the `name: value` pattern no longer sees together. */
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

export function redactPayload<T>(value: T): T {
  return redactStrings(value, redactSecrets);
}

const CUT_LOOKBACK = 8 * 1024;
const TOKEN_CHAR = /[A-Za-z0-9_.~+/=-]/;
/** Where a secret can begin inside an unbroken token run; URL user-info and `Bearer` cannot occur in one. */
const SECRET_START = new RegExp(`(?:gh[pousr]_|github_pat_|sk-|cdt_|AKIA|ASIA|xox[abprs]-|${SECRET_NAME})`, 'gi');

/** Only private-key blocks span a newline, and those are masked over the whole text first. */
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

/** Masks text of any length without cutting it, window by window on boundaries no pattern crosses. */
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

/** A JSON line is masked string by string after decoding, so an escaped newline cannot hide a token. */
export function redactTranscriptLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return redactLongText(line);
  }
  return JSON.stringify(redactStrings(parsed, redactLongText));
}
