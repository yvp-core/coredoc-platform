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
import { hasAdminAccess } from '@/lib/roles';
import { formatRelativeTime } from '@/lib/time';
import { findWorkspace } from './workspace';

const TH = 'border-b border-border-soft pb-[7px] px-3 text-[10.5px] font-normal uppercase tracking-[0.04em] text-ink-4';
const TD = 'border-b border-border-soft px-3 py-2 text-ink-2';

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
    <tr className="hover:bg-surface-2">
      <td className={`${TD} pl-0`}>
        <div className="font-normal text-ink-1">{repo.repoName}</div>
        <div className="truncate font-mono text-[11px] text-ink-4">{repo.gitUrl ?? repo.repoKey}</div>
      </td>
      <td className={`${TD} num text-right`}>{fmt(repo.nodeCount)}</td>
      <td className={`${TD} num text-right`}>{fmt(repo.edgeCount)}</td>
      <td className={`${TD} text-right text-ink-4`}>{formatRelativeTime(repo.lastPushedAt)}</td>
      <td className={`${TD} text-right font-mono text-[11px]`}>{state.data?.currentSummaryVersion ?? '—'}</td>
      {canManage ? (
        <td className={`${TD} pr-0 text-right`}>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </td>
      ) : null}
    </tr>
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
          <label htmlFor="confirm-repo" className="text-[11.5px] text-ink-3">
            Type <span className="font-mono text-ink-1">{repo?.repoName}</span> to confirm
          </label>
          <Input
            id="confirm-repo"
            value={confirm}
            autoComplete="off"
            onChange={(event) => setConfirm(event.target.value)}
          />
          {remove.isError ? (
            <div className="text-[11.5px] text-danger-text">
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
                <table className="w-full min-w-[680px] border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      <th className={`${TH} pl-0 text-left`}>Repository</th>
                      <th className={`${TH} text-right`}>Nodes</th>
                      <th className={`${TH} text-right`}>Edges</th>
                      <th className={`${TH} text-right`}>Last push</th>
                      <th className={`${TH} text-right`}>Summary</th>
                      {canManage ? <th className={`${TH} pr-0 text-right`}>&nbsp;</th> : null}
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
                </table>
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
