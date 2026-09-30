/**
 * Which repository checkout owns a project's intent overlay.
 *
 * Authored once because BOTH read surfaces (CLI `intent *` and the local
 * `get_intent_context` MCP tool) must answer this identically: if they diverged,
 * a maintainer and an agent could read two different files for the same project
 * and neither would notice.
 */
import * as fs from 'fs';
import { StableIdGenerator } from '../id-generator.js';
import { ProjectIntentMode, type CoredocConfig, type ProjectIntentCutover } from '../types/config.js';
import { repoRefKey } from '../utils/repo-ref.js';
import { intentPathsForRepo } from './paths.js';

/**
 * The narrowest projection the write gate needs: project ids and their cutover
 * markers. Deliberately NOT `IntentTargetConfig` — the gate runs before any
 * repo path has to resolve, and a caller must not have to build a runtime
 * config just to ask who owns authority.
 */
export interface LocalIntentWriteConfig {
  projects: Array<{ id: string; intent?: ProjectIntentCutover }>;
}

/**
 * A local intent WRITE refused because a cloud workspace owns authority
 * (spec §8.1).
 *
 * Lifted from the archived `target.ts`, with its `frozen_for_handover` branch
 * deleted: the redesign has no handover state machine, so "frozen" is not a
 * state this build can be in. The message NAMES the owning workspace — the
 * archive's did not, which left a maintainer with a refusal and no next step.
 */
export class IntentLocalWriteBlockedError extends Error {
  constructor(
    readonly projectId: string,
    readonly workspaceId: string,
  ) {
    super(
      `Product intent for project "${projectId}" is cloud-authoritative: workspace ${workspaceId} owns it. ` +
        'Propose and review through the workspace intent tools (cloud MCP or the KB UI). ' +
        'Local CLI reads (status, list, context) show a frozen, non-authoritative snapshot; ' +
        'the local MCP refuses reads too — use the workspace MCP.',
    );
    this.name = 'IntentLocalWriteBlockedError';
  }
}

/**
 * Fail before a local intent mutation can touch the overlay.
 *
 * Called at the entry point of every local intent WRITE verb. An unknown
 * project is NOT this function's refusal to make — the command's own resolution
 * reports it with the available ids — so it passes through silently.
 */
export function assertLocalIntentWritable(config: LocalIntentWriteConfig, projectId: string): void {
  const project = config.projects.find((candidate) => candidate.id === projectId);
  if (project?.intent?.mode !== ProjectIntentMode.Cloud) return;
  throw new IntentLocalWriteBlockedError(projectId, project.intent.workspaceId);
}

/**
 * Which cloud workspace owns a project's intent, or `undefined` while the local
 * overlay is still authoritative. Shared by the CLI read labels and the local
 * `get_intent_context` refusal (LIM-1) so both agree on "cut over".
 */
export interface IntentCloudAuthority {
  workspaceId: string;
}

export function resolveCloudAuthority(
  config: LocalIntentWriteConfig,
  projectId: string,
): IntentCloudAuthority | undefined {
  const intent = config.projects.find((project) => project.id === projectId)?.intent;
  return intent?.mode === ProjectIntentMode.Cloud ? { workspaceId: intent.workspaceId } : undefined;
}

export interface IntentTarget {
  projectId: string;
  repoName: string;
  repoRoot: string;
  /** `<repoRoot>/.coredoc/intent.json` — may or may not exist. */
  intentPath: string;
}

/** Just the parts of `RuntimeConfig` this resolution needs (projects + resolved repo roots). */
export interface IntentTargetConfig extends CoredocConfig {
  resolvedRepoPaths: Map<string, string>;
}

/**
 * Resolve the overlay location for a project.
 *
 * The pilot overlay is repo-local and single-repo (LIM-7). A one-repo project
 * therefore resolves WITHOUT touching the disk — that repo owns the overlay
 * whether or not the file exists yet, which is what lets a caller report
 * `not_configured` against a concrete path.
 *
 * A multi-repo project has no such answer, so we look for the repo that
 * actually carries the file. Zero or several candidates are refused explicitly
 * rather than guessed: silently picking `repos[0]` would report another
 * service's intent (or "not configured") with full confidence. Central,
 * project-level storage is the deferred fix, not a heuristic here.
 */
export function resolveIntentTarget(config: IntentTargetConfig, projectId: string): IntentTarget {
  const project = config.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    const available = config.projects.map((candidate) => candidate.id).join(', ') || 'none';
    throw new Error(`Project "${projectId}" not found. Available projects: ${available}`);
  }
  if (project.repos.length === 0) {
    throw new Error(`Project "${projectId}" has no repos configured.`);
  }

  const candidates = project.repos.map((repo) => {
    const repoRoot = config.resolvedRepoPaths.get(repoRefKey(projectId, repo.name));
    if (!repoRoot) {
      throw new Error(`Repo "${repo.name}" in project "${projectId}" has no resolved path in the config.`);
    }
    return { repoName: repo.name, repoRoot, intentPath: intentPathsForRepo(repoRoot).intentJson };
  });

  if (candidates.length === 1) {
    return { projectId, ...candidates[0] };
  }

  const owning = candidates.filter((candidate) => fs.existsSync(candidate.intentPath));
  if (owning.length === 1) {
    return { projectId, ...owning[0] };
  }
  if (owning.length > 1) {
    throw new Error(
      `Intent overlay ownership is ambiguous in project "${projectId}": ` +
        `${owning.map((candidate) => candidate.repoName).join(', ')} each contain .coredoc/intent.json. ` +
        'The pilot overlay is single-repo (LIM-7) — keep exactly one.',
    );
  }
  throw new Error(
    `Project "${projectId}" has ${candidates.length} repos and none contains .coredoc/intent.json. ` +
      'The pilot overlay is single-repo (LIM-7) — create it in the repo that owns the product intent ' +
      `(${candidates.map((candidate) => candidate.repoName).join(', ')}).`,
  );
}

/** Just the parts of a project config `repoHashesForProject` needs. */
export interface RepoHashProjectConfig {
  repos: Array<{ name: string; key?: string }>;
}

/**
 * The repo-hash map intent-evidence resolution keys anchors by.
 *
 * The hash is `sha256(repo.key ?? repo.name)` — the same canonical key
 * `StableIdGenerator` mints graph-node ids with — and deliberately does NOT
 * depend on whether the repo's filesystem path resolved on this machine. Both
 * the CLI (`coredoc intent status|context`) and the local `get_intent_context`
 * MCP tool call this ONE function so a repo that fails to resolve a local path
 * still gets a hash and can be reported precisely (`missing`, `repo_not_in_project`)
 * instead of silently dropping out of the map on one surface but not the other.
 *
 * `StableIdGenerator` requires a `repoRoot` constructor arg only for
 * file-resolution helpers this call never uses; the hash itself is a pure
 * function of the key, so an empty string is passed for the root.
 */
export function repoHashesForProject(project: RepoHashProjectConfig): Record<string, string> {
  // Null prototype: the keys are config-supplied repo NAMES. On a plain object a
  // repo named `__proto__` writes onto the prototype instead of the map, so it
  // silently vanishes from every lookup — and a repo named `constructor` reads
  // back a truthy inherited member as if it were a hash.
  const repoHashesByName: Record<string, string> = Object.create(null);
  for (const repo of project.repos) {
    repoHashesByName[repo.name] = new StableIdGenerator('', repo.key ?? repo.name).getRepoHash();
  }
  return repoHashesByName;
}
