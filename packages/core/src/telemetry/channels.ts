/**
 * Telemetry channels — the two transports events can ship over — plus the
 * static event→channel routing map. Channels are dumb transports: given an
 * event name, distinct id, and props, ship them (anon) or no-op (cloud
 * stub). Deriving `distinctId`, opt-in gating, and BaseProps merging are the
 * client's job (P0.5), not this file's (SRP).
 */

import { EventName } from './events.js';

/** PostHog's own default ingestion host, used when neither an env nor a bundled host is configured. */
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

// Opt-in diagnostic trace (COREDOC_TELEMETRY_DEBUG=1). OFF by default: nothing
// logs, zero behavior change. STDERR only. `[pid:...]` on every line
// distinguishes the MAIN process (which emits agent_run) from the WORKER
// process/thread. A local copy of the gated helper (index.ts has its own) so
// channels.ts stays free of a circular import back into index. Its own INSTANCE
// nonce means a duplicated bundle shows the same log line under two different ids.
const INSTANCE = Math.random().toString(36).slice(2, 8);
function dbg(msg: string): void {
  if (process.env.COREDOC_TELEMETRY_DEBUG === '1') {
    console.error(`${new Date().toISOString()} [pid:${process.pid}] [coredoc-tel ${INSTANCE}] ${msg}`);
  }
}

/**
 * Minimal structural shape of the lazily-imported PostHog client. Kept local
 * (rather than `import type { PostHog } from 'posthog-node'`) so this file
 * never references `posthog-node` outside the dynamic `import()` below — a
 * node-only subpath poisoning concern, not just a value-import one: even a
 * type-only import can widen a bundler's module graph in some configs, and
 * the simplest safe path is a hand-rolled shape.
 */
interface PostHogClientLike {
  capture(props: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  captureException(error: unknown, distinctId?: string, properties?: Record<string, unknown>): void;
  // `flush()` is per-request cleanup — it resolves BEFORE the batched network send
  // completes. `_shutdown()` is the awaitable drain that guarantees all events were
  // sent and all promises resolved (posthog-node's own docs: "Call before the
  // process exits …"). The public `shutdown()` wrapper returns `void`, not a
  // Promise, so we cannot await it — `_shutdown` is the one to drive at terminal
  // drain. Optional so a client exposing only `flush` still type-checks (back-compat).
  flush(): Promise<void>;
  _shutdown?(shutdownTimeoutMs?: number): Promise<void>;
}

/**
 * Structural shape of what posthog-node's injectable `fetch` must resolve to —
 * a subset of the DOM `Response` (the real `fetch` result satisfies it as-is).
 * Hand-rolled for the same reason as {@link PostHogClientLike}: this file never
 * references `posthog-node` outside the lazy `import()`.
 */
interface PostHogFetchResponseLike {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Synthetic "accepted" response handed to posthog-node in place of a failure. */
const ACCEPTED_RESPONSE: PostHogFetchResponseLike = {
  status: 200,
  text: async () => '',
  json: async () => ({}),
};

/**
 * The injected transport that makes telemetry failure SILENT.
 *
 * posthog-core's flush path reports failures through its own hard-coded
 * `console.error` (`logFlushError`) — not its gated logger, and not
 * suppressible by any constructor option, `on('error')` listener, or `.catch()`
 * on our side: by the time the promise we swallow rejects, the stack trace has
 * already been dumped to the user's stderr, mid-command. A request aborted at
 * `requestTimeout` (trivially reached when a CPU-bound parse starves the event
 * loop) therefore printed a PostHogFetchNetworkError stack into `coredoc parse`
 * output.
 *
 * The injectable `fetch` is the only seam that runs BEFORE the library decides
 * a send failed, so failures are converted into an accepted response here.
 * Dropping the batch is the correct outcome regardless: `fetchRetryCount: 0`
 * means there is no retry to preserve, and one lost anon event is worth less
 * than a stack trace in a user's terminal. `COREDOC_TELEMETRY_DEBUG=1` still
 * shows what was swallowed.
 */
async function silentFetch(
  url: string,
  options: { signal?: AbortSignal } & Record<string, unknown>,
): Promise<PostHogFetchResponseLike> {
  try {
    const res = await fetch(url, options as RequestInit);
    // 413 is the ONE status posthog-core acts on itself (halve the batch, retry),
    // so it must pass through unmasked; every other non-2xx would only ever reach
    // `logFlushError`. Same `<200 || >=400` boundary the library applies.
    if (res.status === 413) {
      return res;
    }
    if (res.status < 200 || res.status >= 400) {
      dbg(`posthog responded ${res.status} (swallowed)`);
      return ACCEPTED_RESPONSE;
    }
    return res;
  } catch (err) {
    dbg(`posthog fetch failed (swallowed): ${err}`);
    return ACCEPTED_RESPONSE;
  }
}

/**
 * `AnonChannel` config. Effective key = `envKey ?? bundledKey`; effective
 * host = `envHost ?? bundledHost ?? DEFAULT_POSTHOG_HOST`. The bundled
 * fallback lets desktop and the CLI-dist build ship a baked-in key (P0.9)
 * while an env var always wins for local/dev overrides.
 */
export interface AnonChannelConfig {
  envKey?: string;
  envHost?: string;
  bundledKey?: string;
  bundledHost?: string;
}

/**
 * Anon PostHog channel. Permanently a no-op when no effective key is
 * configured — `capture`/`captureException` return before ever reaching the
 * lazy `await import('posthog-node')`, so an unconfigured install (or a web
 * bundle that should never see this module at all) never touches the
 * network or the posthog-node package.
 *
 * `posthog-node` MUST stay a lazy, in-method import — never a top-level
 * `import` — because `@coredoc/core/telemetry` is a node-only subpath and
 * `apps/web` value-imports `@coredoc/core`; a top-level `posthog-node`
 * import would poison the web bundle.
 */
export class AnonChannel {
  private readonly key: string | undefined;
  private readonly host: string;
  private client: PostHogClientLike | null = null;
  private clientPromise: Promise<PostHogClientLike | null> | null = null;

  constructor(config: AnonChannelConfig = {}) {
    this.key = config.envKey ?? config.bundledKey;
    this.host = config.envHost ?? config.bundledHost ?? DEFAULT_POSTHOG_HOST;
    dbg(`AnonChannel ctor key=${this.key ? 'present' : 'ABSENT'} host=${this.host}`);
  }

  /** Lazily constructs and caches the posthog-node client. Only ever called once a key is confirmed present. */
  private async getClient(): Promise<PostHogClientLike> {
    if (this.client) {
      return this.client;
    }
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { PostHog } = await import('posthog-node');
        // Bounded network behavior: the library defaults (10s request timeout,
        // retries with backoff, loud error logging) turn a blocked network into
        // ~10s of stalls and ENOTFOUND stack traces PER CLI COMMAND. Telemetry
        // failure must be silent and near-instant. The options bound the stall;
        // `silentFetch` is what makes it silent (the `on('error')` listener below
        // does NOT — posthog-core logs before it emits).
        const client = new PostHog(this.key as string, {
          host: this.host,
          requestTimeout: 2000,
          fetchRetryCount: 0,
          // Silences the library's un-gateable flush-error `console.error` — see silentFetch.
          fetch: silentFetch,
        }) as unknown as PostHogClientLike;
        const emitter = client as { on?: (event: string, listener: (err: unknown) => void) => void };
        if (typeof emitter.on === 'function') {
          emitter.on('error', (err) => {
            dbg(`posthog transport error (swallowed): ${err}`);
          });
        }
        this.client = client;
        return client;
      })();
    }
    return this.clientPromise as Promise<PostHogClientLike>;
  }

  capture(event: EventName | string, distinctId: string, props?: Record<string, unknown>): void {
    dbg(`capture ${event} key=${this.key ? 'present' : 'ABSENT'} host=${this.host}`);
    if (!this.key) {
      return; // no-op when unconfigured — never reaches the lazy import
    }
    void this.getClient()
      .then((client) => {
        client.capture({ distinctId, event, properties: props });
        dbg(`capture ${event} -> posthog enqueued`);
      })
      .catch((err) => {
        // Telemetry must never throw into the caller — swallow lazy-import/construction failures.
        dbg(`capture ${event} FAILED: ${err}`);
      });
  }

  captureException(error: unknown, distinctId: string, props?: Record<string, unknown>): void {
    if (!this.key) {
      return; // no-op when unconfigured — never reaches the lazy import
    }
    void this.getClient()
      .then((client) => {
        client.captureException(error, distinctId, props);
      })
      .catch(() => {
        // Telemetry must never throw into the caller — swallow lazy-import/construction failures.
      });
  }

  /**
   * Races the underlying posthog-node flush against `deadlineMs`, resolving
   * either way (never rejects, never hangs past the deadline). If no client
   * was ever created (unconfigured, or capture never called), resolves
   * immediately — there is nothing to flush.
   */
  async flush(deadlineMs: number): Promise<void> {
    dbg(`flush start (client=${!!this.client} promise=${!!this.clientPromise})`);
    if (!this.client && !this.clientPromise) {
      return;
    }
    // Hold the deadline timer handle so the flush-wins-the-race path can clear it
    // in `finally`. An uncleared ref'd timer keeps the Node event loop alive for
    // the full deadlineMs after flush already resolved — up to deadlineMs (500ms)
    // of tail latency on a one-shot CLI command that awaits shutdown then exits.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
    });
    // Prefer posthog-node's `_shutdown` — the awaitable drain that resolves only
    // once the batched network send has actually completed. `flush()` is merely
    // per-request cleanup and resolves BEFORE the POST lands, so a hard
    // worker-terminate right after it kills the in-flight send (the confirmed
    // silent-drop bug). Fall back to `flush()` for any client that predates
    // `_shutdown`. Terminal `.catch` (not the two-arg `.then(onFulfilled,
    // onRejected)` form) so a rejection from the drain itself is swallowed too,
    // not only one from `getClient()` construction. posthog-node's send can reject
    // at shutdown — the exact failure this races. If it rejects after the deadline
    // already won the race, the swallow also prevents an orphaned rejected promise
    // (unhandledRejection). flush() must ALWAYS resolve, never reject, never hang
    // past the deadline.
    const doFlush = this.getClient()
      .then((client) => (typeof client._shutdown === 'function' ? client._shutdown(deadlineMs) : client.flush()))
      .catch((err) => {
        // Client construction or drain failed — nothing more to do, and flush must never reject.
        dbg(`flush FAILED: ${err}`);
      });
    try {
      await Promise.race([doFlush, deadline]);
    } finally {
      clearTimeout(timer);
      // `_shutdown` CLOSES the client, so reset the channel: a rare reuse after a
      // terminal drain reconstructs a fresh client instead of capturing into a
      // closed one. Safe because `flush` is only ever called at terminal drain
      // (worker-terminate / CLI exit / app-quit).
      this.client = null;
      this.clientPromise = null;
    }
    dbg('flush done');
  }
}

/** Mirrors `initTelemetry`'s `ctx.channels.cloud` shape (P0.5) — apiBase/workspaceId/getToken. */
export interface CloudChannelConfig {
  apiBase: string;
  workspaceId: string;
  getToken: () => Promise<string | null>;
}

/**
 * Cloud channel — attributed, per-workspace agent-run telemetry.
 *
 * Ships ONLY {@link EventName.AgentRun} (the sole `routeChannel === 'both'`
 * event) to a dedicated `POST /api/v1/workspaces/:id/agent-runs` endpoint;
 * every other event is a no-op — the explicit event guard is fail-safe, never
 * a silent broadening of what leaves the machine. Like {@link AnonChannel} it
 * NEVER throws into the caller: an absent config, a null token (unauthenticated
 * desktop), a non-2xx response, and network errors are all swallowed.
 *
 * One emit ≈ one run and the server upserts on `(workspaceId, runId)`, so a
 * dropped emit is simply lost and any retry would be idempotent — there is
 * deliberately no retry queue / batching / persistence (YAGNI). `fetch` is
 * injectable for tests; the config shape is unchanged from the P0 stub so the
 * `initTelemetry` caller is untouched.
 */
export class CloudChannel {
  private readonly config: CloudChannelConfig | undefined;
  private readonly fetchImpl: typeof fetch;
  /** In-flight POST promises, drained (bounded) by {@link flush}. */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(config?: CloudChannelConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Fire-and-forget POST of an agent-run summary. No-op unless the event is
   * `AgentRun` AND a config is present. Returns as soon as the request is
   * dispatched — the network round-trip is tracked in {@link inFlight} and
   * drained by {@link flush}, mirroring AnonChannel's capture/flush split.
   */
  async emit(event: EventName | string, _distinctId: string, props?: Record<string, unknown>): Promise<void> {
    // Explicit guard — only the one event routed here, only when configured.
    if (event !== EventName.AgentRun || !this.config) {
      return;
    }
    const config = this.config;
    // Detach from `this` so native fetch isn't invoked with the wrong receiver.
    const fetchImpl = this.fetchImpl;
    const source = props ?? {};
    const p = (async () => {
      try {
        const token = await config.getToken();
        if (token === null) {
          return; // Unauthenticated desktop — silent drop; never error, never fetch.
        }
        // Whitelist the server DTO fields — base props (install_id, session_id, …)
        // are stripped. `appVersion` is deliberately absent: no emit path populates
        // it (neither AgentRunSummary nor BaseProps carries it), so shipping it would
        // only ever send `undefined`. The server DTO keeps its optional appVersion?
        // field for a future source; re-add here only once one exists.
        const body = JSON.stringify({
          runId: source.runId,
          kind: source.kind,
          tokensIn: source.tokensIn,
          tokensOut: source.tokensOut,
          costUsd: source.costUsd,
          turns: source.turns,
          toolCalls: source.toolCalls,
          interventions: source.interventions,
          outcome: source.outcome,
          durationMs: source.durationMs,
          surface: source.surface,
        });
        await fetchImpl(`${config.apiBase}/api/v1/workspaces/${config.workspaceId}/agent-runs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        // A non-2xx response is not thrown by fetch and is intentionally not
        // inspected — no retry (upsert is idempotent), and telemetry never throws.
      } catch {
        // Token/network failure — swallow; telemetry must never throw into the caller.
      }
    })();
    this.inFlight.add(p);
    void p.finally(() => {
      this.inFlight.delete(p);
    });
  }

  /**
   * Races the in-flight POSTs against `deadlineMs`, resolving either way (never
   * rejects, never hangs past the deadline). Resolves immediately when nothing
   * is in flight. Mirrors {@link AnonChannel.flush} — the deadline timer is
   * cleared in `finally` so a drain-win leaves no ref'd timer keeping the Node
   * event loop alive past the resolve.
   */
  async flush(deadlineMs: number): Promise<void> {
    if (this.inFlight.size === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
    });
    const drain = Promise.allSettled([...this.inFlight]).then(() => undefined);
    try {
      await Promise.race([drain, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pure event→channel routing map — no side effects, no state. Static
 * per-event-class routing (spec §5.2): `AgentRun` goes to both channels;
 * everything else (including `push_*`, revisit later) stays anon-only in P0.
 */
export function routeChannel(event: EventName): 'anon' | 'cloud' | 'both' {
  switch (event) {
    case EventName.AgentRun:
      return 'both';
    default:
      return 'anon';
  }
}
