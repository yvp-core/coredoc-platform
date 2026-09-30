/**
 * `coredoc push --project <id> --cloud` — the project-level cloud publish.
 *
 * THE FRICTION THIS CLOSES. Publishing a project's graph to its workspace used
 * to be `coredoc push <path/to/parsed.json> --remote --workspace-id <id>
 * --rebuild`, repeated per repository: a hand-assembled artifact path plus a
 * workspace id the config already stores. Every one of those is a value the
 * maintainer had to look up and retype, and a mistyped `--workspace-id` is a
 * push into somebody else's workspace.
 *
 * NO SECOND PUBLISH PIPELINE. This resolves the two config facts and then runs
 * the SAME orchestration `coredoc sync` runs — delta check, upsert, upload,
 * push by version, one cross-repo resolve at the end. A parallel implementation
 * would be a second place for the delta rule and the batch-resolve rule to
 * drift, and those rules are the whole value of the path.
 *
 * WHAT IT WILL NOT DO: create or retarget a workspace. `--cloud` publishes into
 * the link the project already carries; linking (and creating) stays
 * `coredoc sync`, which is where the naming flags live. A publish verb that
 * silently created a cloud workspace would make a typo'd project id into a new
 * billable workspace.
 */
import * as fs from 'node:fs';
import type { ProjectConfig, RuntimeConfig } from '@coredoc/core/types';
import { parsedRepoFile } from '@coredoc/core/utils';

/**
 * Flags that mean something on a local or single-repo remote push and nothing
 * here. Refused by name rather than ignored: a maintainer who typed
 * `--cloud --rebuild` believes a full replacement was authorized, and silently
 * dropping it is the difference between a stale graph and a rebuilt one.
 */
const UNSUPPORTED_WITH_CLOUD: ReadonlyArray<{ flag: string; instead: string }> = [
  { flag: '--remote', instead: '`--cloud` IS the remote push; drop `--remote`' },
  {
    flag: '--workspace-id',
    instead: 'the workspace comes from the project link — use `coredoc sync -p <id> --workspace-id <id>` to change it',
  },
  {
    flag: '--rebuild',
    instead: 'the project publish is a delta push; force a full re-push with `coredoc sync -p <id> --force`',
  },
  { flag: '--backend', instead: 'the cloud graph backend is the workspace’s, not a client choice' },
  { flag: '--create-vector-indexes', instead: 'index creation is a local Neo4j concern' },
  {
    flag: '--no-cross-repo',
    instead: 'the cloud resolves cross-repo edges server-side, once, after the batch',
  },
];

/** The flag values `push` collected, in the shape Commander hands them over. */
export interface CloudPushFlags {
  remote?: boolean;
  workspaceId?: string;
  rebuild?: boolean;
  backend?: string;
  createVectorIndexes?: boolean;
  /** Commander's `--no-cross-repo` sets this to `false`. */
  crossRepo?: boolean;
}

/** Throws on the first unsupported flag, naming what to use instead. */
export function assertCloudPushFlags(flags: CloudPushFlags): void {
  const present: Record<string, boolean> = {
    '--remote': flags.remote === true,
    '--workspace-id': flags.workspaceId !== undefined,
    '--rebuild': flags.rebuild === true,
    '--backend': flags.backend !== undefined,
    '--create-vector-indexes': flags.createVectorIndexes === true,
    '--no-cross-repo': flags.crossRepo === false,
  };
  for (const { flag, instead } of UNSUPPORTED_WITH_CLOUD) {
    if (present[flag]) {
      throw new Error(`\`${flag}\` has no meaning with \`--cloud\`: ${instead}.`);
    }
  }
}

export interface LinkedCloudProject {
  project: ProjectConfig;
  workspaceId: string;
}

/**
 * The project and the workspace it is already linked to — or an error saying
 * which of the two is missing.
 *
 * A single-project config needs no `--project`, matching `coredoc sync`; more
 * than one and the id is required, because guessing which product a graph
 * belongs to is not a guess a publish verb gets to make.
 */
export function resolveLinkedCloudProject(config: RuntimeConfig, projectId: string | undefined): LinkedCloudProject {
  if (config.projects.length === 0) throw new Error('Config has no projects.');
  let project: ProjectConfig | undefined;
  if (projectId === undefined) {
    if (config.projects.length > 1) {
      throw new Error(
        `Multiple projects in config; pass --project <id>. Available: ${config.projects.map((p) => p.id).join(', ')}`,
      );
    }
    project = config.projects[0];
  } else {
    project = config.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw new Error(
        `Project "${projectId}" not found. Available: ${config.projects.map((p) => p.id).join(', ') || 'none'}`,
      );
    }
  }

  const workspaceId = project.cloud?.workspaceId;
  if (!workspaceId) {
    throw new Error(
      `Project "${project.id}" is not linked to a cloud workspace. Link it once with ` +
        `\`coredoc sync -p ${project.id}\` (creates or attaches the workspace and records it in the config), ` +
        'then `--cloud` needs no ids.',
    );
  }
  return { project, workspaceId };
}

/**
 * Refuse a publish that has nothing to publish.
 *
 * Without this the per-repo loop reports one "Parsed JSON not found" failure
 * per repository and exits 1 — technically the same verdict, told as N errors
 * about paths instead of one sentence naming the command that produces them.
 */
export function assertProjectHasParsedOutput(config: RuntimeConfig, project: ProjectConfig): void {
  if (project.repos.length === 0) {
    throw new Error(`Project "${project.id}" has no repos to push.`);
  }
  const parsed = project.repos.filter((repo) =>
    fs.existsSync(parsedRepoFile(config.resolvedOutputDir, project.id, repo.name)),
  );
  if (parsed.length === 0) {
    throw new Error(
      `No parsed output for project "${project.id}" under ${config.resolvedOutputDir}. ` +
        `Run \`coredoc parse -p ${project.id}\` first.`,
    );
  }
}
