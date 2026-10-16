import { AnalysisStatus } from '../../../../components/AnalysisStatus';
import { ClockCircle, CodeFile, MenuDots, TrashBinTrash, StopCircle, DangerTriangle } from '@solar-icons/react';
import { ExternalLink, Link2Off, FolderOpen } from 'lucide-react';
import { Badge } from '../../../../components/ui/badge';
import { Progress } from '../../../../components/ui/progress';
import { Spinner } from '../../../../components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import { formatDateTime } from '../../../../lib/utils';
import type { RepoDetailState } from '../../../../../shared/ipc-types';
import type { WorkflowAction } from '../../../../stores/project-detail-store';

export interface WorkspaceGraphRepoRowProps {
  repoName: string;
  repoPath: string;
  state: RepoDetailState | undefined;
  isRunning: boolean;
  /**
   * This repo's own graph-building stage, when it is on one: the card then
   * carries the step chip and its own indeterminate bar.
   */
  runningLabel?: string;
  /** Stop lives in the drawer footer here, so the row must not offer a second one. */
  stopInFooter?: boolean;
  readOnly: boolean;
  onRunAction: (action: WorkflowAction, args?: Record<string, unknown>) => void;
  onStop?: () => void;
  onShowTerminal?: () => void;
  onReview?: () => void;
  onRemove: () => void;
  /** Cloud members only: the local folder this workspace repo is linked to. */
  linkedPath?: string;
  onLink?: () => void;
  onUnlink?: () => void;
}

/**
 * One repository in the Workspace Graph panel: identity, local path, and either
 * its last-sync stamp or a re-parse prompt.
 *
 * Deliberately not ProjectRepoCard — that component carries the whole wizard
 * workflow dropdown and a selection model this panel has no use for.
 */
export function WorkspaceGraphRepoRow({
  repoName,
  repoPath,
  state,
  isRunning,
  runningLabel,
  stopInFooter,
  readOnly,
  onRunAction,
  onStop,
  onShowTerminal,
  onReview,
  onRemove,
  linkedPath,
  onLink,
  onUnlink,
}: WorkspaceGraphRepoRowProps) {
  // What this repo can actually DO, not what the menu happens to list. A freshly
  // added repo has no parser and no output, so "Re-parse", "Summarize", "Push to
  // graph" and "Review parse results" are all offers the app cannot honour — the
  // menu was rendering them unconditionally. `state === undefined` means the detail
  // load has not landed yet; it reads as "nothing here", which is the truth for the
  // repo that just arrived and self-corrects once the state does.
  const hasParser = state?.parserExists === true;
  const hasParsed = state?.parsed?.exists === true;

  const isStale = state?.staleness?.isStale === true;
  const notPushed = state !== undefined && !state.neo4jSynced.synced;
  const lastSync = state?.operations?.lastPushed;
  const revision = state?.parsedRevision?.commitShortHash;

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-selago-100 bg-selago-50 pt-2 pb-3">
      <div className="flex items-center gap-1 px-4">
        <CodeFile weight="Bold" className="size-4 shrink-0 text-content-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5 text-content-primary" title={repoName}>
          {repoName}
        </span>
        {readOnly ? (
          (onLink || onUnlink) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Actions for ${repoName}`}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-content-tertiary hover:text-content-primary"
                >
                  <MenuDots className="size-4 rotate-90" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {linkedPath ? (
                  <>
                    <DropdownMenuItem onClick={() => void window.electronAPI.showItemInFolder(linkedPath)}>
                      <ExternalLink className="size-3.5" />
                      Open in file explorer
                    </DropdownMenuItem>
                    {onUnlink && (
                      <DropdownMenuItem onClick={onUnlink}>
                        <Link2Off className="size-3.5" />
                        Unlink local folder
                      </DropdownMenuItem>
                    )}
                  </>
                ) : (
                  onLink && (
                    <DropdownMenuItem onClick={onLink}>
                      <FolderOpen className="size-3.5" />
                      Link to local folder
                    </DropdownMenuItem>
                  )
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${repoName}`}
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-content-tertiary hover:text-content-primary"
              >
                <MenuDots className="size-4 rotate-90" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!hasParser ? (
                // Nothing exists yet: authoring the profile is the only move.
                <DropdownMenuItem onClick={() => onRunAction('generate')}>Generate parser</DropdownMenuItem>
              ) : (
                <>
                  {/* chain: parse -> summarize -> push, matching the old completed-mode
                      card. Without it a re-parse leaves the graph stale. */}
                  <DropdownMenuItem onClick={() => onRunAction('parse', { chain: true })}>
                    {hasParsed ? 'Re-parse' : 'Parse repository'}
                  </DropdownMenuItem>
                  {hasParsed && (
                    <>
                      <DropdownMenuItem onClick={() => onRunAction('summarize')}>Summarize</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onRunAction('push')}>Push to graph</DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onRunAction('generate')}>Regenerate parser…</DropdownMenuItem>
                  {hasParsed && onReview && (
                    <DropdownMenuItem onClick={onReview}>Review parse results</DropdownMenuItem>
                  )}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                <TrashBinTrash className="size-3.5" />
                Remove repository
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <p
        className="truncate px-4 text-xs font-semibold leading-4 text-content-quaternary"
        title={readOnly ? (linkedPath ?? 'Not linked to a local folder') : repoPath}
      >
        {readOnly ? (linkedPath ?? 'Not linked to a local folder') : repoPath}
      </p>

      <div className="flex items-center gap-2.5 px-4">
        {isRunning ? (
          <>
            {/* The only way back to a terminal the user dismissed mid-run. */}
            <button
              type="button"
              onClick={onShowTerminal}
              aria-label={`Show ${repoName} output`}
              className="cursor-pointer"
            >
              <Badge variant="info" className="shrink-0">
                {runningLabel && <Spinner className="size-3" />}
                {runningLabel ?? 'Working…'}
              </Badge>
            </button>
            {runningLabel && <Progress indeterminate className="w-[145px] shrink-0" />}
            {/* Stop moves to the drawer footer while the running drawer is up;
                everywhere else the row is the only place to stop this repo. */}
            {!stopInFooter && onStop && (
              <button
                type="button"
                onClick={onStop}
                aria-label={`Stop ${repoName}`}
                className="cursor-pointer text-content-tertiary hover:text-content-primary"
              >
                <StopCircle className="size-4" />
              </button>
            )}
          </>
        ) : isStale || notPushed ? (
          <Badge variant="warning" className="shrink-0">
            <DangerTriangle weight="Bold" className="size-3 text-content-tag-warning" />
            {notPushed ? 'Not in graph' : 'Required upd.'}
          </Badge>
        ) : lastSync ? (
          <span className="flex min-w-0 items-center gap-1 text-xs leading-4 text-content-secondary">
            <ClockCircle className="size-4 shrink-0" />
            {formatDateTime(new Date(lastSync))}
          </span>
        ) : null}

        <AnalysisStatus analysis={state?.parsed?.stats?.analysis} />
        {revision && <span className="shrink-0 text-xs leading-4 text-content-secondary">v: {revision}</span>}
      </div>
    </div>
  );
}
