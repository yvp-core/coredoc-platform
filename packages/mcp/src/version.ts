import { createRequire } from 'node:module';

/**
 * The MCP server's own `package.json` version. Release CI stamps the tag version into
 * every workspace manifest before building, so this is the real build version —
 * unlike core's hardcoded `VERSION` constant, which never moves.
 *
 * Fallback is intentional and safe: a version read must never crash the server
 * (e.g. a bundle whose relative layout differs); telemetry then reports `unknown`.
 */
export const MCP_VERSION: string = (() => {
  try {
    return String(createRequire(import.meta.url)('../package.json').version);
  } catch {
    return 'unknown';
  }
})();
