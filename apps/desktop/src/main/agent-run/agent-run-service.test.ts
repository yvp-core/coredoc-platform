import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { AgentRunEventType } from '../../shared/agent-run-types';
import { IpcChannels } from '../../shared/ipc-types';
import type { AgentRunAdapter, AgentRunRequest } from './types';

vi.mock('@coredoc/core/telemetry', () => ({ emitAgentRun: vi.fn() }));

import { startAgentRun } from './agent-run-service';

function makeWindow(): { window: BrowserWindow; sent: Array<{ channel: string; data: unknown }> } {
  const sent: Array<{ channel: string; data: unknown }> = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, data: unknown) => sent.push({ channel, data }),
    },
  } as unknown as BrowserWindow;
  return { window, sent };
}

function makeRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    prompt: 'author a profile',
    cwd: '/work/repo',
    additionalDirectories: [],
    policy: { repoDir: '/work/repo', writeDirs: ['/work/parsers'], readDirs: ['/work/repo'], safeCommandPrefixes: [] },
    env: {},
    nodeExecPath: '/usr/bin/node',
    abortController: new AbortController(),
    ...overrides,
  };
}

/** Adapter that ends its turn claiming success (emits Done ok:true), like a harness that lies. */
const succeedingAdapter: AgentRunAdapter = {
  async run(_req, io) {
    io.emit({ type: AgentRunEventType.Done, ok: true });
  },
};

describe('startAgentRun verifyCompletion', () => {
  it('converts a claimed success into a failure when the deliverable is missing', async () => {
    const { window, sent } = makeWindow();

    await startAgentRun(
      'run-1',
      makeRequest({ verifyCompletion: () => 'The agent run ended without writing the profile.' }),
      window,
      succeedingAdapter,
    );

    const completed = sent.find((m) => m.channel === IpcChannels.COMMAND_COMPLETED)?.data as {
      success: boolean;
      error?: string;
    };
    expect(completed.success).toBe(false);
    expect(completed.error).toContain('without writing the profile');

    const doneEvents = sent
      .filter((m) => m.channel === IpcChannels.AGENT_RUN_EVENT)
      .map((m) => (m.data as { event: { type: string; ok?: boolean } }).event)
      .filter((e) => e.type === AgentRunEventType.Done);
    expect(doneEvents.at(-1)?.ok).toBe(false);
  });

  it('forwards the error the adapter reported on its own Done', async () => {
    const { window, sent } = makeWindow();
    const failingAdapter: AgentRunAdapter = {
      async run(_req, io) {
        io.emit({ type: AgentRunEventType.Done, ok: false, error: 'model not supported' });
      },
    };

    await startAgentRun('run-err', makeRequest(), window, failingAdapter);

    const completed = sent.find((m) => m.channel === IpcChannels.COMMAND_COMPLETED)?.data as {
      success: boolean;
      error?: string;
    };
    expect(completed).toMatchObject({ success: false, error: 'model not supported' });
  });

  it('keeps the success when verifyCompletion passes', async () => {
    const { window, sent } = makeWindow();

    await startAgentRun('run-2', makeRequest({ verifyCompletion: () => null }), window, succeedingAdapter);

    const completed = sent.find((m) => m.channel === IpcChannels.COMMAND_COMPLETED)?.data as { success: boolean };
    expect(completed.success).toBe(true);
  });

  it('finalizes a verified deliverable before reporting success', async () => {
    const { window, sent } = makeWindow();
    const finalizeCompletion = vi.fn(() => null);

    await startAgentRun(
      'run-3',
      makeRequest({ verifyCompletion: () => null, finalizeCompletion }),
      window,
      succeedingAdapter,
    );

    expect(finalizeCompletion).toHaveBeenCalledOnce();
    const completed = sent.find((m) => m.channel === IpcChannels.COMMAND_COMPLETED)?.data as { success: boolean };
    expect(completed.success).toBe(true);
  });

  it('reports failure when a verified deliverable cannot be finalized', async () => {
    const { window, sent } = makeWindow();

    await startAgentRun(
      'run-4',
      makeRequest({ verifyCompletion: () => null, finalizeCompletion: () => 'Atomic profile promotion failed.' }),
      window,
      succeedingAdapter,
    );

    const completed = sent.find((message) => message.channel === IpcChannels.COMMAND_COMPLETED)?.data as {
      success: boolean;
      error?: string;
    };
    expect(completed).toMatchObject({ success: false, error: 'Atomic profile promotion failed.' });
  });
});
