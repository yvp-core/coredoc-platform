/**
 * Rails-style inflector — pure string functions, no framework state. Generic English
 * rules only (no irregular dictionary, no client-specific terms). Covers the common
 * ActiveRecord conventions: PascalCase <-> snake_case, naive pluralize/singularize, and
 * `classify` (table name -> model constant). Best-effort: a handful of irregulars
 * (person/people, child/children) are out of scope and acceptable to miss.
 */

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
/** Suffixes that take `+es` when pluralizing (and drop `es` when singularizing). */
const SIBILANTS = ['s', 'x', 'z', 'ch', 'sh'];

/**
 * Common English irregular singular→plural pairs (generic, not client-specific). `Map`s, not object
 * literals: the key is a word taken from source (a model constant, a table name), and a plain
 * object answers `constructor` / `toString` from `Object.prototype` — so `pluralize('constructor')`
 * returned a Function where a table name was expected.
 */
const IRREGULAR_PLURALS = new Map<string, string>([
  ['person', 'people'],
  ['child', 'children'],
  ['man', 'men'],
  ['woman', 'women'],
  ['foot', 'feet'],
  ['tooth', 'teeth'],
  ['mouse', 'mice'],
  ['goose', 'geese'],
]);
const IRREGULAR_SINGULARS = new Map<string, string>([...IRREGULAR_PLURALS].map(([s, p]) => [p, s]));

/**
 * `'UserProfile'` -> `'user_profile'`, `'HTTPServer'` -> `'http_server'` (best-effort).
 * Inserts an underscore before a capital that starts a new word: at a lower→upper
 * boundary, and at the last capital of an acronym run that is followed by a lowercase
 * (`HTTPServer` -> `HTTP|Server`). Already-snake input passes through unchanged.
 */
export function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // userProfile -> user_Profile
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // HTTPServer -> HTTP_Server
    .toLowerCase()
    .replace(/^_+/, '');
}

/** Capitalize the first letter of a word, leaving the rest as-is. */
function upperFirst(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

/** snake_case -> PascalCase (`user_profile` -> `UserProfile`). */
function pascalCase(s: string): string {
  return s.split('_').filter(Boolean).map(upperFirst).join('');
}

/** Split a snake_case identifier into [leading, lastWord]; lastWord is the inflected unit. */
function splitLastWord(s: string): { lead: string; word: string } {
  const idx = s.lastIndexOf('_');
  if (idx === -1) return { lead: '', word: s };
  return { lead: s.slice(0, idx + 1), word: s.slice(idx + 1) };
}

/** Pluralize a single word with naive English rules. */
function pluralizeWord(w: string): string {
  if (w.length === 0) return w;
  const irregularPlural = IRREGULAR_PLURALS.get(w);
  if (irregularPlural) return irregularPlural;
  const last = w[w.length - 1];
  const prev = w[w.length - 2];
  // y after a consonant -> ies; after a vowel -> stays (just +s below).
  if (last === 'y' && prev !== undefined && !VOWELS.has(prev)) {
    return `${w.slice(0, -1)}ies`;
  }
  for (const suf of SIBILANTS) {
    if (w.endsWith(suf)) return `${w}es`;
  }
  return `${w}s`;
}

/** Singularize a single word with naive English rules. */
function singularizeWord(w: string): string {
  const irregularSingular = IRREGULAR_SINGULARS.get(w);
  if (irregularSingular) return irregularSingular;
  if (w.endsWith('ies') && w.length > 3) return `${w.slice(0, -3)}y`;
  for (const suf of SIBILANTS) {
    if (w.endsWith(`${suf}es`)) return w.slice(0, -2);
  }
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * Pluralize a snake_case identifier or bare word. Only the final word is inflected:
 * `'company'` -> `'companies'`, `'holiday'` -> `'holidays'`, `'address'` -> `'addresses'`,
 * `'user_profile'` -> `'user_profiles'`.
 */
export function pluralize(s: string): string {
  const { lead, word } = splitLastWord(s);
  return lead + pluralizeWord(word);
}

/**
 * Singularize a snake_case identifier or bare word. Only the final word is inflected:
 * `'employees'` -> `'employee'`, `'companies'` -> `'company'`, `'user_profiles'` -> `'user_profile'`.
 */
export function singularize(s: string): string {
  const { lead, word } = splitLastWord(s);
  return lead + singularizeWord(word);
}

/**
 * Table name -> model constant: `'user_profiles'` -> `'UserProfile'`, `'employees'` -> `'Employee'`.
 * Singularizes the final word, then PascalCases.
 */
export function classify(s: string): string {
  return pascalCase(singularize(s));
}
