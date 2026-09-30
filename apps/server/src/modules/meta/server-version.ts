/**
 * Server version facts published by GET /api/v1/meta and the
 * X-Coredoc-Version response header.
 *
 * On-prem servers permanently lag the hosted fleet, so clients need the
 * server's own version plus the oldest client this server still speaks to.
 * The server only publishes facts; each client owns its compatibility verdict.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Oldest desktop/CLI release this server still speaks to. Hand-bumped when an
 * API break lands — nothing derives it, and no client is refused because of it
 * (clients render an advisory banner/warning).
 *
 * Starts at 1.0.0, not the 1.1.0 release line: the CLI reports `VERSION` from
 * @coredoc/core, which is still '1.0.0', and no API break has landed that
 * would make those clients actually incompatible.
 */
export const MIN_CLIENT_VERSION = '1.0.0';

/**
 * Nearest ancestor package.json version, starting at `startDir`. release.yml
 * stamps the tag version into apps/server/package.json before building, so in a
 * released image this is the tag; in dev it is the workspace version.
 */
export function readPackageVersion(startDir: string): string {
  let dir = startDir;
  for (;;) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version.length > 0) return version;
    } catch {
      // No readable package.json at this level — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`No package.json with a "version" found at or above ${startDir}`);
    }
    dir = parent;
  }
}

/** Read once at module init — the file cannot change under a running process. */
export const SERVER_VERSION = readPackageVersion(dirname(fileURLToPath(import.meta.url)));
