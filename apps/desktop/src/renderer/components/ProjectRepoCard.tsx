import { AnalysisStatus } from './AnalysisStatus';
import { useState } from 'react';
import { GitBranch, FolderOpen, Link2Off, ExternalLink } from 'lucide-react';
import {
  CodeFile,
  FileDownload,
  MenuDots,
  Refresh,
  TrashBinTrash,
  StopCircle,
  PlayCircle,
  RestartSquare,
} from '@solar-icons/react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { format } from 'date-fns';
import type { WorkflowAction } from '../stores/project-detail-store';
import type { RepoDetailState, OperationTimestamps, GitRevision, RepoStalenessInfo } from '../../shared/ipc-types';
import { getBadge } from './RepoStateBadge';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { RegenerateDialog } from './RegenerateDialog';
import { RepositoryStatus, isLoadingStatus } from '../types/project';

interface ProjectRepoCardProps {
  repoName: string;
  repoUrl: string;
  state: RepoDetailState | undefined;
  isLoading: boolean;
  isRunning: boolean;
  /** True when the user previously canceled a generate/parse for this repo
   *  and it hasn't been successfully parsed since. Drives the per-repo
   *  "Start parsing" dropdown item. */
  wasCanceled?: boolean;
  onRunAction: (action: WorkflowAction, args?: Record<string, unknown>) => void;
  onStop?: () => void;
  onRemove: () => void;
  onReview?: () => void;
  onApprove?: () => void | Promise<void>;
  onReparse?: (feedback: string) => void;
  runningAction?: WorkflowAction;
  status: RepositoryStatus;
  isSelected?: boolean;
  onClick?: () => void;
  mode?: 'wizard' | 'completed';
  readOnly?: boolean;
  linkedPath?: string;
  onLink?: () => void;
  onUnlink?: () => void;
  graphUpdating?: boolean;
}

export function ProjectRepoCard({
  repoName,
  repoUrl,
  state,
  isLoading,
  isRunning,
  wasCanceled = false,
  onRunAction,
  onStop,
  onRemove,
  onReparse,
  runningAction,
  status,
  isSelected,
  onClick,
  mode = 'wizard',
  readOnly,
  linkedPath,
  onLink,
  onUnlink,
  graphUpdating,
}: ProjectRepoCardProps) {
  const isCompleted = mode === 'completed';
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const isApproved = !!state?.approval?.approved && !state?.approval?.isStale;
  const canReparse = !!state?.parsed?.exists && !isApproved && !isRunning && !isLoading && !isLoadingStatus(status);
  // Show "Start parsing" only after a user-initiated cancel left the repo
  // without a successful parse output.
  const showStartParsing = wasCanceled && !isRunning && !isLoading && !state?.parsed?.exists;

  const stopLabel =
    runningAction === 'docs' || runningAction === 'cloud-docs' ? 'Stop docs generation' : 'Stop parsing';

  return (
    // Selago, not the white glass Card default: DESIGN.md gives repo cards the soft
    // lilac surface, and `WorkspaceGraphRepoRow` — the same card in the workspace-graph
    // drawer — already paints it. Two greys for one card is the drift this aligns.
    <Card
      className="cursor-pointer gap-1.5 border-selago-100 bg-selago-50 pt-2 pb-3 shadow-none"
      data-selected={isSelected || undefined}
      onClick={onClick}
    >
      <CardContent className="px-4">
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex items-center gap-1 min-w-0 shrink">
              <div className="flex items-center py-0.5">
                <CodeFile weight="Bold" className="size-4" />
              </div>
              <h3 className="min-w-0 truncate font-semibold text-sm leading-5 text-content-primary">{repoName}</h3>
            </div>
            {state?.parsedOutputPath && (
              <>
                <div className="w-px h-2 bg-content-quaternary shrink-0" />
                <button
                  type="button"
                  className="flex items-center gap-1 min-w-0 shrink"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.electronAPI.showItemInFolder(state.parsedOutputPath!);
                  }}
                >
                  <div className="flex items-center py-0.5">
                    <FileDownload className="size-4 text-content-secondary" />
                  </div>
                  <span className="text-sm leading-5 text-content-secondary underline truncate">{repoName}.json</span>
                </button>
              </>
            )}
          </div>
          {graphUpdating ? (
            <div aria-hidden className="w-6 h-6 shrink-0" />
          ) : readOnly ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="wrapper" size="icon" className="w-6 h-6 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <MenuDots weight="Bold" className="size-4 rotate-90" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {linkedPath ? (
                  <>
                    <DropdownMenuItem onClick={() => window.electronAPI.showItemInFolder(linkedPath)}>
                      <ExternalLink className="size-4" />
                      Open in file explorer
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onUnlink}>
                      <Link2Off className="size-4" />
                      Unlink local folder
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem onClick={onLink}>
                    <FolderOpen className="size-4" />
                    Link to local folder
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="wrapper"
                  size="icon"
                  className="w-6 h-6 shrink-0 "
                  onClick={(e) => e.stopPropagation()}
                >
                  <MenuDots weight="Bold" className="size-4 rotate-90" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isCompleted ? (
                  <>
                    {state?.parserExists && (
                      <DropdownMenuItem disabled={isRunning || isLoading} onClick={() => onRunAction('generate')}>
                        <RestartSquare className="size-4" />
                        Regenerate Parser
                      </DropdownMenuItem>
                    )}
                    {isRunning && onStop ? (
                      <DropdownMenuItem onClick={onStop}>
                        <StopCircle className="size-4" />
                        {stopLabel}
                      </DropdownMenuItem>
                    ) : state?.parserExists && (!wasCanceled || state?.parsed?.exists) ? (
                      // Suppress Re-parse only when wasCanceled AND nothing has been
                      // parsed yet — otherwise a successfully-parsed repo whose
                      // re-parse was canceled would lose its only retry path.
                      // No feedback dialog: re-parse runs the existing parser on fresh
                      // code and chains through summarize → push. "Regenerate Parser"
                      // above is the dialog path for AI-rebuilding the parser.
                      <DropdownMenuItem disabled={isLoading} onClick={() => onRunAction('parse', { chain: true })}>
                        <RestartSquare className="size-4" />
                        Re-parse Repository
                      </DropdownMenuItem>
                    ) : null}
                    {(showStartParsing || (isRunning && onStop) || state?.parserExists) && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={isRunning || isLoading || isLoadingStatus(status)}
                      onClick={onRemove}
                    >
                      <TrashBinTrash className="size-4" />
                      Remove
                    </DropdownMenuItem>
                  </>
                ) : (
                  <>
                    {showStartParsing && (
                      <DropdownMenuItem onClick={() => onRunAction(state?.parserExists ? 'parse' : 'generate')}>
                        <PlayCircle className="size-4" />
                        Parse Repository
                      </DropdownMenuItem>
                    )}
                    {canReparse && (
                      <DropdownMenuItem onClick={() => setRegenerateOpen(true)}>
                        <RestartSquare className="size-4" />
                        Re-parse Repository
                      </DropdownMenuItem>
                    )}
                    {isRunning && onStop && (
                      <DropdownMenuItem onClick={onStop}>
                        <StopCircle className="size-4" />
                        {stopLabel}
                      </DropdownMenuItem>
                    )}
                    {(isRunning || showStartParsing || canReparse) && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={isRunning || isLoading || isLoadingStatus(status)}
                      onClick={onRemove}
                    >
                      <TrashBinTrash className="size-4" />
                      Remove
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <p className="text-content-quaternary text-xs leading-4 truncate" title={repoUrl}>
          {repoUrl}
        </p>
        {linkedPath && (
          <div className="flex items-center gap-1 text-xs text-content-quaternary truncate">
            <FolderOpen className="size-3 shrink-0" />
            <span className="truncate" title={linkedPath}>
              {linkedPath}
            </span>
          </div>
        )}
      </CardContent>
      {/* Status row — separate Card child for gap-1.5 */}
      <div className="flex items-center gap-3 px-4 text-xs text-content-quaternary">
        {getBadge(status)}
        {isRunning ? (
          <div className="w-24 flex-1 h-2 rounded-full bg-bg-supportive overflow-hidden shrink-0">
            <div className="h-full w-1/4 rounded-full bg-content-primary animate-indeterminate" />
          </div>
        ) : (
          state?.operations && (
            <>
              <OperationTimestampsRow operations={state.operations} />
              <AnalysisStatus analysis={state?.parsed?.stats?.analysis} />
              {state?.parsedRevision && (
                <GitRevisionBadge revision={state.parsedRevision} staleness={state.staleness} />
              )}
            </>
          )
        )}
      </div>
      <RegenerateDialog
        open={regenerateOpen}
        onOpenChange={setRegenerateOpen}
        onSubmit={(feedback) => (onReparse ? onReparse(feedback) : onRunAction('generate', { feedback }))}
      />
    </Card>
  );
}

function GitRevisionBadge({ revision }: { revision: GitRevision; staleness?: RepoStalenessInfo }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 min-w-0 cursor-default">
          <span className="flex items-center gap-1 text-xs text-content-secondary min-w-0">
            <GitBranch className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {revision.branch} @ {revision.commitShortHash}
            </span>
          </span>
        </div>
      </TooltipTrigger>

      <TooltipContent
        side="right"
        sideOffset={-14}
        className="bg-bg-inverted-secondary text-white border-0 shadow-none rounded-md px-1 py-0.5 text-xs font-normal leading-4"
      >
        {revision.branch} @ {revision.commitShortHash}
      </TooltipContent>
    </Tooltip>
  );
}

export function OperationTimestampsRow({ operations }: { operations: OperationTimestamps }) {
  const lastOperation = operations.lastPushed ?? operations.lastSummarized ?? operations.lastParsed;
  if (!lastOperation) return null;

  return (
    <div className="flex items-center gap-1 text-xs text-content-secondary min-w-0 shrink-0">
      <Refresh weight="Bold" className="text-lg shrink-0" />
      <span>{format(new Date(lastOperation), 'dd.MM.yyyy / h:mm a')}</span>
    </div>
  );
}
