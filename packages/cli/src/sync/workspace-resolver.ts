/**
 * Workspace resolution decision tree for `coredoc sync`.
 *
 * Inputs:  the local project's stored cloud link, the --workspace-id flag, the
 *          --rebind flag, and optional --name/--slug overrides used only on create.
 * Output:  { workspaceId, action } where action describes which branch fired
 *          (so the orchestrator knows when to write the config eagerly).
 *
 * Pure-ish: side effects flow through the injected `api`, so unit tests can
 * exercise every branch with stub HTTP.
 */

import type { ProjectConfig, CloudSyncState } from '@coredoc/core/types';
import { createWorkspace, getWorkspace, type CreateWorkspaceResponse } from './workspace-api.js';

export class WorkspaceConflictError extends Error {
  constructor(
    public readonly stored: string,
    public readonly flag: string,
  ) {
    super(`Project is linked to workspace ${stored}; pass --rebind to retarget to ${flag}`);
    this.name = 'WorkspaceConflictError';
  }
}

export interface WorkspaceResolverApi {
  createWorkspace: (body: { name: string; slug: string }) => Promise<CreateWorkspaceResponse>;
  getWorkspace: (workspaceId: string) => Promise<{ id: string; graphBackend?: string }>;
}

export interface ResolveInput {
  project: Pick<ProjectConfig, 'id' | 'name'> & { cloud?: CloudSyncState };
  flag: string | undefined;
  rebind: boolean;
  nameOverride?: string;
  slugOverride?: string;
  /**
   * Plan only — never call `createWorkspace`. When neither a flag nor a stored
   * id exists, return action='would-create' and a placeholder id so the
   * orchestrator can render a dry-run plan without mutating cloud state.
   */
  dryRun?: boolean;
}

export type ResolveAction = 'create' | 'use-stored' | 'use-flag' | 'rebind' | 'would-create';

export interface ResolveResult {
  workspaceId: string;
  action: ResolveAction;
  /** Only set when action='would-create'. Describes what the live run would do. */
  wouldCreate?: { name: string; slug: string };
}

export const defaultResolverApi: WorkspaceResolverApi = {
  createWorkspace,
  getWorkspace,
};

export async function resolveWorkspace(
  input: ResolveInput,
  api: WorkspaceResolverApi = defaultResolverApi,
): Promise<ResolveResult> {
  const stored = input.project.cloud?.workspaceId;
  const flag = input.flag;

  let workspaceId: string;
  let action: ResolveAction;

  if (flag && stored && flag !== stored) {
    if (!input.rebind) throw new WorkspaceConflictError(stored, flag);
    workspaceId = flag;
    action = 'rebind';
  } else if (flag) {
    workspaceId = flag;
    action = 'use-flag';
  } else if (stored) {
    workspaceId = stored;
    action = 'use-stored';
  } else {
    const name = input.nameOverride ?? input.project.name;
    const slug = input.slugOverride ?? input.project.id;
    if (input.dryRun) {
      return {
        workspaceId: `<would-create:${slug}>`,
        action: 'would-create',
        wouldCreate: { name, slug },
      };
    }
    const response = await api.createWorkspace({ name, slug });
    workspaceId = response.id;
    action = 'create';
  }

  // Probe to confirm auth + existence. Skip for create (server just authorized us)
  // and for dry-run (no side effects — the would-create branch returned above).
  if (action !== 'create' && !input.dryRun) {
    await api.getWorkspace(workspaceId);
  }

  return { workspaceId, action };
}
