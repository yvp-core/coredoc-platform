// evals/cases-intent/target.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDbUrl } from '@coredoc/core/utils';

const here = dirname(fileURLToPath(import.meta.url));
const coredocRepoRoot = resolve(here, '..', '..'); // coredoc-parser repo root

/**
 * The checked-in gate corpus (issue-06 D5): a generic widget-ordering fixture
 * repo with its own project id, its own `coredoc.config.json`, and its own
 * graph database under `evals/cases-intent/` — never the maintainer's real
 * workspace. `evals/cases-intent/workspace/` is produced by `setup.ts`; the
 * pristine sources live in `fixture-repo/` and are copied there.
 */
export const FIXTURE_PROJECT_ID = 'intent-eval';
export const FIXTURE_REPO_NAME = 'fixture-repo';
/** Prefix reserved for temp targets created by the eval test helper. */
export const INTENT_TEST_TARGET_PREFIX = 'coredoc-intent-eval-test-';
/** Marker proving a prefix-shaped temp target was created by the test helper. */
export const INTENT_TEST_OWNERSHIP_MARKER = '.coredoc-intent-eval-test-v1';
export const INTENT_TEST_OWNERSHIP_CONTENT = 'owned by coredoc intent eval tests\n';

export interface IntentEvalTarget {
  projectId: string;
  repoName: string;
  /** Parent directory holding the repo checkout(s) the agents see. */
  workspaceRoot: string;
  /** The repository checkout itself — the INTENT arm's and the judge's cwd. */
  repoRoot: string;
  /**
   * `<repoRoot>/.coredoc/intent.json`.
   *
   * There is deliberately no control-checkout field here. The baseline arm runs
   * in a copy of the staged checkout WITHOUT `.coredoc/`, and that copy is
   * created by `setup.ts` in a temp directory outside this repository (a
   * sibling under `cases-intent/` was still reachable by `../..` from the
   * control's cwd). Its path is only knowable after setup ran, so the runner
   * takes it from the recorded `SetupResult`, not from the target.
   */
  intentPath: string;
  configPath: string;
  dbUrl: string;
  mcpServerCommand: string;
  /** MCP project scope handed to the spawned server (`project:<id>`). */
  scope: string;
  /**
   * True when the runner points at anything other than the checked-in fixture
   * (D5's local `cd` arm). A diagnostic target is REPORTED and never gates: its
   * overlay is not in this repository, so its traps are unverifiable here.
   */
  diagnostic: boolean;
}

/**
 * Env-driven so the same tasks can run against the local `cd` overlay as a
 * diagnostic arm (D5) without a second harness. Every field is derived from
 * the config path, so a caller cannot half-point the runner at one project's
 * config and another project's database — the pair that silently reads an
 * empty graph and scores every task zero.
 */
export function resolveIntentEvalTarget(env: NodeJS.ProcessEnv = process.env): IntentEvalTarget {
  const projectId = env.COREDOC_INTENT_EVAL_PROJECT ?? FIXTURE_PROJECT_ID;
  const repoName = env.COREDOC_INTENT_EVAL_REPO ?? FIXTURE_REPO_NAME;
  const configPath = env.COREDOC_INTENT_EVAL_CONFIG ?? join(here, 'coredoc.config.json');
  const workspaceRoot = env.COREDOC_INTENT_EVAL_WORKSPACE_ROOT ?? join(here, 'workspace');
  const repoRoot = env.COREDOC_INTENT_EVAL_REPO_ROOT ?? join(workspaceRoot, repoName);
  const configDir = dirname(resolve(configPath));
  const diagnostic = projectId !== FIXTURE_PROJECT_ID;

  return {
    projectId,
    repoName,
    workspaceRoot,
    repoRoot,
    intentPath: join(repoRoot, '.coredoc', 'intent.json'),
    configPath: resolve(configPath),
    dbUrl: projectDbUrl(configDir, projectId),
    mcpServerCommand: join(coredocRepoRoot, 'packages', 'mcp', 'dist', 'index.js'),
    scope: `project:${projectId}`,
    diagnostic,
  };
}

/** The coredoc-parser checkout that owns the built MCP server and CLI. */
export const COREDOC_REPO_ROOT = coredocRepoRoot;

/** The CLI entry the setup script and preconditions shell out to. */
export const CLI_ENTRY = join(coredocRepoRoot, 'packages', 'cli', 'dist', 'index.js');

/**
 * The one directory setup may create and destroy state inside. Every
 * destructive path checks containment against its REAL path (see
 * `assertFixtureTarget`), because the project id alone does not stop an env
 * override from pointing the fixture project at a real workspace.
 */
export const CASES_INTENT_DIR = here;

/** Pristine fixture sources copied into `workspace/` by `setup.ts`. */
export const FIXTURE_SOURCE_DIR = join(here, 'fixture-repo');

export const intentEvalTarget = resolveIntentEvalTarget();
