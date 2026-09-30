import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useAuthStore } from '../../stores/auth-store';
import { Badge } from '../ui/badge';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '../ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { CheckCircle, CloseCircle, Copy, MenuDots } from '@solar-icons/react';
import { cn } from '../../lib/utils';
import { buildMemberRows, MemberRoleControl, MemberRowKebab, type MemberRowDescriptor } from '../../lib/member-rows';
import { WorkspaceMemberRole } from '../../types/workspace-member-role';

export interface ManualInviteLink {
  email: string;
  signInUrl: string;
  expiresAt: string | null;
}

interface TeamMcpInviteStepProps {
  chips: string[];
  onChipsChange: (chips: string[]) => void;
  inviteRole: string;
  onInviteRoleChange: (role: string) => void;
  manualInviteLinks: ManualInviteLink[];
  /**
   * Authoritative viewer role (`workspace.role`). Optional: hosts that don't
   * know it (the wizard) fall back to the members-derived role inside
   * `buildMemberRows`.
   */
  viewerWorkspaceRole?: string;
}

const AVATAR_PALETTE = [
  { circle: 'bg-bg-tag-success', letter: 'text-brand-600' },
  { circle: 'bg-bg-tag-warning', letter: 'text-content-tag-warning' },
];

function avatarPalette(key: string) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 997;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function ManualInviteLinks({ links }: { links: ManualInviteLink[] }) {
  const [copied, setCopied] = useState<string | null>(null);

  if (links.length === 0) return null;

  const copyLink = async (link: string) => {
    await navigator.clipboard.writeText(link);
    setCopied(link);
    setTimeout(() => setCopied((current) => (current === link ? null : current)), 1500);
  };

  return (
    <output className="block rounded-lg border border-border-controls bg-bg-overlay p-3">
      <p className="text-xs text-content-secondary">
        No invitation email provider is configured. Share each sign-in link before its pending invite expires.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {links.map((link) => (
          <div key={`${link.email}:${link.signInUrl}`} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-content-primary">
              {link.email}
              {link.expiresAt ? ` · expires ${new Date(link.expiresAt).toLocaleString()}` : ''}
            </span>
            <div className="flex items-center gap-2">
              <input
                readOnly
                aria-label={`Sign-in link for ${link.email}`}
                value={link.signInUrl}
                className="min-w-0 flex-1 rounded-md border border-border-controls bg-bg-primary px-2 py-1 text-xs text-content-secondary"
              />
              <button
                type="button"
                aria-label={`Copy sign-in link for ${link.email}`}
                onClick={() => copyLink(link.signInUrl)}
                className="inline-flex items-center gap-1 text-xs text-content-secondary hover:underline cursor-pointer"
              >
                {copied === link.signInUrl ? <CheckCircle size={14} /> : <Copy size={14} />}
                {copied === link.signInUrl ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </output>
  );
}

export function TeamMcpInviteStep({
  chips,
  onChipsChange,
  inviteRole,
  onInviteRoleChange,
  manualInviteLinks,
  viewerWorkspaceRole,
}: TeamMcpInviteStepProps) {
  const [emailInput, setEmailInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [renewedManualLinks, setRenewedManualLinks] = useState<Record<string, ManualInviteLink>>({});
  const [dismissedManualEmails, setDismissedManualEmails] = useState<Set<string>>(() => new Set());
  const { members, invites, removeMember, revokeInvite, resendInvite, updateMemberRole } = useWorkspaceStore();
  const { userId, email: authEmail } = useAuthStore();

  const rows = useMemo(() => {
    const enriched = members.map((m) =>
      m.userId === userId && !m.email && authEmail ? { ...m, email: authEmail } : m,
    );
    return buildMemberRows({ members: enriched, invites, viewer: { workspaceRole: viewerWorkspaceRole, userId } });
  }, [members, invites, userId, authEmail, viewerWorkspaceRole]);

  const addChip = useCallback(
    (email: string) => {
      const trimmed = email.trim().toLowerCase();
      if (trimmed.includes('@') && !chips.includes(trimmed)) {
        onChipsChange([...chips, trimmed]);
      }
      setEmailInput('');
    },
    [chips, onChipsChange],
  );

  const removeChip = useCallback(
    (email: string) => {
      onChipsChange(chips.filter((e) => e !== email));
    },
    [chips, onChipsChange],
  );

  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if ((e.key === 'Enter' || e.key === ',') && emailInput.trim()) {
        e.preventDefault();
        addChip(emailInput);
      } else if (e.key === 'Backspace' && !emailInput && chips.length > 0) {
        onChipsChange(chips.slice(0, -1));
      }
    },
    [emailInput, chips, addChip, onChipsChange],
  );

  const handleRemoveMember = async (memberId: string) => {
    try {
      const result = await removeMember(memberId);
      setNotice(
        result.providerCleanupSucceeded === false
          ? 'Member was removed from Coredoc, but WorkOS organization cleanup failed. Remove the membership in WorkOS.'
          : null,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to remove member');
    }
  };

  const handleRoleChange = async (memberId: string, role: string) => {
    try {
      await updateMemberRole(memberId, role);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to update member role');
    }
  };

  const handleRevokeInvite = async (invitationId: string, email: string) => {
    try {
      const result = await revokeInvite(invitationId);
      setDismissedManualEmails((current) => new Set(current).add(email));
      setRenewedManualLinks((current) => {
        const { [invitationId]: _, ...remaining } = current;
        return remaining;
      });
      setNotice(
        result.emailRevoked === false
          ? 'Invite was revoked in Coredoc, but its WorkOS invitation could not be revoked. Remove it in WorkOS.'
          : null,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to revoke invite');
    }
  };

  const handleResendInvite = async (invitationId: string, email: string) => {
    try {
      const result = await resendInvite(invitationId);
      setNotice(null);
      if (!result.emailSent) {
        setDismissedManualEmails((current) => {
          const next = new Set(current);
          next.delete(email);
          return next;
        });
        setRenewedManualLinks((current) => ({
          ...current,
          [invitationId]: { email, signInUrl: result.signInUrl, expiresAt: result.expiresAt },
        }));
      } else {
        setRenewedManualLinks((current) => {
          const { [invitationId]: _, ...remaining } = current;
          return remaining;
        });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to resend invite');
    }
  };

  const visibleManualLinks = [...manualInviteLinks, ...Object.values(renewedManualLinks)].filter(
    (link) => !dismissedManualEmails.has(link.email),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1">
        <div className="flex-1 flex flex-wrap items-center gap-1.5 px-3 py-1.5 min-h-8 border border-alto-300 rounded-lg bg-bg-input shadow-field focus-within:border-border-secondary-selected focus-within:ring-ring/30 focus-within:ring-2">
          {chips.map((chip) => (
            <span
              key={chip}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-bg-tag-initial text-xs text-content-primary"
            >
              {chip}
              <button type="button" onClick={() => removeChip(chip)} className="text-content-primary cursor-pointer">
                <CloseCircle className="size-4" />
              </button>
            </span>
          ))}
          <input
            type="text"
            placeholder={chips.length === 0 ? 'Enter email' : ''}
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            onKeyDown={handleInputKeyDown}
            onBlur={() => emailInput.trim() && addChip(emailInput)}
            className="flex-1 min-w-[120px] bg-transparent text-sm font-medium leading-5 text-content-primary outline-none placeholder:font-medium placeholder:text-content-quaternary"
          />
        </div>
        <Select value={inviteRole} onValueChange={onInviteRoleChange}>
          <SelectTrigger className="h-8 w-[120px] shrink-0 border-alto-300 bg-bg-primary px-3 py-1.5 text-sm font-semibold leading-5 text-content-secondary">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={WorkspaceMemberRole.Admin}>Admin</SelectItem>
            <SelectItem value={WorkspaceMemberRole.Member}>Member</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ManualInviteLinks links={visibleManualLinks} />

      {notice && (
        <p
          className="rounded-md border border-content-warning/30 bg-content-warning/10 px-3 py-2 text-xs text-content-warning"
          role="alert"
        >
          {notice}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium leading-4 text-content-quaternary">People with access</span>
        {rows.map((row) => (
          <MemberRow
            key={row.key}
            row={row}
            onRoleChange={(role) => void handleRoleChange(row.userId, role)}
            onRemove={() => void handleRemoveMember(row.userId)}
            onResend={() => row.inviteId && void handleResendInvite(row.inviteId, row.email)}
            onRevoke={() => row.inviteId && void handleRevokeInvite(row.inviteId, row.email)}
          />
        ))}
      </div>
    </div>
  );
}

interface MemberRowProps {
  row: MemberRowDescriptor;
  onRoleChange: (role: string) => void;
  onRemove: () => void;
  onResend: () => void;
  onRevoke: () => void;
}

function MemberRow({ row, onRoleChange, onRemove, onResend, onRevoke }: MemberRowProps) {
  const palette = avatarPalette(row.key);
  // The email IS the identity here: it is what you typed to invite the person and
  // what you would type to find them again, so the design puts it on the row alone.
  // A display name is a second string for the same person that pushes every row to
  // two lines. The name is still the avatar's letter when we have one, and the
  // userId remains the last resort so a row never renders as an empty line.
  const label = row.email.trim() || row.userId;
  const initial = (row.displayName?.trim() || label).charAt(0).toUpperCase() || '?';

  return (
    <div className="flex h-9 items-center gap-2 py-0.5">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold leading-5',
          palette.circle,
          palette.letter,
        )}
        aria-hidden
      >
        {initial}
      </span>

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-xs font-medium leading-4 text-content-primary">{label}</span>
        {row.isPending && <Badge variant="warning">Pending</Badge>}
      </div>

      {row.roleControl === MemberRoleControl.Select ? (
        <Select value={row.role} onValueChange={onRoleChange}>
          <SelectTrigger
            aria-label={`Role for ${label}`}
            className="h-7 w-auto shrink-0 gap-1 border-transparent bg-transparent py-1.5 pr-1.5 pl-2 text-xs font-semibold leading-4 text-content-secondary shadow-none"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={WorkspaceMemberRole.Admin}>Admin</SelectItem>
            <SelectItem value={WorkspaceMemberRole.Member}>Member</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <span
          className={cn(
            'shrink-0 px-2 py-1.5 text-xs leading-4',
            row.role === WorkspaceMemberRole.Owner
              ? 'font-medium text-content-quaternary'
              : 'font-semibold text-content-secondary',
          )}
        >
          {row.roleLabel}
        </span>
      )}

      {row.kebab !== MemberRowKebab.None && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for ${label}`}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-content-tertiary hover:text-content-primary"
            >
              <MenuDots className="size-4 rotate-90" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.kebab === MemberRowKebab.ResendRevoke ? (
              <>
                <DropdownMenuItem onClick={onResend}>Resend invite</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={onRevoke}>
                  Revoke invite
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                Remove
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
