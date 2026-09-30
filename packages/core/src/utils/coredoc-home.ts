/**
 * Single source of truth for the coredoc home directory (`~/.coredoc`).
 *
 * `COREDOC_HOME` overrides the default so parallel worlds (dev desktop vs
 * packaged desktop, isolated test runs) never share credentials, telemetry,
 * session, or relay state. The env var name matches the one the
 * coredoc-workflows plugin already honors (`scripts/project-key.mjs`).
 *
 * Must be resolved lazily (call the function, never cache at module scope) so
 * an override set early in process startup — e.g. by the Electron main process
 * before spawning workers — is respected by every consumer.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function resolveCoredocHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.COREDOC_HOME?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`COREDOC_HOME must be an absolute path, got: ${configured}`);
    }
    return resolve(configured);
  }
  const home = env.HOME?.trim();
  return join(home && isAbsolute(home) ? home : homedir(), '.coredoc');
}
