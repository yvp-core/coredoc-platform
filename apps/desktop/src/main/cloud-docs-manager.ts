/**
 * Cloud Docs Manager
 *
 * Runs cloud documentation generation via the Claude Agent SDK with a cloud MCP server.
 * Called from command-runner.ts — emits PTY_DATA and COMMAND_COMPLETED events
 * through the same flow as every other command.
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { IpcChannels, CommandRunOptions } from '../shared/ipc-types.js';
import { getValidTokens } from './auth-manager.js';
import * as serverApi from './server-api.js';
import { getNodeExec, getClaudeCodeCliPath } from './runtime-paths.js';
import { getLinkedRepos } from './linked-repos-manager.js';
import { isE2EMode } from './e2e-mode.js';

type SDKModule = typeof import('@anthropic-ai/claude-agent-sdk');
let _sdkModule: SDKModule | null = null;
async function getSDK(): Promise<SDKModule> {
  if (!_sdkModule) _sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  return _sdkModule;
}

function getCloudDocsDir(workspaceId: string, repoName: string): string {
  return path.join(app.getPath('userData'), 'cloud-docs', workspaceId, `${repoName}-docs`, 'analysis');
}

async function getCloudMcpUrl(workspaceId: string): Promise<string> {
  const config = await serverApi.getMcpConfig(workspaceId);
  const mcpServers = config.mcpServers as { coredoc?: { url?: string } } | undefined;
  return mcpServers?.coredoc?.url || '';
}

function safeSend(mainWindow: BrowserWindow, channel: string, data: unknown): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function sendPty(mainWindow: BrowserWindow, id: string, text: string): void {
  safeSend(mainWindow, IpcChannels.PTY_DATA, { id, data: text });
}

/**
 * Run cloud docs generation — called from command-runner.ts.
 * Emits PTY_DATA for terminal output and COMMAND_COMPLETED when done.
 */
export async function runCloudDocsCommand(
  options: CommandRunOptions,
  id: string,
  mainWindow: BrowserWindow,
): Promise<void> {
  if (isE2EMode(process.env)) {
    throw new Error(
      'runCloudDocsCommand (cloud docs) is blocked in E2E mode (COREDOC_DESKTOP_E2E=1) — no cloud docs SDK session may start.',
    );
  }

  const repoName = options.repo ?? '';
  const workspaceId = options.args?.workspaceId as string;
  const promptName = (options.args?.promptName ?? options.args?.prompt ?? 'all') as string;

  sendPty(mainWindow, id, `Generating "${promptName}" documentation for ${repoName}...\r\n`);

  // Resolve auth
  const tokens = await getValidTokens();
  if (!tokens) {
    throw new Error('Not authenticated — please log in');
  }

  // Resolve cloud MCP
  const mcpUrl = await getCloudMcpUrl(workspaceId);
  if (!mcpUrl) {
    throw new Error('Failed to resolve cloud MCP URL');
  }

  sendPty(mainWindow, id, `Connecting to cloud MCP: ${mcpUrl}\r\n`);

  const { execPath: nodeExecPath, env: nodeEnv } = getNodeExec();
  const claudeCliPath = getClaudeCodeCliPath();

  // Check for linked repo
  const linkedRepos = getLinkedRepos(workspaceId);
  const linked = linkedRepos.find((r) => r.repoName === repoName);

  const allowedTools = linked ? ['Read', 'Glob', 'Grep', 'Bash', 'mcp__coredoc_cloud__*'] : ['mcp__coredoc_cloud__*'];

  const systemPrompt = `You are a documentation generator for the "${repoName}" codebase.
Use MCP tools to analyze the codebase and generate comprehensive documentation.
${linked ? `Local files available at: ${linked.localPath}` : ''}

Generate a detailed markdown document about: ${promptName}
Focus on architecture, key patterns, and important implementation details.
Use scope="${repoName}" for all MCP tool calls.`;

  const { query } = await getSDK();
  let result = '';
  let mcpConnected = false;

  for await (const message of query({
    prompt: `Generate documentation for "${promptName}" in the ${repoName} repository.`,
    options: {
      allowedTools,
      ...(linked && { cwd: linked.localPath }),
      systemPrompt,
      env: nodeEnv,
      executable: nodeExecPath as unknown as 'node',
      ...(claudeCliPath && { pathToClaudeCodeExecutable: claudeCliPath }),
      stderr: (data: string) => {
        if (data.trim()) sendPty(mainWindow, id, data.trim() + '\r\n');
      },
      mcpServers: {
        coredoc_cloud: {
          type: 'http' as const,
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
          },
        },
      },
    },
  })) {
    if (mainWindow.isDestroyed()) break;

    // Detect MCP connection status
    if (message.type === 'system') {
      const sysMsg = message as {
        subtype?: string;
        mcp_servers?: { name: string; status: string; error?: string }[];
      };
      if (sysMsg.subtype === 'init' && sysMsg.mcp_servers) {
        const coredocStatus = sysMsg.mcp_servers.find((s) => s.name === 'coredoc_cloud');
        if (coredocStatus?.status === 'connected') {
          mcpConnected = true;
          sendPty(mainWindow, id, 'MCP connected. Generating documentation...\r\n\r\n');
        } else {
          throw new Error(
            `MCP connection failed: ${coredocStatus?.status || 'unknown'}${coredocStatus?.error ? ' - ' + coredocStatus.error : ''}`,
          );
        }
      }
      continue;
    }

    if (message.type === 'assistant') {
      const blocks = message.message?.content || [];
      for (const block of blocks) {
        if (block.type === 'text') {
          result += block.text;
          sendPty(mainWindow, id, block.text.replace(/\n/g, '\r\n'));
        } else if (block.type === 'tool_use') {
          sendPty(mainWindow, id, `\r\n[Tool] ${block.name}\r\n`);
        }
      }
    }

    if (message.type === 'result' && message.subtype === 'success') {
      const content = (message as { result?: unknown }).result;
      if (typeof content === 'string') {
        result = content;
      }
    }
  }

  if (!mcpConnected) {
    throw new Error('MCP server never connected');
  }

  // Save output
  const outputDir = getCloudDocsDir(workspaceId, repoName);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${promptName}.md`);
  fs.writeFileSync(outputPath, result, 'utf-8');

  sendPty(mainWindow, id, `\r\n\r\nDocumentation saved.\r\n`);

  // Clean up running-command metadata tracked by command-runner
  const { clearCommandMeta } = await import('./command-runner.js');
  clearCommandMeta(id);

  safeSend(mainWindow, IpcChannels.COMMAND_COMPLETED, { id, success: true, exitCode: 0 });
}
