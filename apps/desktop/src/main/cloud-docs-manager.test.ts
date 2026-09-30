import { describe, it, expect, vi, afterEach } from 'vitest';

// cloud-docs-manager pulls in electron/auth-manager/server-api/runtime-paths/linked-repos
// at import time; the E2E guard fires before any of them are touched, so stub them minimally.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/userData') },
}));
const { getValidTokensMock, getMcpConfigMock, queryMock } = vi.hoisted(() => ({
  getValidTokensMock: vi.fn(),
  getMcpConfigMock: vi.fn(),
  queryMock: vi.fn(),
}));
vi.mock('./auth-manager.js', () => ({ getValidTokens: getValidTokensMock }));
vi.mock('./server-api.js', () => ({ getMcpConfig: getMcpConfigMock }));
vi.mock('./runtime-paths.js', () => ({
  getNodeExec: vi.fn(() => ({ execPath: '/usr/bin/node', env: {} })),
  getClaudeCodeCliPath: vi.fn(() => null),
}));
vi.mock('./linked-repos-manager.js', () => ({ getLinkedRepos: vi.fn(() => []) }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { runCloudDocsCommand } from './cloud-docs-manager.js';

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() },
} as unknown as import('electron').BrowserWindow;

const options = {
  command: 'cloud-docs',
  repo: 'repo-1',
  args: { workspaceId: 'ws-1', promptName: 'architecture' },
} as unknown as import('../shared/ipc-types.js').CommandRunOptions;

describe('cloud-docs-manager E2E guard', () => {
  afterEach(() => {
    delete process.env.COREDOC_DESKTOP_E2E;
    queryMock.mockClear();
    getValidTokensMock.mockReset();
    getMcpConfigMock.mockReset();
  });

  it('throws before starting the SDK session when COREDOC_DESKTOP_E2E=1', async () => {
    process.env.COREDOC_DESKTOP_E2E = '1';

    await expect(runCloudDocsCommand(options, 'cmd-1', fakeWindow)).rejects.toThrow(/E2E mode/);

    expect(queryMock).not.toHaveBeenCalled();
    expect(getValidTokensMock).not.toHaveBeenCalled();
  });

  it('proceeds into the normal auth path without the flag', async () => {
    getValidTokensMock.mockResolvedValue(null);

    await expect(runCloudDocsCommand(options, 'cmd-2', fakeWindow)).rejects.toThrow(/Not authenticated/);

    expect(getValidTokensMock).toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
