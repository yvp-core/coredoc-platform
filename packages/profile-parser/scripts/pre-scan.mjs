#!/usr/bin/env node
/**
 * pre-scan.mjs — compare source-code patterns against parser output coverage.
 *
 * Self-contained (no @coredoc dependency). Ported from
 * packages/parser-gen/src/tools/pre-scan.ts. Heuristic grep counts vs output
 * counts — treat as order-of-magnitude signals, not exact targets.
 *
 * Usage:
 *   node pre-scan.mjs <repoPath> <outputFile> [pkgPath1 pkgPath2 ...]
 *     pkgPathN (optional, relative to repoPath) enables per-package breakdown
 *     for monorepos — pass each package root, e.g. apps/api packages/web.
 * Output: JSON { source, output, callDensity, byPackage?, hits } to stdout.
 */
import { readFileSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const repoPath = process.argv[2];
const outputFile = process.argv[3];
const pkgPaths = process.argv.slice(4);

if (!repoPath || !outputFile) {
  console.error('Usage: node pre-scan.mjs <repoPath> <outputFile> [pkgPath ...]');
  process.exit(2);
}

const ALL_EXTENSIONS = [
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'rb',
];
const FRONTEND_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'];
const JSX_EXTENSIONS = ['tsx', 'jsx', 'vue', 'svelte'];

// Hardcoded heuristic patterns (grep BRE alternation), identical to the original tool.
const HTTP_PATTERN =
  '@Get\\|@Post\\|@Put\\|@Delete\\|@Patch\\|@Head\\|@Options\\|router\\.get\\|router\\.post\\|router\\.put\\|router\\.delete\\|router\\.patch\\|@app\\.get\\|@app\\.post\\|@app\\.route\\|@api_view\\|@action\\|HandleFunc\\|r\\.GET\\|r\\.POST';
// `.subscribe(` is intentionally absent: RxJS, state stores, and Supabase Realtime
// use that ubiquitous shape without declaring queue entrypoints. In BRE, '(' is
// literal and '\b' is a word boundary.
// NB: keep in sync with QUEUE_FALLBACK_PATTERN in src/scoring/ts-signals.ts.
const QUEUE_PATTERN = '@EventPattern(\\|@MessagePattern(\\|@SqsMessageHandler(\\|new Consumer(\\|\\bon_message\\b';
// NB: the old `class.*Model` branch matched any class line mentioning "Model" (DTOs,
// base/view classes) and badly over-counted the entity denominator → false FAILs. It is
// dropped: this grep is only the FALLBACK signal when a profile declares no entity source
// (score.ts counts the declared ORM source precisely). Real ORM markers stay below.
const ENTITY_PATTERN = '@Entity(\\|@Table(\\|@model(\\|Base\\.metadata\\|db\\.Model';
const COMPONENT_PATTERN =
  'React\\.FC\\|React\\.Component\\|React\\.memo\\|React\\.forwardRef\\|defineComponent\\|@Component\\|export default function.*return.*<\\|: FC\\|: React\\.FC';
const ROUTE_PATTERN = '<Route\\|createBrowserRouter\\|useRoutes\\|createRouter\\|defineRouter\\|RouterModule';
const STATE_STORE_PATTERN = 'createStore\\|createSlice\\|create.*Store\\|defineStore\\|makeAutoObservable\\|atom(';

// Keep in sync with DEFAULT_IGNORE_DIRS in src/facts/discovery/ignore.ts. This script is
// intentionally self-contained because it is also executed from the packaged Desktop runtime.
const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.yarn',
  '.pnp',
  '.pnpm-store',
  '.git',
  '.worktrees',
  '.hg',
  '.svn',
  'dist',
  'build',
  'coverage',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.vercel',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
]);
const TEST_SOURCE = /(?:^|\/)(?:__tests?|__mocks?)(?:\/|$)|\.(?:spec|test)\.[^/]+$/;
const GREP_BATCH_SIZE = 256;

function isDefaultIgnored(relPath) {
  return relPath.split('/').some((segment) => DEFAULT_IGNORE_DIRS.has(segment));
}

function toRepoRelative(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join('/');
}

function walk(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!DEFAULT_IGNORE_DIRS.has(entry)) pending.push(full);
      } else {
        files.push(toRepoRelative(root, full));
      }
    }
  }
  return files;
}

function gitListFiles(root) {
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (realpathSync(top) !== realpathSync(root)) return null;
    const out = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function enumerateRepoFiles(root) {
  return (gitListFiles(root) ?? walk(root)).filter((relPath) => !isDefaultIgnored(relPath));
}

const repoSourceFiles = enumerateRepoFiles(repoPath)
  .filter((relPath) => !TEST_SOURCE.test(relPath))
  .map((relPath) => join(repoPath, relPath))
  .filter((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      // `git ls-files` can report an unstaged-deleted or sparse tracked path.
      return false;
    }
  });

function sourceFiles(dirs, extensions) {
  const roots = dirs.filter((dir) => existsSync(dir));
  const wanted = new Set(extensions.map((extension) => `.${extension}`));
  return repoSourceFiles.filter(
    (file) =>
      wanted.has(file.slice(file.lastIndexOf('.'))) &&
      roots.some((root) => {
        const relPath = relative(root, file);
        return relPath === '' || (!relPath.startsWith(`..${sep}`) && relPath !== '..' && !isAbsolute(relPath));
      }),
  );
}

function grepRaw(dirs, pattern, extensions, mode /* 'lines' | 'files' */) {
  const files = sourceFiles(dirs, extensions);
  const matches = [];
  const flag = mode === 'files' ? '-Hl' : '-Hn';
  for (let start = 0; start < files.length; start += GREP_BATCH_SIZE) {
    const batch = files.slice(start, start + GREP_BATCH_SIZE);
    try {
      const out = execFileSync('grep', [flag, '-e', pattern, ...batch], {
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      matches.push(...out.split('\n').filter(Boolean));
    } catch (error) {
      // grep exits 1 when there are no matches — that's a legitimate zero, not an error.
      if (error && typeof error === 'object' && 'status' in error && error.status === 1) continue;
      const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
      throw new Error(`Source scan failed${detail ? `: ${detail}` : ''}`, { cause: error });
    }
  }
  return matches;
}

function grepCount(dirs, pattern, extensions, mode /* 'lines' | 'files' */) {
  return grepRaw(dirs, pattern, extensions, mode).length;
}

// Parse `file:line:text` grep lines into {file, line, text} hits — file repo-relative,
// text trimmed and capped at 200 chars so the JSON stays diagnostic-sized.
// NB: keep the parsing regex in sync with grepSourceHits in src/scoring/ts-signals.ts.
function toHits(rawLines) {
  const hits = [];
  for (const l of rawLines) {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (m) hits.push({ file: relative(repoPath, m[1]), line: Number(m[2]), text: m[3].trim().slice(0, 200) });
  }
  return hits;
}

function scanSource(dirs) {
  const httpLines = grepRaw(dirs, HTTP_PATTERN, ALL_EXTENSIONS, 'lines');
  return {
    source: {
      httpPatterns: httpLines.length,
      queuePatterns: grepCount(dirs, QUEUE_PATTERN, ['ts', 'py', 'go', 'java'], 'lines'),
      entityFiles: grepCount(dirs, ENTITY_PATTERN, ALL_EXTENSIONS, 'files'),
      componentPatterns: grepCount(dirs, COMPONENT_PATTERN, JSX_EXTENSIONS, 'lines'),
      routePatterns: grepCount(dirs, ROUTE_PATTERN, FRONTEND_EXTENSIONS, 'lines'),
      stateStorePatterns: grepCount(dirs, STATE_STORE_PATTERN, FRONTEND_EXTENSIONS, 'lines'),
    },
    // Per-hit lists for the scorer's unclaimed-site cluster report — only the patterns
    // the scorer consumes from pre-scan (http); the other categories grep in ts-signals.
    hits: { httpPatterns: toHits(httpLines) },
  };
}

// --- source scan -----------------------------------------------------------
const scanDirs = pkgPaths.length > 0 ? pkgPaths.map((p) => join(repoPath, p)) : [repoPath];

const { source, hits } = scanSource(scanDirs);

// --- output scan -----------------------------------------------------------
let parsed = null;
let output = {
  httpEntrypoints: 0,
  queueEntrypoints: 0,
  entities: 0,
  functions: 0,
  calls: 0,
  externalCalls: 0,
  components: 0,
  routes: 0,
  stateStores: 0,
};
if (existsSync(outputFile)) {
  try {
    parsed = JSON.parse(readFileSync(outputFile, 'utf-8'));
    const eps = parsed.entrypoints ?? [];
    output = {
      httpEntrypoints: eps.filter((e) => e.type === 'http').length,
      queueEntrypoints: eps.filter((e) => e.type === 'queue').length,
      entities: (parsed.entities ?? []).length,
      functions: (parsed.functions ?? []).length,
      calls: (parsed.calls ?? []).length,
      externalCalls: (parsed.externalCalls ?? []).length,
      components: (parsed.components ?? []).length,
      routes: (parsed.routes ?? []).length,
      stateStores: (parsed.stateStores ?? []).length,
    };
  } catch {
    /* leave zeros */
  }
}

const callDensity = output.functions > 0 ? Math.round((output.calls / output.functions) * 100) / 100 : null;

// --- per-package breakdown (monorepo) -------------------------------------
let byPackage;
if (pkgPaths.length > 0) {
  byPackage = {};
  for (const pkg of pkgPaths) {
    const pkgDirs = [join(repoPath, pkg)];
    const src = {
      httpPatterns: grepCount(pkgDirs, HTTP_PATTERN, ALL_EXTENSIONS, 'lines'),
      componentPatterns: grepCount(pkgDirs, COMPONENT_PATTERN, JSX_EXTENSIONS, 'lines'),
      entityFiles: grepCount(pkgDirs, ENTITY_PATTERN, ALL_EXTENSIONS, 'files'),
    };
    let functions = 0;
    let entrypoints = 0;
    let components = 0;
    if (parsed) {
      const prefix = pkg.endsWith('/') ? pkg : pkg + '/';
      const pkgFileIds = new Set(
        (parsed.files ?? []).filter((f) => f.path === pkg || f.path.startsWith(prefix)).map((f) => f.id),
      );
      functions = (parsed.functions ?? []).filter((f) => pkgFileIds.has(f.fileId)).length;
      entrypoints = (parsed.entrypoints ?? []).filter((e) => {
        const handler = (parsed.functions ?? []).find((f) => f.id === e.handlerId);
        return handler && pkgFileIds.has(handler.fileId);
      }).length;
      components = (parsed.components ?? []).filter((c) => pkgFileIds.has(c.fileId)).length;
    }
    byPackage[pkg] = { source: src, output: { functions, entrypoints, components } };
  }
}

// `hits` stays LAST so run.ts's truncated human diagnostic keeps showing the counts first.
console.log(JSON.stringify({ source, output, callDensity, byPackage, hits }, null, 2));
