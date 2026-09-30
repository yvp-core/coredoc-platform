import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the transport so no real network runs. A local ApiError class stands in
// for server-api's — the manager imports ApiError from the same (mocked) module,
// so `err instanceof ApiError` matches the rejections we construct here.
const {
  getRepoStateMock,
  resendInviteMock,
  onAuthChangeMock,
  ApiErrorClass,
  ipcHandlers,
  setUserServerUrlMock,
  resolveServerConfigMock,
  resetServerCompatMock,
  isCliAliasInstalledMock,
  getValidTokensMock,
  setServerApiUrlMock,
} = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    getRepoStateMock: vi.fn(),
    resendInviteMock: vi.fn(),
    onAuthChangeMock: vi.fn(),
    ApiErrorClass: ApiError,
    ipcHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    setUserServerUrlMock: vi.fn(),
    resolveServerConfigMock: vi.fn(() => ({ url: 'https://new.example', source: 'user' })),
    resetServerCompatMock: vi.fn(),
    isCliAliasInstalledMock: vi.fn(() => false),
    getValidTokensMock: vi.fn(async () => null as { serverUrl?: string; email?: string; userId?: string } | null),
    setServerApiUrlMock: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '1.1.0' },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock('./auth-manager.js', () => ({
  onAuthChange: onAuthChangeMock,
  getValidTokens: getValidTokensMock,
  startLogin: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('./server-api.js', () => ({
  ApiError: ApiErrorClass,
  getRepoState: getRepoStateMock,
  resendInvite: resendInviteMock,
  setServerUrl: setServerApiUrlMock,
  getServerMeta: vi.fn(async () => ({})),
}));

vi.mock('./config-manager.js', () => ({
  getCurrentConfig: vi.fn(() => null),
  getConfigDir: vi.fn(() => null),
}));

// Real server-url would persist a settings file under the developer's Coredoc
// home; real version-compat/cli-alias pull in electron and the filesystem.
vi.mock('./server-url.js', () => ({
  resolveServerConfig: resolveServerConfigMock,
  setUserServerUrl: setUserServerUrlMock,
}));

vi.mock('./version-compat.js', () => ({
  getServerCompat: vi.fn(async () => null),
  refreshServerCompat: vi.fn(async () => null),
  resetServerCompat: resetServerCompatMock,
}));

vi.mock('./cli-alias-manager.js', () => ({ isCliAliasInstalled: isCliAliasInstalledMock }));

vi.mock('./parser-artifact.js', () => ({ hasParserArtifact: vi.fn(() => false) }));
vi.mock('@coredoc/cli/parser-remote', () => ({ pushParserToServer: vi.fn() }));
vi.mock('@coredoc/db', () => ({ stripSourceCode: vi.fn() }));

async function registered() {
  ipcHandlers.clear();
  const { registerWorkspaceHandlers } = await import('./workspace-manager.js');
  registerWorkspaceHandlers();
  return ipcHandlers;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  getValidTokensMock.mockResolvedValue(null);
  // clearAllMocks keeps implementations, so restore the defaults the server-url
  // seam tests below replace.
  resolveServerConfigMock.mockImplementation(() => ({ url: 'https://new.example', source: 'user' }));
  setServerApiUrlMock.mockImplementation(() => undefined);
});

describe('workspace:getAuthStatus', () => {
  it('pins the session server from the restored credentials', async () => {
    getValidTokensMock.mockResolvedValue({ serverUrl: 'https://server-a.example', email: 'a@b.co', userId: 'u1' });
    const handlers = await registered();

    await expect(handlers.get('workspace:getAuthStatus')?.({})).resolves.toEqual({
      isLoggedIn: true,
      email: 'a@b.co',
      userId: 'u1',
    });
    expect(setServerApiUrlMock).toHaveBeenCalledWith('https://server-a.example');
  });

  it('reports logged out and pins nothing when the credential store refuses the stored session', async () => {
    // auth-manager returns null when a managed config re-pointed this install:
    // pinning the old server here would undo that and address the wrong host.
    getValidTokensMock.mockResolvedValue(null);
    const handlers = await registered();

    await expect(handlers.get('workspace:getAuthStatus')?.({})).resolves.toEqual({
      isLoggedIn: false,
      email: null,
      userId: null,
    });
    expect(setServerApiUrlMock).not.toHaveBeenCalled();
  });

  it('invalidates the cached compat verdict when restoration moves the resolved server', async () => {
    // Model the real override: applying the token's URL changes what the chain
    // resolves to, so an in-flight handshake would report the previous server.
    let resolved = 'https://server-b.example';
    resolveServerConfigMock.mockImplementation(() => ({ url: resolved, source: 'user' }));
    setServerApiUrlMock.mockImplementation((url: string) => {
      resolved = url;
    });
    getValidTokensMock.mockResolvedValue({ serverUrl: 'https://server-a.example', email: 'a@b.co', userId: 'u1' });
    const handlers = await registered();

    await handlers.get('workspace:getAuthStatus')?.({});

    expect(resetServerCompatMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached compat verdict when restoration resolves to the same server', async () => {
    resolveServerConfigMock.mockImplementation(() => ({ url: 'https://server-a.example/', source: 'user' }));
    getValidTokensMock.mockResolvedValue({ serverUrl: 'https://server-a.example', email: 'a@b.co', userId: 'u1' });
    const handlers = await registered();

    await handlers.get('workspace:getAuthStatus')?.({});

    expect(resetServerCompatMock).not.toHaveBeenCalled();
  });
});

describe('workspace:getRepoState', () => {
  it('returns the repo state when the server has one', async () => {
    const state = { lastPushedAt: '2026-08-01T00:00:00.000Z', nodeCount: 10, edgeCount: 5 };
    getRepoStateMock.mockResolvedValue(state);
    const handlers = await registered();

    const result = await handlers.get('workspace:getRepoState')?.({}, 'ws-1', 'repo-a');

    expect(result).toEqual(state);
    expect(getRepoStateMock).toHaveBeenCalledWith('ws-1', 'repo-a');
  });

  it('returns null on 404 so the renderer can treat the repo as never pushed', async () => {
    getRepoStateMock.mockRejectedValue(new ApiErrorClass(404, 'Repo "repo-b" not found'));
    const handlers = await registered();

    const result = await handlers.get('workspace:getRepoState')?.({}, 'ws-1', 'repo-b');

    expect(result).toBeNull();
  });

  it('rethrows non-404 errors instead of masking them as "no state"', async () => {
    getRepoStateMock.mockRejectedValue(new ApiErrorClass(500, 'boom'));
    const handlers = await registered();

    await expect(handlers.get('workspace:getRepoState')?.({}, 'ws-1', 'repo-c')).rejects.toThrow('boom');
  });
});

describe('workspace:setServerUrl', () => {
  it('invalidates the cached compat verdict so the banner cannot describe the old server', async () => {
    const handlers = await registered();

    await handlers.get('workspace:setServerUrl')?.({}, 'https://new.example');

    expect(setUserServerUrlMock).toHaveBeenCalledWith('https://new.example');
    expect(resetServerCompatMock).toHaveBeenCalledTimes(1);
  });

  it('flags the installed CLI launcher as stale (it baked in the old server URL)', async () => {
    isCliAliasInstalledMock.mockReturnValue(true);
    const handlers = await registered();

    await expect(handlers.get('workspace:setServerUrl')?.({}, 'https://new.example')).resolves.toEqual({
      url: 'https://new.example',
      source: 'user',
      requiresCliReinstall: true,
    });
  });

  it('does not flag a reinstall when no launcher is installed', async () => {
    isCliAliasInstalledMock.mockReturnValue(false);
    const handlers = await registered();

    await expect(handlers.get('workspace:setServerUrl')?.({}, 'https://new.example')).resolves.toMatchObject({
      requiresCliReinstall: false,
    });
  });

  it('rejects a URL the shared normalizer refuses, before touching anything', async () => {
    const handlers = await registered();

    await expect(handlers.get('workspace:setServerUrl')?.({}, 'ftp://corp.example')).rejects.toThrow(/http/);
    expect(setUserServerUrlMock).not.toHaveBeenCalled();
    expect(resetServerCompatMock).not.toHaveBeenCalled();
  });
});

describe('workspace:resendInvite', () => {
  it('forwards the workspace and invitation ids to the server API', async () => {
    resendInviteMock.mockResolvedValue({ resent: true });
    const handlers = await registered();

    await expect(handlers.get('workspace:resendInvite')?.({}, 'ws-1', 'invite-1')).resolves.toEqual({ resent: true });
    expect(resendInviteMock).toHaveBeenCalledWith('ws-1', 'invite-1');
  });
});

describe('batch publication error classification', () => {
  it('detects job_still_running only from the structured code, never from free text', async () => {
    const { structuredErrorCode } = await import('./workspace-manager.js');
    // Structured body embedded in the API error message → pending.
    expect(
      structuredErrorCode(new Error('API 504: {"code":"job_still_running","jobId":"job-9","statusCode":504}')),
    ).toBe('job_still_running');
    // A plain 504 (gateway timeout, proxy error) must NOT read as pending —
    // misfiling it would report a failed publication as still-in-progress.
    expect(structuredErrorCode(new Error('API 504: Gateway Timeout'))).toBeNull();
    expect(structuredErrorCode(new Error('publication failed: still running cleanup'))).toBeNull();
  });

  it('recovers the jobId for the publishing state', async () => {
    const { structuredJobId } = await import('./workspace-manager.js');
    expect(structuredJobId(new Error('API 504: {"code":"job_still_running","jobId":"job-9"}'))).toBe('job-9');
    expect(structuredJobId(new Error('API 500: broken'))).toBeNull();
  });
});
