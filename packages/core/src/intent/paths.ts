import * as path from 'path';

/** Repo-local, git-tracked overlay directory (ADR-1 / D2). */
export const INTENT_DIR_NAME = '.coredoc';
export const INTENT_FILE_NAME = 'intent.json';

export interface IntentPaths {
  /** `<repoRoot>/.coredoc` */
  dir: string;
  /** `<repoRoot>/.coredoc/intent.json` */
  intentJson: string;
}

/**
 * Resolve the intent overlay location for a repository checkout.
 *
 * Pure path math — does not touch the filesystem. The repoRoot must already be
 * absolute: every caller resolves a checkout path before this point, and
 * joining a relative root would silently write the overlay under whatever the
 * process cwd happens to be.
 */
export function intentPathsForRepo(repoRoot: string): IntentPaths {
  if (repoRoot.trim().length === 0) {
    throw new Error('Invalid repoRoot: must be a non-empty absolute path to the repository checkout');
  }
  if (!path.isAbsolute(repoRoot)) {
    throw new Error(`Invalid repoRoot '${repoRoot}': must be an absolute path to the repository checkout`);
  }
  const dir = path.join(repoRoot, INTENT_DIR_NAME);
  return { dir, intentJson: path.join(dir, INTENT_FILE_NAME) };
}
