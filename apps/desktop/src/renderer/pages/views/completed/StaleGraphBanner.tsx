import { InfoCircle } from '@solar-icons/react';
import { Alert, AlertActions, AlertDescription, AlertTitle } from '../../../components/ui/alert';
import { Button } from '../../../components/ui/button';
import type { RepoDetailState } from '../../../../shared/ipc-types';
import { staleBannerMessage } from '../../../features/explorer/workspace-graph-format';

export interface StaleGraphBannerProps {
  /** Pushed repos whose worktree has moved on since the parse. Empty renders nothing. */
  staleRepos: RepoDetailState[];
  /** A summarize/push is already running — the CTA would be a no-op. */
  isUpdating: boolean;
  onUpdate: () => void;
  onRemindLater: () => void;
}

/**
 * Amber "graph is out of date" strip under the top bar.
 *
 * The amber alert variant carries the gradient; --color-bg-warning is red and
 * would read as an error rather than a nudge.
 */
export function StaleGraphBanner({ staleRepos, isUpdating, onUpdate, onRemindLater }: StaleGraphBannerProps) {
  if (staleRepos.length === 0) return null;

  return (
    <Alert variant="amber" className="mx-4 mb-2 shrink-0 flex-row items-center gap-3 px-3">
      <InfoCircle weight="Bold" className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <AlertTitle className="font-bold">Graph is out of date</AlertTitle>
        <AlertDescription className="truncate font-medium">{staleBannerMessage(staleRepos)}</AlertDescription>
      </div>
      <AlertActions className="shrink-0 pt-0">
        <Button size="sm" className="no-drag" disabled={isUpdating} onClick={onUpdate}>
          {isUpdating ? 'Updating…' : 'Update graph'}
        </Button>
        <Button size="sm" variant="secondary" className="no-drag text-content-action-secondary" onClick={onRemindLater}>
          Remind Later
        </Button>
      </AlertActions>
    </Alert>
  );
}
