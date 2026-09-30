import { describe, expect, it } from 'vitest';
import type { McpInfoResult } from '../../shared/ipc-types';
import type { CopilotTab } from './McpConfigView';
import { buildConfigJson } from './McpConfigView';

const CLIENT_TABS: CopilotTab[] = ['claude-code', 'cursor', 'claude', 'chatgpt'];

describe('buildConfigJson', () => {
  it.each(CLIENT_TABS)('%s preserves the exact project-bound MCP environment', () => {
    const info: McpInfoResult = {
      success: true,
      command: '/usr/bin/node',
      args: ['/workspace/packages/mcp/dist/index.js'],
      env: {
        COREDOC_DB_BACKEND: 'sqlite',
        MCP_CONFIG_PATH: '/workspace/coredoc.config.json',
        COREDOC_SCOPE: 'project:project-id',
      },
    };

    const config = JSON.parse(buildConfigJson(info) ?? '{}');

    expect(config.mcpServers.coredoc.env).toEqual(info.env);
    expect(config.mcpServers.coredoc.env.COREDOC_SCOPE).toBe('project:project-id');
    expect(config.mcpServers.coredoc.env.COREDOC_SCOPE).not.toBe('auto');
    expect(JSON.stringify(config)).not.toContain('Project Display Name');
  });

  it('rejects incomplete bridge responses', () => {
    expect(buildConfigJson({ success: false, error: 'not configured' })).toBeNull();
  });
});
