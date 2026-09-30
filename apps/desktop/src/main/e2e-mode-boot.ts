/**
 * Applies the end-to-end harness boundary as an import side effect.
 *
 * MUST be imported first in src/main/index.ts, before any manager module: the
 * managers read app.getPath('userData') at module scope (auth-manager,
 * runtime-paths, docs-manager, …), so a later setPath is silently non-hermetic.
 * No-op unless COREDOC_DESKTOP_E2E=1. Keep this module side-effect-only —
 * production code that needs the flag imports the pure helpers from ./e2e-mode.js.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { app } from 'electron';
import { applyE2EMode, resolveE2EMode } from './e2e-mode.js';
import { setServerUrl } from './server-url.js';

const dirExists = (candidate: string): boolean => existsSync(candidate) && statSync(candidate).isDirectory();

applyE2EMode(
  {
    mkdirRecursive: (path) => {
      mkdirSync(path, { recursive: true });
    },
    setPath: app.setPath.bind(app),
    setServerUrl,
    env: process.env,
  },
  resolveE2EMode(process.env, app.isPackaged, dirExists),
);
