/**
 * Cloud-workspace side of the completed view: whether the cloud copy of the
 * graph has fallen behind the local one, and the push that fixes it.
 *
 * Kept out of the view because it is three effects and a long handler that
 * nothing else in the layout needs to read.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from '../../../hooks/use-toast';
import { useProjectsStore } from '../../../stores/projects-store';
import { parsedRepoFile, useWorkspaceStore } from '../../../stores/workspace-store';
import type { Project } from '../../../types/project';

export interface UseCloudSyncArgs {
  project: Project;
  /** Every repo has been pushed to the local graph — precondition for a cloud push. */
  allSynced: boolean;
  /** Most recent local push; re-runs the comparison when a new push lands. */
  latestPush: string | undefined;
  projectWorkspaceId: string | null;
  cloudEnabled: boolean;
  isCloudMember: boolean;
  isLoggedIn: boolean;
}

export interface CloudSync {
  /** The local graph has been pushed more recently than the cloud copy. */
  cloudOutdated: boolean;
  /** A cloud push is in flight. */
  syncing: boolean;
  /**
   * Whether the workspace has CI/CD enabled — gates the parser upload and,
   * via `bannerVisibility` (D6), the staleness banners. `undefined` until the
   * workspace list has actually loaded *for the current workspace id* — a
   * mid-load, failed, or superseded load stays unknown, so callers never read a
   * transient `false` as "confirmed not CI/CD-managed".
   */
  ciCdEnabled: boolean | undefined;
  /** The resolved workspace row, for slug/role readers such as the Insights panel. */
  workspace: ReturnType<typeof useWorkspaceStore.getState>['workspaces'][number] | undefined;
  syncToCloud: () => Promise<void>;
}

export function useCloudSync({
  project,
  allSynced,
  latestPush,
  projectWorkspaceId,
  cloudEnabled,
  isCloudMember,
  isLoggedIn,
}: UseCloudSyncArgs): CloudSync {
  const { syncToCloud, syncing, workspaces, loadWorkspaces } = useWorkspaceStore();
  const { setProjectCloud } = useProjectsStore();
  const [cloudOutdated, setCloudOutdated] = useState(false);
  /**
   * The `projectWorkspaceId` the CI/CD flag is *confirmed* resolved for —
   * either its workspace list loaded successfully, or the project definitively
   * has no cloud linkage (`null`). `undefined` means unresolved: auth is still
   * settling, the fetch failed, or the id changed since the last answer.
   *
   * Comparing it against the live id is what keeps a previous project's answer
   * from being reported for the current one.
   */
  const [resolvedFor, setResolvedFor] = useState<string | null | undefined>(undefined);

  const workspace = workspaces.find((w) => w.id === projectWorkspaceId);
  const ciCdEnabled: boolean | undefined =
    resolvedFor !== undefined && resolvedFor === projectWorkspaceId ? (workspace?.ciCdEnabled ?? false) : undefined;

  useEffect(() => {
    // Any input change invalidates the previous answer until it is re-earned:
    // reporting a stale `false` here would un-suppress the banners (D6).
    setResolvedFor(undefined);
    // No cloud workspace at all — nothing to load and nothing that could make
    // this project CI/CD-managed.
    if (!projectWorkspaceId) {
      setResolvedFor(null);
      return;
    }
    // Logged out: auth may still be resolving, so this is not evidence of
    // anything. Stay unknown.
    if (!isLoggedIn) return;
    // Owners load workspaces only when cloud is enabled; cloud members always need
    // them too, because the Insights panel reads role + slug from the workspace list.
    if (!isCloudMember && !cloudEnabled) {
      setResolvedFor(projectWorkspaceId);
      return;
    }
    let cancelled = false;
    loadWorkspaces()
      .then(() => {
        if (cancelled) return;
        // The store swallows fetch failures into `error` and resolves normally,
        // so a settled promise is not evidence that the list is real.
        if (useWorkspaceStore.getState().error) return;
        setResolvedFor(projectWorkspaceId);
      })
      .catch(() => {
        // Unresolved — banners stay suppressed rather than reading a stale list.
      });
    return () => {
      cancelled = true;
    };
  }, [cloudEnabled, projectWorkspaceId, isLoggedIn, isCloudMember, loadWorkspaces]);

  // Cloud members never push, so there is nothing to compare for them.
  useEffect(() => {
    if (isCloudMember) return;
    if (!cloudEnabled || !projectWorkspaceId || !allSynced || !isLoggedIn) {
      setCloudOutdated(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Content identity, not timestamps: this is the SAME delta the sync
        // itself uses, so the banner can never demand a sync that would only
        // be skipped as already-current (the old timestamp comparison did
        // exactly that after every local re-push of identical content).
        const allStates = await window.electronAPI.getAllStates();
        const repos = project.repositories.map((r) => ({
          repoName: r.name,
          parsedRepoPath: parsedRepoFile(allStates.outputDir, project.id, r.name),
        }));
        const result = await window.electronAPI.workspaceCheckCloudDelta(projectWorkspaceId, repos);
        if (!cancelled) setCloudOutdated(result.outdated);
      } catch (err) {
        console.error('[useCloudSync] cloud delta check failed:', err);
        if (!cancelled) {
          toast({
            title: 'Cloud status check failed',
            description: 'Could not verify cloud sync status',
            variant: 'destructive',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cloudEnabled, projectWorkspaceId, allSynced, latestPush, isLoggedIn]);

  const runSync = useCallback(async () => {
    if (!projectWorkspaceId) return;
    // Force on first sync (no lastSyncedAt yet).
    const isFirstSync = !project.cloud?.lastSyncedAt;
    try {
      const result = await syncToCloud(
        projectWorkspaceId,
        {
          id: project.id,
          name: project.name,
          repos: project.repositories.map((r) => ({ name: r.name, path: r.path, httpPrefix: r.httpPrefix })),
        },
        isFirstSync,
      );
      // `publishing` means the server has the uploads but has not published
      // them: neither synced nor failed. Freshness must not advance — the job
      // may yet fail, and claiming the cloud is current would hide that.
      const publishing = (result.publishing?.repoNames.length ?? 0) > 0;
      if (result.synced.length > 0 && !publishing) {
        await setProjectCloud(project.id, {
          enabled: true,
          workspaceId: projectWorkspaceId,
          lastSyncedAt: new Date().toISOString(),
        });
      }
      // Cloud now matches local — clear the indicator even when every repo was
      // skipped as already-current.
      if (!publishing && (result.synced.length > 0 || result.skipped.length > 0)) {
        setCloudOutdated(false);
      }
      if (result.errors.length > 0) {
        console.error('[useCloudSync] sync errors:', result.errors);
      }

      // The upload must follow the *confirmed* flag: an unresolved tri-state is
      // not a "no", so resolve it here rather than silently skipping a CI/CD
      // workspace's parsers.
      let ciCdConfirmed = ciCdEnabled;
      if (ciCdConfirmed === undefined) {
        await loadWorkspaces();
        const state = useWorkspaceStore.getState();
        ciCdConfirmed = state.error
          ? undefined
          : (state.workspaces.find((w) => w.id === projectWorkspaceId)?.ciCdEnabled ?? false);
      }

      if (ciCdConfirmed) {
        try {
          const upload = await window.electronAPI.workspaceUploadParsers(projectWorkspaceId);
          if (upload.errors.length > 0) {
            toast({
              title: 'Some parsers failed to upload',
              description: upload.errors.join('\n'),
              variant: 'destructive',
            });
          }
        } catch (err) {
          toast({
            title: 'Parser upload failed',
            description: (err as Error).message,
            variant: 'destructive',
          });
        }
      }
    } catch (err) {
      console.error('[useCloudSync] sync failed:', err);
    }
  }, [projectWorkspaceId, project, syncToCloud, setProjectCloud, ciCdEnabled, loadWorkspaces]);

  return { cloudOutdated, syncing, ciCdEnabled, workspace, syncToCloud: runSync };
}
