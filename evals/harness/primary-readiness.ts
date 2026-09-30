import type { SelectedCell } from './target-loader.js';
import { AccessMode, AgentProvider } from './types.js';
import { assertRegisteredPrimary } from './primary-registry.js';
import {
  isLivePermissionCanaryPassed,
  type LivePermissionCanary,
} from './permission-canary.js';

export interface PrimaryExecutionSelection {
  repoKey: string;
  targetSha: string;
  selected: SelectedCell;
}

/**
 * Keeps uncalibrated lifecycle-v2 cells out of the product-effect boundary.
 * Smoke and diagnostic work remain runnable while backlog #35 is incomplete.
 */
export function assertPrimaryExecutionReady(
  selections: readonly PrimaryExecutionSelection[],
  accessMode: AccessMode,
  preflightOnly: boolean,
  runPrimaryWithCanary = false,
  provider = AgentProvider.Claude,
): void {
  const primary = selections.filter(({ selected }) => selected.cell.lifecycle === 'primary');

  if (primary.length > 0 && !preflightOnly && provider === AgentProvider.Codex) {
    throw new Error('Primary execution is only supported with --provider=claude.');
  }

  if (accessMode === AccessMode.HistorylessSnapshot) {
    if (primary.length === 0) {
      if (runPrimaryWithCanary) {
        throw new Error(
          '--run-primary-with-canary is valid only for registered primary selections in --historyless-snapshot mode.',
        );
      }
      return;
    }
    if (primary.length !== selections.length) {
      throw new Error(
        'Primary selections cannot be mixed with smoke or diagnostic selections.',
      );
    }

    for (const selection of primary) assertRegisteredPrimary(selection);
    if (!preflightOnly && !runPrimaryWithCanary) {
      throw new Error(
        'Actual primary execution requires --run-primary-with-canary so the permission canary runs in the same invocation.',
      );
    }
    return;
  }

  if (runPrimaryWithCanary) {
    throw new Error(
      '--run-primary-with-canary is valid only for registered primary selections in --historyless-snapshot mode.',
    );
  }

  if (primary.length > 0) {
    throw new Error(
      'Primary execution requires --historyless-snapshot; worktree and no-checkout remain diagnostic modes.',
    );
  }
}

/** Final in-memory gate immediately before a paid primary model dispatch. */
export function assertPrimaryDispatchReady(
  selections: readonly PrimaryExecutionSelection[],
  accessMode: AccessMode,
  capability: LivePermissionCanary | null,
  materialFingerprint: string,
): void {
  if (selections.every(({ selected }) => selected.cell.lifecycle !== 'primary')) return;
  if (
    accessMode !== AccessMode.HistorylessSnapshot ||
    selections.length === 0 ||
    selections.some(({ selected }) => selected.cell.lifecycle !== 'primary')
  ) {
    throw new Error(
      'Primary dispatch is restricted to registered historyless-snapshot selections.',
    );
  }
  for (const selection of selections) assertRegisteredPrimary(selection);
  if (!isLivePermissionCanaryPassed(capability, materialFingerprint)) {
    throw new Error(
      'Primary dispatch requires a passed same-invocation permission canary bound to this material runtime.',
    );
  }
}
