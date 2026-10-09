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
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { RUNNER_REFUSALS, runnerVersionsText } from '@/features/agent-runs/agent-run-presentation';
import type {
  AgentRunSettings,
  AvailabilityReason,
  RepositoryEligibility,
  RunnerTokenStatus,
} from '@/features/agent-runs/types';
import { CopyBlock } from '@/features/teams/copy-block';
import { Table, Td, Th, Tr } from '@/features/teams/table';
import { formatRelativeTime } from '@/lib/time';

const ERROR_CLASS = 'text-[13px] text-danger-text';

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function RunnerTokenRow({
  token,
  onRevoke,
}: {
  token: RunnerTokenStatus;
  onRevoke: (token: RunnerTokenStatus) => void;
}) {
  const versions = runnerVersionsText(token.versions);
  return (
    <Tr>
      <Td className="text-left">
        <div className="text-ink-1">{token.name}</div>
        <div className="font-mono text-[12px] text-ink-4">{token.tokenPrefix ?? '—'}</div>
      </Td>
      <Td className="text-left">
        {token.refusal ? (
          <span className="text-danger-text">{RUNNER_REFUSALS[token.refusal] ?? token.refusal}</span>
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

const REPOSITORY_REMEDIES: Record<string, string> = {
  repository_key_missing: 'No durable key: push again with a current CLI or desktop, or set the key.',
  repository_remote_missing: 'No git remote recorded: push again from a clone with an origin.',
  repository_remote_invalid: 'Its git remote is not a GitHub repository.',
  github_connector_unavailable: 'No single active GitHub connector covers its remote.',
};

function ReasonList({ reasons }: { reasons: AvailabilityReason[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {reasons.map((reason) => (
        <li key={reason.code} className="text-[13px] text-danger-text">
          {reason.message}
        </li>
      ))}
    </ul>
  );
}

function AvailabilitySection({ settings }: { settings: AgentRunSettings }) {
  const { availability, trigger } = settings;
  return (
    <div className="flex flex-col gap-2 text-[13px] text-ink-3">
      {availability.available ? (
        <p>Runs can start: object storage, encryption key, connectors and license are in place.</p>
      ) : (
        <>
          <p className="text-ink-2">Runs cannot start until these are fixed; queued runs wait:</p>
          <ReasonList reasons={availability.reasons} />
        </>
      )}
      {trigger.reasons.length > 0 ? (
        <>
          <p className="text-ink-2">The Jira trigger is idle:</p>
          <ReasonList reasons={trigger.reasons} />
        </>
      ) : (
        <p>
          The Jira trigger searches {trigger.projectKeys.join(', ') || 'no projects'} for the label{' '}
          <span className="font-mono">{settings.triggerLabel}</span> every minute.
        </p>
      )}
    </div>
  );
}

/** The values the form edits; the form remounts with fresh values when they change on the server. */
function editableValues(settings: AgentRunSettings) {
  const { runnerTokens, availability, trigger, repositories, runOwner, enabled, ...values } = settings;
  return values;
}

const HOUR = 3600;
const DAY = 86_400;

function NumberField({
  id,
  label,
  value,
  onChange,
  step = '1',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  step?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min="0" step={step} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Trigger label, done status, policies, budgets and model; saved in one update. */
function SettingsForm({ wsId, settings }: { wsId: string; settings: AgentRunSettings }) {
  const queryClient = useQueryClient();
  const [triggerLabel, setTriggerLabel] = useState(settings.triggerLabel);
  const [doneId, setDoneId] = useState(settings.doneStatus?.id ?? '');
  const [doneName, setDoneName] = useState(settings.doneStatus?.name ?? '');
  const [questionsPolicy, setQuestionsPolicy] = useState(settings.questionsPolicy);
  const [scopeAcceptancePolicy, setScopeAcceptancePolicy] = useState(settings.scopeAcceptancePolicy);
  const [spend, setSpend] = useState(String(settings.maxSpendUsd));
  const [turnHours, setTurnHours] = useState(String(settings.maxTurnDurationSeconds / HOUR));
  const [activeHours, setActiveHours] = useState(String(settings.maxActiveSeconds / HOUR));
  const [waitingDays, setWaitingDays] = useState(String(settings.waitingLimitSeconds / DAY));
  const [startedRuns, setStartedRuns] = useState(String(settings.maxStartedRuns));
  const [repositories, setRepositories] = useState(String(settings.maxRepositories));
  const [model, setModel] = useState(settings.model ?? '');
  const save = useMutation({
    mutationFn: updateAgentRunSettings,
    onSuccess: (next) => queryClient.setQueryData(agentRunSettingsQueryOptions(wsId).queryKey, next),
  });

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({
          wsId,
          triggerLabel: triggerLabel.trim(),
          doneStatus: doneId.trim() ? { id: doneId.trim(), name: doneName.trim() || doneId.trim() } : null,
          questionsPolicy,
          scopeAcceptancePolicy,
          maxSpendUsd: Number(spend),
          maxTurnDurationSeconds: Math.round(Number(turnHours) * HOUR),
          maxActiveSeconds: Math.round(Number(activeHours) * HOUR),
          waitingLimitSeconds: Math.round(Number(waitingDays) * DAY),
          maxStartedRuns: Number(startedRuns),
          maxRepositories: Number(repositories),
          model: model.trim() || null,
        });
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agent-runs-trigger-label">Trigger label</Label>
          <Input id="agent-runs-trigger-label" value={triggerLabel} onChange={(e) => setTriggerLabel(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agent-runs-done-id">Done status id</Label>
          <Input
            id="agent-runs-done-id"
            value={doneId}
            placeholder="none"
            onChange={(e) => setDoneId(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agent-runs-done-name">Done status name</Label>
          <Input id="agent-runs-done-name" value={doneName} onChange={(e) => setDoneName(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink-2">Questions</span>
          <Segmented<'pause' | 'assume'>
            value={questionsPolicy}
            onChange={setQuestionsPolicy}
            items={[
              { value: 'pause', label: 'Pause' },
              { value: 'assume', label: 'Assume' },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink-2">Scope acceptance</span>
          <Segmented<'required' | 'automatic'>
            value={scopeAcceptancePolicy}
            onChange={setScopeAcceptancePolicy}
            items={[
              { value: 'required', label: 'Required' },
              { value: 'automatic', label: 'Automatic' },
            ]}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <NumberField id="agent-runs-spend" label="Spend per run (USD)" value={spend} onChange={setSpend} step="any" />
        <NumberField
          id="agent-runs-turn"
          label="Turn duration (hours)"
          value={turnHours}
          onChange={setTurnHours}
          step="any"
        />
        <NumberField
          id="agent-runs-active"
          label="Active time per run (hours)"
          value={activeHours}
          onChange={setActiveHours}
          step="any"
        />
        <NumberField
          id="agent-runs-waiting"
          label="Waiting limit (days)"
          value={waitingDays}
          onChange={setWaitingDays}
          step="any"
        />
        <NumberField
          id="agent-runs-started"
          label="Started runs at once"
          value={startedRuns}
          onChange={setStartedRuns}
        />
        <NumberField
          id="agent-runs-repositories"
          label="Repositories per run"
          value={repositories}
          onChange={setRepositories}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="agent-runs-model">Model</Label>
        <Input
          id="agent-runs-model"
          value={model}
          placeholder="Claude Code default"
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      {save.error && <p className={ERROR_CLASS}>{message(save.error, 'Failed to save the settings')}</p>}
      <div>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </form>
  );
}

function RepositoriesSection({ repositories }: { repositories: RepositoryEligibility[] }) {
  return (
    <section aria-label="Repositories" className="flex flex-col gap-2">
      <h3 className="text-[13.5px] font-medium text-ink-1">Repositories</h3>
      {repositories.length === 0 ? (
        <EmptyNote>No repositories pushed to this workspace yet.</EmptyNote>
      ) : (
        <Table minWidth={520}>
          <thead>
            <tr>
              <Th>Key</Th>
              <Th className="text-left">Eligibility</Th>
            </tr>
          </thead>
          <tbody>
            {repositories.map((repository) => (
              <Tr key={repository.name}>
                <Td className="text-left">
                  <div className="font-mono text-ink-1">{repository.key ?? '—'}</div>
                  {repository.key !== repository.name && (
                    <div className="text-[12px] text-ink-4">{repository.name}</div>
                  )}
                </Td>
                <Td className="text-left">
                  {repository.eligible ? (
                    <span>Eligible</span>
                  ) : (
                    <span className="text-danger-text">
                      {(repository.reason && REPOSITORY_REMEDIES[repository.reason]) ?? repository.reason}
                    </span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

/** Admin settings for cloud agent runs: the switch, availability, the run owner, values, tokens and repositories. */
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
        {data && <AvailabilitySection settings={data} />}
        {data && <SettingsForm key={JSON.stringify(editableValues(data))} wsId={wsId} settings={data} />}

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
        {data && <RepositoriesSection repositories={data.repositories} />}
      </CardBody>
      <CreateRunnerTokenDialog wsId={wsId} open={creating} onOpenChange={setCreating} />
      <RevokeRunnerTokenDialog wsId={wsId} token={revoking} onClose={() => setRevoking(null)} />
    </Card>
  );
}
