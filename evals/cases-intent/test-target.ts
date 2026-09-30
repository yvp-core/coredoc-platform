// evals/cases-intent/test-target.ts
/**
 * A throwaway copy of the intent-eval target, for tests that run the REAL
 * staging/parse machinery.
 *
 * `setup.test.ts` used to exercise `runSetup`/`stageWorkspace` against the
 * shared corpus under `evals/cases-intent/` — so running `pnpm --dir evals test`
 * during a gate run re-staged the workspaces, re-parsed the graph and deleted
 * `setup-result.json` underneath the run. The suite now builds its own target
 * in a temp directory instead: same code paths, same config shape, nothing the
 * gate run depends on.
 *
 * Everything the target derives (workspace, control record, output dir, parser
 * storage, database) hangs off the config path and the workspace root, so
 * overriding those two is enough to move the whole target.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CASES_INTENT_DIR,
  INTENT_TEST_OWNERSHIP_CONTENT,
  INTENT_TEST_OWNERSHIP_MARKER,
  INTENT_TEST_TARGET_PREFIX,
  type IntentEvalTarget,
  resolveIntentEvalTarget,
} from './target.js';

export interface TempIntentTarget {
  /** The temp root holding the config, the workspace, the output and the db. */
  root: string;
  target: IntentEvalTarget;
  /** Removes the temp root. Control workspaces staged from it are separate. */
  cleanup: () => void;
}

/**
 * Build a temp target. The project id stays the fixture's on purpose: it is
 * what keeps `assertFixtureTarget`'s diagnostic refusal out of the way, and the
 * containment guard — not the id — is what decides whether the paths are the
 * harness's to destroy.
 */
export function createTempIntentTarget(): TempIntentTarget {
  const root = mkdtempSync(join(tmpdir(), INTENT_TEST_TARGET_PREFIX));
  writeFileSync(join(root, INTENT_TEST_OWNERSHIP_MARKER), INTENT_TEST_OWNERSHIP_CONTENT, { flag: 'wx' });
  mkdirSync(join(root, 'workspace'), { recursive: true });
  // The checked-in config verbatim: its paths are relative to the config dir,
  // so copying it re-points output, parser storage and the db at the temp root.
  cpSync(join(CASES_INTENT_DIR, 'coredoc.config.json'), join(root, 'coredoc.config.json'));
  // The extraction profile is a FIXTURE, not generated state: without it the
  // parse fails with "Parser not found", so it is copied rather than re-authored.
  cpSync(join(CASES_INTENT_DIR, 'coredoc-parsers'), join(root, 'coredoc-parsers'), { recursive: true });
  const target = resolveIntentEvalTarget({
    ...process.env,
    COREDOC_INTENT_EVAL_PROJECT: undefined,
    COREDOC_INTENT_EVAL_REPO: undefined,
    COREDOC_INTENT_EVAL_REPO_ROOT: undefined,
    COREDOC_INTENT_EVAL_CONFIG: join(root, 'coredoc.config.json'),
    COREDOC_INTENT_EVAL_WORKSPACE_ROOT: join(root, 'workspace'),
  });
  return {
    root,
    target,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
