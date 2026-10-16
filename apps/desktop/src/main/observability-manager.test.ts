import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';

// Mock every collaborator so the manager never touches network or real IPC/IO.
const { getConfiguredServerUrlMock, openExternalMock } = vi.hoisted(() => ({
  getConfiguredServerUrlMock: vi.fn(() => 'https://api.example'),
  openExternalMock: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({ shell: { openExternal: openExternalMock } }));

vi.mock('./server-api.js', () => ({
  getConfiguredServerUrl: getConfiguredServerUrlMock,
}));

vi.mock('./build-env.js', () => ({ BUNDLED_COREDOC_WEB_URL: '' }));

/** Minimal ipcMain double that records handlers registered against it. */
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

async function registered() {
  const { registerObservabilityHandlers } = await import('./observability-manager.js');
  const { ipcMain, handlers } = fakeIpcMain();
  registerObservabilityHandlers(ipcMain);
  return handlers;
}

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // clearAllMocks wipes call history but keeps implementations; restore defaults.
  getConfiguredServerUrlMock.mockReturnValue('https://api.example');
  process.env = { ...savedEnv };
  delete process.env.COREDOC_WEB_URL;
});

describe('observability:openDashboard', () => {
  it('returns {success:false} and does not open when the web URL is unconfigured', async () => {
    const handlers = await registered();
    const res = (await handlers.get('observability:openDashboard')!(null, 'acme')) as {
      success: boolean;
      error?: string;
    };
    expect(res.success).toBe(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('opens the composed dashboard URL when configured', async () => {
    process.env.COREDOC_WEB_URL = 'https://app.example';
    const handlers = await registered();
    const res = (await handlers.get('observability:openDashboard')!(null, 'acme')) as { success: boolean };

    expect(res.success).toBe(true);
    expect(openExternalMock).toHaveBeenCalledWith('https://app.example/w/acme/dashboards');
  });
});
