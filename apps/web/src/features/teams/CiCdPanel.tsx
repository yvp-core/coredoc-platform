import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '@/api/client';
import { createToken, revealToken, revokeToken, tokensQueryOptions, type TokenScope } from '@/api/queries/tokens';
import { intentReleaseTriggerOptions } from '@/api/queries/intent-release';
import { reposQueryOptions, setProductionBranch, setRepoReleaseTrigger } from '@/api/queries/repos';
import { setCiCdEnabled, setIntentReleaseTrigger, workspaceConfigQueryOptions } from '@/api/queries/workspace-config';
import type { CreateTokenResult, Token, WorkspaceRepo } from '@/api/types';
import { IntentReleaseTrigger, releaseTriggerExplain, releaseTriggerLabels } from '@/features/intent/release-types';
import { EmptyNote } from '@/components/empty-note';
import { QueryBoundary } from '@/components/query-boundary';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { formatRelativeTime } from '@/lib/time';

import { CopyBlock } from './copy-block';
import { Table, Td, Th, Tr } from './table';

const ERROR_CLASS = 'text-[13px] text-danger-text';

const TRIGGERS = [IntentReleaseTrigger.Manual, IntentReleaseTrigger.Merge, IntentReleaseTrigger.Deploy];

const SCOPES: { value: TokenScope; label: string; hint: string }[] = [
  { value: 'ci', label: 'CI/CD', hint: 'Publish graphs, sync intent bindings and record deployment releases.' },
  { value: 'intent-agent', label: 'Intent agent', hint: 'Read the graph and propose intent. No authority changes.' },
];

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function PermissionTags({ permissions }: { permissions: string[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {permissions.map((permission) => (
        <span
          key={permission}
          className="rounded-md border border-border-soft bg-surface-2 px-[7px] font-mono text-[12px] text-ink-2"
        >
          {permission}
        </span>
      ))}
    </div>
  );
}

function TokenRow({ token, wsId, onRevoke }: { token: Token; wsId: string; onRevoke: (token: Token) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<string | null>(null);

  const revealMutation = useMutation({
    mutationFn: revealToken,
    onSuccess: (result) => {
      setError(null);
      setValue(result.token);
    },
    // Tokens minted before encrypted storage was configured cannot be
    // revealed; the server says so and that message is the honest surface.
    onError: (err) => setError(message(err, 'Failed to reveal the token value')),
  });

  return (
    <>
      <Tr>
        <Td>
          <div className="leading-tight text-ink-1">{token.name}</div>
          <div className="font-mono text-[12px] leading-tight text-ink-4">{token.tokenPrefix ?? 'no prefix'}</div>
        </Td>
        <Td>
          <PermissionTags permissions={token.permissions} />
        </Td>
        <Td className="text-ink-4">{token.expiresAt === null ? 'never' : formatRelativeTime(token.expiresAt)}</Td>
        <Td className="text-ink-4">
          {token.lastUsedAt === null ? 'never used' : formatRelativeTime(token.lastUsedAt)}
        </Td>
        <Td className="w-8">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={`Actions for ${token.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={revealMutation.isPending}
                onSelect={() => revealMutation.mutate({ wsId, tokenId: token.id })}
              >
                Reveal value
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => onRevoke(token)}>
                Revoke
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Td>
      </Tr>
      {(error || value) && (
        <tr>
          <Td colSpan={5} className="text-left">
            {error && <p className={ERROR_CLASS}>{error}</p>}
            {value && <CopyBlock value={value} label={`Copy ${token.name}`} filename={token.name} />}
          </Td>
        </tr>
      )}
    </>
  );
}

function CreateTokenDialog({
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
  const [scope, setScope] = useState<TokenScope>('ci');
  const [expiresOn, setExpiresOn] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateTokenResult | null>(null);

  function reset() {
    setName('');
    setScope('ci');
    setExpiresOn('');
    setValidation(null);
    setCreated(null);
  }

  const mutation = useMutation({
    mutationFn: createToken,
    onSuccess: (result) => {
      setCreated(result);
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'tokens'] });
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim() === '') {
      setValidation('Name is required');
      return;
    }
    setValidation(null);
    mutation.mutate({
      wsId,
      name: name.trim(),
      scope,
      // <input type="date"> gives a plain calendar day; the API wants an instant.
      expiresAt: expiresOn ? new Date(`${expiresOn}T00:00:00Z`).toISOString() : undefined,
    });
  }

  const error = validation ?? (mutation.error ? message(mutation.error, 'Failed to create the token') : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? 'Copy this token now' : 'Create a service token'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'This is the only time the full value is shown.'
              : 'The scope decides the permission set — a request never assembles its own.'}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <>
            <DialogBody>
              <CopyBlock value={created.token} label={`Copy ${created.name}`} filename={created.name} />
            </DialogBody>
            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogBody className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token-name">Name</Label>
                <Input
                  id="token-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="ci-pipeline"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token-scope">Scope</Label>
                <Select value={scope} onValueChange={(next) => setScope(next as TokenScope)}>
                  <SelectTrigger id="token-scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCOPES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[12.5px] text-ink-4">{SCOPES.find((s) => s.value === scope)?.hint}</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token-expiry">Expires (optional)</Label>
                <Input
                  id="token-expiry"
                  type="date"
                  value={expiresOn}
                  onChange={(event) => setExpiresOn(event.target.value)}
                />
              </div>
              {error && <p className={ERROR_CLASS}>{error}</p>}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Creating…' : 'Create token'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({ wsId, token, onClose }: { wsId: string; token: Token | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: revokeToken,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'tokens'] });
      onClose();
    },
  });

  return (
    <Dialog open={token !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke {token?.name}</DialogTitle>
          <DialogDescription>
            Anything still authenticating with this token stops working immediately. This cannot be undone.
          </DialogDescription>
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

function TokensCard({ wsId }: { wsId: string }) {
  const tokens = useQuery(tokensQueryOptions(wsId));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Token | null>(null);

  return (
    <Card>
      <CardHead
        title="Service tokens"
        sub="cdt_ credentials for the CLI, the GitHub Action and headless MCP clients"
        right={
          <Button size="sm" onClick={() => setCreating(true)}>
            New token
          </Button>
        }
      />
      <CardBody className="pt-2">
        <QueryBoundary query={tokens}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyNote>No tokens yet.</EmptyNote>
            ) : (
              <Table minWidth={720}>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Permissions</Th>
                    <Th>Expires</Th>
                    <Th>Last used</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((token) => (
                    <TokenRow key={token.id} token={token} wsId={wsId} onRevoke={setRevoking} />
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryBoundary>
      </CardBody>
      <CreateTokenDialog wsId={wsId} open={creating} onOpenChange={setCreating} />
      <RevokeDialog wsId={wsId} token={revoking} onClose={() => setRevoking(null)} />
    </Card>
  );
}

function CiCdToggleCard({ wsId, canManage }: { wsId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const config = useQuery(workspaceConfigQueryOptions(wsId));
  const enabled = config.data?.workspace.ciCdEnabled ?? false;

  const mutation = useMutation({
    mutationFn: setCiCdEnabled,
    // Only /config carries ciCdEnabled — /me does not.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'config'] }),
  });

  return (
    <Card>
      <CardHead
        title="CI/CD"
        sub="Parse and push this workspace's repos on every commit"
        right={
          <Switch
            checked={enabled}
            disabled={!canManage || config.isPending || mutation.isPending}
            aria-label="Enable CI/CD"
            onCheckedChange={(next) => mutation.mutate({ wsId, ciCdEnabled: next })}
          />
        }
      />
      <CardBody className="flex flex-col gap-2">
        <p className="text-[13px] text-ink-3">
          With CI/CD on, the <span className="font-mono text-[12.5px]">yvp-core/coredoc-platform</span> GitHub Action
          runs parse → push on each trigger. It authenticates with a CI-scoped token from the table below, stored as the
          repository secret <span className="font-mono text-[12.5px]">COREDOC_TOKEN</span>.
        </p>
        {mutation.error && (
          <p className={ERROR_CLASS}>{message(mutation.error, 'Failed to update the CI/CD setting')}</p>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Production branch of one repository. Committed on blur rather than behind a
 * Save button: the field holds one short string, and an empty field is a
 * meaningful value (clear the override, fall back to the branch the delivery
 * connector reports), so there is nothing to validate before sending.
 */
function ProductionBranchRow({
  repo,
  disabled,
  workspaceTrigger,
  onTriggerSave,
  onSave,
}: {
  repo: WorkspaceRepo;
  disabled: boolean;
  workspaceTrigger: IntentReleaseTrigger;
  onTriggerSave: (repoKey: string, intentReleaseTrigger: IntentReleaseTrigger | null) => void;
  onSave: (repoKey: string, productionBranch: string | null) => void;
}) {
  const stored = repo.productionBranch ?? '';
  const [value, setValue] = useState(stored);

  return (
    <div className="flex items-center gap-2 text-[13px] text-ink-2">
      <span className="min-w-0 flex-1 truncate">{repo.repoName}</span>
      <Select
        disabled={disabled}
        value={repo.intentReleaseTrigger ?? 'inherit'}
        onValueChange={(next) =>
          onTriggerSave(repo.repoKey, next === 'inherit' ? null : (next as IntentReleaseTrigger))
        }
      >
        <SelectTrigger aria-label={`Release trigger for ${repo.repoName}`} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">Default ({releaseTriggerLabels[workspaceTrigger]})</SelectItem>
          {TRIGGERS.map((value) => (
            <SelectItem key={value} value={value}>
              {releaseTriggerLabels[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        className="h-8 w-48"
        value={value}
        disabled={disabled}
        maxLength={255}
        aria-label={`Production branch for ${repo.repoName}`}
        placeholder="default branch"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value.trim() === stored) return;
          onSave(repo.repoKey, value.trim() === '' ? null : value.trim());
        }}
      />
    </div>
  );
}

/**
 * Who records a delivery for this workspace (amendment §2) and, in the
 * automatic modes, which branch counts as production per repository. Admin-only
 * like the CI/CD switch above it; the server refuses anyone else whatever this
 * renders.
 */
function ReleaseTriggerCard({
  wsId,
  canManage,
  intentEnabled,
}: {
  wsId: string;
  canManage: boolean;
  intentEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  // Intent off = nothing here to configure, and neither read is issued.
  const triggerQuery = useQuery({ ...intentReleaseTriggerOptions(wsId), enabled: intentEnabled });
  const repos = useQuery({ ...reposQueryOptions(wsId), enabled: intentEnabled });
  // A failed read is its own state, never dressed up as the `Manual` default.
  const triggerUnavailable = triggerQuery.isError;
  const trigger = triggerQuery.data ?? IntentReleaseTrigger.Manual;

  const triggerMutation = useMutation({
    mutationFn: setIntentReleaseTrigger,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['intent', 'release-trigger', wsId] }),
  });
  const branchMutation = useMutation({
    mutationFn: setProductionBranch,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'repos'] }),
  });
  const repoTriggerMutation = useMutation({
    mutationFn: setRepoReleaseTrigger,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'repos'] }),
  });
  const busy = !canManage || triggerQuery.isPending || triggerUnavailable || triggerMutation.isPending;
  // Shown once the per-repo setting is load-bearing: an automatic workspace
  // default, or a repository that already departs from a manual one.
  const showRepoOverrides =
    (repos.data?.length ?? 0) > 0 &&
    (trigger !== IntentReleaseTrigger.Manual ||
      (repos.data?.some((repo) => repo.intentReleaseTrigger != null) ?? false));

  if (!intentEnabled) return <EmptyNote>Intent is not enabled for this workspace.</EmptyNote>;

  return (
    <Card>
      <CardHead
        title="Intent release trigger"
        sub="Who records a delivery against the product rules"
        right={
          <Select
            value={triggerUnavailable ? undefined : trigger}
            disabled={busy}
            onValueChange={(next) =>
              triggerMutation.mutate({ wsId, intentReleaseTrigger: next as IntentReleaseTrigger })
            }
          >
            <SelectTrigger aria-label="Intent release trigger" className="w-40">
              <SelectValue placeholder="Unavailable" />
            </SelectTrigger>
            <SelectContent>
              {TRIGGERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {releaseTriggerLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <CardBody className="flex flex-col gap-2">
        <p className="text-[13px] text-ink-3">
          {triggerUnavailable ? 'Release trigger unavailable' : releaseTriggerExplain[trigger]}
        </p>
        {!triggerUnavailable && showRepoOverrides && (
          <div className="flex flex-col gap-2 pt-1">
            <p className="text-[12.5px] uppercase tracking-[0.04em] text-ink-4">
              Repository overrides and production branches
            </p>
            {repos.data?.map((repo) => (
              <ProductionBranchRow
                key={repo.id}
                repo={repo}
                disabled={busy || branchMutation.isPending || repoTriggerMutation.isPending}
                workspaceTrigger={trigger}
                onTriggerSave={(repoKey, intentReleaseTrigger) =>
                  repoTriggerMutation.mutate({ wsId, repoKey, intentReleaseTrigger })
                }
                onSave={(repoKey, productionBranch) => branchMutation.mutate({ wsId, repoKey, productionBranch })}
              />
            ))}
          </div>
        )}
        {triggerMutation.error && (
          <p className={ERROR_CLASS}>{message(triggerMutation.error, 'Failed to update the release trigger')}</p>
        )}
        {branchMutation.error && (
          <p className={ERROR_CLASS}>{message(branchMutation.error, 'Failed to update the production branch')}</p>
        )}
        {repoTriggerMutation.error && (
          <p className={ERROR_CLASS}>{message(repoTriggerMutation.error, 'Failed to update the release trigger')}</p>
        )}
      </CardBody>
    </Card>
  );
}

export function CiCdPanel({
  wsId,
  canManage,
  intentEnabled,
}: {
  wsId: string;
  canManage: boolean;
  intentEnabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <CiCdToggleCard wsId={wsId} canManage={canManage} />
      <ReleaseTriggerCard wsId={wsId} canManage={canManage} intentEnabled={intentEnabled} />
      {canManage ? <TokensCard wsId={wsId} /> : <EmptyNote>Only admins can view or mint service tokens.</EmptyNote>}
    </div>
  );
}
