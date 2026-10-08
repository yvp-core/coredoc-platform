import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '@/api/client';
import { agentRunSettingsQueryOptions, updateAgentRunSettings } from '@/api/queries/agent-runs';
import { createToken, revokeToken } from '@/api/queries/tokens';
import type { CreateTokenResult } from '@/api/types';
import { EmptyNote } from '@/components/empty-note';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { RunnerTokenStatus } from '@/features/agent-runs/types';
import { CopyBlock } from '@/features/teams/copy-block';
import { Table, Td, Th, Tr } from '@/features/teams/table';
import { formatRelativeTime } from '@/lib/time';

const ERROR_CLASS = 'text-[13px] text-danger-text';

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

const REFUSALS: Record<string, string> = {
  creator_not_admin: 'Refused: its creator is no longer an admin of this workspace. Mint a new token.',
  runner_incompatible: 'Refused: this runner version is not supported. Upgrade the runner.',
};

function versionsText(versions: RunnerTokenStatus['versions']): string | null {
  if (!versions) return null;
  const parts = Object.entries(versions)
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `${name === 'claudeCode' ? 'claude code' : name} ${value}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function RunnerTokenRow({
  token,
  onRevoke,
}: {
  token: RunnerTokenStatus;
  onRevoke: (token: RunnerTokenStatus) => void;
}) {
  const versions = versionsText(token.versions);
  return (
    <Tr>
      <Td className="text-left">
        <div className="text-ink-1">{token.name}</div>
        <div className="font-mono text-[12px] text-ink-4">{token.tokenPrefix ?? '—'}</div>
      </Td>
      <Td className="text-left">
        {token.refusal ? (
          <span className="text-danger-text">{REFUSALS[token.refusal] ?? token.refusal}</span>
        ) : token.lastSeenAt ? (
          <span>
            {token.lastAction} {formatRelativeTime(token.lastSeenAt)}
            {versions && <span className="block text-[12px] text-ink-4">{versions}</span>}
          </span>
        ) : (
          <span className="text-ink-4">Never connected</span>
        )}
      </Td>
      <Td>
        <Button size="sm" variant="ghost" aria-label={`Revoke ${token.name}`} onClick={() => onRevoke(token)}>
          Revoke
        </Button>
      </Td>
    </Tr>
  );
}

function CreateRunnerTokenDialog({
  wsId,
  open,
  onOpenChange,
}: {
  wsId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreateTokenResult | null>(null);
  const mutation = useMutation({
    mutationFn: createToken,
    onSuccess: (result) => {
      setCreated(result);
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'tokens'] });
    },
  });

  function close() {
    setName('');
    setCreated(null);
    mutation.reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? 'Copy this token now' : 'Create a runner token'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'This is the only time the full value is shown. Put it in the agent runner Secret.'
              : 'A runner token works only on the agent runner API of this workspace.'}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <>
            <DialogBody>
              <CopyBlock value={created.token} label={`Copy ${created.name}`} filename={created.name} />
            </DialogBody>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) mutation.mutate({ wsId, name: name.trim(), scope: 'agent-runner' });
            }}
          >
            <DialogBody className="flex flex-col gap-1.5">
              <Label htmlFor="runner-token-name">Name</Label>
              <Input
                id="runner-token-name"
                value={name}
                placeholder="agent-runner"
                onChange={(event) => setName(event.target.value)}
              />
              {mutation.error && <p className={ERROR_CLASS}>{message(mutation.error, 'Failed to create the token')}</p>}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending || name.trim() === ''}>
                {mutation.isPending ? 'Creating…' : 'Create token'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeRunnerTokenDialog({
  wsId,
  token,
  onClose,
}: {
  wsId: string;
  token: RunnerTokenStatus | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: revokeToken,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'tokens'] });
      onClose();
    },
  });
  return (
    <Dialog open={token !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke {token?.name}</DialogTitle>
          <DialogDescription>The runner using this token stops at its next request.</DialogDescription>
        </DialogHeader>
        {mutation.error && (
          <DialogBody>
            <p className={ERROR_CLASS}>{message(mutation.error, 'Failed to revoke the token')}</p>
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending || token === null}
            onClick={() => token && mutation.mutate({ wsId, tokenId: token.id })}
          >
            {mutation.isPending ? 'Revoking…' : 'Revoke'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Admin settings for cloud agent runs: the switch, the run owner and the runner tokens. */
export function AgentRunsPanel({ wsId }: { wsId: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery(agentRunSettingsQueryOptions(wsId));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<RunnerTokenStatus | null>(null);
  const update = useMutation({
    mutationFn: updateAgentRunSettings,
    onSuccess: (next) => {
      queryClient.setQueryData(agentRunSettingsQueryOptions(wsId).queryKey, next);
      // The navigation entry is gated by the /me flag.
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const data = settings.data;
  const enabled = data?.enabled ?? false;
  const owner = data?.runOwner ?? null;

  return (
    <Card>
      <CardHead
        title="Agent runs"
        sub="Take Jira issues to draft pull requests with your own agent runner"
        right={
          <Switch
            checked={enabled}
            disabled={settings.isPending || update.isPending}
            aria-label="Enable agent runs"
            onCheckedChange={(next) => update.mutate({ wsId, enabled: next })}
          />
        }
      />
      <CardBody className="flex flex-col gap-4 pt-2">
        {settings.isError && (
          <p className={ERROR_CLASS}>{message(settings.error, 'Failed to load agent run settings')}</p>
        )}
        {update.error && <p className={ERROR_CLASS}>{message(update.error, 'Failed to update the setting')}</p>}
        {owner ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-3">
            <span>
              Jira-triggered runs act as {owner.email ?? owner.userId}
              {!owner.valid && (
                <span className="text-danger-text"> — no longer a member; take over to resume Jira triggers</span>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() => update.mutate({ wsId, takeOverOwnership: true })}
            >
              Take over ownership
            </Button>
          </div>
        ) : (
          !settings.isPending && (
            <EmptyNote>Agent runs are off. Turning them on records you as the run owner.</EmptyNote>
          )
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[13.5px] font-medium text-ink-1">Runner tokens</h3>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              Create runner token
            </Button>
          </div>
          {data && data.runnerTokens.length === 0 ? (
            <EmptyNote>No runner tokens yet. Runs wait in the queue until a runner connects.</EmptyNote>
          ) : (
            data && (
              <Table minWidth={520}>
                <thead>
                  <tr>
                    <Th>Token</Th>
                    <Th className="text-left">Last claim or heartbeat</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {data.runnerTokens.map((token) => (
                    <RunnerTokenRow key={token.id} token={token} onRevoke={setRevoking} />
                  ))}
                </tbody>
              </Table>
            )
          )}
        </div>
      </CardBody>
      <CreateRunnerTokenDialog wsId={wsId} open={creating} onOpenChange={setCreating} />
      <RevokeRunnerTokenDialog wsId={wsId} token={revoking} onClose={() => setRevoking(null)} />
    </Card>
  );
}
