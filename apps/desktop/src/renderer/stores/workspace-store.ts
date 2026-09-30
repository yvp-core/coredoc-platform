/**
 * Workspace Store - Zustand store for workspace management state
 */

import { create } from 'zustand';
import type { ProjectConfigSerialized, SyncToCloudResult } from '../../shared/ipc-types';
import type { IntentReleaseTrigger } from '../../shared/intent-release-types';
// Mirror of @coredoc/core/utils/repo-ref `parsedRepoFile`. Inlined here because the
// renderer can't import Node-only modules (path) — Node's fs accepts forward slashes
// on every platform, so plain string concatenation is safe. Exported for
// use-cloud-sync's freshness check, which must build the same paths as sync.
export const parsedRepoFile = (outputDir: string, projectId: string, repoName: string): string =>
  `${outputDir}/${projectId}/${repoName}.json`;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
/** Post-write re-read: the write already succeeded, so a failed refresh is logged, never thrown. */
const refreshAfterWrite = async (what: string, refresh: () => Promise<void>): Promise<void> => {
  try {
    await refresh();
  } catch (err) {
    console.warn(`[workspace store] ${what} refresh after write failed:`, (err as Error).message);
  }
};
const isPendingMember = (member: WorkspaceMember): boolean => member.pending || member.userId.startsWith('pending:');

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  workosOrgId?: string;
  createdAt: string;
  role?: string;
  isCloud?: boolean;
  ciCdEnabled?: boolean;
  /** Workspace release trigger (amendment §2); absent on older servers = `manual`. */
  intentReleaseTrigger?: IntentReleaseTrigger;
  /** Per-workspace delivery-intelligence flag; gates the Analytics tab. */
  deliveryEnabled?: boolean;
  /** Per-workspace intent flag; gates the Intent tab. */
  intentEnabled?: boolean;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  pending: boolean;
  joinedAt: string;
}

export interface WorkspaceRepo {
  id: string;
  repoKey: string;
  repoName: string;
  gitUrl: string | null;
  /** Branch whose merges count as production for intent releases; null = connector default. */
  productionBranch?: string | null;
  intentRepoKey?: string | null;
  intentReleaseTrigger?: IntentReleaseTrigger | null;
  createdAt: string;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: string;
  state: 'pending' | 'expired';
  emailSent: boolean;
  createdAt: string;
  invitedAt: string;
  expiresAt: string | null;
  lastSentAt: string | null;
}

export interface InviteMemberResult {
  invited: true;
  emailSent: boolean;
  expiresAt: string | null;
  signInUrl: string;
}

export interface RemoveMemberResult {
  removed: true;
  providerCleanupSucceeded: boolean | null;
}

export interface RevokeInviteResult {
  revoked: true;
  emailRevoked: boolean | null;
}

export interface ResendInviteResult {
  resent: boolean;
  emailSent: boolean;
  expiresAt: string | null;
  signInUrl: string;
}

interface WorkspaceState {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  members: WorkspaceMember[];
  invites: PendingInvite[];
  repos: WorkspaceRepo[];
  loading: boolean;
  error: string | null;
  syncing: boolean;
  syncError: string | null;
  lastSyncResult: SyncToCloudResult | null;

  loadWorkspaces: () => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  createWorkspace: (name: string, slug: string) => Promise<Workspace>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  inviteMember: (email: string, role?: string) => Promise<InviteMemberResult>;
  removeMember: (userId: string) => Promise<RemoveMemberResult>;
  revokeInvite: (invitationId: string) => Promise<RevokeInviteResult>;
  resendInvite: (invitationId: string) => Promise<ResendInviteResult>;
  connectRepo: (repoKey: string, repoName: string, gitUrl?: string) => Promise<void>;
  disconnectRepo: (repoId: string) => Promise<void>;
  syncToCloud: (workspaceId: string, project: ProjectConfigSerialized, force?: boolean) => Promise<SyncToCloudResult>;
  getMcpConfig: (workspaceId: string, tool?: string) => Promise<Record<string, unknown>>;
  updateWorkspaceName: (workspaceId: string, name: string) => Promise<void>;
  updateMemberRole: (userId: string, role: string) => Promise<void>;
  setCiCdEnabled: (enabled: boolean) => Promise<void>;
  setIntentReleaseTrigger: (trigger: IntentReleaseTrigger) => Promise<void>;
  setProductionBranch: (repoKey: string, branch: string | null) => Promise<void>;
  setRepoReleaseTrigger: (repoKey: string, trigger: IntentReleaseTrigger | null) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  selectedWorkspaceId: null,
  members: [],
  invites: [],
  repos: [],
  loading: false,
  error: null,
  syncing: false,
  syncError: null,
  lastSyncResult: null,

  loadWorkspaces: async () => {
    try {
      set({ loading: true, error: null });
      const workspaces = await window.electronAPI.workspaceListWorkspaces();
      set({ workspaces, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  selectWorkspace: async (workspaceId: string) => {
    try {
      set({ loading: true, error: null, selectedWorkspaceId: workspaceId });
      const [members, repos, invites, workspaces] = await Promise.all([
        window.electronAPI.workspaceListMembers(workspaceId),
        window.electronAPI.workspaceListRepos(workspaceId),
        window.electronAPI.workspaceListInvites(workspaceId),
        window.electronAPI.workspaceListWorkspaces(),
      ]);
      set({ members, repos, invites, workspaces, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  createWorkspace: async (name: string, slug: string) => {
    const workspace = await window.electronAPI.workspaceCreateWorkspace(name, slug);
    set((state) => ({ workspaces: [...state.workspaces, workspace] }));
    return workspace;
  },

  deleteWorkspace: async (workspaceId: string) => {
    await window.electronAPI.workspaceDeleteWorkspace(workspaceId);
    set((state) => ({
      workspaces: state.workspaces.filter((t) => t.id !== workspaceId),
      selectedWorkspaceId: state.selectedWorkspaceId === workspaceId ? null : state.selectedWorkspaceId,
    }));
  },

  inviteMember: async (email: string, role?: string) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    const result = await window.electronAPI.workspaceInviteMember(selectedWorkspaceId, email, role);
    // Refresh members and invites
    const [members, invites] = await Promise.all([
      window.electronAPI.workspaceListMembers(selectedWorkspaceId),
      window.electronAPI.workspaceListInvites(selectedWorkspaceId),
    ]);
    set({ members, invites });
    return result;
  },

  removeMember: async (userId: string) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    const result = await window.electronAPI.workspaceRemoveMember(selectedWorkspaceId, userId);
    // The server FK-cascades the invitation when a pending placeholder is removed.
    set((state) => {
      const removed = state.members.find((m) => m.userId === userId);
      // `|| null` matters: an email-less placeholder normalizes to '' and would
      // otherwise match every invite whose email is also blank.
      const pendingEmail = (removed && isPendingMember(removed) ? normalizeEmail(removed.email) : null) || null;
      return {
        members: state.members.filter((m) => m.userId !== userId),
        invites: pendingEmail
          ? state.invites.filter((inv) => normalizeEmail(inv.email) !== pendingEmail)
          : state.invites,
      };
    });
    return result;
  },

  revokeInvite: async (invitationId: string) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    const result = await window.electronAPI.workspaceRevokeInvite(selectedWorkspaceId, invitationId);
    // The server deletes the pending placeholder member along with the invitation.
    set((state) => {
      const revoked = state.invites.find((inv) => inv.id === invitationId);
      const revokedEmail = revoked ? normalizeEmail(revoked.email) : null;
      return {
        invites: state.invites.filter((inv) => inv.id !== invitationId),
        members: revokedEmail
          ? state.members.filter((m) => !(isPendingMember(m) && normalizeEmail(m.email) === revokedEmail))
          : state.members,
      };
    });
    return result;
  },

  resendInvite: async (invitationId: string) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    const result = await window.electronAPI.workspaceResendInvite(selectedWorkspaceId, invitationId);
    const invites = await window.electronAPI.workspaceListInvites(selectedWorkspaceId);
    set({ invites });
    return result;
  },

  connectRepo: async (repoKey: string, repoName: string, gitUrl?: string) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    const repo = await window.electronAPI.workspaceConnectRepo(selectedWorkspaceId, repoKey, repoName, gitUrl);
    set((state) => ({ repos: [...state.repos, repo] }));
  },

  disconnectRepo: async (repoId: string) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    await window.electronAPI.workspaceDisconnectRepo(selectedWorkspaceId, repoId);
    set((state) => ({ repos: state.repos.filter((r) => r.id !== repoId) }));
  },

  syncToCloud: async (workspaceId: string, project: ProjectConfigSerialized, force?: boolean) => {
    set({ syncing: true, syncError: null });
    try {
      const allStates = await window.electronAPI.getAllStates();
      const projectId = project.id;
      const repos = project.repos.map((repo) => ({
        repoName: repo.name,
        parsedRepoPath: parsedRepoFile(allStates.outputDir, projectId, repo.name),
        httpPrefix: repo.httpPrefix,
        // The durable identity the cloud binds intent anchors/seeds on. Dropping
        // it here left a repo with an explicit `repos[].key` permanently unbound.
        key: repo.key,
      }));
      console.log('[syncToCloud store] Calling IPC with:', { workspaceId, repos, force });

      const result = await window.electronAPI.workspaceSyncToCloud(workspaceId, repos, force);
      console.log('[syncToCloud store] Result:', JSON.stringify(result));
      set({ syncing: false, lastSyncResult: result });
      return result;
    } catch (err) {
      console.error('[syncToCloud store] Error:', (err as Error).message);
      set({ syncing: false, syncError: (err as Error).message });
      throw err;
    }
  },

  getMcpConfig: async (workspaceId: string, tool?: string) => {
    return window.electronAPI.workspaceGetMcpConfig(workspaceId, tool);
  },

  updateWorkspaceName: async (workspaceId: string, name: string) => {
    await window.electronAPI.workspaceUpdateName(workspaceId, name);
  },

  updateMemberRole: async (userId: string, role: string) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    await window.electronAPI.workspaceUpdateMemberRole(selectedWorkspaceId, userId, role);
    // Members and invites are two views of the same person while an invitation
    // is pending — mirror the role into the invite so the two can't desync
    // (same email-keyed cascade revoke/remove already do).
    set((state) => {
      const target = state.members.find((m) => m.userId === userId);
      const email = (target ? normalizeEmail(target.email) : '') || null;
      return {
        members: state.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
        invites: email
          ? state.invites.map((inv) => (normalizeEmail(inv.email) === email ? { ...inv, role } : inv))
          : state.invites,
      };
    });
  },

  setCiCdEnabled: async (enabled: boolean) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    await window.electronAPI.workspaceSetCiCdEnabled(selectedWorkspaceId, enabled);
    const workspaces = await window.electronAPI.workspaceListWorkspaces();
    set({ workspaces });
  },

  setIntentReleaseTrigger: async (trigger: IntentReleaseTrigger) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    await window.electronAPI.workspaceSetIntentReleaseTrigger(selectedWorkspaceId, trigger);
    // The write is committed server-side once the PATCH resolves, so apply it
    // locally and keep the list refresh best-effort: a failing GET must not
    // report a saved write as a failure while the stale value stays on screen.
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === selectedWorkspaceId ? { ...w, intentReleaseTrigger: trigger } : w,
      ),
    }));
    await refreshAfterWrite('workspaces', async () => {
      set({ workspaces: await window.electronAPI.workspaceListWorkspaces() });
    });
  },

  setRepoReleaseTrigger: async (repoKey: string, trigger: IntentReleaseTrigger | null) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    await window.electronAPI.workspaceSetRepoReleaseTrigger(selectedWorkspaceId, repoKey, trigger);
    set((state) => ({
      repos: state.repos.map((r) => (r.repoKey === repoKey ? { ...r, intentReleaseTrigger: trigger } : r)),
    }));
    await refreshAfterWrite('repos', async () => {
      set({ repos: await window.electronAPI.workspaceListRepos(selectedWorkspaceId) });
    });
  },

  setProductionBranch: async (repoKey: string, branch: string | null) => {
    const { selectedWorkspaceId } = get();
    if (!selectedWorkspaceId) throw new Error('No workspace selected');
    await window.electronAPI.workspaceSetProductionBranch(selectedWorkspaceId, repoKey, branch);
    // Same as above: committed write first, best-effort refresh second.
    set((state) => ({
      repos: state.repos.map((r) => (r.repoKey === repoKey ? { ...r, productionBranch: branch } : r)),
    }));
    await refreshAfterWrite('repos', async () => {
      set({ repos: await window.electronAPI.workspaceListRepos(selectedWorkspaceId) });
    });
  },
}));
