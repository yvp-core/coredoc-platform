/**
 * `coredoc intent release` at the CLI seam (amendment §3.2): the local refusals
 * that must happen BEFORE a request is spent, the body the automatic actor
 * sends, and what a refusal and a replay look like to the caller.
 *
 * The transport is injected, so nothing here talks to a server. Exit codes are
 * the registration's contract in `index.ts`: a thrown error is `exit 1`, a
 * resolved result (including a replay of the original record) is `exit 0` — so
 * "replay exits zero" is asserted as "the replayed record resolves".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IntentApiError,
  type CloudIntentRecordedRelease,
  type RecordIntentReleaseBody,
} from '../sync/workspace-api.js';
import {
  formatIntentApiError,
  printIntentReleaseResult,
  runIntentRelease,
  type IntentReleaseCliOptions,
} from './intent-cloud.js';

const WORKSPACE = 'ws_release_1';
const SHA = 'a'.repeat(40);

function recorded(overrides: Partial<CloudIntentRecordedRelease['event']['data']> = {}): CloudIntentRecordedRelease {
  return {
    event: {
      seq: 7,
      kind: 'release',
      recordedAt: '2026-09-11T10:05:00.000Z',
      reason: 'PR backend#42',
      data: {
        deliveredRef: SHA,
        // The server stores ids here; the hashes live in a sibling `contentHashes` map.
        included: ['cap-zig-repositories-are-extracted'],
        retired: ['lim-old-rule'],
        actorKind: 'ci',
        deployId: '12345',
        orderingToken: '2026-09-11T10:04:07Z',
        pr: { repoKey: 'backend', number: 42, url: 'https://github.com/acme/backend/pull/42' },
        ...overrides,
      },
    },
    headSeq: 7,
    currentReleaseSeq: 7,
  };
}

describe('intent release command', () => {
  let sent: Array<{ workspaceId: string; body: RecordIntentReleaseBody }>;

  function options(overrides: Partial<IntentReleaseCliOptions> = {}): IntentReleaseCliOptions {
    return {
      workspaceId: WORKSPACE,
      repo: 'backend',
      ref: SHA,
      deployId: '12345',
      deployedAt: '2026-09-11T10:04:07Z',
      transport: {
        record: async (workspaceId, body) => {
          sent.push({ workspaceId, body });
          return recorded();
        },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    sent = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('argument validation (nothing is sent)', () => {
    // Each deployment property is REQUIRED with no default: a CLI-minted value
    // would move on every retry and let a late record leapfrog a later release.
    for (const [field, flag] of [
      ['workspaceId', '--workspace-id'],
      ['repo', '--repo'],
      ['ref', '--ref'],
      ['deployId', '--deploy-id'],
      ['deployedAt', '--deployed-at'],
    ] as const) {
      it(`refuses a missing ${flag}`, async () => {
        await expect(runIntentRelease(options({ [field]: '' }))).rejects.toThrow(`${flag} is required`);
        expect(sent).toEqual([]);
      });
    }

    it('refuses an unresolved tag before sending deployment evidence', async () => {
      await expect(runIntentRelease(options({ ref: 'v1.4.0' }))).rejects.toThrow('--ref must be a full commit SHA');
      expect(sent).toEqual([]);
    });

    it('refuses a --deployed-at that is not an ISO datetime with a timezone', async () => {
      await expect(runIntentRelease(options({ deployedAt: '2026-09-11' }))).rejects.toThrow('--deployed-at must be');
      expect(sent).toEqual([]);
    });
  });

  it('sends deployment evidence and optional handoff identity, never declarations', async () => {
    await runIntentRelease(options({ handoffId: '11111111-1111-4111-8111-111111111111' }));

    expect(sent).toEqual([
      {
        workspaceId: WORKSPACE,
        body: {
          kind: 'release',
          repoKey: 'backend',
          deliveredRef: SHA,
          deployId: '12345',
          deployedAt: '2026-09-11T10:04:07Z',
          handoffId: '11111111-1111-4111-8111-111111111111',
        },
      },
    ]);
  });

  it('prints the recorded release: seq, ref, counts and actor kind', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    printIntentReleaseResult(await runIntentRelease(options()));

    const output = lines.join('\n');
    expect(output).toContain('Recorded release #7');
    expect(output).toContain(`deliveredRef: ${SHA}`);
    expect(output).toContain('included:     1');
    expect(output).toContain('+ cap-zig-repositories-are-extracted');
    expect(output).toContain('retired:      1');
    expect(output).toContain('actorKind:    ci');
    expect(output).toContain('backend#42');
  });

  it('prints one line per PR the server resolved from the deploy (BR-5)', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    printIntentReleaseResult({
      workspaceId: 'ws_1',
      repo: 'backend',
      result: {
        outcome: 'no_delivery',
        reason: 'no_delivery_declarations',
        deliveries: [
          { handoffId: 'h_1', pr: 41, outcome: 'recorded', seq: 8 },
          { handoffId: 'h_2', pr: 42, outcome: 'no_delivery', reason: 'no_delivery_declarations' },
        ],
      },
    });
    const output = lines.join('\n');
    expect(output).toContain('pr #41: recorded (#8)');
    expect(output).toContain('pr #42: no_delivery no_delivery_declarations');
  });

  it('propagates a server refusal so the registration exits non-zero, printing its code by name', async () => {
    const refusal = new IntentApiError(
      'intent release',
      409,
      {
        code: 'release_out_of_order',
        message: 'This deployment is older than the current release (2026-09-11T12:00:00Z)',
        path: ['deployedAt'],
      },
      '',
    );
    const transport = {
      record: async () => {
        throw refusal;
      },
    };

    await expect(runIntentRelease(options({ transport }))).rejects.toBe(refusal);
    expect(formatIntentApiError(refusal)).toContain('release_out_of_order');
    expect(formatIntentApiError(refusal)).toContain('older than the current release');
  });

  it('resolves (exit 0) when the server replays the original record for the same deployId', async () => {
    const original = recorded();
    const transport = { record: async () => original };

    const first = await runIntentRelease(options({ transport }));
    const retry = await runIntentRelease(options({ transport }));

    expect(retry.result).toEqual(first.result);
    expect(retry.result.event.seq).toBe(7);
  });
});
