import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventName } from './events.js';
import { AnonChannel, CloudChannel, routeChannel } from './channels.js';

// Mock posthog-node so we can assert whether the AnonChannel ever reaches the
// lazy `await import('posthog-node')` — the constructor spy only fires if the
// dynamic import actually resolves this module and `new PostHog(...)` runs.
// vitest hoists `vi.mock` above imports, so this intercepts channels.ts's
// dynamic import too, not just a static one.
const posthogCtorSpy = vi.fn();
const captureSpy = vi.fn();
const onSpy = vi.fn();
const captureExceptionSpy = vi.fn();
const flushSpy = vi.fn(async () => {
  // no-op fake flush — per-request cleanup; resolves BEFORE the real send lands
});
const shutdownSpy = vi.fn(async (_shutdownTimeoutMs?: number) => {
  // no-op fake terminal drain — the awaitable path that resolves after the send
});

// Whether the fake PostHog client exposes `_shutdown` (present in posthog-node
// 5.x — the awaitable terminal drain) or only the legacy `flush` (back-compat).
// Read fresh in the constructor on every `new PostHog(...)`, so a test can toggle
// it before a channel lazily constructs its client. Reset to true in afterEach.
let exposeShutdown = true;

/** Shape of the `fetch` AnonChannel injects into posthog-node (asserted below). */
type InjectedFetch = (url: string, options: Record<string, unknown>) => Promise<{ status: number }>;

vi.mock('posthog-node', () => ({
  PostHog: class {
    _shutdown?: (shutdownTimeoutMs?: number) => Promise<void>;
    constructor(...args: unknown[]) {
      posthogCtorSpy(...args);
      if (exposeShutdown) {
        this._shutdown = (shutdownTimeoutMs?: number) => shutdownSpy(shutdownTimeoutMs);
      }
    }
    capture(...args: unknown[]) {
      captureSpy(...args);
    }
    on(...args: unknown[]) {
      onSpy(...args);
    }
    captureException(...args: unknown[]) {
      captureExceptionSpy(...args);
    }
    async flush() {
      await flushSpy();
    }
  },
}));

describe('routeChannel', () => {
  it('routes EventName.AgentRun to both channels', () => {
    expect(routeChannel(EventName.AgentRun)).toBe('both');
  });

  it('routes EventName.ParseCompleted to anon only', () => {
    expect(routeChannel(EventName.ParseCompleted)).toBe('anon');
  });
});

describe('AnonChannel', () => {
  afterEach(() => {
    // Targeted: `restoreAllMocks` would also strip the fake posthog client's
    // flush/_shutdown implementations that the mocked module hands out.
    vi.mocked(globalThis.fetch).mockRestore?.();
    posthogCtorSpy.mockClear();
    captureSpy.mockClear();
    captureExceptionSpy.mockClear();
    flushSpy.mockClear();
    shutdownSpy.mockClear();
    exposeShutdown = true;
  });

  it('no-ops and never imports posthog-node when unconfigured (no envKey/bundledKey)', async () => {
    const channel = new AnonChannel({});

    channel.capture(EventName.ParseCompleted, 'install-1', { foo: 'bar' });
    channel.captureException(new Error('boom'), 'install-1');
    await channel.flush(50);

    expect(posthogCtorSpy).not.toHaveBeenCalled();
    expect(captureSpy).not.toHaveBeenCalled();
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it('lazily constructs posthog-node once a key IS configured, and captures', async () => {
    const channel = new AnonChannel({ envKey: 'phc_test', envHost: 'https://eu.i.posthog.com' });

    channel.capture(EventName.ParseCompleted, 'install-1', { foo: 'bar' });
    // capture is fire-and-forget; the lazy `import('posthog-node')` resolves
    // asynchronously, so wait for the constructor spy to observe it.
    await vi.waitFor(() => expect(posthogCtorSpy).toHaveBeenCalled());

    expect(posthogCtorSpy).toHaveBeenCalledTimes(1);
    expect(posthogCtorSpy).toHaveBeenCalledWith('phc_test', {
      host: 'https://eu.i.posthog.com',
      requestTimeout: 2000,
      fetchRetryCount: 0,
      fetch: expect.any(Function),
    });
    expect(captureSpy).toHaveBeenCalledTimes(1);
    // Assert the FULL payload shape, not just that the spy fired — a reshape or
    // snake_case regression of the posthog-node capture contract must turn red here.
    expect(captureSpy).toHaveBeenCalledWith({
      distinctId: 'install-1',
      event: EventName.ParseCompleted,
      properties: { foo: 'bar' },
    });
  });

  it('bounds network behavior so a blocked network cannot stall or spam a CLI command', async () => {
    const channel = new AnonChannel({ envKey: 'phc_test' });
    channel.capture(EventName.ParseCompleted, 'install-1');
    await vi.waitFor(() => expect(posthogCtorSpy).toHaveBeenCalled());

    // Defaults are 10s request timeout + retries with backoff + loud error
    // logging: in a network-denied sandbox that is ~10s of stalls and stack
    // traces per CLI command. The options and the swallowed error listener are
    // the whole fix — telemetry failure must be silent and near-instant.
    const options = posthogCtorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.requestTimeout).toBeLessThanOrEqual(2000);
    expect(options.fetchRetryCount).toBeLessThanOrEqual(1);
    expect(onSpy).toHaveBeenCalledWith('error', expect.any(Function));
    // An injected transport is REQUIRED for silence: posthog-core reports flush
    // failures through its own hard-coded console.error, which no option, error
    // listener, or downstream .catch() can suppress.
    expect(options.fetch).toEqual(expect.any(Function));
  });

  // The injected transport is the whole silence mechanism, so assert its contract
  // directly: whatever the network does, posthog-node must never see a failure.
  describe('injected fetch transport', () => {
    const getInjectedFetch = async (): Promise<InjectedFetch> => {
      const channel = new AnonChannel({ envKey: 'phc_test' });
      channel.capture(EventName.ParseCompleted, 'install-1');
      await vi.waitFor(() => expect(posthogCtorSpy).toHaveBeenCalled());
      const options = posthogCtorSpy.mock.calls[0]?.[1] as { fetch: InjectedFetch };
      return options.fetch;
    };

    it('resolves as accepted when the request rejects (aborted / offline)', async () => {
      const injected = await getInjectedFetch();
      const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort);

      // Must RESOLVE, not reject: a rejection here is what posthog-core turns into
      // a PostHogFetchNetworkError stack trace on the user's stderr.
      await expect(injected('https://us.i.posthog.com/batch/', {})).resolves.toMatchObject({ status: 200 });
    });

    it('masks a non-2xx status so the library never takes its logging path', async () => {
      const injected = await getInjectedFetch();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

      await expect(injected('https://us.i.posthog.com/batch/', {})).resolves.toMatchObject({ status: 200 });
    });

    it('passes 413 through — the one status posthog-core acts on itself', async () => {
      const injected = await getInjectedFetch();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('too large', { status: 413 }));

      // Masking this one would silently break the library's batch-halving retry.
      await expect(injected('https://us.i.posthog.com/batch/', {})).resolves.toMatchObject({ status: 413 });
    });

    it('passes a successful response through untouched', async () => {
      const injected = await getInjectedFetch();
      const ok = new Response('{"status":1}', { status: 200 });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok);

      await expect(injected('https://us.i.posthog.com/batch/', {})).resolves.toBe(ok);
    });
  });

  it('lazily constructs posthog-node and delegates captureException(error, distinctId, props)', async () => {
    const channel = new AnonChannel({ envKey: 'phc_test' });
    const err = new Error('boom');
    const props = { error_code: 'parse_error', message: 'boom' };

    channel.captureException(err, 'install-1', props);
    // captureException is fire-and-forget; wait for the lazy import + construction.
    await vi.waitFor(() => expect(posthogCtorSpy).toHaveBeenCalled());

    expect(posthogCtorSpy).toHaveBeenCalledTimes(1);
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    // Delegates the exact (error, distinctId, props) triple to the posthog client.
    expect(captureExceptionSpy).toHaveBeenCalledWith(err, 'install-1', props);
  });

  it('flush resolves immediately if no client was ever created', async () => {
    const channel = new AnonChannel({});
    await expect(channel.flush(10)).resolves.toBeUndefined();
  });

  it('flush drives the client _shutdown(deadlineMs) drain (not flush) when _shutdown is present', async () => {
    const channel = new AnonChannel({ envKey: 'phc_test' });

    channel.capture(EventName.ParseCompleted, 'install-1', { foo: 'bar' });
    await vi.waitFor(() => expect(posthogCtorSpy).toHaveBeenCalled());

    await expect(channel.flush(50)).resolves.toBeUndefined();
    // The terminal drain must be `_shutdown` — the awaitable path that resolves
    // only after the batched network send actually lands — bounded by the
    // deadline. It must NOT be `flush` (per-request cleanup that resolves before
    // the send completes → the confirmed worker-terminate silent-drop bug).
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
    expect(shutdownSpy).toHaveBeenCalledWith(50);
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('falls back to client.flush() when the client exposes no _shutdown (back-compat)', async () => {
    exposeShutdown = false; // legacy client: only flush(), no _shutdown
    const channel = new AnonChannel({ envKey: 'phc_test' });

    channel.capture(EventName.ParseCompleted, 'install-1', { foo: 'bar' });
    await vi.waitFor(() => expect(posthogCtorSpy).toHaveBeenCalled());

    await expect(channel.flush(50)).resolves.toBeUndefined();
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(shutdownSpy).not.toHaveBeenCalled();
  });

  it('flush resolves (never rejects) even when the _shutdown drain rejects', async () => {
    const channel = new AnonChannel({ envKey: 'phc_test' });

    channel.capture(EventName.ParseCompleted, 'install-1');
    await vi.waitFor(() => expect(posthogCtorSpy).toHaveBeenCalled());

    // The real posthog-node terminal drain sends batched events and can reject at
    // shutdown (failed request) — the exact failure the deadline race swallows.
    shutdownSpy.mockRejectedValueOnce(new Error('ingest request failed at shutdown'));

    await expect(channel.flush(50)).resolves.toBeUndefined();
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('flush resolves by the deadline even when the _shutdown drain never settles', async () => {
    const channel = new AnonChannel({ envKey: 'phc_test' });

    channel.capture(EventName.ParseCompleted, 'install-1');
    await vi.waitFor(() => expect(posthogCtorSpy).toHaveBeenCalled());

    // Make the underlying drain hang forever; only the deadline can win the race,
    // proving flush() never hangs past deadlineMs even on a stuck _shutdown.
    shutdownSpy.mockImplementationOnce(
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
    );

    const start = Date.now();
    await expect(channel.flush(20)).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('CloudChannel', () => {
  // A resolved 2xx fetch fake — the sender never inspects the body, only that
  // the request was dispatched, so a minimal Response-like cast suffices.
  const okFetch = () => vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);

  const makeConfig = () => ({
    apiBase: 'https://cloud.example.com',
    workspaceId: 'ws-1',
    getToken: vi.fn<[], Promise<string | null>>(async () => 'tok'),
  });

  // A representative merged props bag as `emitAgentRun` builds it: BaseProps
  // (which MUST be stripped) + the AgentRunSummary economics. `surface` is the
  // one base prop that IS part of the DTO.
  const agentRunProps = () => ({
    install_id: 'inst-1',
    session_id: 'sess-1',
    invocation_id: 'inv-1',
    platform: 'darwin',
    schema_version: 1,
    cli_version: '1.2.3',
    engine_version: '4.5.6',
    repo_id: 'repo-abc',
    surface: 'desktop',
    runId: 'run-1',
    kind: 'author-profile',
    tokensIn: 100,
    tokensOut: 200,
    costUsd: 0.42,
    turns: 3,
    toolCalls: 5,
    interventions: 1,
    outcome: 'success',
    durationMs: 1234,
  });

  it('POSTs an AgentRun to the workspace agent-runs endpoint with a Bearer token and the picked DTO body', async () => {
    const fetchMock = okFetch();
    const config = makeConfig();
    const channel = new CloudChannel(config, fetchMock as unknown as typeof fetch);

    await channel.emit(EventName.AgentRun, 'install-1', agentRunProps());
    await channel.flush(100);

    expect(config.getToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cloud.example.com/api/v1/workspaces/ws-1/agent-runs');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    // Only the DTO fields survive — base props (install_id, session_id, …) are
    // stripped. appVersion is never in the whitelist (no emit path populates it),
    // so it is absent from the body.
    expect(JSON.parse(init.body as string)).toEqual({
      runId: 'run-1',
      kind: 'author-profile',
      tokensIn: 100,
      tokensOut: 200,
      costUsd: 0.42,
      turns: 3,
      toolCalls: 5,
      interventions: 1,
      outcome: 'success',
      durationMs: 1234,
      surface: 'desktop',
    });
  });

  it('is a no-op for non-AgentRun events — never mints a token or fetches', async () => {
    const fetchMock = okFetch();
    const config = makeConfig();
    const channel = new CloudChannel(config, fetchMock as unknown as typeof fetch);

    await channel.emit(EventName.ParseCompleted, 'install-1', agentRunProps());
    await channel.flush(50);

    expect(config.getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a no-op when no config is present — never fetches', async () => {
    const fetchMock = okFetch();
    const channel = new CloudChannel(undefined, fetchMock as unknown as typeof fetch);

    await expect(channel.emit(EventName.AgentRun, 'install-1', agentRunProps())).resolves.toBeUndefined();
    await channel.flush(50);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('silently drops (no fetch) when getToken resolves null — unauthenticated desktop must not error', async () => {
    const fetchMock = okFetch();
    const config = { ...makeConfig(), getToken: vi.fn<[], Promise<string | null>>(async () => null) };
    const channel = new CloudChannel(config, fetchMock as unknown as typeof fetch);

    await expect(channel.emit(EventName.AgentRun, 'install-1', agentRunProps())).resolves.toBeUndefined();
    await channel.flush(50);

    expect(config.getToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows a non-2xx response — emit and flush still resolve, never throw', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    const channel = new CloudChannel(makeConfig(), fetchMock as unknown as typeof fetch);

    await expect(channel.emit(EventName.AgentRun, 'install-1', agentRunProps())).resolves.toBeUndefined();
    await expect(channel.flush(50)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a network error (fetch rejects) — emit and flush still resolve', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const channel = new CloudChannel(makeConfig(), fetchMock as unknown as typeof fetch);

    await expect(channel.emit(EventName.AgentRun, 'install-1', agentRunProps())).resolves.toBeUndefined();
    await expect(channel.flush(50)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a getToken rejection — emit and flush still resolve, and never fetches', async () => {
    const fetchMock = okFetch();
    const config = {
      ...makeConfig(),
      getToken: vi.fn<[], Promise<string | null>>(async () => {
        throw new Error('mint failed');
      }),
    };
    const channel = new CloudChannel(config, fetchMock as unknown as typeof fetch);

    await expect(channel.emit(EventName.AgentRun, 'install-1', agentRunProps())).resolves.toBeUndefined();
    await expect(channel.flush(50)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flush resolves immediately when nothing is in flight', async () => {
    const channel = new CloudChannel(makeConfig(), okFetch() as unknown as typeof fetch);
    await expect(channel.flush(10)).resolves.toBeUndefined();
  });

  it('flush resolves by the deadline even when the in-flight POST never settles', async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(() => {
          /* never resolves */
        }),
    );
    const channel = new CloudChannel(makeConfig(), fetchMock as unknown as typeof fetch);

    await channel.emit(EventName.AgentRun, 'install-1', agentRunProps());
    const start = Date.now();
    await expect(channel.flush(20)).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
