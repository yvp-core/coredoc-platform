import { describe, expect, it } from 'vitest';
import type { PendingInvite, WorkspaceMember } from '../stores/workspace-store';
import { WorkspaceMemberRole } from '../types/workspace-member-role';
import { MemberRoleControl, MemberRowKebab, buildMemberRows } from './member-rows';

// Fixture shapes copy the raw rows the desktop receives untouched over IPC:
// members = Prisma `WorkspaceMember` rows from ControlPlaneService.listMembers
// (workspaceId omitted client-side; `pending` placeholders carry userId
// `pending:<email>`), invites = MembersService.listPendingInvites entries.
const member = (overrides: Partial<WorkspaceMember> = {}): WorkspaceMember => ({
  userId: 'user-owner',
  email: 'owner@example.com',
  displayName: 'Owner Person',
  role: WorkspaceMemberRole.Owner,
  pending: false,
  joinedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const placeholder = (email: string, role: WorkspaceMemberRole = WorkspaceMemberRole.Member): WorkspaceMember =>
  member({ userId: `pending:${email}`, email, displayName: null, role, pending: true });

const invite = (id: string, email: string, role: WorkspaceMemberRole = WorkspaceMemberRole.Member): PendingInvite => ({
  id,
  email,
  role,
  state: 'pending',
  emailSent: true,
  createdAt: '2026-08-05T00:00:00.000Z',
  invitedAt: '2026-08-05T00:00:00.000Z',
  expiresAt: '2026-08-12T00:00:00.000Z',
  lastSentAt: null,
});

const owner = member();
const active = member({
  userId: 'user-member',
  email: 'member@example.com',
  displayName: 'Member Person',
  role: WorkspaceMemberRole.Member,
});

describe('buildMemberRows', () => {
  it('renders one row per email, merging pending placeholders with their invite (S3)', () => {
    const rows = buildMemberRows({
      members: [owner, active, placeholder('invited@example.com')],
      invites: [invite('inv-1', 'invited@example.com')],
      viewer: { workspaceRole: WorkspaceMemberRole.Owner, userId: 'user-owner' },
    });

    expect(rows.map((r) => r.key)).toEqual(['user-owner', 'user-member', 'pending:invited@example.com']);
    const pendingRow = rows[2];
    expect(pendingRow.isPending).toBe(true);
    expect(pendingRow.inviteId).toBe('inv-1');
    expect(pendingRow.kebab).toBe(MemberRowKebab.ResendRevoke);
    expect(pendingRow.roleControl).toBe(MemberRoleControl.Static);
  });

  it('keys rows by userId so duplicate emails stay separate rows', () => {
    const rows = buildMemberRows({
      members: [
        owner,
        member({ userId: 'user-dup-a', email: 'dup@example.com', displayName: 'Dup A' }),
        member({ userId: 'user-dup-b', email: 'dup@example.com', displayName: 'Dup B' }),
      ],
      invites: [],
      viewer: { workspaceRole: WorkspaceMemberRole.Owner, userId: 'user-owner' },
    });

    expect(rows.map((r) => r.key)).toEqual(['user-owner', 'user-dup-a', 'user-dup-b']);
  });

  it('keys email-less members by userId instead of collapsing them', () => {
    const rows = buildMemberRows({
      members: [
        owner,
        member({ userId: 'user-blank-a', email: '', displayName: 'Blank A', role: WorkspaceMemberRole.Member }),
        member({ userId: 'user-blank-b', email: '', displayName: 'Blank B', role: WorkspaceMemberRole.Member }),
      ],
      invites: [],
      viewer: { workspaceRole: WorkspaceMemberRole.Owner, userId: 'user-owner' },
    });

    expect(rows.map((r) => r.key)).toEqual(['user-owner', 'user-blank-a', 'user-blank-b']);
  });

  it('collapses a stale placeholder into the real membership sharing its email', () => {
    const rows = buildMemberRows({
      members: [
        owner,
        placeholder('invited@example.com'),
        member({ userId: 'user-accepted', email: 'Invited@example.com', displayName: 'Accepted Person' }),
      ],
      invites: [invite('inv-1', 'invited@example.com')],
      viewer: { workspaceRole: WorkspaceMemberRole.Owner, userId: 'user-owner' },
    });

    expect(rows.map((r) => r.key)).toEqual(['user-owner', 'user-accepted']);
    expect(rows[1]).toMatchObject({ isPending: false, displayName: 'Accepted Person' });
  });

  it('falls back to a remove kebab for a pending row with no resolvable invite id', () => {
    const rows = buildMemberRows({
      members: [owner, placeholder('invited@example.com')],
      invites: [],
      viewer: { workspaceRole: WorkspaceMemberRole.Owner, userId: 'user-owner' },
    });

    expect(rows[1]).toMatchObject({
      email: 'invited@example.com',
      isPending: true,
      inviteId: undefined,
      kebab: MemberRowKebab.Remove,
    });
  });

  it('treats an unresolvable member role as unmanageable and shows the raw role string', () => {
    const rows = buildMemberRows({
      members: [owner, member({ userId: 'user-weird', email: 'weird@example.com', role: 'billing-admin' })],
      invites: [],
      viewer: { workspaceRole: WorkspaceMemberRole.Owner, userId: 'user-owner' },
    });

    expect(rows[1]).toMatchObject({
      role: undefined,
      roleLabel: 'billing-admin',
      roleControl: MemberRoleControl.Static,
      kebab: MemberRowKebab.None,
    });
  });

  it('normalizes padded and mixed-case wire roles', () => {
    const rows = buildMemberRows({
      members: [owner, member({ userId: 'user-admin', email: 'admin@example.com', role: '  Admin ' })],
      invites: [],
      viewer: { workspaceRole: ' OWNER ', userId: 'user-owner' },
    });

    expect(rows[1]).toMatchObject({
      role: WorkspaceMemberRole.Admin,
      roleLabel: 'Admin',
      roleControl: MemberRoleControl.Select,
      kebab: MemberRowKebab.Remove,
    });
  });

  it('renders a row from an invite that has no placeholder member', () => {
    const rows = buildMemberRows({
      members: [owner],
      invites: [invite('inv-2', 'legacy@example.com', WorkspaceMemberRole.Admin)],
      viewer: { workspaceRole: WorkspaceMemberRole.Owner, userId: 'user-owner' },
    });

    expect(rows[1]).toMatchObject({
      key: 'pending:legacy@example.com',
      userId: 'pending:legacy@example.com',
      email: 'legacy@example.com',
      displayName: null,
      isPending: true,
      role: WorkspaceMemberRole.Admin,
      roleLabel: 'Admin',
      inviteId: 'inv-2',
      kebab: MemberRowKebab.ResendRevoke,
    });
  });

  it('renders the owner row as a static muted label with no kebab for every viewer (S5)', () => {
    for (const workspaceRole of [WorkspaceMemberRole.Owner, WorkspaceMemberRole.Admin, WorkspaceMemberRole.Member]) {
      const rows = buildMemberRows({
        members: [owner, active],
        invites: [],
        viewer: { workspaceRole, userId: 'user-member' },
      });

      expect(rows[0]).toMatchObject({
        role: WorkspaceMemberRole.Owner,
        roleLabel: 'Owner',
        roleControl: MemberRoleControl.Static,
        kebab: MemberRowKebab.None,
      });
    }
  });

  it('renders the viewer own row as static without a kebab', () => {
    const rows = buildMemberRows({
      members: [owner, active],
      invites: [],
      viewer: { workspaceRole: WorkspaceMemberRole.Admin, userId: 'user-member' },
    });

    expect(rows[1]).toMatchObject({
      email: 'member@example.com',
      isSelf: true,
      roleControl: MemberRoleControl.Static,
      kebab: MemberRowKebab.None,
    });
  });

  it('renders every row static without kebabs for a member viewer (S4)', () => {
    const rows = buildMemberRows({
      members: [owner, active, placeholder('invited@example.com')],
      invites: [invite('inv-1', 'invited@example.com')],
      viewer: { workspaceRole: WorkspaceMemberRole.Member, userId: 'user-other' },
    });

    expect(rows.map((r) => r.roleControl)).toEqual([
      MemberRoleControl.Static,
      MemberRoleControl.Static,
      MemberRoleControl.Static,
    ]);
    expect(rows.map((r) => r.kebab)).toEqual([MemberRowKebab.None, MemberRowKebab.None, MemberRowKebab.None]);
  });

  it('renders select + remove on active non-self rows for an admin viewer (S4)', () => {
    const rows = buildMemberRows({
      members: [owner, active],
      invites: [],
      viewer: { workspaceRole: WorkspaceMemberRole.Admin, userId: 'user-admin' },
    });

    expect(rows[1]).toMatchObject({
      userId: 'user-member',
      role: WorkspaceMemberRole.Member,
      roleLabel: 'Member',
      roleControl: MemberRoleControl.Select,
      kebab: MemberRowKebab.Remove,
      isSelf: false,
    });
  });

  it('trusts workspace.role even when the viewer userId matches no member (D4)', () => {
    const rows = buildMemberRows({
      members: [owner, placeholder('invited@example.com')],
      invites: [invite('inv-1', 'invited@example.com')],
      viewer: { workspaceRole: WorkspaceMemberRole.Admin, userId: 'user-not-in-list' },
    });

    expect(rows[0].kebab).toBe(MemberRowKebab.None);
    expect(rows[1].kebab).toBe(MemberRowKebab.ResendRevoke);
    expect(rows.every((r) => r.isSelf === false)).toBe(true);
  });

  it('fails closed on the sole-member fallback: self is identified, privileges are not inherited', () => {
    const rows = buildMemberRows({
      members: [owner, placeholder('invited@example.com')],
      invites: [invite('inv-1', 'invited@example.com')],
      viewer: { userId: 'stale-user-id' },
    });

    expect(rows[0]).toMatchObject({ isSelf: true, roleControl: MemberRoleControl.Static });
    expect(rows[1].kebab).toBe(MemberRowKebab.None);
    expect(rows[1].roleControl).toBe(MemberRoleControl.Static);
  });

  it('derives the viewer role from members when workspace.role is undefined', () => {
    const rows = buildMemberRows({
      members: [owner, active, placeholder('invited@example.com')],
      invites: [],
      viewer: { userId: 'user-member' },
    });

    expect(rows[2].kebab).toBe(MemberRowKebab.None);
    expect(rows[2].roleControl).toBe(MemberRoleControl.Static);
  });

  it('treats an unknown viewer role as non-privileged', () => {
    const rows = buildMemberRows({
      members: [owner, active],
      invites: [],
      viewer: { workspaceRole: 'guest', userId: 'user-other' },
    });

    expect(rows[1].roleControl).toBe(MemberRoleControl.Static);
  });

  it('treats an unrecognized-but-present viewer role as non-privileged even on an exact userId match', () => {
    const admin = member({ userId: 'user-admin', email: 'admin@example.com', role: WorkspaceMemberRole.Admin });
    const rows = buildMemberRows({
      members: [owner, admin, active],
      invites: [],
      viewer: { workspaceRole: 'guest', userId: 'user-admin' },
    });

    expect(rows.map((r) => r.roleControl)).toEqual([
      MemberRoleControl.Static,
      MemberRoleControl.Static,
      MemberRoleControl.Static,
    ]);
    expect(rows.map((r) => r.kebab)).toEqual([MemberRowKebab.None, MemberRowKebab.None, MemberRowKebab.None]);
    expect(rows[1]).toMatchObject({ isSelf: true });
  });

  it('matches placeholders to invites case-insensitively', () => {
    const rows = buildMemberRows({
      members: [owner, placeholder('Invited@Example.com')],
      invites: [invite('inv-3', 'invited@example.com')],
      viewer: { workspaceRole: WorkspaceMemberRole.Owner, userId: 'user-owner' },
    });

    expect(rows).toHaveLength(2);
    expect(rows[1].inviteId).toBe('inv-3');
  });
});
