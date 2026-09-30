import { createRequire } from 'node:module';

/** Baked in by `scripts/build-cli-bundle.mjs` (esbuild `define`); undeclared everywhere else. */
declare const __COREDOC_CLI_VERSION__: string | undefined;

/**
 * The CLI's own version. Release CI stamps the tag version into every workspace
 * manifest before building, so this is the real build version — unlike core's
 * hardcoded `VERSION` constant, which never moves.
 *
 * Two sources, in order:
 *  1. the compile-time constant, for the single-file CI bundle — it runs from a
 *     temp dir with no `package.json` beside it;
 *  2. the package's own `package.json`, for the tsc dist (npm / docker / desktop).
 *
 * Fallback to `unknown` is intentional and safe: a version read must never crash
 * a command; telemetry then reports `unknown`.
 */
export const CLI_VERSION: string = (() => {
  if (typeof __COREDOC_CLI_VERSION__ === 'string') {
    return __COREDOC_CLI_VERSION__;
  }
  try {
    return String(createRequire(import.meta.url)('../package.json').version);
  } catch {
    return 'unknown';
  }
})();
