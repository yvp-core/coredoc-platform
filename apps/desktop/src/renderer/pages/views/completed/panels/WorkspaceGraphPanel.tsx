import { AddFolder, CheckCircle, ClockCircle, DangerTriangle, ShareCircle } from '@solar-icons/react';
import { format } from 'date-fns';
import { Alert, AlertTitle } from '../../../../components/ui/alert';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Progress } from '../../../../components/ui/progress';
import { Spinner } from '../../../../components/ui/spinner';
import { GraphStatus, graphStatus } from '../../../../features/explorer/workspace-graph-format';
import { WorkspaceGraphRepoRow } from './WorkspaceGraphRepoRow';
import type { RepoDetailState } from '../../../../../shared/ipc-types';
import type { WorkflowAction } from '../../../../stores/project-detail-store';
import type { ProjectRepository } from '../../../../types/project';

export interface WorkspaceGraphPanelProps {
  repositories: ProjectRepository[];
  repoStates: Map<string, RepoDetailState>;
  runningRepoNames: string[];
  latestPush: string | undefined;
  isCloudMember: boolean;
  /**
   * The graph-building stage in flight, per repo. A non-empty map switches the
   * panel to the running state: step chip + indeterminate bars instead of
   * freshness and the Update-graph CTA. The bars are infinite animations — the
   * CLI reports no percentage and none is invented here.
   */
  runningStageByRepo?: ReadonlyMap<string, WorkflowAction>;
  /**
   * Set by the running drawer, which carries a Stop in its sticky footer — the
   * rows then drop their own Stop rather than offering it twice. The plain
   * workspace-graph panel has no footer, so its rows keep theirs.
   */
  stopInFooter?: boolean;
  onAddRepo: () => void;
  /** Graph-level re-parse chain. Omitted where the workspace has no local repos to run. */
  onUpdateGraph?: () => void;
  onRunAction: (repoName: string, action: WorkflowAction, args?: Record<string, unknown>) => void;
  onStopRepo: (repoName: string) => void;
  /** Re-open the terminal for a run already in flight. */
  onShowTerminal: (repoName: string) => void;
  onReviewRepo: (repoName: string) => void;
  onRemoveRepo: (repoName: string) => void;
  /** Cloud members only — resolves the local folder linked to a workspace repo. */
  getLinkedPath?: (repoName: string) => string | undefined;
  onLinkRepo?: (repoName: string) => void;
  onUnlinkRepo?: (repoName: string) => void;
}

/** The chip carries the stage; nothing else in the drawer distinguishes them. */
const GRAPH_UPDATE_LABEL = 'Updating Graph';
const STEP_LABEL: Partial<Record<WorkflowAction, string>> = {
  parse: 'Parsing',
  summarize: 'Summarizing',
  push: 'Pushing',
};

/** Docked panel listing the workspace's repositories and the graph's freshness. */
export function WorkspaceGraphPanel({
  repositories,
  repoStates,
  runningRepoNames,
  latestPush,
  isCloudMember,
  runningStageByRepo,
  stopInFooter,
  onAddRepo,
  onUpdateGraph,
  onRunAction,
  onStopRepo,
  onShowTerminal,
  onReviewRepo,
  onRemoveRepo,
  getLinkedPath,
  onLinkRepo,
  onUnlinkRepo,
}: WorkspaceGraphPanelProps) {
  const status = graphStatus(Array.from(repoStates.values()));
  const healthy = status.status === GraphStatus.UpToDate;
  const stageLabel = (action: WorkflowAction | undefined): string | null =>
    action ? (STEP_LABEL[action] ?? GRAPH_UPDATE_LABEL) : null;
  // The header chip is workspace-level: the chain runs one repo's stage at a
  // time, so the first stage in flight is the one to name.
  const [workspaceStage] = runningStageByRepo ? [...runningStageByRepo.values()] : [];
  const runningLabel = stageLabel(workspaceStage);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1 px-5 py-1">
          <ShareCircle weight="Bold" className="size-4 shrink-0 text-content-primary" />
          <h2 className="text-sm font-black leading-5 text-content-primary">Workspace Graph</h2>
        </div>

        {runningLabel ? (
          <div className="flex items-center justify-between gap-2.5 px-5">
            <Badge variant="info" className="shrink-0">
              <Spinner className="size-3" />
              {runningLabel}
            </Badge>
            <Progress indeterminate className="w-[177px] shrink-0" />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2.5 px-5">
            <Badge variant={healthy ? 'success' : 'warning'} className="shrink-0">
              {healthy ? (
                <CheckCircle weight="Bold" className="size-3 text-content-tag-success" />
              ) : (
                <DangerTriangle weight="Bold" className="size-3 text-content-tag-warning" />
              )}
              {status.label}
            </Badge>
            {latestPush && (
              <span className="flex items-center gap-1 text-xs font-medium leading-4 text-content-secondary">
                <ClockCircle className="size-4 shrink-0" />
                {format(new Date(latestPush), 'dd.MM.yyyy / h:mm a')}
              </span>
            )}
          </div>
        )}
      </div>

      {runningLabel ? (
        <div className="px-5 pt-2.5">
          <Alert variant="amber" className="py-3">
            <DangerTriangle weight="Bold" />
            <AlertTitle className="text-xs font-medium leading-4 text-content-secondary">
              Please stay here while we update graph
            </AlertTitle>
          </Alert>
        </div>
      ) : (
        onUpdateGraph && (
          <div className="px-5 pt-2">
            <Button size="sm" className="w-full" onClick={onUpdateGraph}>
              Update graph
            </Button>
          </div>
        )
      )}

      <div className="px-5 pt-3">
        <div className="h-px rounded-[10px] bg-border-input" />
      </div>

      <div className="flex items-center justify-between px-5 pt-4">
        <span className="text-sm font-black leading-5 text-content-primary">Repositories:</span>
        {!isCloudMember && (
          <Button variant="outline" size="sm" className="w-[142px] gap-1.5" onClick={onAddRepo}>
            <AddFolder className="size-4" />
            Edit repositories
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2 px-5 pt-2">
        {repositories.map((repo) => (
          <WorkspaceGraphRepoRow
            key={repo.id}
            repoName={repo.name}
            repoPath={repo.path}
            state={repoStates.get(repo.name)}
            isRunning={runningRepoNames.includes(repo.name)}
            runningLabel={stageLabel(runningStageByRepo?.get(repo.name)) ?? undefined}
            stopInFooter={stopInFooter}
            readOnly={isCloudMember}
            onRunAction={(action, args) => onRunAction(repo.name, action, args)}
            onStop={() => onStopRepo(repo.name)}
            onShowTerminal={() => onShowTerminal(repo.name)}
            onReview={() => onReviewRepo(repo.name)}
            onRemove={() => onRemoveRepo(repo.name)}
            linkedPath={getLinkedPath?.(repo.name)}
            onLink={onLinkRepo ? () => onLinkRepo(repo.name) : undefined}
            onUnlink={onUnlinkRepo ? () => onUnlinkRepo(repo.name) : undefined}
          />
        ))}
      </div>

      <div className="h-4 shrink-0" />
    </div>
  );
}
