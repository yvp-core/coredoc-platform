import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LoadedTarget, parseTargetManifestText } from './target-loader.js';

const TARGETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'targets');

/**
 * Load a target manifest that may legitimately be absent.
 *
 * Manifests describing PRIVATE client repositories are deliberately untracked (see the
 * `evals/targets/ignored` rule in .gitignore), so they exist only on a machine that has the
 * corresponding repos checked out. A test that reads one by path therefore cannot be a hard
 * requirement: on CI, on a fresh clone, and for every other contributor the file is simply not
 * there, and `readFileSync` throwing at module scope fails the whole suite.
 *
 * Returns `undefined` when the manifest is absent so the caller can skip, rather than fail.
 * Use with `describe.skipIf(!manifest)` and say in the title which manifest is required.
 */
export function readOptionalTargetManifest(fileName: string): LoadedTarget | undefined {
  const manifestPath = join(TARGETS_DIR, fileName);
  if (!existsSync(manifestPath)) return undefined;
  return parseTargetManifestText(readFileSync(manifestPath, 'utf8'), manifestPath);
}
