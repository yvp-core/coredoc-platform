import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '@/api/client';
import {
  createConnector,
  deleteConnector,
  deliveryConnectorsQueryOptions,
  deliverySettingsQueryOptions,
  setConnectorStatus,
  setDeliveryEnabled,
  syncConnector,
  type CreateConnectorInput,
} from '@/api/queries/delivery-settings';
import { EmptyNote } from '@/components/empty-note';
import { Badge } from '@/components/ui/badge';
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
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Table, Td, Th, Tr } from '@/features/teams/table';
import { formatRelativeTime } from '@/lib/time';

import type { DeliveryConnector } from './types';

const ERROR_CLASS = 'text-[13px] text-danger-text';

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** "a, b" → ['a','b']; empty input stays undefined so the DTO field is omitted. */
function csv(value: string): string[] | undefined {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** baseUrl is not in the list projection, so identity comes from the config scope. */
function scopeLabel(connector: DeliveryConnector): string {
  const scope = connector.config?.repos ?? connector.config?.projects ?? [];
  return scope.length > 0 ? scope.join(', ') : 'all accessible';
}

function ConnectorRow({
  connector,
  wsId,
  onDelete,
}: {
  connector: DeliveryConnector;
  wsId: string;
  onDelete: (connector: DeliveryConnector) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'delivery-connectors'] });

  const syncMutation = useMutation({
    mutationFn: syncConnector,
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => setError(message(err, 'Failed to trigger a sync')),
  });

  const statusMutation = useMutation({
    mutationFn: setConnectorStatus,
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => setError(message(err, 'Failed to change the connector status')),
  });

  const paused = connector.status === 'paused';
  const busy = syncMutation.isPending || statusMutation.isPending;

  return (
    <>
      <Tr>
        <Td className="font-mono text-[12.5px] text-ink-1">{connector.provider}</Td>
        <Td className="text-ink-2">{scopeLabel(connector)}</Td>
        <Td>
          <Badge variant={paused ? 'warn' : 'ok'}>{connector.status}</Badge>
        </Td>
        <Td className="text-ink-4">
          {connector.lastSyncAt === null ? 'never' : formatRelativeTime(connector.lastSyncAt)}
        </Td>
        <Td className="w-8">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={`Actions for ${connector.provider}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={busy || paused}
                onSelect={() => syncMutation.mutate({ wsId, connectorId: connector.id })}
              >
                Sync now
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() =>
                  statusMutation.mutate({ wsId, connectorId: connector.id, action: paused ? 'resume' : 'pause' })
                }
              >
                {paused ? 'Resume' : 'Pause'}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(connector)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Td>
      </Tr>
      {error && (
        <tr>
          <Td colSpan={5} className="text-left">
            <p className={ERROR_CLASS}>{error}</p>
          </Td>
        </tr>
      )}
    </>
  );
}

function AddConnectorDialog({
  wsId,
  open,
  onOpenChange,
}: {
  wsId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<'github' | 'jira'>('github');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [scope, setScope] = useState('');
  const [validation, setValidation] = useState<string | null>(null);

  function reset() {
    setToken('');
    setEmail('');
    setBaseUrl('');
    setScope('');
    setValidation(null);
  }

  const mutation = useMutation({
    mutationFn: createConnector,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'delivery-connectors'] });
      reset();
      onOpenChange(false);
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (token.trim() === '') {
      setValidation(provider === 'github' ? 'A GitHub PAT is required' : 'A Jira API token is required');
      return;
    }
    if (provider === 'jira' && (email.trim() === '' || baseUrl.trim() === '')) {
      setValidation('Jira connectors require both an account email and a site base URL');
      return;
    }
    setValidation(null);
    const input: CreateConnectorInput =
      provider === 'github'
        ? { provider, token: token.trim(), repos: csv(scope), baseUrl: baseUrl.trim() || undefined }
        : { provider, token: token.trim(), email: email.trim(), baseUrl: baseUrl.trim(), projects: csv(scope) };
    mutation.mutate({ wsId, input });
  }

  const error = validation ?? (mutation.error ? message(mutation.error, 'Failed to create the connector') : null);
  const github = provider === 'github';

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
          <DialogTitle>Add a delivery connector</DialogTitle>
          <DialogDescription>
            One connector per provider — posting again rotates the credential of the existing one.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogBody className="flex flex-col gap-3">
            <Segmented<'github' | 'jira'>
              value={provider}
              onChange={setProvider}
              items={[
                { value: 'github', label: 'GitHub' },
                { value: 'jira', label: 'Jira' },
              ]}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="connector-token">{github ? 'Personal access token' : 'API token'}</Label>
              {/* Write-only: the server encrypts it and no response ever echoes it back. */}
              <Input
                id="connector-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={github ? 'ghp_…' : 'ATATT…'}
              />
            </div>
            {!github && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="connector-email">Account email</Label>
                <Input
                  id="connector-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="connector-base-url">{github ? 'Enterprise host (optional)' : 'Site base URL'}</Label>
              <Input
                id="connector-base-url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={github ? 'https://github.example.com/api/v3' : 'https://example.atlassian.net'}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="connector-scope">{github ? 'Repositories' : 'Project keys'}</Label>
              <Input
                id="connector-scope"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                placeholder={github ? 'owner/repo, owner/other' : 'ENG, OPS'}
              />
              <p className="text-[12.5px] text-ink-4">
                Comma separated. Leave empty to ingest everything the credential can reach.
              </p>
            </div>
            {error && <p className={ERROR_CLASS}>{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Connecting…' : 'Add connector'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteConnectorDialog({
  wsId,
  connector,
  onClose,
}: {
  wsId: string;
  connector: DeliveryConnector | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: deleteConnector,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'delivery-connectors'] });
      onClose();
    },
  });

  return (
    <Dialog open={connector !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete the {connector?.provider} connector</DialogTitle>
          <DialogDescription>
            This permanently removes its raw payloads, status policy and connector-scoped code changes. Canonical task
            references are detached. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {mutation.error && (
          <DialogBody>
            <p className={ERROR_CLASS}>{message(mutation.error, 'Failed to delete the connector')}</p>
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending || connector === null}
            onClick={() => connector && mutation.mutate({ wsId, connectorId: connector.id })}
          >
            {mutation.isPending ? 'Deleting…' : 'Delete connector'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeliveryPanel({ wsId }: { wsId: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery(deliverySettingsQueryOptions(wsId));
  const enabled = settings.data?.enabled ?? false;
  // Every connector route sits behind DeliveryEnabledGuard — asking while the
  // feature is off is a guaranteed 403.
  const connectors = useQuery(deliveryConnectorsQueryOptions(wsId, enabled));
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<DeliveryConnector | null>(null);

  const toggleMutation = useMutation({
    mutationFn: setDeliveryEnabled,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'delivery-settings'] }),
  });

  const rows = connectors.data?.connectors ?? [];

  return (
    <Card>
      <CardHead
        title="Delivery analytics"
        sub="Poll GitHub and Jira to fold delivery signals into the graph"
        right={
          <div className="flex items-center gap-2">
            {enabled && (
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                Add connector
              </Button>
            )}
            <Switch
              checked={enabled}
              disabled={settings.isPending || toggleMutation.isPending}
              aria-label="Enable delivery analytics"
              onCheckedChange={(next) => toggleMutation.mutate({ wsId, enabled: next })}
            />
          </div>
        }
      />
      <CardBody className="pt-2">
        {toggleMutation.error && (
          <p className={`mb-2 ${ERROR_CLASS}`}>{message(toggleMutation.error, 'Failed to update the setting')}</p>
        )}
        {!enabled ? (
          <EmptyNote>Delivery analytics is off. Turn it on to connect GitHub or Jira.</EmptyNote>
        ) : connectors.isError ? (
          <p className={ERROR_CLASS}>{message(connectors.error, 'Failed to load connectors')}</p>
        ) : rows.length === 0 ? (
          <EmptyNote>{connectors.isPending ? 'Loading connectors…' : 'No connectors yet.'}</EmptyNote>
        ) : (
          <Table minWidth={620}>
            <thead>
              <tr>
                <Th>Provider</Th>
                <Th>Scope</Th>
                <Th>Status</Th>
                <Th>Last sync</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((connector) => (
                <ConnectorRow key={connector.id} connector={connector} wsId={wsId} onDelete={setDeleting} />
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>
      <AddConnectorDialog wsId={wsId} open={adding} onOpenChange={setAdding} />
      <DeleteConnectorDialog wsId={wsId} connector={deleting} onClose={() => setDeleting(null)} />
    </Card>
  );
}
