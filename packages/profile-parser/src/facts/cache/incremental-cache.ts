/**
 * Incremental-parse cache — the "skip everything when nothing relevant changed" fast-path.
 *
 * scip-typescript indexes the WHOLE program per run (no per-file / incremental mode), and SCIP
 * resolution is GLOBAL — a change in one file can flip which symbols references in OTHER files
 * resolve to. So per-file edge carry-forward is unsound (it would serve a stale edge, violating
 * 0-fabrication). The only safe reuse is wholesale: when the inputs are byte-for-byte identical,
 * the output is identical, so we reuse the prior `ParsedRepo` and skip the (dominant-cost) SCIP
 * subprocess entirely. On ANY change — or any doubt — we fall back to a full re-parse.
 *
 * Correctness therefore reduces to "is the change-detection complete?" — captured here by a manifest
 * that fingerprints every input that affects the output: the source bytes, the profile (incl.
 * customRule function bodies), the scope, the parser version, and the dependency lockfile (external
 * SCIP monikers drift when deps change). The unit tests exercise each axis.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core/types';
import { PARSER_VERSION } from '../config.js';
import type { ExtractionProfile } from '../../types.js';

const MANIFEST_FILE = 'manifest.json';
const REPO_FILE = 'parsed.json';
// First lockfile found fingerprints the dependency set (a dep upgrade can change external monikers).
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];
// TS/JS compiler configs steer scip-typescript resolution (paths, baseUrl, include) but are NOT part
// of the discovered source set, so they need their own fingerprint axis (see fingerprintConfig).
const CONFIG_FILES = ['tsconfig.json', 'jsconfig.json'];

export interface ParseManifest {
  parserVersion: string;
  profileFingerprint: string;
  scopeFingerprint: string;
  depsFingerprint: string;
  configFingerprint: string;
  /** repo-relative (forward-slash) path → sha256 of its bytes. */
  files: Record<string, string>;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Stable fingerprint of a profile. Functions (customRule handlers) are serialized via `.toString()`
 * so a change to a custom-rule body invalidates the cache — JSON.stringify would silently drop them.
 */
export function fingerprintProfile(profile: ExtractionProfile): string {
  return sha256(JSON.stringify(profile, (_k, v) => (typeof v === 'function' ? v.toString() : v)));
}

/** Fingerprint of the parse scope — a widened include/exclude must invalidate (different file set). */
function fingerprintScope(profile: ExtractionProfile): string {
  const s = profile.substrate;
  return sha256(
    JSON.stringify({
      language: s.language,
      include: s.include,
      exclude: s.exclude ?? [],
      untypedJsMode: s.untypedJsMode ?? false,
    }),
  );
}

/** sha256 of the repo's lockfile bytes (first found) — covers external-symbol/moniker drift on a dep change. */
function fingerprintDeps(repoRoot: string): string {
  // Installing a frozen lockfile enables SCIP without changing source or lockfile bytes.
  const availability = existsSync(join(repoRoot, 'node_modules')) ? 'installed' : 'missing';
  for (const lf of LOCKFILES) {
    const p = join(repoRoot, lf);
    if (existsSync(p)) {
      try {
        return `${availability}:${sha256(readFileSync(p))}`;
      } catch {
        /* unreadable → fall through to the next candidate */
      }
    }
  }
  return `${availability}:no-lockfile`;
}

/**
 * sha256 over the repo's TS/JS compiler configs — `tsconfig.json` / `jsconfig.json` plus any relative
 * `extends` targets they chain to. scip-typescript resolution depends on these (paths/baseUrl/include),
 * so a config edit with byte-identical source must still invalidate the cache. Order-independent (hashes
 * are sorted) and JSONC-tolerant (the raw-byte hash still flips on any direct edit even if `extends`
 * can't be parsed). Package-based `extends` is covered transitively by depsFingerprint.
 */
function fingerprintConfig(repoRoot: string): string {
  const seen = new Set<string>();
  const hashes: string[] = [];
  const visit = (pathLike: string, depth: number): void => {
    if (depth > 8) return;
    const p = isAbsolute(pathLike) ? pathLike : join(repoRoot, pathLike);
    if (seen.has(p)) return;
    seen.add(p);
    if (!existsSync(p)) return;
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch {
      return;
    }
    hashes.push(sha256(raw));
    try {
      const ext = (JSON.parse(raw) as { extends?: string | string[] }).extends;
      const targets = Array.isArray(ext) ? ext : ext ? [ext] : [];
      for (const t of targets) {
        // Only follow relative extends; package extends live in node_modules (covered by depsFingerprint).
        if (t.startsWith('.')) visit(join(dirname(p), t.endsWith('.json') ? t : `${t}.json`), depth + 1);
      }
    } catch {
      /* JSONC / comments — the raw-byte hash above already covers direct edits */
    }
  };
  for (const f of CONFIG_FILES) visit(f, 0);
  return hashes.length ? sha256(hashes.sort().join('|')) : 'no-config';
}

/** Build the manifest for the current tree: hash every discovered source file + the input fingerprints. */
export function buildManifest(profile: ExtractionProfile, repoRoot: string, relPaths: string[]): ParseManifest {
  const files: Record<string, string> = {};
  for (const rel of relPaths) {
    try {
      files[rel] = sha256(readFileSync(join(repoRoot, rel)));
    } catch {
      // Vanished between discovery and hashing → omit; the differing file set forces a (correct) miss.
    }
  }
  return {
    parserVersion: PARSER_VERSION,
    profileFingerprint: fingerprintProfile(profile),
    scopeFingerprint: fingerprintScope(profile),
    depsFingerprint: fingerprintDeps(repoRoot),
    configFingerprint: fingerprintConfig(repoRoot),
    files,
  };
}

/**
 * Exact equality of two manifests. ANY difference — fingerprint mismatch, or an added / removed /
 * content-changed file — is a miss. This is the whole correctness contract: a true result means the
 * inputs are byte-identical, so reusing the prior output is provably sound.
 */
export function manifestsMatch(a: ParseManifest, b: ParseManifest): boolean {
  if (
    a.parserVersion !== b.parserVersion ||
    a.profileFingerprint !== b.profileFingerprint ||
    a.scopeFingerprint !== b.scopeFingerprint ||
    a.depsFingerprint !== b.depsFingerprint ||
    a.configFingerprint !== b.configFingerprint
  ) {
    return false;
  }
  const aKeys = Object.keys(a.files);
  if (aKeys.length !== Object.keys(b.files).length) return false; // added / removed file
  for (const k of aKeys) {
    if (a.files[k] !== b.files[k]) return false; // content change (or removed: b[k] is undefined)
  }
  return true;
}

export function loadManifest(cacheDir: string): ParseManifest | null {
  const p = join(cacheDir, MANIFEST_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ParseManifest;
  } catch {
    return null; // corrupt cache → treat as cold
  }
}

export function loadCachedRepo(cacheDir: string): ParsedRepo | null {
  const p = join(cacheDir, REPO_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ParsedRepo;
  } catch {
    return null;
  }
}

/** Persist manifest + repo together, only AFTER a successful parse — never poison the cache on failure. */
export function writeCache(cacheDir: string, manifest: ParseManifest, repo: ParsedRepo): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, REPO_FILE), JSON.stringify(repo));
  writeFileSync(join(cacheDir, MANIFEST_FILE), JSON.stringify(manifest));
}
