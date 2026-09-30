/**
 * Pure logic for the design-conformance checker.
 *
 * Everything here takes strings in and returns plain data — no fs, no process,
 * no console. The runnable script (design-conformance.mjs) does the I/O and the
 * reporting, and `--self-test` exercises these functions against embedded
 * fixtures so the checks are verified even when the real tree has no hits.
 */

const GRADIENT_FUNCTIONS = [
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
];

/** Color utilities Tailwind compiles to a single *-color declaration. */
export const COLOR_UTILITY_PREFIXES = ['bg', 'text', 'border', 'ring'];

/**
 * Figma variable name -> globals.css token name.
 *
 * Seeded from the literal values in globals.css (`Custom primitive colors`).
 * Names that already match a css token after normalization resolve
 * automatically, so this table only carries the ones Figma spells differently.
 * Edit freely — it is a lookup table, not logic.
 */
export const FIGMA_TOKEN_MAP = {
  // Primitives
  'Primitives/Selago/50': '--color-selago-50',
  'Primitives/Selago/100': '--color-selago-100',
  'Primitives/Dodger Blue/50': '--color-dodger-blue-50',
  'Primitives/Dodger Blue/100': '--color-dodger-blue-100',
  'Primitives/Dodger Blue/400': '--color-dodger-blue-400',
  'Primitives/Dodger Blue/500': '--color-dodger-blue-500',
  'Primitives/Lavender Magenta/400': '--color-lavender-magenta-400',
  'Primitives/Alto/50': '--color-alto-50',
  'Primitives/Alto/200': '--color-alto-200',
  'Primitives/Alto/300': '--color-alto-300',
  'Primitives/Gray/50': '--color-gray-50',
  'Primitives/Gray/100': '--color-gray-100',
  'Primitives/Gray/200': '--color-gray-200',
  'Primitives/Gray/300': '--color-gray-300',
  // Figma's zinc ramp (spelled "Zink") is deliberately NOT mapped: `@theme` defines
  // no `--color-zinc-*`, because Tailwind ships that palette and the semantic tokens
  // alias straight into it. Mapping the names would point at tokens that do not
  // exist. The consequence is visible in the report — every semantic token whose
  // value is `var(--color-zinc-N)` comes back UNVERIFIABLE, since resolving it needs
  // Tailwind's default palette, which this checker does not carry.

  // Semantic — content
  'Content/Primary/Default': '--color-content-primary',
  'Content/Secondary/Default': '--color-content-secondary',
  'Content/Tertiary/Default': '--color-content-tertiary',
  'Content/Quaternary/Default': '--color-content-quaternary',
  'Content/Quaternary/Disabled': '--color-content-quaternary-disabled',
  'Content/Inverted/Default': '--color-content-inverted',
  'Content/Brand/Default': '--color-content-brand',
  'Content/Action Primary/Default': '--color-content-action-primary',
  'Content/Action Secondary/Default': '--color-content-action-secondary',
  'Content/Tag Success/Default': '--color-content-tag-success',

  // Semantic — background
  'Background/Primary/Default': '--color-bg-primary',
  'Background/Tertiary/Default': '--color-bg-tertiary',
  'Background/Inverted/Default': '--color-bg-inverted',
  'Background/Action Primary/Default': '--color-bg-action-primary',
  'Background/Action Secondary/Default': '--color-bg-action-secondary',
  'Background/Tag Progress/Default': '--color-bg-tag-progress',

  // Semantic — border
  'Border/primary': '--color-border-primary',
  'Border/Primary/Selected': '--color-border-primary-selected',
  'Border/Secondary/Default': '--color-border-secondary',
  'Border/Input/Default': '--color-border-input',
  'Border/Inverted/Default': '--color-border-inverted',
  'Border/Action Primary/Default': '--color-border-action',
  'Border/Action Primary/Hover': '--color-border-action-hover',
};

function isGradientValue(value) {
  const v = value.trim().toLowerCase();
  return GRADIENT_FUNCTIONS.some((fn) => v.startsWith(`${fn}(`));
}

/**
 * Extract the `@theme { ... }` block. Returns '' when there is none.
 * Brace-counted rather than regex-matched so nested blocks cannot truncate it.
 */
function extractThemeBlock(css) {
  const start = css.indexOf('@theme');
  if (start === -1) return '';
  const open = css.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return css.slice(open + 1);
}

/**
 * Parse `--color-*` custom properties out of `@theme`.
 *
 * @returns {{ tokens: Map<string, {name: string, token: string, value: string, line: number, isGradient: boolean, resolvedFrom: string|null}>, definedUtilities: Set<string> }}
 *   `tokens` is keyed by the utility-facing name (`--color-bg-info` -> `bg-info`).
 *   `definedUtilities` holds `@utility` names and plain class selectors so the
 *   checker never flags a class the stylesheet defines by hand.
 */
export function parseTheme(css) {
  const block = extractThemeBlock(css);
  const themeStartLine = block ? css.slice(0, css.indexOf(block)).split('\n').length : 1;

  /** @type {Map<string, any>} */
  const byVar = new Map();
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(--color-[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(lines[i]);
    if (!match) continue;
    const [, cssVar, rawValue] = match;
    byVar.set(cssVar, {
      cssVar,
      name: cssVar.replace(/^--color-/, ''),
      value: rawValue.trim(),
      line: themeStartLine + i,
    });
  }

  // Resolve `var(--color-x)` chains inside the theme so an alias to a gradient
  // is classified as a gradient too.
  const tokens = new Map();
  for (const entry of byVar.values()) {
    let value = entry.value;
    let resolvedFrom = null;
    const seen = new Set([entry.cssVar]);
    for (let hop = 0; hop < 8; hop++) {
      const alias = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
      if (!alias) break;
      const next = byVar.get(alias[1]);
      if (!next || seen.has(alias[1])) break;
      seen.add(alias[1]);
      resolvedFrom = alias[1];
      value = next.value;
    }
    tokens.set(entry.name, {
      ...entry,
      resolvedValue: value,
      resolvedFrom,
      isGradient: isGradientValue(value),
    });
  }

  const definedUtilities = new Set();
  for (const m of css.matchAll(/@utility\s+([a-z0-9][\w-]*)/gi)) definedUtilities.add(m[1]);
  for (const m of css.matchAll(/^\.([a-z0-9][\w-]*)\s*(?:,|\{|:)/gim)) definedUtilities.add(m[1]);

  return { tokens, definedUtilities };
}

/** Escape a literal for use inside a RegExp. */
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * CHECK A — a gradient-valued token used through a plain color utility.
 *
 * Tailwind emits `background-color` / `border-color` / `color` for these, and
 * those properties reject a gradient, so the declaration is dropped and the
 * style silently no-ops.
 *
 * @param {{path: string, content: string}[]} files
 * @param {ReturnType<typeof parseTheme>} theme
 */
export function checkGradientTokenMisuse(files, theme) {
  const candidates = [];
  for (const token of theme.tokens.values()) {
    if (!token.isGradient) continue;
    for (const prefix of COLOR_UTILITY_PREFIXES) {
      const utility = `${prefix}-${token.name}`;
      // A hand-written @utility or class of the same name is the correct escape
      // hatch, not a bug.
      if (theme.definedUtilities.has(utility)) continue;
      candidates.push({ utility, token });
    }
  }

  const findings = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;
      for (const candidate of candidates) {
        // Allow variant prefixes (hover:, dark:, group-hover:) and an opacity
        // suffix; reject longer names that merely start with the candidate.
        const re = new RegExp(`(?<![\\w-])(?:[\\w[\\]().-]+:)*${esc(candidate.utility)}(?:\\/\\d+)?(?![\\w-])`);
        const m = re.exec(lines[i]);
        if (!m) continue;
        findings.push({
          severity: 'error',
          file: file.path,
          line: i + 1,
          utility: m[0],
          token: candidate.token.cssVar,
          tokenValue: candidate.token.resolvedValue,
        });
      }
    }
  }
  return findings;
}

const ARBITRARY_COLOR_RE =
  /(?<![\w-])(?:[\w[\]().-]+:)*(bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|decoration|caret|accent|divide|placeholder)-\[(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^\]]*\))\]/g;

/**
 * CHECK B — arbitrary color literals in renderer components.
 *
 * @param {{path: string, content: string}[]} files
 * @param {{allow?: {file?: string, value: string, reason?: string}[]}} allowlist
 */
export function checkArbitraryColors(files, allowlist = {}) {
  const entries = Array.isArray(allowlist.allow) ? allowlist.allow : [];
  const findings = [];

  entries.forEach((entry, index) => {
    if (!entry.reason || !String(entry.reason).trim()) {
      findings.push({
        severity: 'error',
        file: '<allowlist>',
        line: index + 1,
        message: `allowlist entry ${JSON.stringify(entry.value ?? entry)} has no "reason" — every exception must justify itself`,
      });
    }
  });

  const allowed = entries.filter((e) => e.reason && String(e.reason).trim());
  const isAllowed = (path, value) =>
    allowed.some(
      (e) => e.value.toLowerCase() === value.toLowerCase() && (!e.file || path === e.file || path.endsWith(e.file)),
    );

  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;
      for (const m of lines[i].matchAll(ARBITRARY_COLOR_RE)) {
        const value = m[2];
        if (isAllowed(file.path, value)) continue;
        findings.push({
          severity: 'warn',
          file: file.path,
          line: i + 1,
          utility: m[0],
          value,
        });
      }
    }
  }
  return findings;
}

/** Normalize a color literal so `#DCFCE7` and `#dcfce7` compare equal. */
export function normalizeColor(value) {
  const v = value.trim().toLowerCase().replace(/\s+/g, '');
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const withAlpha = /^#([0-9a-f]{6})ff$/.exec(v);
  if (withAlpha) return `#${withAlpha[1]}`;
  return v;
}

const LITERAL_COLOR_RE = /^(#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch)\(.*\))$/i;

/**
 * Is a Figma variable's exported value something this checker can compare?
 *
 * Only colour literals are. A dump also carries bare numbers (spacing, radii,
 * stroke widths, font sizes) and the structured `Font(...)` / `Effect(...)`
 * serialisations, none of which have a `--color-*` counterpart to drift against.
 */
export function isComparableColor(value) {
  return LITERAL_COLOR_RE.test(String(value).trim());
}

/** `Primitives/Dodger Blue/500` -> `dodger-blue-500`, `Bg/primary` -> `bg-primary`. */
function normalizeFigmaName(name) {
  return name
    .split('/')
    .slice(-2)
    .join('-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * CHECK C — drift between the Figma variable dump and the @theme values.
 *
 * The Figma MCP `get_variable_defs` dump emits gradients as an empty string, so
 * those are reported UNVERIFIABLE instead of being read as a drift.
 *
 * @param {Record<string, string>} figmaVars name -> value
 * @param {ReturnType<typeof parseTheme>} theme
 */
export function checkFigmaDrift(figmaVars, theme) {
  const results = [];
  for (const [figmaName, figmaValue] of Object.entries(figmaVars)) {
    // Shape-gate BEFORE resolving a token. A real dump is mostly spacing, radii,
    // type and effect variables, and this check only knows how to compare colours.
    // Letting them through produced two failures at once: 70-odd bogus "add it to
    // FIGMA_TOKEN_MAP" lines that buried the genuine gaps, and a false DRIFT where
    // Figma's stroke-width variable `border` (value `1`) name-matched `--color-border`
    // and got compared to a colour.
    if (String(figmaValue).trim() && !isComparableColor(figmaValue)) {
      results.push({
        status: 'OUT_OF_SCOPE',
        figmaName,
        figmaValue,
        detail: 'not a colour variable — this check compares --color-* tokens only',
      });
      continue;
    }
    const mappedVar = FIGMA_TOKEN_MAP[figmaName];
    let token = mappedVar ? theme.tokens.get(mappedVar.replace(/^--color-/, '')) : undefined;
    if (!token) {
      const guess = normalizeFigmaName(figmaName);
      token = theme.tokens.get(guess) ?? theme.tokens.get(guess.replace(/^primitives-/, ''));
    }

    if (!token) {
      results.push({
        status: 'UNMAPPED',
        figmaName,
        figmaValue,
        detail: 'no css token mapped — add it to FIGMA_TOKEN_MAP',
      });
      continue;
    }
    if (!figmaValue || !String(figmaValue).trim()) {
      results.push({
        status: 'UNVERIFIABLE',
        figmaName,
        token: token.cssVar,
        detail: 'Figma exports gradients as an empty value',
      });
      continue;
    }
    if (!LITERAL_COLOR_RE.test(token.resolvedValue)) {
      results.push({
        status: 'UNVERIFIABLE',
        figmaName,
        token: token.cssVar,
        detail: `css value \`${token.resolvedValue}\` is an alias this checker does not resolve`,
      });
      continue;
    }
    if (normalizeColor(token.resolvedValue) === normalizeColor(figmaValue)) {
      results.push({ status: 'MATCH', figmaName, token: token.cssVar, value: token.resolvedValue });
    } else {
      results.push({
        status: 'DRIFT',
        figmaName,
        token: token.cssVar,
        line: token.line,
        from: token.resolvedValue,
        to: String(figmaValue).trim(),
      });
    }
  }
  return results;
}
