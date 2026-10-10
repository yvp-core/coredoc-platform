import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerMessage } from './sdk-worker-core';

// Model the batched-telemetry pipeline the worker sits on top of:
//  - the SDK enqueues a SUCCESS event into a batch (`queued`) when a command settles,
//  - `shutdownTelemetry` is the flush that delivers the batch to the transport (`delivered`).
// The parent terminates the worker within ms of the 'result' message, so the flush
// MUST run on the settle→result boundary or every success event is dropped.
const {
  queued,
  delivered,
  order,
  parseMock,
  loadConfigMock,
  shutdownTelemetryMock,
  closeAllDriversMock,
  closeProjectDatabasesMock,
} = vi.hoisted(() => {
  const queued: string[] = [];
  const delivered: string[] = [];
  const order: string[] = [];
  return {
    queued,
    delivered,
    order,
    // SUCCESS path: the SDK op enqueues a batched success event, then settles.
    parseMock: vi.fn(async () => {
      queued.push('parse_completed');
      return { success: true, files: 601 };
    }),
    loadConfigMock: vi.fn(() => ({})),
    // The flush drains the batch to the (fake) transport.
    shutdownTelemetryMock: vi.fn(async () => {
      order.push('flush');
      delivered.push(...queued.splice(0));
    }),
    closeAllDriversMock: vi.fn(async () => {
      order.push('close-singleton');
    }),
    closeProjectDatabasesMock: vi.fn(async () => {
      order.push('close-project-pool');
    }),
  };
});

const { runSummarizeMock, runEmbedMock, trackMock } = vi.hoisted(() => ({
  runSummarizeMock: vi.fn(async () => ({ success: true })),
  runEmbedMock: vi.fn(async () => ({ success: true })),
  trackMock: vi.fn(),
}));

vi.mock('@coredoc/cli/sdk', () => ({
  loadConfig: loadConfigMock,
  parse: parseMock,
  runSummarize: runSummarizeMock,
  runEmbed: runEmbedMock,
  redactNames: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
}));

vi.mock('@coredoc/core/telemetry', () => ({
  shutdownTelemetry: shutdownTelemetryMock,
  track: trackMock,
  classifyError: () => 'unknown',
  scrubPaths: (s: string) => s,
  EventName: { CommandFailed: 'command_failed' },
}));
vi.mock('@coredoc/db', () => ({
  closeAllDrivers: closeAllDriversMock,
  closeProjectDatabases: closeProjectDatabasesMock,
}));

import { handleCommandMessage } from './sdk-worker-core';

const PARSE_MSG: WorkerMessage = {
  command: 'parse',
  configPath: '/workspace/coredoc.config.json',
  projectId: 'proj-1',
  repo: 'repo-1',
  args: {},
};

describe('handleCommandMessage', () => {
  beforeEach(() => {
    queued.length = 0;
    delivered.length = 0;
    order.length = 0;
    vi.clearAllMocks();
  });

  it('flushes batched success telemetry BEFORE posting the result (settle→result boundary)', async () => {
    const post = vi.fn((m: unknown) => {
      order.push(`result:${(m as { success: boolean }).success}`);
    });

    await handleCommandMessage(PARSE_MSG, post);

    // Flush ran, and it ran BEFORE the result was posted — so the batch is delivered
    // before the parent's worker.terminate() can hard-kill it.
    expect(order).toEqual(['flush', 'close-singleton', 'close-project-pool', 'result:true']);
    expect(shutdownTelemetryMock).toHaveBeenCalledWith(500);

    // The enqueued success event actually reached the (fake) transport — not dropped.
    expect(delivered).toContain('parse_completed');
    expect(queued).toHaveLength(0);

    expect(post).toHaveBeenCalledWith({ type: 'result', success: true, data: { success: true, files: 601 } });
  });

  it('reports and flushes a command_failed, then closes project database drivers, on the failure path', async () => {
    parseMock.mockRejectedValueOnce(new Error('parse blew up'));
    const post = vi.fn();

    await handleCommandMessage(PARSE_MSG, post);

    // A failure thrown before trackOperation would otherwise leave no trace, so
    // the worker boundary reports every failure and flushes before 'result'.
    expect(trackMock).toHaveBeenCalledWith('command_failed', {
      command: 'parse',
      error_code: 'unknown',
      error_name: 'Error',
      error_message: 'parse blew up',
    });
    expect(shutdownTelemetryMock).toHaveBeenCalledOnce();
    expect(closeAllDriversMock).toHaveBeenCalledOnce();
    expect(closeProjectDatabasesMock).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ type: 'result', success: false, error: 'parse blew up' });
  });

  it('preserves a successful command result when database cleanup fails', async () => {
    closeAllDriversMock.mockRejectedValueOnce(new Error('singleton close failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const post = vi.fn();

    try {
      await handleCommandMessage(PARSE_MSG, post);

      expect(closeAllDriversMock).toHaveBeenCalledOnce();
      expect(closeProjectDatabasesMock).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('[sdk-worker] Failed to close database drivers: singleton close failed');
      expect(post).toHaveBeenCalledWith({ type: 'result', success: true, data: { success: true, files: 601 } });
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves the primary command error when database cleanup also fails', async () => {
    parseMock.mockRejectedValueOnce(new Error('parse blew up'));
    closeProjectDatabasesMock.mockRejectedValueOnce(new Error('project pool close failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const post = vi.fn();

    try {
      await handleCommandMessage(PARSE_MSG, post);

      expect(closeAllDriversMock).toHaveBeenCalledOnce();
      expect(closeProjectDatabasesMock).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('[sdk-worker] Failed to close project databases: project pool close failed');
      expect(post).toHaveBeenCalledWith({ type: 'result', success: false, error: 'parse blew up' });
    } finally {
      warn.mockRestore();
    }
  });

  describe('E2E LLM/egress guard', () => {
    beforeEach(() => {
      delete process.env.COREDOC_DESKTOP_E2E;
    });

    it.each([
      'summarize',
      'embed',
    ] as const)('blocks %s under COREDOC_DESKTOP_E2E without touching the SDK', async (command) => {
      process.env.COREDOC_DESKTOP_E2E = '1';
      const post = vi.fn();

      try {
        await handleCommandMessage({ ...PARSE_MSG, command }, post);
      } finally {
        delete process.env.COREDOC_DESKTOP_E2E;
      }

      expect(runSummarizeMock).not.toHaveBeenCalled();
      expect(runEmbedMock).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith({
        type: 'result',
        success: false,
        error: expect.stringContaining('blocked in E2E mode'),
      });
    });

    it.each(['summarize', 'embed'] as const)('%s proceeds to the SDK without the flag', async (command) => {
      const post = vi.fn();

      await handleCommandMessage({ ...PARSE_MSG, command }, post);

      const target = command === 'summarize' ? runSummarizeMock : runEmbedMock;
      expect(target).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledWith({ type: 'result', success: true, data: { success: true } });
    });

    it('forwards the invocation-scoped Codex harness to summarize', async () => {
      const post = vi.fn();
      await handleCommandMessage(
        {
          ...PARSE_MSG,
          command: 'summarize',
          harnessProvider: 'codex',
          codexCliPath: '/bundled/codex',
          nodeEnv: { PATH: '/usr/bin', CODEX_API_KEY: 'selected-token' },
        },
        post,
      );

      expect(runSummarizeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          batchSize: 20,
          harness: 'codex',
          codexCliPath: '/bundled/codex',
          sdkEnv: { PATH: '/usr/bin', CODEX_API_KEY: 'selected-token' },
        }),
        expect.anything(),
      );
    });
  });
});
