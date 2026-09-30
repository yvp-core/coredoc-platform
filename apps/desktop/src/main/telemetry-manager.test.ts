import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { TelemetryStatusResult } from '../shared/ipc-types.js';

// The adapter must route through the shared @coredoc/core/telemetry client so
// main-process crashes get centrally path-scrubbed — spy on that client here.
const {
  trackErrorMock,
  shutdownTelemetryMock,
  initTelemetryMock,
  getTelemetryConfigMock,
  setTelemetryEnabledMock,
  markConsentPromptedMock,
  getValidTokensMock,
  getConfiguredServerUrlMock,
} = vi.hoisted(() => ({
  trackErrorMock: vi.fn(),
  shutdownTelemetryMock: vi.fn(async () => undefined),
  initTelemetryMock: vi.fn(),
  getTelemetryConfigMock: vi.fn(
    async (): Promise<{ enabled: boolean; installId: string; consentPromptedAt?: string }> => ({
      enabled: true,
      installId: 'install-xyz',
    }),
  ),
  setTelemetryEnabledMock: vi.fn(async () => undefined),
  markConsentPromptedMock: vi.fn(async () => undefined),
  getValidTokensMock: vi.fn(async (): Promise<{ accessToken: string } | null> => ({ accessToken: 'jwt-token' })),
  getConfiguredServerUrlMock: vi.fn(() => 'https://api.example'),
}));

vi.mock('@coredoc/core/telemetry', () => ({
  trackError: trackErrorMock,
  shutdownTelemetry: shutdownTelemetryMock,
  initTelemetry: initTelemetryMock,
  newInvocationId: () => 'test-invocation-id',
  ErrorCode: { Unknown: 'unknown' },
}));

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9-test' } }));

vi.mock('./server-api.js', () => ({
  getConfiguredServerUrl: getConfiguredServerUrlMock,
}));

vi.mock('./auth-manager.js', () => ({ getValidTokens: getValidTokensMock }));

vi.mock('@coredoc/core/utils', () => ({
  getTelemetryConfig: getTelemetryConfigMock,
  setTelemetryEnabled: setTelemetryEnabledMock,
  markTelemetryConsentPrompted: markConsentPromptedMock,
}));

vi.mock('./build-env.js', () => ({
  BUNDLED_POSTHOG_KEY: 'bundled-key',
  BUNDLED_POSTHOG_HOST: 'https://ph.example',
}));

// A local posthog-node client must NEVER be constructed by the adapter — the
// old telemetry-manager did; the shared client owns transport now.
const PostHogCtor = vi.fn(() => {
  throw new Error('posthog-node must not be constructed by the desktop adapter');
});
vi.mock('posthog-node', () => ({ PostHog: PostHogCtor }));

/** Minimal ipcMain double that records the handlers registered against it. */
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
function fakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, IpcHandler> } {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // clearAllMocks wipes call history but keeps implementations; restore the
  // resolved-value defaults the cloud tests rely on.
  getConfiguredServerUrlMock.mockReturnValue('https://api.example');
  getValidTokensMock.mockResolvedValue({ accessToken: 'jwt-token' });
  delete process.env.COREDOC_SESSION_ID;
  delete process.env.COREDOC_SURFACE;
  delete process.env.COREDOC_CLI_VERSION;
  delete process.env.COREDOC_ENGINE_VERSION;
  delete process.env.COREDOC_POSTHOG_KEY;
  delete process.env.COREDOC_POSTHOG_HOST;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('captureMainException', () => {
  it('routes the raw error through core trackError (central scrub) with ErrorCode.Unknown + merged props', async () => {
    const { captureMainException } = await import('./telemetry-manager.js');
    const err = new Error('crashed reading /Users/alex/secret/repo/profile.ts');

    await captureMainException(err, { source: 'uncaughtException' });

    expect(trackErrorMock).toHaveBeenCalledTimes(1);
    const [passedErr, code, props] = trackErrorMock.mock.calls[0];
    expect(passedErr).toBe(err); // the raw error — core scrubs the message + stack, not the call site
    expect(code).toBe('unknown'); // ErrorCode.Unknown
    expect(props).toMatchObject({ source: 'uncaughtException' });
  });

  it('never constructs a local posthog-node client', async () => {
    const { captureMainException } = await import('./telemetry-manager.js');
    await captureMainException(new Error('boom'), { source: 'unhandledRejection' });
    expect(PostHogCtor).not.toHaveBeenCalled();
  });
});

describe('shutdownMainTelemetry', () => {
  it('delegates to core shutdownTelemetry', async () => {
    const { shutdownMainTelemetry } = await import('./telemetry-manager.js');
    await shutdownMainTelemetry();
    expect(shutdownTelemetryMock).toHaveBeenCalledTimes(1);
  });
});

describe('initMainTelemetry', () => {
  it('mints a launch session, tags surface=desktop, and stitches children via process.env', async () => {
    const { initMainTelemetry } = await import('./telemetry-manager.js');

    initMainTelemetry();

    // Children (sdk-worker, CLI spawns) inherit process.env → same session + surface.
    expect(process.env.COREDOC_SESSION_ID).toBe('test-invocation-id');
    expect(process.env.COREDOC_SURFACE).toBe('desktop');
    // Version base props ride on env too, so the worker thread + CLI spawns inherit them.
    expect(process.env.COREDOC_CLI_VERSION).toBe('9.9.9-test');
    expect(process.env.COREDOC_ENGINE_VERSION).toBe('9.9.9-test');

    expect(initTelemetryMock).toHaveBeenCalledTimes(1);
    expect(initTelemetryMock.mock.calls[0][0]).toEqual({
      surface: 'desktop',
      sessionId: 'test-invocation-id',
      channels: { posthogKey: 'bundled-key', posthogHost: 'https://ph.example' },
    });
  });

  it('prefers runtime COREDOC_POSTHOG_* over the bundled key/host for the channel config', async () => {
    process.env.COREDOC_POSTHOG_KEY = 'runtime-key';
    process.env.COREDOC_POSTHOG_HOST = 'https://runtime.example';
    const { initMainTelemetry } = await import('./telemetry-manager.js');

    initMainTelemetry();

    expect(initTelemetryMock.mock.calls[0][0]).toMatchObject({
      channels: { posthogKey: 'runtime-key', posthogHost: 'https://runtime.example' },
    });
  });
});

describe('buildCloudChannelConfig', () => {
  it('returns a per-run config bound to the workspace (no process-global mutation)', async () => {
    const { buildCloudChannelConfig } = await import('./telemetry-manager.js');

    const cfg = buildCloudChannelConfig('ws-1');

    // A plain config the caller binds to ONE run — the desktop flow passes it
    // straight to emitAgentRun(summary, { cloud }). It touches no shared channel
    // state, which is precisely what stops concurrent runs cross-attributing.
    expect(cfg.apiBase).toBe('https://api.example');
    expect(cfg.workspaceId).toBe('ws-1');
    expect(typeof cfg.getToken).toBe('function');
    expect(initTelemetryMock).not.toHaveBeenCalled(); // pure builder — never re-inits
  });

  it('two workspaces yield two independent configs (no cross-attribution at the source)', async () => {
    const { buildCloudChannelConfig } = await import('./telemetry-manager.js');

    const a = buildCloudChannelConfig('ws-1');
    const b = buildCloudChannelConfig('ws-2');

    expect(a.workspaceId).toBe('ws-1');
    expect(b.workspaceId).toBe('ws-2');
  });

  it('getToken returns the signed-in desktop user JWT', async () => {
    const { buildCloudChannelConfig } = await import('./telemetry-manager.js');
    const { getToken } = buildCloudChannelConfig('ws-1');

    expect(await getToken()).toBe('jwt-token');
    expect(getValidTokensMock).toHaveBeenCalledTimes(1);
  });

  it('getToken resolves null when the desktop user is logged out', async () => {
    getValidTokensMock.mockResolvedValueOnce(null);
    const { buildCloudChannelConfig } = await import('./telemetry-manager.js');
    const { getToken } = buildCloudChannelConfig('ws-1');

    expect(await getToken()).toBeNull();
  });

  it('getToken resolves null (silent drop) when auth refresh fails', async () => {
    getValidTokensMock.mockRejectedValueOnce(new Error('refresh failed'));
    const { buildCloudChannelConfig } = await import('./telemetry-manager.js');
    const { getToken } = buildCloudChannelConfig('ws-1');

    expect(await getToken()).toBeNull();
  });
});

describe('registerTelemetryHandlers', () => {
  it('telemetry:getStatus returns a well-formed TelemetryStatusResult (bundled fallback)', async () => {
    const { registerTelemetryHandlers } = await import('./telemetry-manager.js');
    const { ipcMain, handlers } = fakeIpcMain();
    registerTelemetryHandlers(ipcMain);

    const status = (await handlers.get('telemetry:getStatus')!(null)) as TelemetryStatusResult;
    expect(status).toEqual({
      enabled: true,
      installId: 'install-xyz',
      posthogConfigured: true,
      posthogKey: 'bundled-key',
      posthogHost: 'https://ph.example',
      consentPrompted: false,
    });
  });

  it('telemetry:getStatus reports consentPrompted=true once consentPromptedAt is set', async () => {
    getTelemetryConfigMock.mockResolvedValueOnce({
      enabled: false,
      installId: 'install-xyz',
      consentPromptedAt: '2026-07-18T00:00:00.000Z',
    });
    const { registerTelemetryHandlers } = await import('./telemetry-manager.js');
    const { ipcMain, handlers } = fakeIpcMain();
    registerTelemetryHandlers(ipcMain);

    const status = (await handlers.get('telemetry:getStatus')!(null)) as TelemetryStatusResult;
    expect(status.consentPrompted).toBe(true);
  });

  it('telemetry:setEnabled forwards to core setTelemetryEnabled', async () => {
    const { registerTelemetryHandlers } = await import('./telemetry-manager.js');
    const { ipcMain, handlers } = fakeIpcMain();
    registerTelemetryHandlers(ipcMain);

    await handlers.get('telemetry:setEnabled')!(null, false);
    expect(setTelemetryEnabledMock).toHaveBeenCalledWith(false);
  });

  it('telemetry:markConsentPrompted forwards to core markTelemetryConsentPrompted', async () => {
    const { registerTelemetryHandlers } = await import('./telemetry-manager.js');
    const { ipcMain, handlers } = fakeIpcMain();
    registerTelemetryHandlers(ipcMain);

    await handlers.get('telemetry:markConsentPrompted')!(null);
    expect(markConsentPromptedMock).toHaveBeenCalledTimes(1);
    // The consent card must never opt the user in as a side effect.
    expect(setTelemetryEnabledMock).not.toHaveBeenCalled();
  });
});
