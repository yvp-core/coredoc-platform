import type { PendingInvite, WorkspaceMember } from '../stores/workspace-store';
import { WorkspaceMemberRole, isWorkspaceAdminRole, toWorkspaceMemberRole } from '../types/workspace-member-role';

export enum MemberRoleControl {
  Select = 'select',
  Static = 'static',
}

export enum MemberRowKebab {
  None = 'none',
  ResendRevoke = 'resend-revoke',
  Remove = 'remove',
}

export interface MemberRowDescriptor {
  /** React key = `userId` (synthesized `pending:<email>` for invite-only rows). */
  key: string;
  userId: string;
  email: string;
  displayName: string | null;
  isPending: boolean;
  isSelf: boolean;
  /** `undefined` when the wire role is not one this client knows — fail closed. */
  role: WorkspaceMemberRole | undefined;
  roleLabel: string;
  roleControl: MemberRoleControl;
  kebab: MemberRowKebab;
  inviteId?: string;
}

export interface MemberRowsViewer {
  workspaceRole?: string;
  userId?: string | null;
}

export interface MemberRowsInput {
  members: WorkspaceMember[];
  invites: PendingInvite[];
  viewer: MemberRowsViewer;
}

const ROLE_LABEL: Record<WorkspaceMemberRole, string> = {
  [WorkspaceMemberRole.Owner]: 'Owner',
  [WorkspaceMemberRole.Admin]: 'Admin',
  [WorkspaceMemberRole.Member]: 'Member',
};

const emailKey = (email: string): string => email.trim().toLowerCase();

const isPendingMember = (member: WorkspaceMember): boolean => member.pending || member.userId.startsWith('pending:');

/**
 * Viewer identity: an exact userId match when the member list contains it,
 * otherwise the sole real member — pending placeholders no longer break this
 * fallback the way a plain `members.length === 1` check did, and an
 * authoritative `workspace.role` that contradicts the candidate rejects it.
 *
 * The fallback fails closed: without an authoritative `workspace.role` AND
 * without an exact userId match we only guess *who* the viewer is (so their own
 * row renders as self), never *what they may do* — the guessed identity gets
 * plain Member-level viewing, so a misidentification can't hand out manage
 * affordances.
 */
function resolveViewer(
  members: WorkspaceMember[],
  viewer: MemberRowsViewer,
): { selfUserId?: string; role?: WorkspaceMemberRole } {
  const authoritativeRole =
    viewer.workspaceRole === undefined ? undefined : toWorkspaceMemberRole(viewer.workspaceRole);
  const exact = viewer.userId ? members.find((m) => m.userId === viewer.userId) : undefined;
  if (exact) {
    return {
      selfUserId: exact.userId,
      role: viewer.workspaceRole === undefined ? toWorkspaceMemberRole(exact.role) : authoritativeRole,
    };
  }

  const realMembers = members.filter((m) => !isPendingMember(m));
  const candidate = realMembers.length === 1 ? realMembers[0] : undefined;
  if (!candidate) return { role: authoritativeRole };
  if (viewer.workspaceRole !== undefined) {
    return toWorkspaceMemberRole(candidate.role) === authoritativeRole
      ? { selfUserId: candidate.userId, role: authoritativeRole }
      : { role: authoritativeRole };
  }
  return { selfUserId: candidate.userId, role: WorkspaceMemberRole.Member };
}

export function buildMemberRows({ members, invites, viewer }: MemberRowsInput): MemberRowDescriptor[] {
  const { selfUserId, role: viewerRole } = resolveViewer(members, viewer);
  const viewerCanManage = isWorkspaceAdminRole(viewerRole);

  const inviteByEmail = new Map(invites.map((invite) => [emailKey(invite.email), invite]));
  // Email is the *merge* lookup only — never the row key: duplicate and empty
  // emails are both real on the wire and would collide.
  const realEmails = new Set(
    members
      .filter((m) => !isPendingMember(m))
      .map((m) => emailKey(m.email))
      .filter(Boolean),
  );
  const seenEmails = new Set<string>();
  const rows: MemberRowDescriptor[] = [];

  for (const member of members) {
    const email = emailKey(member.email);
    const pending = isPendingMember(member);
    // An expired invitation's placeholder can outlive the real membership that
    // later replaced it — collapse it into the real row rather than duplicate.
    if (pending && email && realEmails.has(email)) continue;
    if (email) seenEmails.add(email);
    rows.push(
      descriptor({
        key: member.userId,
        userId: member.userId,
        email: member.email,
        displayName: member.displayName,
        rawRole: member.role,
        isPending: pending,
        isSelf: member.userId === selfUserId,
        inviteId: pending ? inviteByEmail.get(email)?.id : undefined,
        viewerCanManage,
      }),
    );
  }

  for (const invite of invites) {
    const email = emailKey(invite.email);
    if (email && seenEmails.has(email)) continue;
    if (email) seenEmails.add(email);
    const synthUserId = `pending:${email}`;
    rows.push(
      descriptor({
        key: synthUserId,
        userId: synthUserId,
        email: invite.email,
        displayName: null,
        rawRole: invite.role,
        isPending: true,
        isSelf: false,
        inviteId: invite.id,
        viewerCanManage,
      }),
    );
  }

  return rows;
}

function descriptor(
  row: Omit<MemberRowDescriptor, 'role' | 'roleLabel' | 'roleControl' | 'kebab'> & {
    rawRole: string;
    viewerCanManage: boolean;
  },
): MemberRowDescriptor {
  const { viewerCanManage, rawRole, ...base } = row;
  const role = toWorkspaceMemberRole(rawRole);
  // A role this client can't narrow is unmanageable: rendering a Select over it
  // would silently rewrite an unknown role to Member on the first change.
  const managed = viewerCanManage && !base.isSelf && role !== undefined && role !== WorkspaceMemberRole.Owner;
  return {
    ...base,
    role,
    roleLabel: role ? ROLE_LABEL[role] : rawRole,
    // Pending rows carry the role their *invitation* was issued with; changing
    // it is a revoke-and-reinvite, not a member mutation — static label only.
    roleControl: managed && !base.isPending ? MemberRoleControl.Select : MemberRoleControl.Static,
    kebab: !managed
      ? MemberRowKebab.None
      : // No resolvable invitation to resend or revoke — removing the placeholder
        // member FK-cascades the invitation server-side, so offer that instead.
        base.isPending && base.inviteId
        ? MemberRowKebab.ResendRevoke
        : MemberRowKebab.Remove,
  };
}
