/**
 * Load `<repo-root>/.env` into `process.env` without overwriting any variable
 * already set (shell/CI wins). Returns the loaded path, or `null` when the repo
 * root or its `.env` is absent. See `load-root-env.mjs` for behavior.
 */
export function loadRootEnv(startDir: string): string | null;
