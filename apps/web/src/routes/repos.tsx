import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { meQueryOptions } from '@/api/queries/me';
import { disconnectRepo, repoStateQueryOptions, reposQueryOptions } from '@/api/queries/repos';
import type { WorkspaceRepo } from '@/api/types';
import { EmptyNote } from '@/components/empty-note';
import { PageHead } from '@/components/page-head';
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
import { Input } from '@/components/ui/input';
import { Table, Td, Th, Tr } from '@/features/teams/table';
import { hasAdminAccess } from '@/lib/roles';
import { formatRelativeTime } from '@/lib/time';
import { findWorkspace } from './workspace';

const NUM = new Intl.NumberFormat('en-US');
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : NUM.format(Math.round(n)));

/** The CLI path that puts a repo here — see `coredoc push` in packages/cli/src/index.ts. */
const PUSH_HINT = 'coredoc push <repo> --remote --workspace-id <id>';

function RepoRow({
  repo,
  wsId,
  canManage,
  onRemove,
}: {
  repo: WorkspaceRepo;
  wsId: string;
  canManage: boolean;
  onRemove: () => void;
}) {
  // Summary version is the one field the control-plane list row does not
  // carry — it describes the graph actually being served, so it comes from
  // the per-repo /state endpoint. A dash until it lands; never a stand-in.
  const state = useQuery(repoStateQueryOptions(wsId, repo.repoName));

  return (
    <Tr>
      <Td>
        <div className="font-medium text-ink-1">{repo.repoName}</div>
        <div className="truncate font-mono text-[12px] text-ink-4">{repo.gitUrl ?? repo.repoKey}</div>
      </Td>
      <Td>{fmt(repo.nodeCount)}</Td>
      <Td>{fmt(repo.edgeCount)}</Td>
      <Td className="text-ink-4">{formatRelativeTime(repo.lastPushedAt)}</Td>
      <Td className="font-mono text-[12px]">{state.data?.currentSummaryVersion ?? '—'}</Td>
      {canManage ? (
        <Td className="pr-0">
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </Td>
      ) : null}
    </Tr>
  );
}

function RemoveRepoDialog({ wsId, repo, onClose }: { wsId: string; repo: WorkspaceRepo | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState('');
  const remove = useMutation({
    mutationFn: (repoId: string) => disconnectRepo(wsId, repoId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'repos'] }),
        queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'config'] }),
      ]);
      onClose();
    },
  });

  return (
    <Dialog
      open={repo !== null}
      onOpenChange={(open) => {
        if (!open) {
          setConfirm('');
          remove.reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove repository</DialogTitle>
          <DialogDescription>
            This disconnects <span className="font-mono">{repo?.repoName}</span> from the workspace. Its graph stops
            being served to members and MCP clients. Push it again to restore it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <label htmlFor="confirm-repo" className="text-[12.5px] text-ink-3">
            Type <span className="font-mono text-ink-1">{repo?.repoName}</span> to confirm
          </label>
          <Input
            id="confirm-repo"
            value={confirm}
            autoComplete="off"
            onChange={(event) => setConfirm(event.target.value)}
          />
          {remove.isError ? (
            <div className="text-[12.5px] text-danger-text">
              {remove.error instanceof Error ? remove.error.message : 'Removal failed'}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setConfirm('');
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={repo === null || confirm !== repo.repoName || remove.isPending}
            onClick={() => repo && remove.mutate(repo.id)}
          >
            {remove.isPending ? 'Removing…' : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReposContent({ wsId, canManage }: { wsId: string; canManage: boolean }) {
  const reposQuery = useQuery(reposQueryOptions(wsId));
  const [pending, setPending] = useState<WorkspaceRepo | null>(null);

  return (
    <>
      <QueryBoundary query={reposQuery}>
        {(repos) => (
          <Card>
            <CardHead title="Connected repositories" sub={`${repos.length} in this workspace`} />
            <CardBody className="overflow-x-auto pt-2">
              {repos.length === 0 ? (
                <EmptyNote>
                  Push a repository from the CLI: <span className="font-mono text-ink-2">{PUSH_HINT}</span>
                </EmptyNote>
              ) : (
                <Table minWidth={680}>
                  <thead>
                    <tr>
                      <Th>Repository</Th>
                      <Th>Nodes</Th>
                      <Th>Edges</Th>
                      <Th>Last push</Th>
                      <Th>Summary</Th>
                      {canManage ? <Th className="pr-0">&nbsp;</Th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {repos.map((repo) => (
                      <RepoRow
                        key={repo.id}
                        repo={repo}
                        wsId={wsId}
                        canManage={canManage}
                        onRemove={() => setPending(repo)}
                      />
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        )}
      </QueryBoundary>
      <RemoveRepoDialog wsId={wsId} repo={pending} onClose={() => setPending(null)} />
    </>
  );
}

export function WorkspaceRepos() {
  const { slug } = useParams({ strict: false });
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const workspace = slug ? findWorkspace(me, slug) : undefined;

  // Unreachable: /w/$slug's beforeLoad redirects an unknown slug before this renders.
  if (!workspace) return null;

  return (
    <>
      <PageHead title="Repositories" sub="Parsed repos pushed into this workspace." />
      <ReposContent wsId={workspace.id} canManage={hasAdminAccess(workspace.role)} />
    </>
  );
}
