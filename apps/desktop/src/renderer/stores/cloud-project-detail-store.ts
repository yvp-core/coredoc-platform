/**
 * Cloud Project Detail Store
 *
 * Manages state for cloud member workspaces — fetches repo metadata from
 * the server and builds synthetic RepoDetailState objects that satisfy
 * the "completed" conditions in getRepoStep/deriveRepoStatus.
 */

import { create } from 'zustand';
import type { RepoDetailState, CloudRepoState, LinkedRepo } from '../../shared/ipc-types';

/**
 * Convert a cloud repo state to a synthetic RepoDetailState that shows
 * as "complete" in the wizard/completed view logic.
 */
function cloudRepoToDetailState(cloud: CloudRepoState): RepoDetailState {
  return {
    name: cloud.repoName,
    parserExists: true,
    parserPath: '',
    parsed: { exists: true },
    summarized: { exists: true },
    neo4jSynced: {
      synced: cloud.lastPushedAt !== null,
      timestamp: cloud.lastPushedAt ?? undefined,
    },
    operations: {
      lastPushed: cloud.lastPushedAt ?? undefined,
    },
    approval: {
      approved: true,
      isStale: false,
      outputMatchesParser: true,
    },
  };
}

interface CloudProjectDetailState {
  workspaceId: string | null;
  cloudRepoStates: CloudRepoState[];
  repoDetailStates: Map<string, RepoDetailState>;
  linkedRepos: LinkedRepo[];
  mcpUrl: string | null;
  loading: boolean;

  init: (workspaceId: string) => Promise<void>;
  getLinkedPath: (repoName: string) => string | undefined;
  getLinkedRepoPaths: () => Record<string, string>;
  refreshLinkedRepos: () => Promise<void>;
}

export const useCloudProjectDetailStore = create<CloudProjectDetailState>((set, get) => ({
  workspaceId: null,
  cloudRepoStates: [],
  repoDetailStates: new Map(),
  linkedRepos: [],
  mcpUrl: null,
  loading: false,

  init: async (workspaceId: string) => {
    // Don't re-init if already loaded for this workspace
    if (get().workspaceId === workspaceId && !get().loading && get().cloudRepoStates.length > 0) {
      return;
    }

    set({ loading: true, workspaceId });

    try {
      // Fetch in parallel
      const [cloudStates, mcpConfig, linkedRepos] = await Promise.all([
        window.electronAPI.getCloudRepoStates(workspaceId),
        window.electronAPI.workspaceGetMcpConfig(workspaceId).catch(() => null),
        window.electronAPI.getLinkedRepos(workspaceId),
      ]);

      // Extract MCP URL
      const mcpServers = (mcpConfig as { mcpServers?: { coredoc?: { url?: string } } } | null)?.mcpServers;
      const mcpUrl = mcpServers?.coredoc?.url || null;

      // Build synthetic detail states
      const repoDetailStates = new Map<string, RepoDetailState>();
      for (const cloud of cloudStates) {
        repoDetailStates.set(cloud.repoName, cloudRepoToDetailState(cloud));
      }

      set({
        cloudRepoStates: cloudStates,
        repoDetailStates,
        linkedRepos,
        mcpUrl,
        loading: false,
      });
    } catch (error) {
      console.error('[CloudStore] Failed to init:', error);
      set({ loading: false });
    }
  },

  getLinkedPath: (repoName: string) => {
    const { linkedRepos } = get();
    return linkedRepos.find((r) => r.repoName === repoName)?.localPath;
  },

  getLinkedRepoPaths: () => {
    const { linkedRepos } = get();
    const map: Record<string, string> = {};
    for (const r of linkedRepos) {
      map[r.repoName] = r.localPath;
    }
    return map;
  },

  refreshLinkedRepos: async () => {
    const { workspaceId } = get();
    if (!workspaceId) return;
    const linkedRepos = await window.electronAPI.getLinkedRepos(workspaceId);
    set({ linkedRepos });
  },
}));
