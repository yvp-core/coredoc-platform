/**
 * Cargo crate enumeration — the package layer the Python substrate lacks.
 *
 * `facts/workspace.ts` reads `package.json` / `pnpm-workspace.yaml` only, so it cannot see a
 * Cargo workspace. A Cargo workspace's members and each crate's `[package] name` are the Rust
 * analogue of workspace packages, so the Rust substrate emits them itself: one crate per
 * `Cargo.toml`, and every `FileNode` assigned to its owning crate by longest-prefix path match
 * (mirroring `ownerPackagePath` in facts/workspace.ts).
 *
 * Crates are enumerated by FINDING every `Cargo.toml` rather than by expanding the
 * `[workspace] members` list: members entries are globs (`crates/*`), and a path-glob
 * expansion would silently miss any crate the list does not name (path dependencies outside
 * the workspace, nested workspaces). The manifest walk cannot miss one.
 *
 * The TOML reader is deliberately line-oriented (no dependency; same approach as
 * `ruby-schema.ts` over `schema.rb`). It reads exactly what this substrate needs — the package
 * name/version, whether the manifest declares a workspace, and the set of dependency NAMES
 * (which gates the contract-entrypoint lane) — and ignores everything else.
 */
import { readFileSync } from 'node:fs';
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';

/** One Cargo crate (or a virtual workspace root manifest). */
export interface RustCrate {
  /** `[package] name`, else the manifest directory's basename ('' → the repo root). */
  name: string;
  /** Repo-relative directory holding the manifest; the repo root is '.'. */
  path: string;
  /** Repo-relative path of the `Cargo.toml`, when one exists. */
  manifestFile?: string;
  version?: string;
  /** Declared dependency names across every `*dependencies` table (normal, dev, build, target). */
  dependencies: Set<string>;
  /** The manifest declares a `[workspace]` table. */
  isWorkspaceRoot: boolean;
  /** The manifest declares a `[package]` table (a virtual workspace manifest does not). */
  isPackage: boolean;
}

/** Section headers whose keys are dependency names. */
const DEPENDENCY_SECTION = /(^|\.)(dependencies|dev-dependencies|build-dependencies)$/;
/** `[dependencies.foo]` / `[target.'cfg(unix)'.dev-dependencies.bar]` — the tail is one dep. */
const DEPENDENCY_ENTRY_SECTION = /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]+)$/;

/** Strip a TOML comment tail that is not inside a quoted string. */
function stripComment(line: string): string {
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === inString && line[i - 1] !== '\\') inString = null;
    } else if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** The bare section path of a `[a.b.c]` / `[[a.b]]` header line, else undefined. */
function sectionHeader(line: string): string | undefined {
  const m = /^\[{1,2}\s*([^\]]+?)\s*\]{1,2}$/.exec(line);
  if (!m) return undefined;
  // Quoted segments (`target.'cfg(unix)'.dependencies`) keep their quotes; the regexes above
  // only anchor on the head/tail segments, which are never quoted in practice.
  return m[1];
}

/** The key of a `key = value` line, else undefined. */
function entryKey(line: string): string | undefined {
  const m = /^["']?([A-Za-z0-9_.-]+)["']?\s*=/.exec(line);
  return m ? m[1] : undefined;
}

/** The string value of a `key = "value"` line, else undefined. */
function stringEntry(line: string, key: string): string | undefined {
  const m = new RegExp(`^["']?${key}["']?\\s*=\\s*["']([^"']*)["']`).exec(line);
  return m ? m[1] : undefined;
}

/** Parse the pieces of a `Cargo.toml` this substrate needs. */
export function parseCargoManifest(source: string, fallbackName: string): Omit<RustCrate, 'path' | 'manifestFile'> {
  let section = '';
  let name: string | undefined;
  let version: string | undefined;
  let isWorkspaceRoot = false;
  let isPackage = false;
  const dependencies = new Set<string>();

  for (const rawLine of source.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const header = sectionHeader(line);
    if (header !== undefined) {
      section = header;
      if (section === 'workspace' || section.startsWith('workspace.')) isWorkspaceRoot = true;
      if (section === 'package') isPackage = true;
      const entry = DEPENDENCY_ENTRY_SECTION.exec(section);
      if (entry) dependencies.add(entry[1]);
      continue;
    }

    if (section === 'package') {
      name = stringEntry(line, 'name') ?? name;
      version = stringEntry(line, 'version') ?? version;
      continue;
    }
    if (DEPENDENCY_SECTION.test(section)) {
      const key = entryKey(line);
      // `foo.workspace = true` / `foo.version = "1"` inline-dotted forms name the dep first.
      if (key) dependencies.add(key.split('.')[0]);
    }
  }

  return { name: name ?? fallbackName, version, dependencies, isWorkspaceRoot, isPackage };
}

/** The repo-relative directory of a manifest path; the repo root is '.'. */
function manifestDir(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '.' : rel.slice(0, i);
}

/**
 * Every crate in the repo, ordered by path. Manifests under a build (`target/`) or vendored
 * (`vendor/`) tree are skipped: those are dependency copies, not this repo's crates, and a
 * built workspace has thousands of them.
 */
export function discoverCrates(root: string): RustCrate[] {
  const crates: RustCrate[] = [];
  for (const rel of enumerateRepoFiles(root)) {
    if (!rel.endsWith('Cargo.toml')) continue;
    const segments = rel.split('/');
    if (segments.some((s) => s === 'target' || s === 'vendor')) continue;
    const path = manifestDir(rel);
    let source: string;
    try {
      source = readFileSync(`${root}/${rel}`, 'utf-8');
    } catch {
      continue; // unreadable manifest — the crate simply isn't described
    }
    const fallbackName = path === '.' ? 'root' : (path.split('/').pop() as string);
    crates.push({ ...parseCargoManifest(source, fallbackName), path, manifestFile: rel });
  }
  return crates.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The crate directory that owns a repo-relative file — the longest matching path prefix,
 * mirroring `ownerPackagePath`. Returns undefined when no crate contains the file (the caller
 * decides the fallback), so a file is never silently attributed to an unrelated crate.
 */
export function crateOwnerPath(rel: string, crates: RustCrate[]): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const c of crates) {
    if (c.path === '.') {
      if (bestLen < 0) {
        best = '.';
        bestLen = 0;
      }
      continue;
    }
    if ((rel === c.path || rel.startsWith(`${c.path}/`)) && c.path.length > bestLen) {
      best = c.path;
      bestLen = c.path.length;
    }
  }
  return best;
}

/**
 * Whether ANY crate in the workspace declares one of `names` as a dependency. Gates the
 * framework lanes that would otherwise fabricate: `#[program]` is a plausible attribute name
 * in unrelated code, and a fabricated smart contract is the one claim a reader scrutinizes
 * hardest — so the four contract detectors only run when the matching crate is actually there.
 */
export function dependsOnAny(crates: RustCrate[], names: readonly string[]): boolean {
  return crates.some((c) => names.some((n) => c.dependencies.has(n)));
}

/**
 * A crate's code-facing name. Cargo `[package] name` uses hyphens (`my-api`) while the same
 * crate is `my_api` in `use` paths, so every consumer of a crate name for RESOLUTION must go
 * through this. Getting it wrong breaks every cross-crate `use` in a workspace, silently.
 */
export function crateCodeName(name: string): string {
  return name.replace(/-/g, '_');
}
