import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '@/api/client';
import {
  inviteMember,
  invitesQueryOptions,
  membersQueryOptions,
  removeMember,
  resendInvite,
  revokeInvite,
  updateMemberRole,
} from '@/api/queries/members';
import type { Member, PendingInvite } from '@/api/types';
import { EmptyNote } from '@/components/empty-note';
import { QueryBoundary } from '@/components/query-boundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatRelativeTime } from '@/lib/time';

import { CopyBlock } from './copy-block';
import { Table, Td, Th, Tr } from './table';

// Mirrors ASSIGNABLE_ROLES on the server — 'owner' is never assignable, so it
// is never an option.
const ASSIGNABLE_ROLES = ['admin', 'product', 'member'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const ERROR_CLASS = 'text-[13px] text-danger-text';

const title = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** "Owner Person" → "OP"; a single token → its first two characters. */
function initials(member: { displayName: string | null; email: string }): string {
  const name = (member.displayName ?? member.email.split('@')[0] ?? member.email).trim();
  const parts = name.split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const second = parts[1]?.[0] ?? '';
  if (first && second) return (first + second).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function Avatar({ member }: { member: { displayName: string | null; email: string } }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-track text-[10.5px] font-normal tracking-[0.02em] text-ink-2"
    >
      {initials(member)}
    </span>
  );
}

function RoleSelect({
  value,
  label,
  disabled,
  onChange,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (role: AssignableRole) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as AssignableRole)}>
      <SelectTrigger aria-label={label} className="h-7 w-[108px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ASSIGNABLE_ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {title(role)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MemberRow({
  member,
  wsId,
  isSelf,
  canManage,
}: {
  member: Member;
  wsId: string;
  isSelf: boolean;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // The server refuses to change or remove an owner (403), so the owner row
  // simply carries no controls rather than disabled ones.
  const managed = canManage && member.role !== 'owner';

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'members'] });
    // The Overview page renders the member count off the config query.
    queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'config'] });
  }

  const roleMutation = useMutation({
    mutationFn: updateMemberRole,
    onSuccess: () => {
      setError(null);
      invalidate();
      // me.workspaces[].role gates the shell's nav — refetch it after a
      // self-demotion.
      if (isSelf) queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => setError(message(err, 'Failed to update role')),
  });

  const removeMutation = useMutation({
    mutationFn: removeMember,
    onSuccess: (result) => {
      setError(
        result.providerCleanupSucceeded === false
          ? 'Removed from Coredoc, but the WorkOS organization membership could not be cleaned up.'
          : null,
      );
      invalidate();
    },
    onError: (err) => setError(message(err, 'Failed to remove member')),
  });

  const busy = roleMutation.isPending || removeMutation.isPending;

  return (
    <>
      <Tr>
        <Td>
          <div className="flex min-w-0 items-center gap-[9px]">
            <Avatar member={member} />
            <div className="min-w-0">
              <div className="truncate leading-tight text-ink-1">
                {member.displayName ?? member.email}
                {isSelf && <span className="ml-1 text-ink-4">(you)</span>}
              </div>
              {member.displayName && (
                <div className="truncate text-[12px] leading-tight text-ink-4">{member.email}</div>
              )}
            </div>
          </div>
        </Td>
        <Td>
          {managed ? (
            <RoleSelect
              value={member.role}
              label={`Role for ${member.email}`}
              disabled={busy}
              onChange={(role) => roleMutation.mutate({ wsId, userId: member.userId, role })}
            />
          ) : (
            <Badge variant="neutral">{title(member.role)}</Badge>
          )}
        </Td>
        <Td className="text-ink-4">{formatRelativeTime(member.joinedAt)}</Td>
        <Td className="w-8">
          {managed && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label={`Actions for ${member.email}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  disabled={busy}
                  onSelect={() => removeMutation.mutate({ wsId, userId: member.userId })}
                >
                  Remove from workspace
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </Td>
      </Tr>
      {error && (
        <tr>
          <Td colSpan={4} className="text-left">
            <p className={ERROR_CLASS}>{error}</p>
          </Td>
        </tr>
      )}
    </>
  );
}

function InviteRow({ invite, wsId, canManage }: { invite: PendingInvite; wsId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);

  const resendMutation = useMutation({
    mutationFn: resendInvite,
    onSuccess: (result) => {
      setError(null);
      setSignInUrl(result.emailSent ? null : result.signInUrl);
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'invites'] });
    },
    onError: (err) => setError(message(err, 'Failed to resend invite')),
  });

  const revokeMutation = useMutation({
    mutationFn: revokeInvite,
    onSuccess: (result) => {
      setError(
        result.emailRevoked === false
          ? 'Revoked in Coredoc, but the WorkOS invitation could not be revoked. Remove it in WorkOS.'
          : null,
      );
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'invites'] });
      // GET /members includes pending placeholder rows, so the member count
      // on Overview moves too.
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'members'] });
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'config'] });
    },
    onError: (err) => setError(message(err, 'Failed to revoke invite')),
  });

  const busy = resendMutation.isPending || revokeMutation.isPending;

  return (
    <>
      <Tr>
        <Td>
          <div className="flex min-w-0 items-center gap-[9px]">
            <Avatar member={{ displayName: null, email: invite.email }} />
            <div className="min-w-0">
              <div className="truncate leading-tight text-ink-1">{invite.email}</div>
              <div className="truncate text-[12px] leading-tight text-ink-4">
                {invite.emailSent ? 'email sent' : 'email not sent'}
              </div>
            </div>
          </div>
        </Td>
        <Td>
          <Badge variant="neutral">{title(invite.role)}</Badge>
        </Td>
        <Td>
          <Badge variant={invite.state === 'expired' ? 'warn' : 'info'}>{invite.state}</Badge>
        </Td>
        <Td className="text-ink-4">{formatRelativeTime(invite.invitedAt)}</Td>
        <Td className="w-8">
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label={`Actions for ${invite.email}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={busy}
                  onSelect={() => resendMutation.mutate({ wsId, invitationId: invite.id })}
                >
                  {invite.emailSent ? 'Resend email' : 'Send email'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={busy}
                  onSelect={() => revokeMutation.mutate({ wsId, invitationId: invite.id })}
                >
                  Revoke invite
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </Td>
      </Tr>
      {(error || signInUrl) && (
        <tr>
          <Td colSpan={5} className="text-left">
            {error && <p className={ERROR_CLASS}>{error}</p>}
            {signInUrl && (
              <div className="mt-1">
                <p className="mb-1.5 text-[12.5px] text-ink-4">
                  No email provider is configured — share this sign-in link instead.
                </p>
                <CopyBlock value={signInUrl} label="Copy sign-in link" filename="sign-in link" />
              </div>
            )}
          </Td>
        </tr>
      )}
    </>
  );
}

function InviteForm({ wsId }: { wsId: string }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const [validation, setValidation] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: inviteMember,
    onSuccess: (result) => {
      setEmail('');
      setRole('member');
      setValidation(null);
      setSignInUrl(result.emailSent ? null : result.signInUrl);
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'invites'] });
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'members'] });
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'config'] });
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (email.trim() === '') {
      setValidation('Email is required');
      return;
    }
    setValidation(null);
    setSignInUrl(null);
    // The server validates the address shape; its message renders below.
    mutation.mutate({ wsId, email: email.trim(), role });
  }

  const error = validation ?? (mutation.error ? message(mutation.error, 'Failed to invite') : null);

  return (
    <Card>
      <CardHead title="Invite a member" sub="Creates a pending invitation" />
      <CardBody>
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
            aria-label="Invite email"
            className="w-64"
          />
          <Select value={role} onValueChange={(next) => setRole(next as AssignableRole)}>
            <SelectTrigger aria-label="Invite role" className="w-[108px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASSIGNABLE_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {title(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Inviting…' : 'Send invite'}
          </Button>
        </form>
        {error && <p className={`mt-2 ${ERROR_CLASS}`}>{error}</p>}
        {signInUrl && (
          <div className="mt-3">
            <p className="mb-1.5 text-[12.5px] text-ink-4">
              Access was created, but no email was sent. Share this sign-in link — access activates once they sign in
              with the same verified email.
            </p>
            <CopyBlock value={signInUrl} label="Copy sign-in link" filename="sign-in link" />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function MembersPanel({
  wsId,
  currentUserId,
  canManage,
}: {
  wsId: string;
  currentUserId: string;
  canManage: boolean;
}) {
  const membersQuery = useQuery(membersQueryOptions(wsId));
  const invitesQuery = useQuery(invitesQueryOptions(wsId));

  return (
    <div className="flex flex-col gap-4">
      <QueryBoundary query={membersQuery}>
        {(members) => {
          // GET /members is unfiltered and carries invite placeholder rows
          // (`pending: true`); those belong to the invites section below.
          const active = members.filter((member) => !member.pending);
          return (
            <Card>
              <CardHead title="Members" sub={`${active.length} active`} />
              <CardBody className="pt-2">
                <Table minWidth={620}>
                  <thead>
                    <tr>
                      <Th>Member</Th>
                      <Th>Role</Th>
                      <Th>Joined</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {active.map((member) => (
                      <MemberRow
                        key={member.userId}
                        member={member}
                        wsId={wsId}
                        isSelf={member.userId === currentUserId}
                        canManage={canManage}
                      />
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>
          );
        }}
      </QueryBoundary>

      <QueryBoundary query={invitesQuery}>
        {(invites) =>
          invites.length > 0 && (
            <Card>
              <CardHead title="Pending invites" sub="Awaiting first sign-in" />
              <CardBody className="pt-2">
                <Table minWidth={640}>
                  <thead>
                    <tr>
                      <Th>Invitee</Th>
                      <Th>Role</Th>
                      <Th>State</Th>
                      <Th>Invited</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((invite) => (
                      <InviteRow key={invite.id} invite={invite} wsId={wsId} canManage={canManage} />
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>
          )
        }
      </QueryBoundary>

      {canManage ? <InviteForm wsId={wsId} /> : <EmptyNote>Only admins can invite or change members.</EmptyNote>}
    </div>
  );
}
