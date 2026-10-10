/** No agent runs here; the server verifies every reported pull request itself. */
import { setTimeout as sleep } from 'node:timers/promises';
import { type DeliveryReport, type RetryDelay, RunFailureCode, type TurnAssignment } from '@coredoc/core/agent-runner';
import type { GithubApi } from '../github/github-api.js';
import type { TurnIO, TurnResult } from '../runner.js';
import { GITHUB_ATTEMPTS, TurnFailure } from '../turn-failure.js';

type Planned = NonNullable<TurnAssignment['delivery']>['pullRequests'][number];

/** After a stop it opens nothing more but returns what it already opened or reused, for the server to record. */
export async function deliver(
  turn: TurnAssignment,
  io: Pick<TurnIO, 'signal'>,
  github: GithubApi,
  retryDelay: RetryDelay,
): Promise<TurnResult> {
  const deliveries: DeliveryReport[] = [];
  try {
    for (const planned of turn.delivery?.pullRequests ?? []) {
      if (io.signal.aborted) break;
      const repository = turn.repositories.find((candidate) => candidate.key === planned.key);
      if (!repository) {
        throw new TurnFailure(
          RunFailureCode.DeliveryFailed,
          `The assignment has no repository ${planned.key} to deliver.`,
        );
      }
      const report = await deliverOne(turn.run.branch, repository, planned, io.signal, github, retryDelay);
      if (report) deliveries.push(report);
    }
  } catch (error) {
    if (!(error instanceof TurnFailure)) throw error;
    return { spend: null, outcome: { kind: 'failed', code: error.code, reason: error.message }, deliveries };
  }
  return { spend: null, deliveries };
}

/** Null when a stop arrived before anything was written for this repository. */
async function deliverOne(
  branch: string,
  repository: TurnAssignment['repositories'][number],
  planned: Planned,
  signal: AbortSignal,
  github: GithubApi,
  retryDelay: RetryDelay,
): Promise<DeliveryReport | null> {
  const existing = await github.findPullByHead(repository, branch, RunFailureCode.DeliveryFailed);
  if (existing) {
    // Reuse an open one with a refreshed body; a closed or merged one is recorded, never reopened.
    if (existing.open && !signal.aborted) await github.updatePullBody(repository, existing.number, planned.body);
    return { key: planned.key, pullRequest: { number: existing.number } };
  }
  const base = await github.defaultBranch(repository, RunFailureCode.DeliveryFailed);
  for (let attempt = 1; attempt <= GITHUB_ATTEMPTS; attempt += 1) {
    // The heartbeat's answer is checked before each write.
    if (signal.aborted) return null;
    const result = await github.createDraftPull(repository, {
      title: planned.title,
      body: planned.body,
      head: branch,
      base,
    });
    if (result.kind === 'created') return { key: planned.key, pullRequest: { number: result.number } };
    if (result.kind === 'no_commits') return { key: planned.key, pullRequest: null };
    // A 422, timeout or 5xx may still have opened it: look it up by head before any retry.
    const found = await github.findPullByHead(repository, branch, RunFailureCode.DeliveryFailed);
    if (found) return { key: planned.key, pullRequest: { number: found.number } };
    if (attempt < GITHUB_ATTEMPTS) await sleep(retryDelay(attempt, null));
  }
  throw new TurnFailure(RunFailureCode.DeliveryFailed, `GitHub kept failing to open a pull request in ${planned.key}.`);
}
