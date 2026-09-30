/**
 * Telemetry Manager — desktop MAIN-process adapter over the shared
 * `@coredoc/core/telemetry` client.
 *
 * The client owns identity, opt-in gating, central path scrubbing, and
 * transport. This module only:
 *  - initializes the client at launch and stitches child processes
 *    (`initMainTelemetry`),
 *  - forwards main-process crashes to it (`captureMainException` →
 *    `trackError`), so raw stacks carrying user paths are scrubbed centrally
 *    (fixes the live leak where `captureException` shipped raw paths),
 *  - flushes on quit (`shutdownMainTelemetry` → `shutdownTelemetry`),
 *  - keeps the Settings-switch IPC surface (`registerTelemetryHandlers`) and
 *    the bundled-key fallback (`resolvePosthogConfig`) that the renderer
 *    SettingsPage depends on via `TelemetryStatusResult`.
 *
 * Node-only: `@coredoc/core/telemetry` is imported in the MAIN process only,
 * NEVER the renderer (which keeps its own posthog-js for pageviews).
 */

import { app, type IpcMain } from 'electron';
import type { TelemetryStatusResult } from '../shared/ipc-types.js';
import { BUNDLED_POSTHOG_KEY, BUNDLED_POSTHOG_HOST } from './build-env.js';
import { getTelemetryConfig, markTelemetryConsentPrompted, setTelemetryEnabled } from '@coredoc/core/utils';
import {
  type CloudChannelConfig,
  ErrorCode,
  type InitContext,
  initTelemetry,
  newInvocationId,
  shutdownTelemetry,
  trackError,
} from '@coredoc/core/telemetry';
import { getValidTokens } from './auth-manager.js';
import { getConfiguredServerUrl } from './server-api.js';

/**
 * Resolve the PostHog anon-channel config: runtime env (workspace .env / OS env)
 * wins over the build-time bundled defaults. Used both to compute
 * `posthogConfigured` for the status IPC and to seed the client's channel.
 */
export function resolvePosthogConfig(): { apiKey: string; host: string } | null {
  const apiKey = process.env.COREDOC_POSTHOG_KEY?.trim() || BUNDLED_POSTHOG_KEY;
  const host = process.env.COREDOC_POSTHOG_HOST?.trim() || BUNDLED_POSTHOG_HOST;
  if (!apiKey || !host) return null;
  return { apiKey, host };
}

/** Launch-time desktop session id, reused when the cloud channel is later added. */
let mainSessionId = '';

/**
 * The anon-only init context set at launch by {@link initMainTelemetry}. Cloud
 * attribution is NOT part of this context: it is resolved per agent-run via
 * {@link buildCloudChannelConfig} and bound to that run, so the PostHog key/host
 * and stitched session id here are the complete up-front config.
 */
function buildMainInitContext(): InitContext {
  const cfg = resolvePosthogConfig();
  return {
    surface: 'desktop',
    sessionId: mainSessionId,
    channels: {
      posthogKey: cfg?.apiKey,
      posthogHost: cfg?.host,
    },
  };
}

/**
 * Initialize the shared telemetry client for the desktop MAIN process and
 * stitch child processes to the same session. Call once at launch, BEFORE the
 * crash hooks can fire.
 *
 * Mints a launch-time desktop session id, tags `surface: 'desktop'`, and exports
 * both on `process.env` so children — the sdk-worker thread and any CLI spawn,
 * which inherit `{ ...process.env }` — join the same session and carry
 * `surface: 'desktop'`. The bundled/env PostHog key+host seed the anon channel.
 * Cloud attribution is resolved per agent-run (workspace-scoped) via
 * {@link buildCloudChannelConfig}.
 */
export function initMainTelemetry(): void {
  mainSessionId = newInvocationId();
  // Export for children (sdk-worker inherits process.env at Worker creation; the
  // core client reads COREDOC_SESSION_ID / COREDOC_SURFACE to stitch + tag).
  process.env.COREDOC_SESSION_ID = mainSessionId;
  process.env.COREDOC_SURFACE = 'desktop';
  // Version base props: the app version is stamped from the release tag, and the
  // bundled engine ships in lockstep with it. Set here (before any worker/CLI
  // spawn) so every surface in this session reports the same build.
  process.env.COREDOC_CLI_VERSION = app.getVersion();
  process.env.COREDOC_ENGINE_VERSION = app.getVersion();

  initTelemetry(buildMainInitContext());
}

/**
 * Build the cloud-attribution config for a single agent-run's workspace. Returns
 * a plain {@link CloudChannelConfig} — it mutates NO process-global state — so the
 * caller can bind it to one run and pass it straight to `emitAgentRun(summary,
 * { cloud })`. That per-run binding is what keeps concurrent desktop agent-runs
 * from cross-attributing their economics: each run's summary POSTs to the
 * workspace resolved at ITS start, never a channel a later run swapped in.
 *
 * `getToken` resolves the desktop user's OAuth access token. Agent-run telemetry
 * is an authenticated desktop API call and must not mint or reuse the separate
 * workspace OTLP credential, which is reserved for the external Claude Code
 * exporter configured in `.claude/settings.local.json`. Missing/failed auth
 * resolves `null`, which the cloud channel treats as a silent drop.
 */
export function buildCloudChannelConfig(workspaceId: string): CloudChannelConfig {
  return {
    apiBase: getConfiguredServerUrl(),
    workspaceId,
    getToken: () =>
      getValidTokens()
        .then((tokens) => tokens?.accessToken ?? null)
        .catch(() => null),
  };
}

/**
 * Forward a desktop main-process exception to the shared client. Best-effort:
 * `trackError` gates on opt-in, scrubs the message + stack, and never throws.
 * Kept `async` so the existing crash-hook call sites (`.catch(...)`) type-check.
 */
export async function captureMainException(error: unknown, properties: Record<string, unknown> = {}): Promise<void> {
  trackError(error, ErrorCode.Unknown, { ...properties, $lib: 'coredoc-desktop-main' });
}

/**
 * Flush and shut down telemetry. Call from app.before-quit. Delegates to the
 * shared client's bounded flush (never rejects, never hangs past its deadline).
 */
export async function shutdownMainTelemetry(): Promise<void> {
  await shutdownTelemetry();
}

export function registerTelemetryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('telemetry:getStatus', async (): Promise<TelemetryStatusResult> => {
    try {
      const config = await getTelemetryConfig();
      // Runtime env (workspace .env / OS env) overrides build-time defaults.
      const posthogKey = process.env.COREDOC_POSTHOG_KEY?.trim() || BUNDLED_POSTHOG_KEY || undefined;
      const posthogHost = process.env.COREDOC_POSTHOG_HOST?.trim() || BUNDLED_POSTHOG_HOST || undefined;
      return {
        enabled: config.enabled,
        installId: config.installId,
        posthogConfigured: !!(posthogKey && posthogHost),
        posthogKey,
        posthogHost,
        consentPrompted: !!config.consentPromptedAt,
      };
    } catch {
      return { enabled: false, installId: '', posthogConfigured: false, consentPrompted: false };
    }
  });

  ipcMain.handle('telemetry:setEnabled', async (_event, enabled: boolean): Promise<void> => {
    try {
      await setTelemetryEnabled(enabled);
    } catch (err) {
      console.error('[Telemetry] Failed to update telemetry setting:', err);
    }
  });

  // First-run consent card resolves here: stamp `consentPromptedAt` so the card
  // shows exactly once. Best-effort — never enables telemetry, never throws.
  ipcMain.handle('telemetry:markConsentPrompted', async (): Promise<void> => {
    try {
      await markTelemetryConsentPrompted();
    } catch (err) {
      console.error('[Telemetry] Failed to mark consent prompted:', err);
    }
  });
}
