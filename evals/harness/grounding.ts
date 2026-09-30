// evals/harness/grounding.ts
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { GroundingResult } from './planning-types.js';

// Module-level cache: workspaceRoot → list of relative file paths (forward slashes).
// Built once per workspaceRoot per process to avoid re-scanning on repeated calls.
const workspaceFileIndex = new Map<string, string[]>();

/**
 * Pure-Node fallback for `rg --files`: recursive walk skipping hidden entries (rg's
 * default) and the same exclusions the rg invocation passes. Without this, a machine
 * with no ripgrep (GitHub's ubuntu runners, minimal containers) silently loses the
 * cross-repo suffix match and the same spec scores differently than it does locally —
 * a grounding metric that depends on which box ran it is not a metric.
 */
function walkFiles(workspaceRoot: string): string[] {
  const files: string[] = [];
  const skip = new Set(['node_modules', '.worktrees']);
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, matching rg's behavior
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else if (e.isFile()) files.push(childRel);
    }
  };
  walk(workspaceRoot, '');
  return files;
}

function buildFileIndex(workspaceRoot: string): string[] {
  const cached = workspaceFileIndex.get(workspaceRoot);
  if (cached !== undefined) return cached;

  if (!hasRipgrep()) {
    const files = walkFiles(workspaceRoot);
    workspaceFileIndex.set(workspaceRoot, files);
    return files;
  }

  try {
    const output = execFileSync(
      'rg',
      [
        '--files',
        '-g', '!**/node_modules/**',
        '-g', '!**/.worktrees/**',
        '--',
        workspaceRoot,
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    const files = output
      .split('\n')
      .filter(Boolean)
      .map((f) => {
        // Make relative to workspaceRoot with forward slashes.
        const rel = f.startsWith(workspaceRoot)
          ? f.slice(workspaceRoot.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
          : f.replace(/\\/g, '/');
        return rel;
      });
    workspaceFileIndex.set(workspaceRoot, files);
    return files;
  } catch {
    // rg failed (e.g. root not found) — same pure-Node walk, so behavior stays uniform
    const files = walkFiles(workspaceRoot);
    workspaceFileIndex.set(workspaceRoot, files);
    return files;
  }
}

/**
 * Returns true if `citedPath` (after stripping a leading `./`) suffix-matches
 * any real file under the workspace. Used to ground repo-relative paths that
 * live inside a subdir repo (e.g. `src/foo.ts` → `api-server/src/foo.ts`).
 */
function pathExistsInIndex(files: string[], citedPath: string): boolean {
  const p = citedPath.replace(/^\.\//, '');
  for (const f of files) {
    if (f === p || f.endsWith('/' + p)) return true;
  }
  return false;
}

// A backticked token containing a slash AND a file extension → treat as a path.
const PATH_RE = /`([A-Za-z0-9_@./-]+\/[A-Za-z0-9_.-]+\.[A-Za-z]{1,5})`/g;
// A backticked identifier or Class.method, optionally trailed by () → a symbol.
const SYMBOL_RE = /`([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)\(?\)?`/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractCodeRefs(spec: string): { paths: string[]; symbols: string[] } {
  const paths = new Set<string>();
  for (const m of spec.matchAll(PATH_RE)) paths.add(m[1]!);
  const symbols = new Set<string>();
  for (const m of spec.matchAll(SYMBOL_RE)) {
    const sym = m[1]!;
    // Skip anything already captured as a path (paths never match SYMBOL_RE, but be safe).
    if (!sym.includes('/')) symbols.add(sym);
  }
  return { paths: [...paths], symbols: [...symbols] };
}

let rgAvailable: boolean | null = null;
function hasRipgrep(): boolean {
  if (rgAvailable !== null) return rgAvailable;
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/**
 * Does this symbol appear as a DEFINITION anywhere under workspaceRoot? Uses the
 * last dotted segment (so `ShiftsService.deleteBulk` checks `deleteBulk`). This
 * is a heuristic anti-hallucination signal — if ripgrep is unavailable we return
 * true (don't penalise) and the caller down-weights symbols.
 */
export function symbolExistsOnDisk(workspaceRoot: string, symbol: string): boolean {
  if (!hasRipgrep()) return true;
  const name = symbol.split('.').pop()!;
  if (name.length < 2) return true;
  const def = `\\b(function|class|interface|type|enum|const|let|var|async)\\s+${escapeRe(name)}\\b`;
  const member = `\\b${escapeRe(name)}\\s*[(:=]`;
  try {
    execFileSync(
      'rg',
      ['--max-count', '1', '-q', '-e', def, '-e', member, '--', workspaceRoot],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false; // rg exits non-zero on no match
  }
}

export function groundingToHint(g: GroundingResult): { present: number; total: number; absent: string[] } {
  const NOISE = /^(Read|Grep|Glob|Bash|Edit|Write|TodoWrite)$|^mcp__|(^|\/)node_modules(\/|$)/;
  return {
    present: g.pathsExisting + g.symbolsExisting,
    total: g.pathRefs + g.symbolRefs,
    absent: g.missing.filter((m) => !NOISE.test(m)).slice(0, 25),
  };
}

export function checkGrounding(spec: string, workspaceRoot: string): GroundingResult {
  const { paths, symbols } = extractCodeRefs(spec);
  const missing: string[] = [];

  // Build (or reuse cached) file index for cross-repo suffix matching.
  const fileIndex = buildFileIndex(workspaceRoot);

  let pathsExisting = 0;
  for (const p of paths) {
    const rel = p.replace(/^\.\//, '');
    // (a) direct root-relative check
    if (existsSync(join(workspaceRoot, rel))) {
      pathsExisting += 1;
    // (b) suffix match across all repo subdirs (via rg-built index)
    } else if (fileIndex.length > 0 && pathExistsInIndex(fileIndex, rel)) {
      pathsExisting += 1;
    } else {
      missing.push(rel);
    }
  }

  let symbolsExisting = 0;
  for (const s of symbols) {
    if (symbolExistsOnDisk(workspaceRoot, s)) symbolsExisting += 1;
    else missing.push(s);
  }

  const total = paths.length + symbols.length;
  const existing = pathsExisting + symbolsExisting;
  return {
    pathRefs: paths.length,
    pathsExisting,
    symbolRefs: symbols.length,
    symbolsExisting,
    precision: total === 0 ? 1 : existing / total,
    missing,
  };
}
