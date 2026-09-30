import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useWorkspaceStore, type WorkspaceRepo } from '../../stores/workspace-store';
import { intentReleaseTriggerOptions } from '../../features/intent/intent-release-api';
import {
  IntentReleaseTrigger,
  releaseTriggerExplain,
  releaseTriggerLabels,
} from '../../../shared/intent-release-types';

const TRIGGERS = [IntentReleaseTrigger.Manual, IntentReleaseTrigger.Merge, IntentReleaseTrigger.Deploy];

/**
 * Production branch of one repository. Committed on blur rather than behind a
 * Save button: the field holds one short string, and an empty field is a
 * meaningful value (clear the override, fall back to the branch the delivery
 * connector reports), so there is nothing to validate before sending.
 */
function ProductionBranchRow({
  repo,
  disabled,
  onSave,
  workspaceTrigger,
  onTriggerSave,
}: {
  repo: WorkspaceRepo;
  disabled: boolean;
  workspaceTrigger: IntentReleaseTrigger;
  onTriggerSave: (repoKey: string, trigger: IntentReleaseTrigger | null) => void;
  onSave: (repoKey: string, branch: string | null) => void;
}) {
  const stored = repo.productionBranch ?? '';
  const [value, setValue] = useState(stored);

  return (
    <div className="flex items-center gap-2 text-xs text-content-secondary">
      <span className="min-w-0 flex-1 truncate">{repo.repoName}</span>
      <Select
        disabled={disabled}
        value={repo.intentReleaseTrigger ?? 'inherit'}
        onValueChange={(value) =>
          onTriggerSave(repo.repoKey, value === 'inherit' ? null : (value as IntentReleaseTrigger))
        }
      >
        <SelectTrigger aria-label={`Release trigger for ${repo.repoName}`} className="h-8 w-40">
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
      {(repo.intentReleaseTrigger ?? workspaceTrigger) !== IntentReleaseTrigger.Manual && (
        <Input
          className="h-8 w-44"
          value={value}
          disabled={disabled}
          maxLength={255}
          aria-label={`Production branch for ${repo.repoName}`}
          placeholder="default branch"
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (value.trim() === stored) return;
            onSave(repo.repoKey, value.trim() === '' ? null : value.trim());
          }}
        />
      )}
    </div>
  );
}

/**
 * Who records a delivery for this workspace (amendment §2) and, for the
 * automatic modes, which branch counts as production per repository. Admin-only
 * like the CI/CD switch beside it; the server refuses anyone else whatever this
 * renders.
 */
export function TeamMcpReleaseTriggerStep({ workspaceId }: { workspaceId: string }) {
  const { setIntentReleaseTrigger, setProductionBranch, setRepoReleaseTrigger } = useWorkspaceStore();
  // Intent off = no release trigger to choose: the whole card is about who
  // records intent deliveries. Gated on the same flag as the Intent tab, and
  // the reads below stay unissued so a disabled workspace makes no intent call.
  const intentEnabled = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.intentEnabled === true,
  );
  const queryClient = useQueryClient();
  // The same read the Releases header does, so the two cannot disagree: a
  // failed or pending read is its own state, not the `Manual` an absent field
  // (old server) legitimately means, and editing off a stale value is worse
  // than not offering the control.
  const triggerQuery = useQuery({ ...intentReleaseTriggerOptions(workspaceId), enabled: intentEnabled });
  const reposQuery = useQuery({
    queryKey: ['intent', 'release-repos', workspaceId],
    queryFn: () => window.electronAPI.workspaceListRepos(workspaceId),
    enabled: intentEnabled,
  });
  const repos = reposQuery.data ?? [];
  const triggerUnavailable = triggerQuery.isError;
  const trigger = triggerQuery.data ?? IntentReleaseTrigger.Manual;
  // Under a manual default with nothing overridden the rows said "Default
  // (Manual)" N times — a list of non-settings. It appears once the setting is
  // load-bearing: an automatic default, or a repository that already departs.
  const showRepoOverrides =
    repos.length > 0 &&
    (trigger !== IntentReleaseTrigger.Manual || repos.some((repo) => repo.intentReleaseTrigger != null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = saving || triggerQuery.isPending || triggerUnavailable || reposQuery.isPending || reposQuery.isError;

  const run = async (action: Promise<void>) => {
    setSaving(true);
    setError(null);
    try {
      await action;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!intentEnabled) {
    return (
      <section className="flex flex-col gap-3 pt-4" aria-label="Intent release trigger">
        <p className="text-xs leading-4 text-content-tertiary">Intent is not enabled for this workspace.</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 pt-4" aria-label="Intent release trigger">
      <div className="flex items-center gap-2">
        <h3 className="mr-auto text-xs font-medium text-content-primary">Workspace default</h3>
        <Select
          disabled={busy}
          value={triggerUnavailable ? '' : trigger}
          onValueChange={(value) =>
            void run(
              // The store is not the only reader: the Releases header reads the
              // same workspace row through `intentReleaseTriggerOptions`, so the
              // cached copy has to be dropped or the header shows the old mode.
              setIntentReleaseTrigger(value as IntentReleaseTrigger).then(() =>
                queryClient.invalidateQueries({ queryKey: ['intent', 'release-trigger', workspaceId] }),
              ),
            )
          }
        >
          <SelectTrigger aria-label="Intent release trigger" className="h-8 w-40">
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
      </div>
      <p className="text-xs leading-4 text-content-secondary">
        {triggerUnavailable ? 'Release trigger unavailable' : releaseTriggerExplain[trigger]}
      </p>
      {!triggerUnavailable && !reposQuery.isError && showRepoOverrides && (
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-content-tertiary">Repository overrides and production branches</h4>
          {repos.map((repo) => (
            <ProductionBranchRow
              key={`${repo.id}:${repo.productionBranch ?? ''}`}
              repo={repo}
              disabled={busy}
              workspaceTrigger={trigger}
              onTriggerSave={(repoKey, value) =>
                void run(
                  setRepoReleaseTrigger(repoKey, value).then(() =>
                    queryClient.invalidateQueries({ queryKey: ['intent', 'release-repos', workspaceId] }),
                  ),
                )
              }
              onSave={(repoKey, branch) =>
                void run(
                  setProductionBranch(repoKey, branch).then(() =>
                    queryClient.invalidateQueries({ queryKey: ['intent', 'release-repos', workspaceId] }),
                  ),
                )
              }
            />
          ))}
        </div>
      )}
      {reposQuery.isError && (
        <p role="alert" className="text-xs text-content-warning">
          Repository settings unavailable
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-content-warning">
          {error}
        </p>
      )}
    </section>
  );
}
