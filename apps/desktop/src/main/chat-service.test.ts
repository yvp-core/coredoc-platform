import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

// chat-service pulls in electron/config-manager/runtime-paths/auth-manager/server-api at import
// time; the E2E guard fires before any of them are touched, so stub them minimally.
vi.mock('./config-manager.js', () => ({
  getCurrentConfig: vi.fn(),
  getCurrentConfigPath: vi.fn(),
  resolveRepoPath: vi.fn(),
  resolveProjectPath: vi.fn(),
  getProjectRepos: vi.fn(),
}));
vi.mock('./runtime-paths.js', () => ({
  requireProjectRoot: vi.fn(() => '/root'),
  getNodeExec: vi.fn(() => ({ execPath: '/usr/bin/node', env: {} })),
  getMcpServerPath: vi.fn(() => '/mcp/index.js'),
  getClaudeCodeCliPath: vi.fn(() => '/bundled/claude'),
  getCodexCliPath: vi.fn(() => '/bundled/codex'),
  getEnvPath: vi.fn(() => '/workspace/.env'),
}));
vi.mock('./auth-manager.js', () => ({ getValidTokens: vi.fn() }));
vi.mock('./server-api.js', () => ({ getMcpConfig: vi.fn() }));
vi.mock('./linked-repos-manager.js', () => ({ getLinkedRepos: vi.fn() }));

const { harnessSettings, buildHarnessEnvironmentMock, codexRunMock } = vi.hoisted(() => ({
  harnessSettings: { provider: 'claude-code' as 'claude-code' | 'codex', authMode: 'subscription', credentials: {} },
  buildHarnessEnvironmentMock: vi.fn((_env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ PATH: '/usr/bin' })),
  codexRunMock: vi.fn(),
}));
vi.mock('./harness-settings.js', () => ({
  readHarnessSettings: vi.fn(() => ({ ...harnessSettings })),
  buildHarnessEnvironment: buildHarnessEnvironmentMock,
}));
vi.mock('./codex-app-server.js', () => ({
  CodexAppServerClient: class {
    constructor(readonly executablePath: string) {}
    run = codexRunMock;
  },
}));

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { sendMessage } from './chat-service.js';
import { getValidTokens } from './auth-manager.js';
import { getCurrentConfig, getCurrentConfigPath, getProjectRepos, resolveRepoPath } from './config-manager.js';
import { getLinkedRepos } from './linked-repos-manager.js';
import * as serverApi from './server-api.js';

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() },
} as unknown as import('electron').BrowserWindow;

const fixtures: string[] = [];

describe('chat-service E2E guard', () => {
  afterEach(() => {
    delete process.env.COREDOC_DESKTOP_E2E;
    queryMock.mockClear();
    codexRunMock.mockReset();
    buildHarnessEnvironmentMock.mockClear();
    harnessSettings.provider = 'claude-code';
    harnessSettings.authMode = 'subscription';
    harnessSettings.credentials = {};
    vi.mocked(getValidTokens).mockReset();
    vi.mocked(getLinkedRepos).mockReset();
    vi.mocked(serverApi.getMcpConfig).mockReset();
    vi.mocked(fakeWindow.webContents.send).mockClear();
    for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  });

  it('throws before starting the SDK session when COREDOC_DESKTOP_E2E=1 (local mode)', async () => {
    process.env.COREDOC_DESKTOP_E2E = '1';
    await expect(sendMessage('hello', { project: 'proj1' }, fakeWindow)).rejects.toThrow(/E2E mode/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('throws before starting the SDK session when COREDOC_DESKTOP_E2E=1 (cloud member mode)', async () => {
    process.env.COREDOC_DESKTOP_E2E = '1';
    await expect(sendMessage('hello', { cloudMember: true, workspaceId: 'ws-1' }, fakeWindow)).rejects.toThrow(
      /E2E mode/,
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('runs local chat through Codex with read-only project-scoped MCP config and maps stream events', async () => {
    harnessSettings.provider = 'codex';
    harnessSettings.authMode = 'api-token';
    harnessSettings.credentials = { codex: 'stored-token' };
    buildHarnessEnvironmentMock.mockReturnValueOnce({ PATH: '/usr/bin', CODEX_API_KEY: 'stored-token' });
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [{ id: 'proj1' }] } as never);
    vi.mocked(getCurrentConfigPath).mockReturnValue('/workspace/coredoc.config.json');
    vi.mocked(getProjectRepos).mockReturnValue([{ name: 'repo1' }] as never);
    vi.mocked(resolveRepoPath).mockReturnValue('/repo');
    codexRunMock.mockImplementationOnce(async (options) => {
      options.onNotification({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
      options.onNotification({
        method: 'item/started',
        params: {
          item: { id: 'tool-1', type: 'mcpToolCall', server: 'coredoc', tool: 'describe_repository', arguments: {} },
        },
      });
      options.onNotification({
        method: 'item/completed',
        params: {
          item: {
            id: 'tool-1',
            type: 'mcpToolCall',
            server: 'coredoc',
            tool: 'describe_repository',
            arguments: {},
            status: 'completed',
            result: { content: [{ type: 'text', text: 'repo result' }] },
          },
        },
      });
      return { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' };
    });

    await sendMessage('hello', { project: 'proj1', repo: 'repo1', cwd: '/renderer-controlled' }, fakeWindow);

    expect(queryMock).not.toHaveBeenCalled();
    expect(codexRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo',
        env: { PATH: '/bundled:/usr/bin', CODEX_API_KEY: 'stored-token' },
        permissionProfile: 'coredoc-chat',
        runtimeWorkspaceRoots: ['/repo'],
        config: expect.objectContaining({
          mcp_servers: {
            coredoc: expect.objectContaining({
              command: '/usr/bin/node',
              args: ['/mcp/index.js'],
              required: true,
              default_tools_approval_mode: 'approve',
            }),
          },
        }),
      }),
    );
    const sends = vi.mocked(fakeWindow.webContents.send).mock.calls;
    expect(sends.some(([channel, data]) => channel === 'chat:stream:delta' && data.delta === 'Hello')).toBe(true);
    expect(
      sends.some(
        ([channel, data]) =>
          channel === 'chat:stream:tool' && data.toolCall.name === 'mcp__coredoc__describe_repository',
      ),
    ).toBe(true);
    expect(sends.some(([channel, data]) => channel === 'chat:stream:end' && data.success === true)).toBe(true);
  });

  it('keeps Claude chat inside the resolved repo and denies credential-reading tools', async () => {
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [{ id: 'proj1' }] } as never);
    vi.mocked(getCurrentConfigPath).mockReturnValue('/workspace/coredoc.config.json');
    vi.mocked(getProjectRepos).mockReturnValue([{ name: 'repo1' }] as never);
    vi.mocked(resolveRepoPath).mockReturnValue('/repo');
    const decisions: Record<string, unknown> = {};
    let sdkOptions: Record<string, unknown> | undefined;
    queryMock.mockImplementationOnce(({ options }) => {
      sdkOptions = options;
      return (async function* () {
        const canUseTool = options.canUseTool as (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
        decisions.source = await canUseTool('Read', { file_path: '/repo/src/index.ts' });
        decisions.env = await canUseTool('Read', { file_path: '/repo/.env' });
        decisions.outside = await canUseTool('Read', { file_path: '/outside/secret' });
        decisions.grep = await canUseTool('Grep', { pattern: '.*', path: '/repo' });
        decisions.bash = await canUseTool('Bash', { command: 'cat .env' });
        yield { type: 'result', subtype: 'success' };
      })();
    });

    await sendMessage('hello', { project: 'proj1', repo: 'repo1' }, fakeWindow);

    expect(sdkOptions).toMatchObject({
      cwd: '/repo',
      allowedTools: ['mcp__coredoc__*'],
      settingSources: [],
      strictMcpConfig: true,
    });
    expect(decisions.source).toMatchObject({ behavior: 'allow' });
    expect(decisions.env).toMatchObject({ behavior: 'deny' });
    expect(decisions.outside).toMatchObject({ behavior: 'deny' });
    expect(decisions.grep).toMatchObject({ behavior: 'deny' });
    expect(decisions.bash).toMatchObject({ behavior: 'deny' });
  });

  it('denies Claude chat reads through an in-repo symlink to a host file', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'coredoc-chat-policy-'));
    fixtures.push(fixture);
    const repo = path.join(fixture, 'repo');
    const secret = path.join(fixture, 'workspace.env');
    mkdirSync(repo);
    writeFileSync(secret, 'ANTHROPIC_API_KEY=secret');
    symlinkSync(secret, path.join(repo, 'safe-looking.txt'));
    vi.mocked(getCurrentConfig).mockReturnValue({ projects: [{ id: 'proj1' }] } as never);
    vi.mocked(getCurrentConfigPath).mockReturnValue('/workspace/coredoc.config.json');
    vi.mocked(getProjectRepos).mockReturnValue([{ name: 'repo1' }] as never);
    vi.mocked(resolveRepoPath).mockReturnValue(repo);
    let decision: unknown;
    queryMock.mockImplementationOnce(({ options }) =>
      (async function* () {
        const canUseTool = options.canUseTool as (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
        decision = await canUseTool('Read', { file_path: path.join(repo, 'safe-looking.txt') });
        yield { type: 'result', subtype: 'success' };
      })(),
    );

    await sendMessage('hello', { project: 'proj1', repo: 'repo1' }, fakeWindow);

    expect(decision).toMatchObject({ behavior: 'deny' });
  });

  it('runs cloud chat through Codex with bearer auth scoped to the MCP host', async () => {
    harnessSettings.provider = 'codex';
    vi.mocked(getValidTokens).mockResolvedValue({ accessToken: 'cloud-token' } as never);
    vi.mocked(serverApi.getMcpConfig).mockResolvedValue({
      mcpServers: { coredoc: { url: 'https://mcp.example.com/api' } },
    } as never);
    vi.mocked(getLinkedRepos).mockReturnValue([{ workspaceId: 'ws-1', repoName: 'repo1', localPath: '/linked/repo' }]);
    codexRunMock.mockResolvedValueOnce({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed' });

    await sendMessage(
      'hello',
      {
        cloudMember: true,
        workspaceId: 'ws-1',
        repo: 'repo1',
        linkedRepoPaths: { repo1: '/renderer-controlled' },
        cloudRepoNames: ['repo1'],
      },
      fakeWindow,
    );

    expect(codexRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/linked/repo',
        runtimeWorkspaceRoots: ['/linked/repo'],
        config: expect.objectContaining({
          permissions: {
            'coredoc-chat': expect.objectContaining({
              network: { enabled: true, domains: { 'mcp.example.com': 'allow' } },
            }),
          },
          mcp_servers: {
            coredoc_cloud: {
              url: 'https://mcp.example.com/api',
              http_headers: { Authorization: 'Bearer cloud-token' },
              required: true,
              default_tools_approval_mode: 'approve',
            },
          },
        }),
      }),
    );
  });
});
