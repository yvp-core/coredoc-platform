import { describe, expect, it } from 'vitest';
import {
  assertPrimaryDispatchReady,
  assertPrimaryExecutionReady,
} from './primary-readiness.js';
import type { SelectedCell } from './target-loader.js';
import { AccessMode, AgentProvider } from './types.js';

function nonPrimary(
  lifecycle: 'smoke' | 'diagnostic',
): { repoKey: string; targetSha: string; selected: SelectedCell } {
  return {
    repoKey: 'sample',
    targetSha: 'a'.repeat(40),
    selected: {
      caseId: 'explain-repo',
      paramsKey: 'explainRepo',
      cell: {
        lifecycle,
        params: {},
        provenance: {
          kind: 'source-audit',
          snapshotCommit: 'a'.repeat(40),
          evidence: ['test fixture'],
        },
      },
    },
  };
}

// No verifier is registered in this snapshot, so this synthetic primary cell
// exercises the gate ordering and the fail-closed registry rejection.
function primary() {
  const sha = 'b'.repeat(40);
  const selected: SelectedCell = {
    caseId: 'feature-implementation-plan',
    paramsKey: 'featureImplementationPlan',
    cell: {
      lifecycle: 'primary',
      admission: {
        artifact: { kind: 'issue', ref: 'ACME-1' },
        observer: 'An acme-api operator.',
        decision: 'Whether the change is safe to ship.',
        verifierId: 'acme-api-v1',
      },
      params: {},
      provenance: {
        kind: 'historical-diff',
        snapshotCommit: sha,
        artifactBaseCommit: 'c'.repeat(40),
        sourceCommit: 'd'.repeat(40),
        evidence: ['test fixture'],
      },
    },
  };
  return { repoKey: 'acme-api', targetSha: sha, selected };
}

describe('primary execution readiness', () => {
  it.each(['smoke', 'diagnostic'] as const)(
    'permits %s cells in historyless snapshots, including paid dispatch without a canary',
    (lifecycle) => {
      const selection = nonPrimary(lifecycle);
      expect(() =>
        assertPrimaryExecutionReady([selection], AccessMode.Worktree, false),
      ).not.toThrow();
      expect(() =>
        assertPrimaryExecutionReady([selection], AccessMode.NoCheckout, false),
      ).not.toThrow();
      expect(() =>
        assertPrimaryExecutionReady(
          [selection],
          AccessMode.HistorylessSnapshot,
          false,
        ),
      ).not.toThrow();
      expect(() =>
        assertPrimaryDispatchReady(
          [selection],
          AccessMode.HistorylessSnapshot,
          null,
          '',
        ),
      ).not.toThrow();
    },
  );

  it('rejects the primary canary flag for a non-primary historyless selection', () => {
    expect(() =>
      assertPrimaryExecutionReady(
        [nonPrimary('diagnostic')],
        AccessMode.HistorylessSnapshot,
        false,
        true,
      ),
    ).toThrow(/registered primary/i);
  });

  it.each([AccessMode.Worktree, AccessMode.NoCheckout])(
    'rejects primary cells in %s mode',
    (accessMode) => {
      expect(() =>
        assertPrimaryExecutionReady(
          [primary()],
          accessMode,
          true,
        ),
      ).toThrow(/historyless-snapshot/i);
    },
  );

  it('rejects mixed primary and diagnostic historyless selections', () => {
    expect(() =>
      assertPrimaryExecutionReady(
        [primary(), nonPrimary('diagnostic')],
        AccessMode.HistorylessSnapshot,
        true,
      ),
    ).toThrow(/cannot be mixed/i);
  });

  it('rejects an unregistered primary before preflight workspace creation', () => {
    expect(() =>
      assertPrimaryExecutionReady(
        [primary()],
        AccessMode.HistorylessSnapshot,
        true,
      ),
    ).toThrow(/registered primary/i);
  });

  it('rejects paid Codex primary execution while keeping Codex diagnostics available', () => {
    expect(() =>
      assertPrimaryExecutionReady(
        [nonPrimary('diagnostic')],
        AccessMode.HistorylessSnapshot,
        false,
        false,
        AgentProvider.Codex,
      ),
    ).not.toThrow();
    expect(() =>
      assertPrimaryExecutionReady(
        [primary()],
        AccessMode.HistorylessSnapshot,
        false,
        true,
        AgentProvider.Codex,
      ),
    ).toThrow(/primary execution.*provider=claude/i);
  });

  it('rejects an unregistered primary at dispatch with or without a canary capability', () => {
    const selections = [primary()];
    expect(() =>
      assertPrimaryDispatchReady(
        selections,
        AccessMode.HistorylessSnapshot,
        null,
        'material',
      ),
    ).toThrow(/registered primary/i);
    expect(() =>
      assertPrimaryDispatchReady(
        selections,
        AccessMode.HistorylessSnapshot,
        {
          evidence: {
            passed: true,
            materialFingerprint: 'material',
          },
        } as never,
        'material',
      ),
    ).toThrow(/registered primary/i);
  });
});
