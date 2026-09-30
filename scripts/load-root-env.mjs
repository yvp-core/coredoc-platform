/**
 * Dependency-free loader for the monorepo-root `.env`.
 *
 * A single `<repo-root>/.env` is the ONE place a developer sets the build-time
 * telemetry/server vars (`COREDOC_POSTHOG_KEY`, `COREDOC_POSTHOG_HOST`,
 * `COREDOC_SERVER_URL`). Every package that bakes those at build (the CLI + MCP
 * `gen-build-env.mjs` codegen and the desktop `electron.vite.config.ts`) calls
 * `loadRootEnv()` FIRST, so all three read the same source.
 *
 * Precedence is: shell/CI env  >  root `.env`  >  (each surface's own fallback).
 * That is enforced here by only writing `process.env[KEY]` when it is currently
 * `undefined` — an already-set (even empty-string) shell value always wins.
 *
 * The parser is intentionally tiny — no `dotenv` dependency. It handles the
 * subset that appears in a hand-written `.env`: blank lines, `#` comment lines,
 * an optional `export ` prefix, surrounding single/double quotes, and a trailing
 * ` # inline comment` on unquoted values. A missing file (or missing root) is a
 * no-op, never an error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Walk up from `startDir` until a directory containing `pnpm-workspace.yaml`
 * is found; that marks the monorepo root. Returns `null` if none exists up to
 * the filesystem root.
 */
function findRepoRoot(startDir) {
  // Ascend from `startDir`; `dirname` fixes at the filesystem root, so the loop
  // checks every directory up to (but not including) the root, then the root.
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return existsSync(join(dir, 'pnpm-workspace.yaml')) ? dir : null;
}

/** Parse one `KEY=VALUE` line into `[key, value]`, or `null` to skip it. */
function parseLine(rawLine) {
  let line = rawLine.trim();
  if (line === '' || line.startsWith('#')) return null;
  if (line.startsWith('export ')) line = line.slice(7).trim();

  const eq = line.indexOf('=');
  if (eq === -1) return null;

  const key = line.slice(0, eq).trim();
  if (key === '') return null;

  let value = line.slice(eq + 1).trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    // Quoted: take the literal content up to the matching closing quote, which
    // naturally drops any trailing ` # comment` outside the quotes.
    const end = value.indexOf(quote, 1);
    value = end === -1 ? value.slice(1) : value.slice(1, end);
  } else {
    // Unquoted: strip a trailing inline comment introduced by ` #`.
    const hash = value.indexOf(' #');
    if (hash !== -1) value = value.slice(0, hash).trim();
  }

  return [key, value];
}

/**
 * Load `<repo-root>/.env` into `process.env` WITHOUT overwriting any variable
 * already present (shell/CI wins). Returns the loaded path, or `null` when the
 * root or its `.env` is absent.
 *
 * @param {string} startDir Directory to begin the upward root search from.
 * @returns {string | null}
 */
export function loadRootEnv(startDir) {
  const root = findRepoRoot(startDir);
  if (!root) return null;

  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return null;

  for (const rawLine of readFileSync(envPath, 'utf-8').split('\n')) {
    const parsed = parseLine(rawLine);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return envPath;
}
