/**
 * Observed local checkouts for a cloud intent context read (spec §6.3, issue
 * v1.1-04).
 *
 * WHAT IT BUYS. Without an observed checkout the server can only report the
 * snapshot it read from; it may never claim freshness, so every repo comes back
 * `unverified` and the detail pane can never say `stale`. With one, the server
 * compares the workspace's graph commit against what the user actually has and
 * answers `current`/`stale` per repo. The desktop is the one client that knows
 * both halves, so it is the one that can close this.
 *
 * WHERE IT RUNS. MAIN PROCESS ONLY. The renderer never asks for git state and
 * never receives it: `intent:getContext` appends the parameter on its way out,
 * so a compromised or merely curious renderer learns nothing about the local
 * worktree that it did not already know.
 *
 * THE GRAMMAR IS THE SERVER'S. `<repoKey>@<commit>[:dirty]`, split at the LAST
 * `@` because a durable repo key may contain one, hex commit, lower-cased. A
 * value that does not match is REFUSED by `parseObserved` rather than ignored,
 * so this module emits nothing it has not verified — a malformed entry would
 * fail the whole read, and an omitted one merely stays `unverified`.
 *
 * OMISSION IS THE FAILURE MODE, ALWAYS. A repo with no local mapping, a path
 * that is not a git checkout, a git binary that is missing, a timeout: each
 * yields no entry for that repo, logged at debug. Freshness is never asserted by
 * omission (§6.3), so the honest degradation is exactly "we said nothing about
 * this repo", and a read must never fail because a worktree was unreadable.
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getCurrentConfig, getConfigDir } from './config-manager.js';

const execFileAsync = promisify(execFile);

/** Mirrors `capture-repository-key.ts`'s runner seam: injected in tests, never real git there. */
export type ObservedGitRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeout: number; encoding: 'utf8' },
) => Promise<{ stdout: string }>;

const defaultRunner: ObservedGitRunner = async (executable, args, options) => {
  const { stdout } = await execFileAsync(executable, args, options);
  return { stdout };
};

const GIT_TIMEOUT_MS = 3_000;

/**
 * The server's `INTENT_CONTEXT_READ_LIMITS.observed`. Exceeding it does not
 * degrade the answer — it REFUSES the whole read — so a project with more repos
 * than this reports the first ones and leaves the rest `unverified`, which is
 * the failure mode this module already has for a repo it cannot read.
 */
const MAX_OBSERVED_REPOS = 20;

/** The server's own commit shape (`OBSERVED_COMMIT`); anything else is not emitted. */
const COMMIT = /^[0-9a-f]{7,64}$/;

/** One repo the desktop can observe: its durable intent key and its checkout. */
export interface ObservedRepo {
  repoKey: string;
  repoPath: string;
}

/** Default sink: callers that pass no logger accept the omission silently. */
const discard = (_line: string): void => {
  // Intentionally does nothing — an unreadable checkout is a non-event here.
};

/**
 * Per-PATH cache for the session. Keyed by path rather than by repo key because
 * the same checkout can be registered under two workspaces, and the git answer
 * is a property of the worktree. Invalidated wholesale by
 * {@link invalidateObservedCheckouts} — a manual refresh means "read git again",
 * not "read git again for one repo".
 */
const cache = new Map<string, string>();

/**
 * The resolutions currently running, keyed by the same path.
 *
 * Two context reads in flight at once (the detail pane and a by-id read, say)
 * both miss the cache — which is only written after git answers — and both
 * spawned their own `git rev-parse` + `git status`. Sharing the pending promise
 * makes it one pair of spawns per checkout however many callers ask.
 */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Generation of the cache. A resolution that started BEFORE an invalidate must
 * not write its answer afterwards: that is exactly the stale value the manual
 * refresh was asking to get rid of.
 */
let generation = 0;

/** Drop every cached checkout state; the next read re-runs git. */
export function invalidateObservedCheckouts(): void {
  generation += 1;
  cache.clear();
  inFlight.clear();
}

/**
 * The repos of the project bound to `workspaceId`, with absolute paths.
 *
 * The mapping is the local config's: a project carries `cloud.workspaceId`, and
 * its repos carry the durable intent key (`repos[].key ?? repos[].name`) that
 * anchors and seeds address — the same key `buildRepoIntentIdentity` proves to
 * the server on connect. A workspace with no local project (an invited member
 * who never cloned anything) maps to nothing, which is the honest answer.
 */
export function observedReposForWorkspace(workspaceId: string): ObservedRepo[] {
  const config = getCurrentConfig();
  const configDir = getConfigDir();
  if (!config || !configDir) return [];
  const project = config.projects.find((candidate) => candidate.cloud?.workspaceId === workspaceId);
  if (!project) return [];
  return project.repos.map((repo) => ({
    repoKey: repo.key ?? repo.name,
    repoPath: path.resolve(configDir, repo.path),
  }));
}

/**
 * `"<commit>"` or `"<commit>:dirty"` for one checkout, or null when git could
 * not answer. Cached per path for the session, and COALESCED while it runs:
 * concurrent callers share one resolution instead of each spawning git.
 */
function readCheckoutState(
  repoPath: string,
  runner: ObservedGitRunner,
  log: (line: string) => void,
): Promise<string | null> {
  const cached = cache.get(repoPath);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inFlight.get(repoPath);
  if (pending !== undefined) return pending;
  const resolution = spawnCheckoutState(repoPath, runner, log).finally(() => {
    // Whatever the answer was, the next caller starts from the cache or from a
    // fresh spawn — never from a settled promise nobody can read again.
    if (inFlight.get(repoPath) === resolution) inFlight.delete(repoPath);
  });
  inFlight.set(repoPath, resolution);
  return resolution;
}

async function spawnCheckoutState(
  repoPath: string,
  runner: ObservedGitRunner,
  log: (line: string) => void,
): Promise<string | null> {
  const startedAt = generation;
  try {
    const options = { cwd: repoPath, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' as const };
    const head = (await runner('git', ['rev-parse', 'HEAD'], options)).stdout.trim().toLowerCase();
    if (!COMMIT.test(head)) {
      log(`[intent-observed] "${repoPath}" did not answer a commit for HEAD — omitting it from the read.`);
      return null;
    }
    // `--porcelain` is empty exactly when the worktree and index are clean; any
    // line at all (tracked edit, staged change, untracked file) makes it dirty,
    // which is what the server's `:dirty` suffix means.
    const status = (await runner('git', ['status', '--porcelain'], options)).stdout.trim();
    const state = status === '' ? head : `${head}:dirty`;
    if (startedAt === generation) cache.set(repoPath, state);
    return state;
  } catch (error) {
    log(`[intent-observed] git could not read "${repoPath}" (${String(error)}) — omitting it from the read.`);
    return null;
  }
}

/**
 * The `observed` parameter values for one workspace, one per repo the desktop
 * could actually read. Never throws: an unreadable repo is dropped, and a
 * workspace whose repos are all unreadable yields an empty array, which the
 * caller sends as nothing at all.
 */
export async function resolveObservedCheckouts(
  workspaceId: string,
  runner: ObservedGitRunner = defaultRunner,
  log: (line: string) => void = discard,
): Promise<string[]> {
  const observed: string[] = [];
  const repos = observedReposForWorkspace(workspaceId);
  if (repos.length > MAX_OBSERVED_REPOS) {
    log(
      `[intent-observed] project has more repos than the server's observed limit (${MAX_OBSERVED_REPOS}) — ` +
        'the rest stay unverified.',
    );
  }
  for (const repo of repos.slice(0, MAX_OBSERVED_REPOS)) {
    const state = await readCheckoutState(repo.repoPath, runner, log);
    if (state !== null) observed.push(`${repo.repoKey}@${state}`);
  }
  return observed;
}
