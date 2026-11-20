import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '@/api/client';
import {
  type Access,
  type AccessGroup,
  accessQueryOptions,
  deleteGroup,
  type RepoBinding,
  saveGroup,
  saveResourceAccess,
} from '@/api/queries/access';
import { membersQueryOptions } from '@/api/queries/members';
import type { Member } from '@/api/types';
import { EmptyNote } from '@/components/empty-note';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

import { Table, Td, Th, Tr } from './table';

/** A repo or an intent domain, as the access form sees it. */
interface Resource {
  kind: 'repos' | 'domains';
  id: string;
  name: string;
  restricted: boolean;
  bindings: RepoBinding[];
}

const ERROR_CLASS = 'text-[13px] text-danger-text';
// The only role a repo binding can carry today (REPO_ROLES on the server).
const REPO_ROLE = 'member';
// Workspace managers read every repo, restricted or not.
const READS_ALL = new Set(['admin', 'owner']);

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function CheckList({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="min-w-0 flex-1 basis-64">
      <legend className="mb-1.5 text-[11.5px] uppercase tracking-[0.04em] text-ink-4">{legend}</legend>
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-border-soft p-2">
        {children}
      </div>
    </fieldset>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  note,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  note?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[13.5px] text-ink-2">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="truncate">{label}</span>
      {note && <span className="shrink-0 text-[12px] text-ink-4">{note}</span>}
    </label>
  );
}

function MemberChecks({
  members,
  selected,
  onChange,
}: {
  members: Member[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <CheckList legend="Members">
      {members.map((member) => (
        <CheckRow
          key={member.userId}
          checked={selected.includes(member.userId)}
          onChange={() => onChange(toggled(selected, member.userId))}
          label={member.displayName ?? member.email}
          note={READS_ALL.has(member.role) ? `${member.role}, reads everything` : undefined}
        />
      ))}
    </CheckList>
  );
}

function FormActions({ pending, disabled, onCancel }: { pending: boolean; disabled?: boolean; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <Button type="submit" disabled={pending || disabled}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function GroupForm({
  wsId,
  group,
  members,
  onDone,
}: {
  wsId: string;
  group: AccessGroup | null;
  members: Member[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(group?.name ?? '');
  const [memberUserIds, setMemberUserIds] = useState(group?.memberUserIds ?? []);
  const mutation = useMutation({
    mutationFn: saveGroup,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'access'] });
      onDone();
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate({ wsId, groupId: group?.id ?? null, input: { name: name.trim(), memberUserIds } });
      }}
      className="mt-3 flex flex-col gap-3 border-t border-border-soft pt-3"
    >
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Group name"
        aria-label="Group name"
        maxLength={100}
        className="w-64"
      />
      <div className="flex flex-wrap gap-4">
        <MemberChecks members={members} selected={memberUserIds} onChange={setMemberUserIds} />
      </div>
      <FormActions pending={mutation.isPending} disabled={name.trim() === ''} onCancel={onDone} />
      {mutation.error && <p className={ERROR_CLASS}>{message(mutation.error, 'Failed to save')}</p>}
    </form>
  );
}

function ResourceForm({
  wsId,
  resource,
  groups,
  members,
  onDone,
}: {
  wsId: string;
  resource: Resource;
  groups: AccessGroup[];
  members: Member[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [restricted, setRestricted] = useState(resource.restricted);
  const [userIds, setUserIds] = useState(resource.bindings.flatMap((binding) => binding.userId ?? []));
  const [groupIds, setGroupIds] = useState(resource.bindings.flatMap((binding) => binding.groupId ?? []));
  const mutation = useMutation({
    mutationFn: saveResourceAccess,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'access'] });
      // A member's repo list is filtered by the same bindings.
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'repos'] });
      onDone();
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate({
          wsId,
          kind: resource.kind,
          id: resource.id,
          input: {
            restricted,
            bindings: [
              ...groupIds.map((groupId) => ({ groupId, role: REPO_ROLE })),
              ...userIds.map((userId) => ({ userId, role: REPO_ROLE })),
            ],
          },
        });
      }}
      className="mt-3 flex flex-col gap-3 border-t border-border-soft pt-3"
    >
      <div className="text-[13.5px] font-medium text-ink-1">{resource.name}</div>
      <label className="flex items-center gap-2 text-[13.5px] text-ink-2">
        <Switch checked={restricted} onChange={(event) => setRestricted(event.target.checked)} />
        Restricted: only the groups and members below can read it
      </label>
      {restricted && (
        <div className="flex flex-wrap gap-4">
          <CheckList legend="Groups">
            {groups.length === 0 && <span className="text-[13px] text-ink-4">No groups yet</span>}
            {groups.map((group) => (
              <CheckRow
                key={group.id}
                checked={groupIds.includes(group.id)}
                onChange={() => setGroupIds(toggled(groupIds, group.id))}
                label={group.name}
                note={`${group.memberUserIds.length} members`}
              />
            ))}
          </CheckList>
          <MemberChecks members={members} selected={userIds} onChange={setUserIds} />
        </div>
      )}
      <FormActions pending={mutation.isPending} onCancel={onDone} />
      {mutation.error && <p className={ERROR_CLASS}>{message(mutation.error, 'Failed to save')}</p>}
    </form>
  );
}

function describeAccess(resource: Resource): string {
  if (!resource.restricted) return 'All members';
  const groups = resource.bindings.filter((binding) => binding.groupId).length;
  const people = resource.bindings.length - groups;
  return `Restricted · ${groups} groups, ${people} members`;
}

/** A table of repos or intent domains with the access form of the one being edited. */
function ResourceCard({
  wsId,
  title,
  sub,
  column,
  empty,
  resources,
  groups,
  members,
}: {
  wsId: string;
  title: string;
  sub: string;
  column: string;
  empty: string;
  resources: Resource[];
  groups: AccessGroup[];
  members: Member[];
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const edited = resources.find((resource) => resource.id === editing);
  return (
    <Card>
      <CardHead title={title} sub={sub} />
      <CardBody className="pt-2">
        {resources.length === 0 ? (
          <EmptyNote>{empty}</EmptyNote>
        ) : (
          <Table minWidth={480}>
            <thead>
              <tr>
                <Th>{column}</Th>
                <Th>Who can read</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {resources.map((resource) => (
                <Tr key={resource.id}>
                  <Td>{resource.name}</Td>
                  <Td>{describeAccess(resource)}</Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing(resource.id)}
                      aria-label={`Edit access to ${resource.name}`}
                    >
                      Edit
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {edited && (
          <ResourceForm
            key={edited.id}
            wsId={wsId}
            resource={edited}
            groups={groups}
            members={members}
            onDone={() => setEditing(null)}
          />
        )}
      </CardBody>
    </Card>
  );
}

function Panels({ wsId, access, members }: { wsId: string; access: Access; members: Member[] }) {
  const queryClient = useQueryClient();
  // null = closed, 'new' = blank group form, otherwise the id of the group being edited.
  const [group, setGroup] = useState<string | null>(null);
  const removal = useMutation({
    mutationFn: deleteGroup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'access'] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHead
          title="Groups"
          sub="A group can be given access to a restricted repo"
          right={
            <Button size="sm" onClick={() => setGroup('new')}>
              New group
            </Button>
          }
        />
        <CardBody className="pt-2">
          {access.groups.length === 0 ? (
            <EmptyNote>No groups.</EmptyNote>
          ) : (
            <Table minWidth={480}>
              <thead>
                <tr>
                  <Th>Group</Th>
                  <Th>Members</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {access.groups.map((item) => (
                  <Tr key={item.id}>
                    <Td>{item.name}</Td>
                    <Td>{item.memberUserIds.length}</Td>
                    <Td>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setGroup(item.id)}
                          aria-label={`Edit ${item.name}`}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={removal.isPending}
                          onClick={() => removal.mutate({ wsId, groupId: item.id })}
                          aria-label={`Delete ${item.name}`}
                        >
                          Delete
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
          {removal.error && <p className={`mt-2 ${ERROR_CLASS}`}>{message(removal.error, 'Failed to delete')}</p>}
          {group && (
            <GroupForm
              key={group}
              wsId={wsId}
              group={access.groups.find((item) => item.id === group) ?? null}
              members={members}
              onDone={() => setGroup(null)}
            />
          )}
        </CardBody>
      </Card>

      <ResourceCard
        wsId={wsId}
        title="Repos"
        sub="A repo is readable by all members unless restricted. Admins and owners read everything."
        column="Repo"
        empty="No repos connected."
        resources={access.repos.map((repo) => ({ ...repo, kind: 'repos', id: repo.repoKey, name: repo.repoName }))}
        groups={access.groups}
        members={members}
      />
      <ResourceCard
        wsId={wsId}
        title="Intent domains"
        sub="A domain and everything under it is readable by all members unless restricted."
        column="Domain"
        empty="No intent domains."
        resources={access.domains.map((domain) => ({
          ...domain,
          kind: 'domains',
          name: domain.archived ? `${domain.title} (archived)` : domain.title,
        }))}
        groups={access.groups}
        members={members}
      />
    </div>
  );
}

/** Admin-only: the server refuses every access route below admin. */
export function AccessPanel({ wsId }: { wsId: string }) {
  const accessQuery = useQuery(accessQueryOptions(wsId));
  const membersQuery = useQuery(membersQueryOptions(wsId));
  return (
    <QueryBoundary query={accessQuery}>
      {(access) => (
        <QueryBoundary query={membersQuery}>
          {(members) => <Panels wsId={wsId} access={access} members={members} />}
        </QueryBoundary>
      )}
    </QueryBoundary>
  );
}
