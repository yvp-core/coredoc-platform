/**
 * TypeScript port of the coredoc Claude-Code plugin's credentials primitive
 * (`plugins/coredoc/scripts/lib/creds.mjs`), for the Electron main process.
 *
 * Byte/shape-compatible with the plugin so both surfaces interoperate on the same
 * `~/.coredoc/credentials.json`: BOM-tolerant reads, atomic 0600 writes, 2-space
 * JSON + trailing newline, and merge-never-replace workspace mutations. The
 * plugin `.mjs` stays the source of truth — this file must preserve its semantics.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { resolveCoredocHome } from '@coredoc/core/utils';

/** Shape of `~/.coredoc/credentials.json`. All fields optional — partial files are valid. */
export interface CoredocCredentials {
  accessToken?: string;
  expiresAt?: number;
  serverUrl?: string;
  workspaces?: Record<string, CoredocWorkspaceEntry>;
}

export interface CoredocWorkspaceEntry {
  otelToken?: string;
  serverUrl?: string;
}

/**
 * Default credentials location; overridable per call for tests. Resolved
 * lazily so the dev-mode COREDOC_HOME default set during app boot applies.
 */
export function defaultCredentialsFile(): string {
  return join(resolveCoredocHome(), 'credentials.json');
}

/**
 * Read credentials, or `null` when the file is absent, empty, or unparseable.
 * BOM-tolerant (strips a leading U+FEFF) to match the plugin reader byte-for-byte.
 */
export async function readCreds(path: string = defaultCredentialsFile()): Promise<CoredocCredentials | null> {
  try {
    let raw = await readFile(path, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return raw.trim() ? (JSON.parse(raw) as CoredocCredentials) : null;
  } catch {
    // Absent or unparseable credentials → treat as "not logged in yet"; callers gate on null.
    return null;
  }
}

/**
 * Atomically persist credentials at mode 0600: mkdir -p the parent, write to a
 * unique temp file, rename into place, then chmod again (rename can carry the
 * temp's mode but chmod after is belt-and-suspenders, matching the reference).
 * Output is 2-space JSON with a trailing newline for byte-parity with the plugin.
 */
export async function writeCreds(creds: CoredocCredentials, path: string = defaultCredentialsFile()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

/** True when an access token is present and not yet expired. */
export function isCredValid(creds: CoredocCredentials | null | undefined): boolean {
  return Boolean(creds?.accessToken) && typeof creds?.expiresAt === 'number' && creds.expiresAt > Date.now();
}

/** Read one workspace entry, or `undefined` when absent. */
export function getWorkspaceEntry(
  creds: CoredocCredentials | null | undefined,
  wsId: string,
): CoredocWorkspaceEntry | undefined {
  return creds?.workspaces?.[wsId];
}

/**
 * Return a new credentials object with `wsId` set to `entry`, MERGED into the
 * existing state: top-level fields (accessToken/expiresAt/serverUrl) and every
 * other workspace entry survive. Never replaces the whole document.
 */
export function setWorkspaceEntry(
  creds: CoredocCredentials | null | undefined,
  wsId: string,
  entry: CoredocWorkspaceEntry,
): CoredocCredentials {
  return { ...creds, workspaces: { ...(creds?.workspaces ?? {}), [wsId]: entry } };
}
