import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentReleaseTrigger } from '../../shared/intent-release-types';
import { WorkspaceMemberRole } from '../types/workspace-member-role';
import type { PendingInvite } from './workspace-store';
import { useWorkspaceStore } from './workspace-store';

const pendingInvite: PendingInvite = {
  id: 'invite-1',
  email: 'invited@example.com',
  role: WorkspaceMemberRole.Member,
  state: 'pending',
  emailSent: true,
  createdAt: '2026-08-05T00:00:00.000Z',
  invitedAt: '2026-08-05T00:00:00.000Z',
  expiresAt: '2026-08-12T00:00:00.000Z',
  lastSentAt: null,
};

const electronAPI = {
  workspaceInviteMember: vi.fn(),
  workspaceListMembers: vi.fn(),
  workspaceListInvites: vi.fn(),
  workspaceRemoveMember: vi.fn(),
  workspaceRevokeInvite: vi.fn(),
  workspaceResendInvite: vi.fn(),
  workspaceUpdateMemberRole: vi.fn(),
  workspaceSetIntentReleaseTrigger: vi.fn(),
  workspaceSetProductionBranch: vi.fn(),
  workspaceListWorkspaces: vi.fn(),
  workspaceListRepos: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { electronAPI });
  electronAPI.workspaceListMembers.mockResolvedValue([]);
  electronAPI.workspaceListInvites.mockResolvedValue([]);
  useWorkspaceStore.setState({ selectedWorkspaceId: 'ws-1', members: [], invites: [] });
});

describe('workspace invitation mutation results', () => {
  it('returns manual invitation delivery details to the renderer', async () => {
    const result = {
      invited: true as const,
      emailSent: false,
      expiresAt: '2026-08-19T00:00:00.000Z',
      signInUrl: 'https://coredoc.example.com/api/v1/auth/web/login',
    };
    electronAPI.workspaceInviteMember.mockResolvedValue(result);

    await expect(useWorkspaceStore.getState().inviteMember('person@example.com')).resolves.toEqual(result);
  });

  it('returns provider cleanup failures after applying local removal', async () => {
    electronAPI.workspaceRemoveMember.mockResolvedValue({ removed: true, providerCleanupSucceeded: false });
    electronAPI.workspaceRevokeInvite.mockResolvedValue({ revoked: true, emailRevoked: false });

    await expect(useWorkspaceStore.getState().removeMember('user-1')).resolves.toEqual({
      removed: true,
      providerCleanupSucceeded: false,
    });
    await expect(useWorkspaceStore.getState().revokeInvite('invite-1')).resolves.toEqual({
      revoked: true,
      emailRevoked: false,
    });
  });

  it('drops the pending placeholder member together with the revoked invite', async () => {
    electronAPI.workspaceRevokeInvite.mockResolvedValue({ revoked: true, emailRevoked: true });
    useWorkspaceStore.setState({
      members: [
        {
          userId: 'user-owner',
          email: 'owner@example.com',
          displayName: 'Owner',
          role: WorkspaceMemberRole.Owner,
          pending: false,
          joinedAt: '2026-08-01T00:00:00.000Z',
        },
        {
          userId: 'pending:invited@example.com',
          email: 'invited@example.com',
          displayName: null,
          role: WorkspaceMemberRole.Member,
          pending: true,
          joinedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
      invites: [pendingInvite],
    });

    await useWorkspaceStore.getState().revokeInvite('invite-1');

    const { members, invites } = useWorkspaceStore.getState();
    expect(invites).toEqual([]);
    expect(members.map((m) => m.userId)).toEqual(['user-owner']);
  });

  it('drops the matching invite when a pending member row is removed', async () => {
    electronAPI.workspaceRemoveMember.mockResolvedValue({ removed: true, providerCleanupSucceeded: true });
    useWorkspaceStore.setState({
      members: [
        {
          userId: 'pending:invited@example.com',
          email: 'invited@example.com',
          displayName: null,
          role: WorkspaceMemberRole.Member,
          pending: true,
          joinedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
      invites: [pendingInvite],
    });

    await useWorkspaceStore.getState().removeMember('pending:invited@example.com');

    const { members, invites } = useWorkspaceStore.getState();
    expect(members).toEqual([]);
    expect(invites).toEqual([]);
  });

  it('keeps unrelated invites when an active member is removed', async () => {
    electronAPI.workspaceRemoveMember.mockResolvedValue({ removed: true, providerCleanupSucceeded: true });
    useWorkspaceStore.setState({
      members: [
        {
          userId: 'user-member',
          email: 'member@example.com',
          displayName: 'Member',
          role: WorkspaceMemberRole.Member,
          pending: false,
          joinedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
      invites: [pendingInvite],
    });

    await useWorkspaceStore.getState().removeMember('user-member');

    expect(useWorkspaceStore.getState().invites).toEqual([pendingInvite]);
  });

  it('keeps unrelated invites when an email-less placeholder is removed', async () => {
    electronAPI.workspaceRemoveMember.mockResolvedValue({ removed: true, providerCleanupSucceeded: true });
    useWorkspaceStore.setState({
      members: [
        {
          userId: 'pending:',
          email: '   ',
          displayName: null,
          role: WorkspaceMemberRole.Member,
          pending: true,
          joinedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
      invites: [pendingInvite, { ...pendingInvite, id: 'invite-2', email: '' }],
    });

    await useWorkspaceStore.getState().removeMember('pending:');

    expect(useWorkspaceStore.getState().invites.map((i) => i.id)).toEqual(['invite-1', 'invite-2']);
  });

  it('mirrors a role change into the matching pending invite', async () => {
    electronAPI.workspaceUpdateMemberRole.mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      members: [
        {
          userId: 'pending:invited@example.com',
          email: 'Invited@Example.com',
          displayName: null,
          role: WorkspaceMemberRole.Member,
          pending: true,
          joinedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
      invites: [pendingInvite, { ...pendingInvite, id: 'invite-2', email: 'other@example.com' }],
    });

    await useWorkspaceStore.getState().updateMemberRole('pending:invited@example.com', WorkspaceMemberRole.Admin);

    const { members, invites } = useWorkspaceStore.getState();
    expect(members[0].role).toBe(WorkspaceMemberRole.Admin);
    expect(invites.map((i) => [i.id, i.role])).toEqual([
      ['invite-1', WorkspaceMemberRole.Admin],
      ['invite-2', WorkspaceMemberRole.Member],
    ]);
  });

  it('leaves invites untouched when the role-changed member has no email', async () => {
    electronAPI.workspaceUpdateMemberRole.mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      members: [
        {
          userId: 'user-blank',
          email: '',
          displayName: 'Blank',
          role: WorkspaceMemberRole.Member,
          pending: false,
          joinedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
      invites: [{ ...pendingInvite, email: '' }],
    });

    await useWorkspaceStore.getState().updateMemberRole('user-blank', WorkspaceMemberRole.Admin);

    expect(useWorkspaceStore.getState().invites[0].role).toBe(WorkspaceMemberRole.Member);
  });

  it('returns a renewed manual sign-in link after resend', async () => {
    const result = {
      resent: false,
      emailSent: false,
      expiresAt: '2026-08-19T00:00:00.000Z',
      signInUrl: 'https://coredoc.example.com/api/v1/auth/web/login',
    };
    electronAPI.workspaceResendInvite.mockResolvedValue(result);

    await expect(useWorkspaceStore.getState().resendInvite('invite-1')).resolves.toEqual(result);
  });
});

describe('committed writes survive a failed refresh', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: [{ id: 'ws-1', name: 'Acme', slug: 'acme', createdAt: '2026-09-01T00:00:00.000Z' }],
      repos: [
        {
          id: 'repo-1',
          repoKey: 'backend',
          repoName: 'backend',
          gitUrl: null,
          productionBranch: null,
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('keeps the saved release trigger when the workspace re-read fails', async () => {
    electronAPI.workspaceSetIntentReleaseTrigger.mockResolvedValue(undefined);
    electronAPI.workspaceListWorkspaces.mockRejectedValue(new Error('Network unreachable'));

    await expect(
      useWorkspaceStore.getState().setIntentReleaseTrigger(IntentReleaseTrigger.Deploy),
    ).resolves.toBeUndefined();

    expect(useWorkspaceStore.getState().workspaces[0].intentReleaseTrigger).toBe(IntentReleaseTrigger.Deploy);
  });

  it('keeps the saved production branch when the repo re-read fails', async () => {
    electronAPI.workspaceSetProductionBranch.mockResolvedValue(undefined);
    electronAPI.workspaceListRepos.mockRejectedValue(new Error('Network unreachable'));

    await expect(useWorkspaceStore.getState().setProductionBranch('backend', 'release')).resolves.toBeUndefined();

    expect(useWorkspaceStore.getState().repos[0].productionBranch).toBe('release');
  });
});
