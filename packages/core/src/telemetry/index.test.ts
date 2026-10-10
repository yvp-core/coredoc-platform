import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';

// Mock the utils barrel so getTelemetryConfig never touches ~/.coredoc (no real
// file I/O in CI — see memory feedback_storybook_no_real_ipc_in_ci). Only the
// client imports getTelemetryConfig from '../utils/index.js', so a minimal
// factory is safe. `vi.hoisted` guarantees the mock fn exists before the
// hoisted vi.mock factory closes over it.
const { getTelemetryConfigMock } = vi.hoisted(() => ({ getTelemetryConfigMock: vi.fn() }));
vi.mock('../utils/index.js', () => ({
  getTelemetryConfig: getTelemetryConfigMock,
}));

import { EventName, ErrorCode, SCHEMA_VERSION } from './events.js';
import {
  __resetTelemetryForTests,
  __setChannelsForTests,
  emitAgentRun,
  initTelemetry,
  track,
  trackError,
  shutdownTelemetry,
  type AgentRunSummary,
} from './index.js';

// Structural fake for the injection seam. Records capture/captureException and
// exposes a `flush` we can override for the deadline test.
function makeFakeAnon() {
  const captured: Array<{ event: string; distinctId: string; props?: Record<string, unknown> }> = [];
  const capturedExceptions: Array<{ error: unknown; distinctId: string; props?: Record<string, unknown> }> = [];
  return {
    captured,
    capturedExceptions,
    capture(event: string, distinctId: string, props?: Record<string, unknown>): void {
      captured.push({ event, distinctId, props });
    },
    captureException(error: unknown, distinctId: string, props?: Record<string, unknown>): void {
      capturedExceptions.push({ error, distinctId, props });
    },
    flush: vi.fn((_deadlineMs: number): Promise<void> => Promise.resolve()),
  };
}

const ENV_KEYS = [
  'COREDOC_SURFACE',
  'COREDOC_SESSION_ID',
  'COREDOC_TELEMETRY_DISABLED',
  'COREDOC_POSTHOG_KEY',
  'COREDOC_POSTHOG_HOST',
  'COREDOC_CLI_VERSION',
  'COREDOC_ENGINE_VERSION',
] as const;

describe('telemetry client', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Deterministic, I/O-free session: the env id wins inside resolveSession, so
    // no ~/.coredoc/session.json read/write happens.
    process.env.COREDOC_SESSION_ID = 'sess-env';
    // Prove `surface` is read from the environment (desktop children set this).
    process.env.COREDOC_SURFACE = 'desktop';

    getTelemetryConfigMock.mockReset();
    getTelemetryConfigMock.mockResolvedValue({
      installId: 'install-xyz',
      enabled: true,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
    });

    __resetTelemetryForTests();
  });

  afterEach(() => {
    __resetTelemetryForTests();
    vi.unstubAllGlobals(); // the per-run cloud test stubs globalThis.fetch
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('track() before any initTelemetry still emits (lazy auto-init) with BaseProps merged', async () => {
    const anon = makeFakeAnon();
    __setChannelsForTests(anon);

    // No initTelemetry() call — this must lazy auto-init.
    track(EventName.ParseCompleted, { files: 42 });
    await shutdownTelemetry(500);

    expect(anon.captured).toHaveLength(1);
    const c = anon.captured[0];
    expect(c.event).toBe(EventName.ParseCompleted);
    expect(c.distinctId).toBe('install-xyz'); // distinctId = installId
    expect(c.props).toMatchObject({
      install_id: 'install-xyz',
      session_id: 'sess-env',
      surface: 'desktop', // resolved from COREDOC_SURFACE
      schema_version: SCHEMA_VERSION,
      platform: process.platform,
      files: 42, // caller prop preserved
    });
    expect(typeof c.props?.invocation_id).toBe('string');
  });

  it('defaults surface to cli when neither ctx nor COREDOC_SURFACE is set', async () => {
    delete process.env.COREDOC_SURFACE;
    const anon = makeFakeAnon();
    __setChannelsForTests(anon);

    track(EventName.CommandCompleted);
    await shutdownTelemetry(500);

    expect(anon.captured[0]?.props?.surface).toBe('cli');
  });

  it('initTelemetry ctx (surface/sessionId) takes precedence over env', async () => {
    const anon = makeFakeAnon();
    __setChannelsForTests(anon);

    initTelemetry({ surface: 'ci', sessionId: 'sess-ctx' });
    track(EventName.CommandCompleted);
    await shutdownTelemetry(500);

    expect(anon.captured[0]?.props).toMatchObject({ surface: 'ci', session_id: 'sess-ctx' });
  });

  it('sends nothing when opt-in is disabled', async () => {
    getTelemetryConfigMock.mockResolvedValue({
      installId: 'install-xyz',
      enabled: false,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
    });
    const anon = makeFakeAnon();
    __setChannelsForTests(anon);

    track(EventName.ParseCompleted, { files: 42 });
    await shutdownTelemetry(500);

    expect(anon.captured).toHaveLength(0);
  });

  it('re-evaluates opt-in at EMIT time — a mid-session Disable stops emits WITHOUT re-init', async () => {
    // Long-lived-surface invariant (desktop main): the opt-in gate must be read
    // fresh at every emit, not latched at init. Otherwise a mid-session Disable
    // never takes effect until process restart.
    const anon = makeFakeAnon();
    __setChannelsForTests(anon);

    // Enabled at the first emit.
    track(EventName.ParseCompleted, { files: 1 });
    await shutdownTelemetry(500);
    expect(anon.captured).toHaveLength(1);

    // Mid-session Disable: setTelemetryEnabled(false) updates the cached config —
    // simulate by flipping the mocked getTelemetryConfig. Crucially we do NOT call
    // initTelemetry or __resetTelemetryForTests: the client is never re-initialized.
    getTelemetryConfigMock.mockResolvedValue({
      installId: 'install-xyz',
      enabled: false,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
    });

    // Subsequent emits (track AND emitAgentRun) must produce NOTHING — the gate is
    // re-read fresh at emit time, not carried over from the first init.
    track(EventName.CommandCompleted, { n: 2 });
    emitAgentRun({
      runId: 'run-x',
      kind: 'k',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0.1,
      turns: 1,
      toolCalls: 1,
      outcome: 'success',
      interventions: 0,
      durationMs: 10,
    });
    await shutdownTelemetry(500);

    // Still only the one pre-disable capture — no emits after the flip.
    expect(anon.captured).toHaveLength(1);
  });

  it('trackError passes a scrubbed message (no home path) to the channel', async () => {
    const anon = makeFakeAnon();
    __setChannelsForTests(anon);

    const err = new Error(`Failed to read ${homedir()}/secret/x.ts while parsing`);
    err.name = 'ParseError';
    err.stack = `Error: boom\n    at parse (${homedir()}/secret/x.ts:10:5)`;

    trackError(err, ErrorCode.ParseError, { phase: 'extract' });
    await shutdownTelemetry(500);

    expect(anon.capturedExceptions).toHaveLength(1);
    const captured = anon.capturedExceptions[0];
    const message = captured.props?.message as string;
    expect(message).toContain('<path>');
    expect(message).not.toContain(homedir());
    expect(message).not.toContain('secret/x.ts');
    // Guard the stack scrub specifically — the documented historical leak was
    // `captureException` shipping RAW stacks with user paths. The scrubbed Error
    // object (not just its message prop) reaches the channel, so assert its stack
    // is redacted too. Deleting the stack scrub in index.ts must turn this red.
    const stack = (captured.error as Error).stack ?? '';
    expect(stack).toContain('<path>');
    expect(stack).not.toContain(homedir());
    expect(stack).not.toContain('secret/x.ts');
    // The Error OBJECT's own message (not just the props copy) carries the
    // scrubbed text. This is the value posthog-node serializes as the exception
    // `value`, computed off the Error and independent of the props bag — which is
    // precisely why a caller cannot suppress a message with a prop-level
    // `message: undefined`. The CLI shim's known-bucket drop therefore emits no
    // report at all rather than trying to override the prop (see telemetry.test.ts).
    expect((captured.error as Error).message).toBe(message);
    // The error class survives the scrub clone — it is PostHog's grouping key.
    expect((captured.error as Error).name).toBe('ParseError');
    expect(captured.props).toMatchObject({
      error_code: ErrorCode.ParseError,
      phase: 'extract',
      install_id: 'install-xyz',
    });
  });

  it('emitAgentRun sends anon a coarse aggregate, never the exact summary', async () => {
    const anon = makeFakeAnon();
    __setChannelsForTests(anon);

    const summary: AgentRunSummary = {
      runId: 'run-1',
      kind: 'profile-author',
      tokensIn: 1000,
      tokensOut: 2000,
      costUsd: 0.42,
      turns: 7,
      toolCalls: 12,
      outcome: 'success',
      interventions: 1,
      durationMs: 8500,
    };

    emitAgentRun(summary);
    await shutdownTelemetry(500);

    // Anon: coarse aggregate derived from the summary (never the raw cost).
    expect(anon.captured).toHaveLength(1);
    expect(anon.captured[0].event).toBe(EventName.AgentRun);
    expect(anon.captured[0].props).toMatchObject({
      outcome: 'success',
      turns: 7,
      cost_bucket: 'lt_1',
    });
    // Guard the anon privacy boundary against the actual camelCase leak vectors
    // from AgentRunSummary — a regression that spread `...summary` into the anon
    // capture would leak these. (`cost_usd` snake_case was a no-op assertion: no
    // such key ever exists, so it could never fail.)
    expect(anon.captured[0].props?.costUsd).toBeUndefined(); // exact cost never on anon
    expect(anon.captured[0].props?.tokensIn).toBeUndefined();
    expect(anon.captured[0].props?.tokensOut).toBeUndefined();
    expect(anon.captured[0].props?.toolCalls).toBeUndefined();
    expect(anon.captured[0].props?.runId).toBeUndefined();
  });

  it('emitAgentRun with per-run cloud config POSTs to the RUN own workspace', async () => {
    // The concurrency guard on the REAL client (no injected fakes): desktop can run
    // several agent-runs at once, and each run's per-run config decides where its
    // summary POSTs. The anon channel has no key in this env, so only configured
    // cloud channels ever touch globalThis.fetch.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const run = (runId: string): AgentRunSummary => ({
      runId,
      kind: 'author-profile',
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.5,
      turns: 3,
      toolCalls: 2,
      outcome: 'success',
      interventions: 0,
      durationMs: 100,
    });

    // Two runs, each bound to its OWN workspace via per-run opts.
    emitAgentRun(run('run-A'), {
      cloud: { apiBase: 'https://api.example', workspaceId: 'ws-A', getToken: async () => 'tok-A' },
    });
    emitAgentRun(run('run-B'), {
      cloud: { apiBase: 'https://api.example', workspaceId: 'ws-B', getToken: async () => 'tok-B' },
    });
    await shutdownTelemetry(500);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const byUrl = new Map(calls.map(([url, init]) => [url, init]));

    // Each run reached its OWN workspace, with matching body + auth.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const initA = byUrl.get('https://api.example/api/v1/workspaces/ws-A/agent-runs')!;
    expect((initA.headers as Record<string, string>).Authorization).toBe('Bearer tok-A');
    expect(JSON.parse(initA.body as string)).toMatchObject({ runId: 'run-A' });
    const initB = byUrl.get('https://api.example/api/v1/workspaces/ws-B/agent-runs')!;
    expect((initB.headers as Record<string, string>).Authorization).toBe('Bearer tok-B');
    expect(JSON.parse(initB.body as string)).toMatchObject({ runId: 'run-B' });
  });

  it('shutdownTelemetry(10) resolves even when the anon flush never settles (deadline race)', async () => {
    const anon = makeFakeAnon();
    anon.flush.mockImplementation(
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
    );
    __setChannelsForTests(anon);

    track(EventName.ParseCompleted, { files: 1 });

    const start = Date.now();
    await expect(shutdownTelemetry(10)).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('env kill-switch: COREDOC_TELEMETRY_DISABLED=1 suppresses all emits even when config.enabled is true', async () => {
    // Config says opted-in, but the Global Constraint kill-switch env var must win.
    getTelemetryConfigMock.mockResolvedValue({
      installId: 'install-xyz',
      enabled: true,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
    });
    process.env.COREDOC_TELEMETRY_DISABLED = '1';
    const anon = makeFakeAnon();
    __setChannelsForTests(anon);

    track(EventName.ParseCompleted, { files: 42 });
    await shutdownTelemetry(500);

    expect(anon.captured).toHaveLength(0);

    // Clean the env var (afterEach also restores ENV_KEYS, this is belt-and-suspenders).
    delete process.env.COREDOC_TELEMETRY_DISABLED;
  });

  it('concurrent init: two track() calls before init resolves share ONE init and lose no events', async () => {
    const anon = makeFakeAnon();
    __setChannelsForTests(anon);

    // Manually-controlled deferred config so BOTH track() calls land while the
    // single shared init promise is still in-flight (the exact concurrency the
    // stored-promise init guards against).
    let resolveConfig!: (value: { installId: string; enabled: boolean; firstSeenAt: string }) => void;
    getTelemetryConfigMock.mockReset();
    getTelemetryConfigMock.mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );

    // Fire both emits before init can resolve.
    track(EventName.ParseCompleted, { files: 1 });
    track(EventName.CommandCompleted, { n: 2 });

    // Unblock the one shared init.
    resolveConfig({ installId: 'install-xyz', enabled: true, firstSeenAt: '2026-01-01T00:00:00.000Z' });
    await shutdownTelemetry(500);

    // Single shared init promise: getTelemetryConfig is read ONCE for init plus
    // ONCE per emit for the fresh opt-in gate (2 emits) = 3. A non-shared init
    // would double the init read (2 + 2 = 4), so 3 still proves doInit ran once.
    expect(getTelemetryConfigMock).toHaveBeenCalledTimes(3);
    // BOTH events captured — neither lost to the init race.
    expect(anon.captured).toHaveLength(2);
    expect(anon.captured.map((c) => c.event)).toEqual([EventName.ParseCompleted, EventName.CommandCompleted]);
  });
});
