#!/usr/bin/env node
/**
 * Design-conformance checker for the desktop renderer.
 *
 * Three checks over `styles/globals.css` and `src/renderer/**`:
 *
 *   A (ERROR) gradient-valued token used through a plain color utility.
 *             `--color-bg-info: linear-gradient(...)` + `bg-bg-info` compiles to
 *             `background-color: linear-gradient(...)`, which is invalid, so the
 *             declaration is dropped and the surface silently paints nothing.
 *   B (WARN)  arbitrary color literals (`text-[#079467]`) in renderer components.
 *   C (DRIFT) `@theme` values vs a Figma variable dump (`--figma-vars`).
 *
 * Usage:
 *   node scripts/design-conformance.mjs [--figma-vars <path.json>] [--strict]
 *   node scripts/design-conformance.mjs --self-test
 *
 * Exit code: non-zero on any ERROR; WARN/DRIFT exit zero unless --strict.
 * Node >= 20, no dependencies.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkArbitraryColors,
  checkFigmaDrift,
  checkGradientTokenMisuse,
  normalizeColor,
  parseTheme,
} from './design-conformance-lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..');
const RENDERER_DIR = join(APP_ROOT, 'src/renderer');
const GLOBALS_CSS = join(RENDERER_DIR, 'styles/globals.css');
const ALLOWLIST = join(SCRIPT_DIR, 'design-conformance-allowlist.json');

const SOURCE_EXTENSIONS = ['.tsx', '.ts'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'out', '.git']);

function parseArgs(argv) {
  const options = { figmaVars: null, strict: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict') options.strict = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--figma-vars') options.figmaVars = argv[++i];
    else if (arg.startsWith('--figma-vars=')) options.figmaVars = arg.slice('--figma-vars='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (!SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    files.push({ path: relative(APP_ROOT, full), content: readFileSync(full, 'utf8') });
  }
  return files;
}

function readAllowlist() {
  try {
    return JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`allowlist ${relative(APP_ROOT, ALLOWLIST)} is not valid JSON: ${error.message}`);
  }
}

function run(options) {
  const css = readFileSync(GLOBALS_CSS, 'utf8');
  const theme = parseTheme(css);
  const files = collectSourceFiles(RENDERER_DIR);
  const gradientTokens = [...theme.tokens.values()].filter((t) => t.isGradient);

  const lines = [];
  const out = (line = '') => lines.push(line);

  out('Design conformance — apps/desktop');
  out(
    `  tokens: ${theme.tokens.size} --color-* in @theme (${gradientTokens.length} gradient-valued), ` +
      `${files.length} renderer source files`,
  );
  out();

  const misuse = checkGradientTokenMisuse(files, theme);
  out(`CHECK A — gradient token used via a color utility  [${misuse.length} error(s)]`);
  if (misuse.length === 0) {
    out('  none');
  } else {
    for (const f of misuse) {
      out(`  ERROR ${f.file}:${f.line}  ${f.utility}`);
      out(`        ${f.token} is a gradient (${f.tokenValue.slice(0, 64)}…)`);
      out('        Tailwind emits background-color/border-color/color here, which reject a gradient.');
      out(`        Fix: define a dedicated utility in styles/globals.css —`);
      out(`             @utility <name> { background: var(${f.token}); }  (see the existing bg-panel)`);
      out('             and use that class instead.');
    }
  }
  out();

  const allowlist = readAllowlist();
  const arbitrary = checkArbitraryColors(files, allowlist);
  const arbitraryErrors = arbitrary.filter((f) => f.severity === 'error');
  const arbitraryWarnings = arbitrary.filter((f) => f.severity === 'warn');
  out(
    `CHECK B — arbitrary color literals in renderer  [${arbitraryWarnings.length} warning(s), ` +
      `${arbitraryErrors.length} error(s)]`,
  );
  for (const f of arbitraryErrors) out(`  ERROR ${f.message}`);
  if (arbitraryWarnings.length === 0 && arbitraryErrors.length === 0) {
    out('  none');
  }
  for (const f of arbitraryWarnings) {
    out(`  WARN  ${f.file}:${f.line}  ${f.utility}  → use a --color-* token (or allowlist it with a reason)`);
  }
  out();

  let drift = [];
  if (options.figmaVars) {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), options.figmaVars), 'utf8'));
    drift = checkFigmaDrift(raw, theme);
    const counts = {};
    for (const r of drift) counts[r.status] = (counts[r.status] ?? 0) + 1;
    out(
      `CHECK C — Figma drift  [${counts.MATCH ?? 0} match, ${counts.DRIFT ?? 0} drift, ` +
        `${counts.UNMAPPED ?? 0} unmapped, ${counts.UNVERIFIABLE ?? 0} unverifiable, ` +
        `${counts.OUT_OF_SCOPE ?? 0} non-colour]`,
    );
    for (const r of drift) {
      // Non-colour variables are counted, never listed: a real dump is mostly
      // spacing and type, and printing all of it buries the drifts.
      if (r.status === 'OUT_OF_SCOPE') continue;
      if (r.status === 'MATCH') out(`  MATCH        ${r.figmaName} = ${r.token} (${r.value})`);
      else if (r.status === 'DRIFT')
        out(`  DRIFT        ${r.token} (globals.css:${r.line}) ${r.from} → ${r.to}   [Figma: ${r.figmaName}]`);
      else out(`  ${r.status.padEnd(12)} ${r.figmaName}${r.token ? ` (${r.token})` : ''} — ${r.detail}`);
    }
  } else {
    out('CHECK C — Figma drift  [skipped: pass --figma-vars <path.json>]');
  }
  out();

  const driftCount = drift.filter((r) => r.status === 'DRIFT').length;
  const errors = misuse.length + arbitraryErrors.length;
  const warnings = arbitraryWarnings.length + driftCount;
  out(`Summary: ${errors} error(s), ${warnings} warning(s)${options.strict ? ' (--strict)' : ''}`);

  const exitCode = errors > 0 || (options.strict && warnings > 0) ? 1 : 0;
  return { report: lines.join('\n'), exitCode };
}

/* ------------------------------------------------------------------ */
/* Self-test                                                          */
/*                                                                    */
/* The checker is a build-time node script, so it lives outside the   */
/* vitest `src/**` collection root. Fixtures are embedded here so the */
/* checks stay verified even when the real tree happens to be clean.  */
/* ------------------------------------------------------------------ */

const FIXTURE_CSS = `
@theme {
  --color-zinc-800: #27272a;
  --color-bg-primary: var(--color-white);
  --color-bg-panel: linear-gradient(180deg, rgba(255,255,255,0.80) 0%, rgba(255,255,255,0.66) 100%);
  --color-bg-info: linear-gradient(87deg, var(--color-amber-200), var(--color-amber-300));
  --color-content-accent: linear-gradient(273deg, #439CFB, #F187FB);
  --color-bg-alias: var(--color-bg-info);
  --color-bg-hero: linear-gradient(90deg, #000, #fff);
  --color-selago-50: #F7F7FB;
  --color-bg-tag-success: #DCFCE7;
  --color-content-primary: var(--color-zinc-800);
}

@utility bg-panel {
  background: var(--color-bg-panel);
}

@utility text-content-accent-default {
  background: linear-gradient(273deg, #439CFB 0%, #F187FB 100%);
}

/* the correct fix shape: a utility named exactly like the color utility */
@utility bg-bg-hero {
  background: var(--color-bg-hero);
}
`;

const FIXTURE_FILES = [
  {
    // The shipped amber-alert bug class: a gradient token through bg-*.
    path: 'src/renderer/components/Alert.tsx',
    content: [
      '<div className="rounded-lg bg-bg-info px-3 py-2">',
      '<span className="hover:bg-bg-info/50 text-content-accent">alert</span>',
      '<span className="bg-bg-alias">aliased gradient</span>',
      '</div>',
    ].join('\n'),
  },
  {
    path: 'src/renderer/components/Ok.tsx',
    content: [
      '<div className="bg-panel bg-bg-hero bg-bg-primary text-content-accent-default">',
      '<span className="bg-bg-info-hover">not the token</span>',
      '// bg-bg-info in a comment does not count',
      '<button className="bg-[#079467] text-[#FFFFFF] ring-[rgb(0,0,0)]">brand</button>',
      '</div>',
    ].join('\n'),
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function selfTest() {
  const theme = parseTheme(FIXTURE_CSS);
  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
    }
  };

  check('parseTheme classifies literal and aliased gradients', () => {
    assert(theme.tokens.get('bg-info').isGradient, 'bg-info should be a gradient');
    assert(theme.tokens.get('content-accent').isGradient, 'content-accent should be a gradient');
    assert(theme.tokens.get('bg-alias').isGradient, 'bg-alias resolves to a gradient');
    assert(!theme.tokens.get('bg-primary').isGradient, 'bg-primary is not a gradient');
    assert(!theme.tokens.get('selago-50').isGradient, 'selago-50 is not a gradient');
  });

  check('parseTheme collects @utility escape hatches', () => {
    assert(theme.definedUtilities.has('bg-panel'), 'bg-panel utility not collected');
    assert(theme.definedUtilities.has('text-content-accent-default'), 'gradient text utility not collected');
  });

  const misuse = checkGradientTokenMisuse(FIXTURE_FILES, theme);
  const hits = misuse.map((f) => `${f.file}:${f.line}:${f.utility}`);

  check('CHECK A flags the gradient-through-bg bug', () => {
    assert(hits.includes('src/renderer/components/Alert.tsx:1:bg-bg-info'), `missing plain hit: ${hits}`);
  });
  check('CHECK A flags variant prefixes and opacity modifiers', () => {
    assert(hits.includes('src/renderer/components/Alert.tsx:2:hover:bg-bg-info/50'), `missing variant hit: ${hits}`);
  });
  check('CHECK A flags gradient tokens through text-*', () => {
    assert(hits.includes('src/renderer/components/Alert.tsx:2:text-content-accent'), `missing text hit: ${hits}`);
  });
  check('CHECK A follows var() aliases to a gradient', () => {
    assert(hits.includes('src/renderer/components/Alert.tsx:3:bg-bg-alias'), `missing alias hit: ${hits}`);
  });
  check('CHECK A ignores dedicated utilities, longer names, non-gradients and comments', () => {
    const noise = hits.filter((h) => h.startsWith('src/renderer/components/Ok.tsx'));
    assert(noise.length === 0, `Ok.tsx should be clean, got ${noise}`);
  });
  check('CHECK A reports the offending token for the fix hint', () => {
    assert(
      misuse.every((f) => f.token.startsWith('--color-')),
      'every finding must name its token',
    );
  });

  check('CHECK B warns on hex and rgb literals', () => {
    const found = checkArbitraryColors(FIXTURE_FILES, {}).map((f) => f.value.toLowerCase());
    assert(found.includes('#079467'), `missing hex: ${found}`);
    assert(found.includes('rgb(0,0,0)'), `missing rgb: ${found}`);
    assert(found.length === 3, `expected 3 literals, got ${found}`);
  });
  check('CHECK B honors a file-scoped allowlist entry', () => {
    const found = checkArbitraryColors(FIXTURE_FILES, {
      allow: [{ file: 'src/renderer/components/Ok.tsx', value: '#079467', reason: 'brand green, DESIGN.md' }],
    });
    assert(!found.some((f) => f.value === '#079467'), 'allowlisted value still reported');
    assert(found.length === 2, `expected the other two literals, got ${found.length}`);
  });
  check('CHECK B errors on an allowlist entry without a reason', () => {
    const found = checkArbitraryColors(FIXTURE_FILES, { allow: [{ value: '#079467' }] });
    assert(
      found.some((f) => f.severity === 'error' && /no "reason"/.test(f.message)),
      'reasonless allowlist entry must be an error',
    );
    assert(
      found.some((f) => f.value === '#079467'),
      'reasonless entry must not suppress the warning',
    );
  });

  check('CHECK C reports MATCH / DRIFT / UNMAPPED / UNVERIFIABLE', () => {
    const drift = checkFigmaDrift(
      {
        'Primitives/Selago/50': '#f7f7fb',
        'Bg/tag-success': '#D1FAE5',
        'Bg/info': '',
        'Content/primary': '#27272a',
        'Primitives/Nonexistent/900': '#123456',
      },
      theme,
    );
    const by = Object.fromEntries(drift.map((r) => [r.figmaName, r]));
    assert(by['Primitives/Selago/50'].status === 'MATCH', 'case-insensitive hex should MATCH');
    assert(by['Bg/tag-success'].status === 'DRIFT', 'changed hex should DRIFT');
    assert(
      by['Bg/tag-success'].from === '#DCFCE7' && by['Bg/tag-success'].to === '#D1FAE5',
      'DRIFT must carry old→new',
    );
    assert(by['Bg/info'].status === 'UNVERIFIABLE', 'empty Figma value (gradient) must be UNVERIFIABLE, not DRIFT');
    assert(by['Content/primary'].status === 'MATCH', 'alias resolvable inside @theme should compare');
    assert(by['Primitives/Nonexistent/900'].status === 'UNMAPPED', 'unknown variable must be UNMAPPED');
  });

  check('normalizeColor folds shorthand and case', () => {
    assert(normalizeColor('#ABC') === '#aabbcc', 'shorthand hex not expanded');
    assert(normalizeColor('#FFFFFFFF') === '#ffffff', 'opaque 8-digit hex not folded');
  });

  const failed = results.filter((r) => !r.ok);
  const report = [
    'design-conformance self-test',
    ...results.map((r) => `  ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n        ${r.error}`}`),
    '',
    `${results.length - failed.length}/${results.length} passed`,
  ].join('\n');
  return { report, exitCode: failed.length > 0 ? 1 : 0 };
}

const HELP = `design-conformance — token-usage checks for apps/desktop

  node scripts/design-conformance.mjs                       run checks A and B
  node scripts/design-conformance.mjs --figma-vars vars.json  also check Figma drift
  node scripts/design-conformance.mjs --strict              fail on warnings too
  node scripts/design-conformance.mjs --self-test           verify the checks themselves
`;

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const { report, exitCode } = options.selfTest ? selfTest() : run(options);
  process.stdout.write(`${report}\n`);
  process.exit(exitCode);
}

main();
