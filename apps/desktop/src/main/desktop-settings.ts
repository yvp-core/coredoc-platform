/**
 * Desktop-local user preferences that must outlive a logout, stored in
 * `<coredoc home>/desktop-settings.json`.
 *
 * Deliberately a separate file from `credentials.json`: that one is
 * byte/shape-compatible with the Claude-Code plugin's `creds.mjs` and is
 * cleared on logout, while the server the user typed has to survive both.
 *
 * Synchronous on purpose — `server-url.ts` resolves the base URL on a
 * synchronous path used by every API call.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { resolveCoredocHome } from '@coredoc/core/utils';

export interface DesktopSettings {
  /** Server URL the user entered on the pre-login screen; null when never set. */
  serverUrl: string | null;
}

const EMPTY: DesktopSettings = { serverUrl: null };

/** Resolved lazily so the dev-mode COREDOC_HOME default set during boot applies. */
export function defaultDesktopSettingsFile(): string {
  return join(resolveCoredocHome(), 'desktop-settings.json');
}

function readRaw(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Absent, empty or corrupt settings are indistinguishable from "never
    // configured" for every consumer; a stale preference is not worth a crash.
    return {};
  }
}

export function readDesktopSettings(path: string = defaultDesktopSettingsFile()): DesktopSettings {
  const raw = readRaw(path);
  return typeof raw.serverUrl === 'string' && raw.serverUrl ? { serverUrl: raw.serverUrl } : EMPTY;
}

/**
 * Atomically persist the user's server choice, preserving any other key already
 * in the file (a newer build's settings must survive an older build's write).
 */
export function writeDesktopServerUrl(serverUrl: string, path: string = defaultDesktopSettingsFile()): void {
  const next = { ...readRaw(path), serverUrl };
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created; the original error is what matters.
    }
    throw error;
  }
}
