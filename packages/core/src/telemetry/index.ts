/**
 * Telemetry client — the single entry point instrumented paths call.
 *
 * Responsibilities (SRP): resolve identity (install id / opt-in / session /
 * invocation / surface / repo id), merge {@link BaseProps} onto every event,
 * enforce the opt-in gate, centralize path scrubbing, and ship events on the
 * anon channel (agent runs also POST to their own workspace's cloud channel). It owns NO transport itself — the channels
 * are dumb transports and identity/session live in P0.2/P0.3.
 *
 * Two review-mandated design shapes:
 *  - **Lazy, idempotent init.** `track`/`trackError`/`emitAgentRun` auto-resolve
 *    identity on first call if `initTelemetry` never ran — because P0's
 *    instrumented paths (operations-tracker, sdk/parse, and the desktop
 *    sdk-worker THREAD with its own fresh module state) never call
 *    `initTelemetry`. A "no-op before init" client would silently drop every P0
 *    event while fake-channel unit tests still pass — the exact silent-failure
 *    class this project exists to kill. `initTelemetry` remains for callers that
 *    want to pass channels/sessionId up front (desktop main, CLI entry).
 *
 * Node-only: never a top-level value import of `posthog-node` (the AnonChannel
 * lazy-imports it). `apps/web` must never import `@coredoc/core/telemetry`.
 */

import { getTelemetryConfig } from '../utils/index.js';
import { AnonChannel, CloudChannel, type CloudChannelConfig, dbg } from './channels.js';
import { type BaseProps, ErrorCode, EventName, type Props, SCHEMA_VERSION, type Surface } from './events.js';
import { newInvocationId, repoId, resolveSession } from './ids.js';
import { scrubPaths } from './sanitize.js';

// ---------------------------------------------------------------------------
// Public surface re-exports. `@coredoc/core/telemetry` maps to a SINGLE subpath
// (there are no deep-import subpaths), so this barrel is the complete public
// API. Downstream consumers (CLI P0.7, desktop P0.8/P0.9) import the event/error
// vocabulary, anomaly detection, and id/session helpers from here — not from
// sibling modules. Internal-only symbols (channel classes, the __*ForTests
// seam) are deliberately NOT re-exported.
// ---------------------------------------------------------------------------
export { EventName, ErrorCode, SCHEMA_VERSION } from './events.js';
export type { Surface, Props, BaseProps } from './events.js';
export { detectParseAnomalies } from './parse-anomaly.js';
export type { DetectParseAnomaliesInput } from './parse-anomaly.js';
export { newInvocationId, repoId, resolveSession } from './ids.js';
export type { ResolveSessionOptions } from './ids.js';
export type { CloudChannelConfig } from './channels.js';
// Exported so callers can put a redacted error message on a `*_failed` event
// prop (the path-scrub rule stays defined in one place).
export { scrubPaths } from './sanitize.js';

/** Coarse agent-run summary — pinned NOW so P2's channel choice can't grow the API. */
export interface AgentRunSummary {
  runId: string;
  kind: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  turns: number;
  toolCalls: number;
  outcome: string;
  interventions: number;
  durationMs: number;
}

/** Optional up-front configuration passed by callers that init explicitly (desktop main, CLI entry). */
export interface InitContext {
  /** Default 'cli'; desktop children read `COREDOC_SURFACE`. */
  surface?: Surface;
  sessionId?: string;
  repoRoot?: string;
  channels?: {
    posthogKey?: string;
    posthogHost?: string;
  };
}

/** Structural anon-channel shape (real {@link AnonChannel} or a test fake). */
interface AnonChannelLike {
  capture(event: EventName | string, distinctId: string, props?: Record<string, unknown>): void;
  captureException(error: unknown, distinctId: string, props?: Record<string, unknown>): void;
  flush(deadlineMs: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Module state. Fresh per module instance — the desktop sdk-worker thread gets
// its own, which is exactly why lazy auto-init must work without initTelemetry.
// ---------------------------------------------------------------------------

let pendingCtx: InitContext | null = null;
let initPromise: Promise<void> | null = null;

let installId = '';
let sessionId = '';
let invocationId = '';
let surface: Surface = 'cli';
let resolvedRepoId: string | undefined;
let cliVersion = 'unknown';
let engineVersion = 'unknown';

let anonChannel: AnonChannelLike | null = null;

/** In-flight emit promises, drained (bounded) by {@link shutdownTelemetry}. */
const inFlight = new Set<Promise<unknown>>();

/** Default bounded flush deadline (ms) — shared by shutdown and the per-run agent-run cloud drain. */
const DEFAULT_FLUSH_DEADLINE_MS = 500;

/**
 * Lazy, idempotent init. Concurrent callers before init completes all await the
 * SAME promise (stored, not just a bool) — operations-tracker may fire several
 * events fast. Resolves identity, opt-in, and channels exactly once.
 */
function ensureInit(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }
  initPromise = doInit();
  return initPromise;
}

async function doInit(): Promise<void> {
  const ctx = pendingCtx ?? {};

  const config = await getTelemetryConfig();
  installId = config.installId;
  // NOTE: the opt-in gate is NOT latched here. On a long-lived surface (desktop
  // main) a mid-session Disable updates the telemetry-config cache, so the gate
  // is re-evaluated at EMIT time via {@link isOptedInNow} — latching it here
  // would keep emitting until process restart. Identity below (install/session/
  // invocation/surface) DOES latch: it cannot change intra-process.

  surface = ctx.surface ?? (process.env.COREDOC_SURFACE as Surface | undefined) ?? 'cli';
  // The env session id wins inside resolveSession, so desktop children (given
  // COREDOC_SESSION_ID) stitch to the parent's session.
  sessionId = ctx.sessionId ?? (await resolveSession({ surface, envSessionId: process.env.COREDOC_SESSION_ID }));
  invocationId = newInvocationId();
  resolvedRepoId = ctx.repoRoot ? repoId(installId, ctx.repoRoot) : undefined;

  // Versions are stamped into env by each entry (CLI/MCP package.json, desktop app version)
  // so child processes/threads inherit them; 'unknown' means no entry stamped them.
  cliVersion = process.env.COREDOC_CLI_VERSION ?? 'unknown';
  engineVersion = process.env.COREDOC_ENGINE_VERSION ?? 'unknown';

  // Preserve a test-injected channel; otherwise build the real one. An env key
  // always wins over a bundled key (see AnonChannelConfig).
  if (!anonChannel) {
    anonChannel = new AnonChannel({
      envKey: process.env.COREDOC_POSTHOG_KEY,
      envHost: process.env.COREDOC_POSTHOG_HOST,
      bundledKey: ctx.channels?.posthogKey,
      bundledHost: ctx.channels?.posthogHost,
    });
  }

  dbg(
    `init surface=${surface} sessionId=${sessionId?.slice(0, 8)} installId=${installId?.slice(0, 8)} anonKey=${anonChannel ? 'ch-created' : 'no-ch'}`,
  );
  dbg(
    `init anon effectiveKey=${(process.env.COREDOC_POSTHOG_KEY ?? ctx.channels?.posthogKey) ? 'present' : 'ABSENT'} host=${process.env.COREDOC_POSTHOG_HOST ?? ctx.channels?.posthogHost ?? '(default)'}`,
  );
}

/**
 * Re-evaluate the opt-in gate at EMIT time — never latched in {@link doInit}.
 * On a long-lived surface (desktop main) a mid-session Disable
 * (`setTelemetryEnabled(false)`) updates the telemetry-config cache, so this
 * fresh read stops emits WITHOUT a re-init — the "Disabled ⇒ zero emit"
 * invariant for long-lived processes. `getTelemetryConfig()` is cached
 * (utils/telemetry-config.ts), so this is a cheap in-memory read on the hot
 * path. The config already forces `enabled:false` under the kill-switch; the
 * env re-check is belt-and-suspenders against a stale cache (Global Constraint).
 */
async function isOptedInNow(): Promise<boolean> {
  const config = await getTelemetryConfig();
  return config.enabled === true && process.env.COREDOC_TELEMETRY_DISABLED !== '1';
}

function buildBaseProps(): BaseProps {
  return {
    install_id: installId,
    session_id: sessionId,
    invocation_id: invocationId,
    surface,
    // Omitted (undefined) when the command has no repo in scope — expected.
    repo_id: resolvedRepoId,
    cli_version: cliVersion,
    engine_version: engineVersion,
    platform: process.platform,
    schema_version: SCHEMA_VERSION,
  };
}

/** Tracks an emit promise so a bounded {@link shutdownTelemetry} can drain it. */
function trackInFlight(p: Promise<unknown>): void {
  inFlight.add(p);
  void p.finally(() => {
    inFlight.delete(p);
  });
}

/** Coarse cost bucket — the anon channel never sees an exact dollar amount. */
function bucket(costUsd: number): string {
  if (costUsd < 0.1) {
    return 'lt_0.1';
  }
  if (costUsd < 1) {
    return 'lt_1';
  }
  return 'gte_1';
}

/**
 * Explicit up-front init. Records the context for the (lazy) init to consume —
 * channels are built on first emit, so injected/test channels still win. Safe
 * to skip entirely: the first `track` auto-inits.
 */
export function initTelemetry(ctx: InitContext = {}): void {
  pendingCtx = ctx;
}

/**
 * Anon, fire-and-forget. Lazy-auto-inits on first call. Merges BaseProps, gates
 * on opt-in. All emit errors are swallowed —
 * telemetry must never throw into the caller (Fail-safe).
 */
export function track(event: EventName, props?: Props): void {
  dbg(`track ${event}`);
  const p = ensureInit()
    .then(async () => {
      const optedIn = await isOptedInNow();
      dbg(`track ${event} optedIn=${optedIn} -> ${optedIn ? 'emitting' : 'skipped'}`);
      if (!optedIn) {
        return;
      }
      anonChannel?.capture(event, installId, { ...buildBaseProps(), ...props });
    })
    .catch(() => {
      // Telemetry must never throw into the caller — swallow emit/init failures.
    });
  trackInFlight(p);
}

/**
 * Best-effort, data-shape-driven `error_code` bucket for `*_failed` events: a
 * generic network/auth substring probe (never client- or SDK-specific),
 * defaulting to {@link ErrorCode.Unknown}. The one classifier every surface uses.
 */
export function classifyError(error: unknown): ErrorCode {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/network|econn|etimedout|fetch failed|socket hang up/.test(message)) {
    return ErrorCode.NetworkError;
  }
  if (/unauthor|forbidden|\b401\b|\b403\b|\bauth\b|authenticat|authoriz/.test(message)) {
    return ErrorCode.AuthFailed;
  }
  return ErrorCode.Unknown;
}

/**
 * Centralized error emit. Path scrub happens HERE, never at call sites — this
 * fixes the live leak where `captureException` shipped raw stacks carrying user
 * paths. The message is scrubbed + truncated; the error's stack is scrubbed too
 * before it reaches the wire. Anon-routed.
 */
export function trackError(err: unknown, code: ErrorCode, props?: Props): void {
  const p = ensureInit()
    .then(async () => {
      if (!(await isOptedInNow())) {
        return;
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = scrubPaths(rawMessage).slice(0, 200);
      // Scrub the stack too so no raw user path reaches PostHog's exception capture.
      const scrubbed = new Error(message);
      // Keep the original error class — it is PostHog's grouping key alongside the message.
      scrubbed.name = err instanceof Error ? err.name : 'Error';
      scrubbed.stack = err instanceof Error && err.stack ? scrubPaths(err.stack) : undefined;
      anonChannel?.captureException(scrubbed, installId, {
        ...buildBaseProps(),
        error_code: code,
        message,
        ...props,
      });
    })
    .catch(() => {
      // Telemetry must never throw into the caller — swallow emit/init failures.
    });
  trackInFlight(p);
}

/**
 * Emits an agent-run: anon gets a COARSE aggregate DERIVED from the summary
 * object (never recomputed — spec §10 risk); cloud gets the FULL summary, but
 * only when `opts.cloud` binds it to THIS run's workspace. Attribution follows
 * the run, not the process — desktop runs several agent-runs concurrently, so a
 * shared channel would let one run's summary land in another's workspace. A
 * workspaceless run (no `opts.cloud`) is anon-only.
 */
export function emitAgentRun(summary: AgentRunSummary, opts?: { cloud?: CloudChannelConfig }): void {
  const p = ensureInit()
    .then(async () => {
      if (!(await isOptedInNow())) {
        return;
      }
      const base = buildBaseProps();
      // Anon FIRST (synchronous) — the privacy-safe aggregate is the channel that
      // must never be gated behind cloud transport. Mirrors `track`, so a cloud
      // rejection can't skip it. No exact cost, no run id.
      anonChannel?.capture(EventName.AgentRun, installId, {
        ...base,
        cost_bucket: bucket(summary.costUsd),
        outcome: summary.outcome,
        turns: summary.turns,
      });
      // Cloud: full summary.
      if (opts?.cloud) {
        // The channel is EPHEMERAL to this emit, so shutdown never sees it —
        // this emit therefore owns the channel's full lifecycle: dispatch AND drain.
        // The tracked promise stays in-flight until the POST settles (bounded),
        // so app-quit shutdown drains it too. In a long-lived desktop process a
        // POST slower than the deadline still completes on its own afterwards.
        const perRun = new CloudChannel(opts.cloud);
        await perRun.emit(EventName.AgentRun, installId, { ...base, ...summary });
        await perRun.flush(DEFAULT_FLUSH_DEADLINE_MS);
      }
    })
    .catch(() => {
      // Telemetry must never throw into the caller — swallow emit/init failures.
    });
  trackInFlight(p);
}

/**
 * Bounded flush. Awaits in-flight emits then flushes the anon channel, racing the
 * whole drain against `deadlineMs`. Resolves either way — never rejects, never
 * hangs past the deadline (posthog-node batches; a one-shot CLI command would
 * otherwise drop events without this).
 */
export async function shutdownTelemetry(deadlineMs = DEFAULT_FLUSH_DEADLINE_MS): Promise<void> {
  const drain = (async () => {
    dbg(`shutdown: draining ${inFlight.size} inFlight, deadline=${deadlineMs}`);
    await Promise.allSettled([...inFlight]);
    await anonChannel?.flush(deadlineMs);
    dbg('shutdown: flushed');
  })().catch(() => {
    // Shutdown must never reject into the caller.
  });
  // Hold the handle so a drain-win clears it — an uncleared ref'd timer keeps the
  // Node event loop alive for the full deadlineMs, adding tail latency to a
  // one-shot CLI command that awaits shutdown then exits naturally.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  try {
    await Promise.race([drain, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Test-only seam (underscore-prefixed, per repo convention — cf.
// resetTelemetryConfigCache / __clearRegistryForTests). Not part of the public
// API; used by index.test.ts to inject fake channels and reset module state.
// ---------------------------------------------------------------------------

/** Overrides the module's anon channel instance (structural fake). */
export function __setChannelsForTests(anon: AnonChannelLike): void {
  anonChannel = anon;
}

/** Clears init state, channels, and in-flight emits so each test starts clean. */
export function __resetTelemetryForTests(): void {
  pendingCtx = null;
  initPromise = null;
  installId = '';
  sessionId = '';
  invocationId = '';
  surface = 'cli';
  resolvedRepoId = undefined;
  cliVersion = 'unknown';
  engineVersion = 'unknown';
  anonChannel = null;
  inFlight.clear();
}
