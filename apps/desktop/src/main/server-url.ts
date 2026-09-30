/**
 * Coredoc server base-URL resolver, shared by auth-manager and server-api.
 * Extracted so auth-manager can resolve the URL without importing server-api
 * (which imports auth-manager's getValidTokens — a cycle).
 */

import { BUNDLED_COREDOC_SERVER_URL } from './build-env.js';
import { getManagedConfig } from './managed-config.js';
import { readDesktopSettings, writeDesktopServerUrl } from './desktop-settings.js';
import { type ServerConfigInfo, ServerUrlSource } from '../shared/ipc-types.js';

const DEFAULT_SERVER_URL = 'http://localhost:3000';

let serverUrlOverride: string | null = null;
/** `undefined` = not read from disk yet; `null` = read, nothing persisted. */
let persistedUserUrl: string | null | undefined;

function userServerUrl(): string | null {
  if (persistedUserUrl === undefined) persistedUserUrl = readDesktopSettings().serverUrl;
  return persistedUserUrl;
}

/**
 * Resolve the server to talk to, and where that value came from.
 *
 * Managed config wins over everything: it is the fleet admin's pin, and a
 * machine-local env var or preference must not be able to move a managed
 * install off its server. The persisted user choice sits below env but above
 * the bundled default, so a logout (which only clears the runtime override)
 * falls back to the server the user actually typed.
 */
export function resolveServerConfig(): ServerConfigInfo {
  const managed = getManagedConfig().serverUrl;
  if (managed) return { url: managed, source: ServerUrlSource.Managed };

  if (serverUrlOverride) return { url: serverUrlOverride, source: ServerUrlSource.Override };

  const fromEnv = process.env.COREDOC_SERVER_URL?.trim();
  if (fromEnv) return { url: fromEnv, source: ServerUrlSource.Env };

  const fromUser = userServerUrl();
  if (fromUser) return { url: fromUser, source: ServerUrlSource.User };

  if (BUNDLED_COREDOC_SERVER_URL) return { url: BUNDLED_COREDOC_SERVER_URL, source: ServerUrlSource.Bundled };

  return { url: DEFAULT_SERVER_URL, source: ServerUrlSource.Default };
}

export function getConfiguredServerUrl(): string {
  return resolveServerConfig().url;
}

export function setServerUrl(url: string): void {
  serverUrlOverride = url.trim();
}

/**
 * Persist the user's server choice and apply it to this session, so the very
 * next login registers against it. Refuses when a managed config pins the
 * server — the renderer hides the affordance, but renderer input is untrusted.
 */
export function setUserServerUrl(url: string): void {
  if (getManagedConfig().serverUrl) {
    throw new Error('The server URL is managed by your organization and cannot be changed.');
  }
  writeDesktopServerUrl(url);
  persistedUserUrl = url;
  setServerUrl(url);
}

/**
 * Drop the runtime override so resolution falls back to env/persisted/bundled.
 * Called on logout — otherwise a logout→login in the same app session would
 * keep registering against the previous session's server.
 */
export function resetServerUrl(): void {
  serverUrlOverride = null;
}
