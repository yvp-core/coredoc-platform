import { beforeEach, describe, expect, it, vi } from 'vitest';

const configState = vi.hoisted(() => ({
  current: {
    projects: [{ id: 'project-a', name: 'Project A', repos: [{ name: 'api', path: 'api' }] }],
  } as { projects: Array<{ id: string; name: string; repos: Array<{ name: string; path: string }> }> } | null,
}));
const mockResolveRepoPath = vi.hoisted(() => vi.fn(() => '/workspace/api'));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  IpcMain: class {},
}));

vi.mock('./config-manager.js', () => ({
  getCurrentConfig: () => configState.current,
  getCurrentConfigPath: () => '/workspace/coredoc.config.json',
  getProjectRepos: (projectId: string) =>
    configState.current?.projects.find((project) => project.id === projectId)?.repos ?? [],
  resolveRepoPath: mockResolveRepoPath,
  resolveProjectPath: () => '/workspace/api',
}));

vi.mock('./runtime-paths.js', () => ({
  requireProjectRoot: () => '/workspace',
  getNodeExec: () => ({ execPath: '/usr/bin/node', env: {} }),
  getExternalNodeExec: () => ({ execPath: '/usr/bin/node', env: {} }),
  getMcpServerPath: () => '/workspace/packages/mcp/dist/index.js',
  getClaudeCodeCliPath: () => undefined,
  getConfigPath: () => '/workspace/coredoc.config.json',
}));

vi.mock('./auth-manager.js', () => ({ getValidTokens: vi.fn() }));
vi.mock('./server-api.js', () => ({ getMcpConfig: vi.fn() }));

import { buildSystemPrompt, sendMessage } from './chat-service.js';
import { getMcpInfo } from './mcp-bridge.js';

describe('local MCP scope binding', () => {
  beforeEach(() => {
    configState.current = {
      projects: [{ id: 'project-a', name: 'Project A', repos: [{ name: 'api', path: 'api' }] }],
    };
    mockResolveRepoPath.mockClear();
  });

  it('tells repo-level chat to pass the repo scope explicitly', () => {
    const prompt = buildSystemPrompt({
      project: 'project-a',
      repo: 'api',
      repoPath: '/workspace/api',
    });

    expect(prompt).toContain('pass scope="api"');
    expect(prompt).not.toContain('do NOT pass a scope param');
  });

  it('rejects a repo that is not owned by the selected project', async () => {
    await expect(
      sendMessage('Explain this repository', { project: 'project-a', repo: 'other' }, {} as never),
    ).rejects.toThrow('Repository "other" does not belong to project "project-a"');
    expect(mockResolveRepoPath).not.toHaveBeenCalled();
  });

  it('hands external MCP clients the backend this app session resolved', () => {
    const previous = process.env.COREDOC_DB_BACKEND;
    try {
      process.env.COREDOC_DB_BACKEND = 'ladybug';
      const ladybug = getMcpInfo('project-a');
      expect(ladybug.success && ladybug.env?.COREDOC_DB_BACKEND).toBe('ladybug');

      // Rollback env must travel too, or the client would read a different graph.
      process.env.COREDOC_DB_BACKEND = 'sqlite';
      const sqlite = getMcpInfo('project-a');
      expect(sqlite.success && sqlite.env?.COREDOC_DB_BACKEND).toBe('sqlite');

      delete process.env.COREDOC_DB_BACKEND;
      const unset = getMcpInfo('project-a');
      expect(unset.success && unset.env?.COREDOC_DB_BACKEND).toBe('ladybug');
    } finally {
      if (previous === undefined) delete process.env.COREDOC_DB_BACKEND;
      else process.env.COREDOC_DB_BACKEND = previous;
    }
  });

  it('refuses to generate MCP config for a duplicated project id', () => {
    configState.current = {
      projects: [
        { id: 'project-a', name: 'First', repos: [{ name: 'api', path: 'api' }] },
        { id: 'project-a', name: 'Second', repos: [{ name: 'web', path: 'web' }] },
      ],
    };

    expect(getMcpInfo('project-a')).toEqual({
      success: false,
      error: 'Project id "project-a" is duplicated in the loaded config.',
    });
  });
});
