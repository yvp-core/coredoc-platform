/**
 * Chat Service - Claude Agent SDK integration with MCP tools
 *
 * Uses the Claude Agent SDK with subscription auth (no API key needed)
 * and connects to coredoc MCP server for codebase analysis tools.
 */

import { IpcMain, BrowserWindow } from 'electron';
// Dynamic import — the SDK is ESM-only (sdk.mjs) and can't be require()'d.
// CJS bundles must use await import() to load ESM modules.
type SDKModule = typeof import('@anthropic-ai/claude-agent-sdk');
let _sdkModule: SDKModule | null = null;
async function getSDK(): Promise<SDKModule> {
  if (!_sdkModule) _sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  return _sdkModule;
}
import type { PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import * as path from 'path';
import { IpcChannels } from '../shared/ipc-types.js';
import {
  getCurrentConfig,
  getCurrentConfigPath,
  resolveRepoPath,
  resolveProjectPath,
  getProjectRepos,
} from './config-manager.js';
import type { ChatContext } from '../shared/ipc-types.js';
import {
  requireProjectRoot,
  getNodeExec,
  getMcpServerPath as runtimeGetMcpServerPath,
  getClaudeCodeCliPath,
  getCodexCliPath,
  getEnvPath as runtimeGetEnvPath,
} from './runtime-paths.js';
import { getValidTokens } from './auth-manager.js';
import { isE2EMode } from './e2e-mode.js';
import * as serverApi from './server-api.js';
import { buildHarnessEnvironment, readHarnessSettings } from './harness-settings.js';
import type { HarnessProvider } from '../shared/ipc-types.js';
import { CodexAppServerClient, type CodexAppServerMessage } from './codex-app-server.js';
import { getLinkedRepos } from './linked-repos-manager.js';
import { buildSystemCodexEnvironment } from './codex-runtime.js';
import { canonicalPath, isCanonicalInside } from './canonical-path.js';

// Track active query for cancellation
let activeAbortController: AbortController | null = null;

export interface ChatHarness {
  provider: HarnessProvider;
  env: NodeJS.ProcessEnv;
  mcpEnv: NodeJS.ProcessEnv;
  nodeExecPath: string;
  claudeCliPath?: string;
  codexCliPath?: string;
}

function isEnvFile(target: string): boolean {
  return target.split(/[\\/]/).some((segment) => segment === '.env' || segment.startsWith('.env.'));
}

function buildClaudeChatPermission(readDirs: string[]) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    context: { blockedPath?: string } = {},
  ): Promise<PermissionResult> => {
    if (context.blockedPath) {
      return {
        behavior: 'deny',
        message: 'The Claude sandbox blocked a path outside the linked repository.',
      };
    }
    if (toolName === 'Read' || toolName === 'Glob') {
      const pattern = toolName === 'Glob' && typeof input.pattern === 'string' ? input.pattern : undefined;
      if (pattern && (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..'))) {
        return {
          behavior: 'deny',
          message: 'Coredoc chat glob patterns must stay relative to the linked repository.',
        };
      }
      const raw = toolName === 'Read' ? input.file_path : (input.path ?? '.');
      const target =
        typeof raw === 'string' ? (path.isAbsolute(raw) ? raw : path.resolve(readDirs[0] ?? '', raw)) : undefined;
      const canonicalTarget = target ? canonicalPath(target) : null;
      if (
        !canonicalTarget ||
        !readDirs.some((readDir) => isCanonicalInside(readDir, canonicalTarget)) ||
        isEnvFile(canonicalTarget)
      ) {
        return {
          behavior: 'deny',
          message: 'Coredoc chat may read only non-credential files inside the linked repository.',
        };
      }
      return { behavior: 'allow', updatedInput: input };
    }

    // Grep can read every matching file and Bash can bypass path checks through shell expansion.
    return {
      behavior: 'deny',
      message: `The ${toolName} tool is not available in this read-only Coredoc chat session.`,
    };
  };
}

export function captureChatHarness(): ChatHarness {
  const { execPath: nodeExecPath, env: nodeEnv } = getNodeExec();
  const envPath = runtimeGetEnvPath() ?? path.join(requireProjectRoot(), '.env');
  const settings = readHarnessSettings(envPath);
  const env = buildHarnessEnvironment(nodeEnv, settings);
  const mcpEnv = buildHarnessEnvironment(nodeEnv, { ...settings, authMode: 'subscription' });
  if (settings.provider === 'codex') {
    const codexCliPath = getCodexCliPath();
    if (!codexCliPath) {
      throw new Error('Compatible system Codex CLI not found. Install or update Codex, then restart Coredoc.');
    }
    return {
      provider: settings.provider,
      env: buildSystemCodexEnvironment(env, codexCliPath),
      mcpEnv,
      nodeExecPath,
      codexCliPath,
    };
  }
  const claudeCliPath = getClaudeCodeCliPath();
  if (!claudeCliPath) throw new Error('Claude Code runtime not found in this build.');
  return { provider: settings.provider, env, mcpEnv, nodeExecPath, claudeCliPath };
}

/**
 * Safely send IPC message to renderer, checking if window is still valid
 */
function safeSend(mainWindow: BrowserWindow, channel: string, data: unknown): boolean {
  try {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      console.log(`[Chat] Window destroyed, skipping send to ${channel}`);
      return false;
    }
    mainWindow.webContents.send(channel, data);
    return true;
  } catch (error) {
    console.log(`[Chat] Error sending to ${channel}:`, error);
    return false;
  }
}

/**
 * Get the monorepo root directory (delegates to runtime-paths).
 */
function getRootDir(): string {
  return requireProjectRoot();
}

/**
 * Get path to MCP server (delegates to runtime-paths).
 */
function getMcpServerPath(): string {
  return runtimeGetMcpServerPath() ?? path.join(getRootDir(), 'packages', 'mcp', 'dist', 'index.js');
}

/**
 * Build system prompt with available tools
 */
export function buildSystemPrompt(context: {
  project?: string;
  repo?: string;
  repoPath?: string;
  projectRepos?: string[];
}): string {
  let contextSection = '';

  if (context.repo && context.repoPath) {
    const projectLine = context.project ? ` inside the "${context.project}" project` : '';
    contextSection = `You are working in the "${context.repo}" repository${projectLine} located at: ${context.repoPath}

IMPORTANT:
- For every MCP tool call (mcp__coredoc__*): pass scope="${context.repo}" to keep queries narrowed to this repository
- For file tools (Read, Glob, Grep, Bash): Commands execute in ${context.repoPath}`;
  } else if (context.project && context.projectRepos && context.projectRepos.length > 0) {
    // Project-level context - scopes to all repos in the group with narrowing support
    contextSection = `You are working in the "${context.project}" project which contains:
${context.projectRepos.map((r) => `- ${r}`).join('\n')}

## Scope Rules for MCP Tools:
- By default (no scope param): queries ALL repos in this project
- To narrow to a specific repo: use scope="${context.projectRepos[0]}" (use exact repo name)
- Valid scope values: ${context.projectRepos.join(', ')}
- Do NOT use file paths as scope - use repo names only

## File Tools:
Commands execute in: ${context.repoPath || 'project directory'}`;
  } else if (context.repo) {
    contextSection = `Focus on the "${context.repo}" repository. Use scope="${context.repo}" for MCP tools.`;
  }

  return `You are a code analysis assistant with access to coredoc MCP tools.
${contextSection}

## Available Tools

### File Tools (direct access)
- Read - Read source files
- Glob - Find files by pattern
- Grep - Search code with regex

### Coredoc MCP Tools (codebase analysis)
- mcp__coredoc__describe_repository - Start here. Codebase summary: language, framework, counts
- mcp__coredoc__describe_db_schema - Data model: tables/entities and their fields
- mcp__coredoc__search_symbols - Search for functions, classes, entrypoints by name
- mcp__coredoc__list_file_symbols - Outline everything declared in one file
- mcp__coredoc__list_entrypoints - List all entrypoints
- mcp__coredoc__get_extraction_coverage - How much of this repo was extracted (trust an empty result?)
- mcp__coredoc__explain - Deep-dive a function or entrypoint, with its call tree
- mcp__coredoc__find_callers - Find what calls a function
- mcp__coredoc__find_dependents - Find code depending on a class/interface
- mcp__coredoc__find_entity_usage - Find DB model readers/writers
- mcp__coredoc__analyze_change_impact - Analyze impact of changes
- mcp__coredoc__trace_cross_repo_call - Trace calls across service boundaries
- mcp__coredoc__list_service_dependencies - List external service calls

When answering questions about the codebase:
1. Use MCP tools for high-level analysis (explain, find_callers, etc.)
2. Use file tools (Read, Grep) to examine specific source code
3. Always provide file paths and line numbers when referencing code`;
}

/**
 * Build system prompt for cloud member mode
 */
function buildCloudMemberSystemPrompt(context: {
  repo?: string;
  cloudRepoNames?: string[];
  linkedPath?: string;
}): string {
  const repoList = context.cloudRepoNames?.map((r) => `- ${r}`).join('\n') || '- (none)';
  const fileToolsSection = context.linkedPath
    ? `### File Tools (available for linked repo "${context.repo}")
- Read - Read source files at ${context.linkedPath}
- Glob - Find files by pattern
- Grep - Search code with regex
- Bash - Execute shell commands

Use file tools to examine specific source code.`
    : `### File Tools
Not available — no repo is linked to a local folder. Use MCP tools only.`;

  return `You are a code analysis assistant connected to a shared team workspace via cloud MCP.

## Available repos:
${repoList}

## Tools

### MCP Tools (always available)
- mcp__coredoc_cloud__describe_repository - Codebase summary
- mcp__coredoc_cloud__describe_db_schema - Data model: tables/entities and their fields
- mcp__coredoc_cloud__search_symbols - Search functions, classes, entrypoints
- mcp__coredoc_cloud__list_file_symbols - Outline everything declared in one file
- mcp__coredoc_cloud__list_entrypoints - List all entrypoints
- mcp__coredoc_cloud__get_extraction_coverage - How much of this repo was extracted
- mcp__coredoc_cloud__explain - Deep-dive a function or entrypoint, with its call tree
- mcp__coredoc_cloud__find_callers - Find what calls a function
- mcp__coredoc_cloud__find_dependents - Find code depending on a class/interface
- mcp__coredoc_cloud__find_entity_usage - Find DB model readers/writers
- mcp__coredoc_cloud__analyze_change_impact - Analyze impact of changes
- mcp__coredoc_cloud__trace_cross_repo_call - Trace calls across services
- mcp__coredoc_cloud__list_service_dependencies - List external service calls

${fileToolsSection}

${context.repo ? `Focus on the "${context.repo}" repository. Use scope="${context.repo}" for MCP tools.` : 'Use MCP tools for high-level analysis across all repos.'}`;
}

/**
 * Get cloud MCP URL for a workspace
 */
async function getCloudMcpUrl(workspaceId: string): Promise<string> {
  const config = await serverApi.getMcpConfig(workspaceId);
  const mcpServers = config.mcpServers as { coredoc?: { url?: string } } | undefined;
  return mcpServers?.coredoc?.url || '';
}

const CODEX_CHAT_PROFILE = 'coredoc-chat';

function buildCodexChatConfig(options: {
  readDirs: string[];
  mcpServers: Record<string, Record<string, unknown>>;
  networkDomain?: string;
}): Record<string, unknown> {
  const filesystem: Record<string, 'read' | 'deny'> = { ':root': 'deny', ':minimal': 'read' };
  for (const readDir of options.readDirs) {
    filesystem[readDir] = 'read';
    for (const pattern of ['.env', '.env.*', '**/.env', '**/.env.*']) {
      filesystem[path.join(readDir, pattern)] = 'deny';
    }
  }
  return {
    project_doc_max_bytes: 0,
    web_search: 'disabled',
    permissions: {
      [CODEX_CHAT_PROFILE]: {
        filesystem,
        network: options.networkDomain
          ? { enabled: true, domains: { [options.networkDomain]: 'allow' } }
          : { enabled: false },
      },
    },
    mcp_servers: options.mcpServers,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Preserve the opaque value below.
    }
  }
  return { value };
}

function toolOutput(item: Record<string, unknown>): string {
  const result = item.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = result?.content
    ?.filter((content) => content.type === 'text' && typeof content.text === 'string')
    .map((content) => content.text)
    .join('\n');
  if (text) return text;
  if (item.aggregatedOutput) return String(item.aggregatedOutput);
  return result ? JSON.stringify(result) : '';
}

function handleCodexNotification(message: CodexAppServerMessage, messageId: string, mainWindow: BrowserWindow): void {
  const params = message.params ?? {};
  if (message.method === 'item/agentMessage/delta') {
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (delta) {
      safeSend(mainWindow, IpcChannels.CHAT_STREAM_DELTA, { sessionId: 'default', messageId, delta });
    }
    return;
  }
  if (message.method !== 'item/started' && message.method !== 'item/completed') return;

  const item = (params.item ?? {}) as Record<string, unknown>;
  const id = String(item.id ?? 'codex-tool');
  const type = String(item.type ?? '');
  let name: string;
  let input: Record<string, unknown>;
  if (type === 'mcpToolCall') {
    name = `mcp__${String(item.server ?? 'unknown')}__${String(item.tool ?? 'unknown')}`;
    input = asRecord(item.arguments);
  } else if (type === 'commandExecution') {
    name = 'Bash';
    input = { command: String(item.command ?? '') };
  } else if (type === 'fileChange') {
    name = 'Edit';
    input = { changes: item.changes ?? [] };
  } else {
    return;
  }

  const completed = message.method === 'item/completed';
  const failed = item.status === 'failed' || Boolean(item.error);
  const error = item.error as { message?: string } | undefined;
  safeSend(mainWindow, IpcChannels.CHAT_STREAM_TOOL, {
    sessionId: 'default',
    messageId,
    toolCall: {
      id,
      name,
      input,
      status: completed ? (failed ? 'error' : 'completed') : 'running',
      ...(completed ? { output: toolOutput(item) } : {}),
      ...(failed ? { error: error?.message ?? 'Tool call failed.' } : {}),
    },
  });
}

async function runCodexChat(options: {
  harness: ChatHarness;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  readDirs: string[];
  mcpServers: Record<string, Record<string, unknown>>;
  networkDomain?: string;
  abortController: AbortController;
  messageId: string;
  mainWindow: BrowserWindow;
}): Promise<void> {
  const client = new CodexAppServerClient(options.harness.codexCliPath as string);
  const result = await client.run({
    prompt: options.prompt,
    cwd: options.cwd,
    env: options.harness.env,
    signal: options.abortController.signal,
    developerInstructions: options.systemPrompt,
    permissionProfile: CODEX_CHAT_PROFILE,
    runtimeWorkspaceRoots: options.readDirs,
    config: buildCodexChatConfig(options),
    onNotification: (message) => handleCodexNotification(message, options.messageId, options.mainWindow),
  });
  safeSend(options.mainWindow, IpcChannels.CHAT_STREAM_END, {
    sessionId: 'default',
    messageId: options.messageId,
    success: result.status === 'completed',
    ...(result.status === 'completed' ? {} : { error: `Codex turn ended with status: ${result.status}` }),
  });
}

/**
 * Send a chat message with streaming
 */
export async function sendMessage(
  userMessage: string,
  context: ChatContext,
  mainWindow: BrowserWindow,
): Promise<{ messageId: string }> {
  if (isE2EMode(process.env)) {
    throw new Error(
      'sendMessage (chat) is blocked in E2E mode (COREDOC_DESKTOP_E2E=1) — no chat SDK session may start.',
    );
  }

  const messageId = `msg-${Date.now()}`;
  console.log(
    '[Chat] sendMessage context:',
    JSON.stringify({
      cloudMember: context.cloudMember,
      workspaceId: context.workspaceId,
      repo: context.repo,
      project: context.project,
      hasLinkedRepoPaths: context.linkedRepoPaths ? Object.keys(context.linkedRepoPaths) : null,
    }),
  );

  // ===== Cloud Member Mode =====
  if (context.cloudMember && context.workspaceId) {
    console.log('[Chat] Routing to cloud member message handler');
    return sendCloudMemberMessage(userMessage, context, mainWindow, messageId, captureChatHarness());
  }

  // ===== Local Mode =====
  console.log('[Chat] Routing to local message handler');
  const mcpServerPath = getMcpServerPath();
  const configPath = getCurrentConfigPath();

  // Resolve working directory and scope based on context
  let workingDirectory: string;
  if (!context.project || !getCurrentConfig()?.projects.some((project) => project.id === context.project)) {
    throw new Error('Local chat requires a valid project id. Reopen the project and try again.');
  }

  const scopeValue = `project:${context.project}`;
  let projectRepos: string[] = [];

  projectRepos = getProjectRepos(context.project).map((r) => r.name);

  if (context.repo) {
    if (!projectRepos.includes(context.repo)) {
      throw new Error(
        `Repository "${context.repo}" does not belong to project "${context.project}". Reopen the project and try again.`,
      );
    }

    const resolvedPath = resolveRepoPath(context.repo, context.project);
    if (!resolvedPath) {
      throw new Error(
        `Repository "${context.repo}" has no local path in project "${context.project}". Re-link the repository and try again.`,
      );
    }
    workingDirectory = resolvedPath;
    console.log(`[Chat] Resolved repo "${context.repo}" to: ${resolvedPath}`);
  } else {
    console.log(`[Chat] Project-level chat for "${context.project}" with repos: ${projectRepos.join(', ')}`);

    const projectPath = resolveProjectPath(context.project);
    workingDirectory = projectPath || getRootDir();
    console.log(`[Chat] Resolved project path to: ${workingDirectory}`);
  }
  const harness = captureChatHarness();

  // Create abort controller for cancellation
  activeAbortController = new AbortController();
  const { signal } = activeAbortController;

  // Track tool calls to update their status
  const toolCallsMap = new Map<string, { name: string; input: Record<string, unknown> }>();
  const systemPrompt = buildSystemPrompt({
    project: context.project,
    repo: context.repo,
    repoPath: workingDirectory,
    projectRepos: projectRepos.length > 0 ? projectRepos : undefined,
  });
  const mcpServer = {
    command: harness.nodeExecPath,
    args: [mcpServerPath],
    env: {
      ...harness.mcpEnv,
      COREDOC_SCOPE: scopeValue,
      ...(context.repo ? { COREDOC_CURRENT_REPO: context.repo } : {}),
      MCP_CONFIG_PATH: configPath || '',
    },
    required: true,
    default_tools_approval_mode: 'approve',
  };

  try {
    if (harness.provider === 'codex') {
      await runCodexChat({
        harness,
        prompt: userMessage,
        systemPrompt,
        cwd: workingDirectory,
        readDirs: [workingDirectory],
        mcpServers: { coredoc: mcpServer },
        abortController: activeAbortController,
        messageId,
        mainWindow,
      });
    } else {
      const { query } = await getSDK();
      for await (const message of query({
        prompt: userMessage,
        options: {
          allowedTools: ['mcp__coredoc__*'],
          cwd: workingDirectory,
          systemPrompt,
          env: harness.env,
          executable: harness.nodeExecPath as unknown as 'node',
          includePartialMessages: true,
          abortController: activeAbortController,
          permissionMode: 'default',
          settingSources: [],
          strictMcpConfig: true,
          canUseTool: buildClaudeChatPermission([workingDirectory]),
          ...(harness.claudeCliPath && { pathToClaudeCodeExecutable: harness.claudeCliPath }),
          mcpServers: {
            coredoc: { type: 'stdio', command: mcpServer.command, args: mcpServer.args, env: mcpServer.env },
          },
        },
      })) {
        if (signal.aborted || mainWindow.isDestroyed()) break;
        handleSDKMessage(message, messageId, mainWindow, toolCallsMap);
      }
    }
  } catch (error) {
    // Don't send error if aborted
    if (!signal.aborted) {
      safeSend(mainWindow, IpcChannels.CHAT_STREAM_END, {
        sessionId: 'default',
        messageId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  } finally {
    activeAbortController = null;
  }

  return { messageId };
}

/**
 * Send a cloud member message via cloud MCP with bearer auth
 */
async function sendCloudMemberMessage(
  userMessage: string,
  context: ChatContext,
  mainWindow: BrowserWindow,
  messageId: string,
  harness: ChatHarness,
): Promise<{ messageId: string }> {
  // Get auth token
  const tokens = await getValidTokens();
  if (!tokens) {
    safeSend(mainWindow, IpcChannels.CHAT_STREAM_END, {
      sessionId: 'default',
      messageId,
      success: false,
      error: 'Not authenticated — please log in',
    });
    return { messageId };
  }

  // Get cloud MCP URL
  const mcpUrl = await getCloudMcpUrl(context.workspaceId!);
  if (!mcpUrl) {
    safeSend(mainWindow, IpcChannels.CHAT_STREAM_END, {
      sessionId: 'default',
      messageId,
      success: false,
      error: 'Failed to resolve cloud MCP URL',
    });
    return { messageId };
  }

  console.log('[Chat:Cloud] MCP URL:', mcpUrl);

  // Determine tools and cwd based on linked repos
  const linkedPath = context.repo
    ? getLinkedRepos(context.workspaceId!).find((repo) => repo.repoName === context.repo)?.localPath
    : undefined;
  console.log('[Chat:Cloud] Linked repo path:', linkedPath);

  // Create abort controller
  activeAbortController = new AbortController();
  const { signal } = activeAbortController;
  const toolCallsMap = new Map<string, { name: string; input: Record<string, unknown> }>();

  try {
    const systemPrompt = buildCloudMemberSystemPrompt({
      repo: context.repo,
      cloudRepoNames: context.cloudRepoNames,
      linkedPath,
    });
    if (harness.provider === 'codex') {
      const networkDomain = new URL(mcpUrl).hostname;
      await runCodexChat({
        harness,
        prompt: userMessage,
        systemPrompt,
        cwd: linkedPath ?? getRootDir(),
        readDirs: linkedPath ? [linkedPath] : [],
        mcpServers: {
          coredoc_cloud: {
            url: mcpUrl,
            http_headers: { Authorization: `Bearer ${tokens.accessToken}` },
            required: true,
            default_tools_approval_mode: 'approve',
          },
        },
        networkDomain,
        abortController: activeAbortController,
        messageId,
        mainWindow,
      });
    } else {
      const { query } = await getSDK();
      for await (const message of query({
        prompt: userMessage,
        options: {
          allowedTools: ['mcp__coredoc_cloud__*'],
          ...(linkedPath && { cwd: linkedPath }),
          systemPrompt,
          env: harness.env,
          executable: harness.nodeExecPath as unknown as 'node',
          includePartialMessages: true,
          abortController: activeAbortController,
          permissionMode: 'default',
          settingSources: [],
          strictMcpConfig: true,
          canUseTool: buildClaudeChatPermission(linkedPath ? [linkedPath] : []),
          ...(harness.claudeCliPath && { pathToClaudeCodeExecutable: harness.claudeCliPath }),
          stderr: (data: string) => {
            if (data.trim()) console.log('[Chat:Cloud:stderr]', data.trim());
          },
          mcpServers: {
            coredoc_cloud: {
              type: 'http' as const,
              url: mcpUrl,
              headers: { Authorization: `Bearer ${tokens.accessToken}` },
            },
          },
        },
      })) {
        if (signal.aborted || mainWindow.isDestroyed()) break;
        if (message.type !== 'stream_event') {
          console.log(
            '[Chat:Cloud] SDK message:',
            message.type,
            message.type === 'result' ? (message as { subtype?: string }).subtype : '',
          );
        }
        handleSDKMessage(message, messageId, mainWindow, toolCallsMap);
      }
    }
  } catch (error) {
    console.error('[Chat:Cloud] SDK error:', error);
    if (!signal.aborted) {
      safeSend(mainWindow, IpcChannels.CHAT_STREAM_END, {
        sessionId: 'default',
        messageId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  } finally {
    activeAbortController = null;
  }

  return { messageId };
}

/**
 * Handle SDK message and dispatch to renderer
 */
function handleSDKMessage(
  message: SDKMessage,
  messageId: string,
  mainWindow: BrowserWindow,
  toolCallsMap: Map<string, { name: string; input: Record<string, unknown> }>,
): void {
  switch (message.type) {
    case 'stream_event': {
      // Handle streaming text delta
      const event = message.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta &&
        'type' in event.delta &&
        event.delta.type === 'text_delta' &&
        'text' in event.delta
      ) {
        safeSend(mainWindow, IpcChannels.CHAT_STREAM_DELTA, {
          sessionId: 'default',
          messageId,
          delta: event.delta.text,
        });
      }
      break;
    }

    case 'assistant': {
      // Handle tool calls from content blocks
      const content = message.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          // Track tool call
          toolCallsMap.set(block.id, {
            name: block.name,
            input: block.input as Record<string, unknown>,
          });

          safeSend(mainWindow, IpcChannels.CHAT_STREAM_TOOL, {
            sessionId: 'default',
            messageId,
            toolCall: {
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
              status: 'running',
            },
          });
        }
      }
      break;
    }

    case 'user': {
      // Check for tool results in user messages (SDK sends tool results as user messages)
      const userContent = message.message?.content;
      if (Array.isArray(userContent)) {
        for (const block of userContent) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const toolResultBlock = block as {
              type: 'tool_result';
              tool_use_id: string;
              content?: string | Array<{ type: string; text?: string }>;
              is_error?: boolean;
            };
            const toolId = toolResultBlock.tool_use_id;
            const toolInfo = toolCallsMap.get(toolId);

            if (toolInfo) {
              let output = '';
              if (typeof toolResultBlock.content === 'string') {
                output = toolResultBlock.content;
              } else if (Array.isArray(toolResultBlock.content)) {
                output = toolResultBlock.content
                  .map((c) => (typeof c === 'object' && 'text' in c ? c.text : ''))
                  .join('\n');
              }

              safeSend(mainWindow, IpcChannels.CHAT_STREAM_TOOL, {
                sessionId: 'default',
                messageId,
                toolCall: {
                  id: toolId,
                  name: toolInfo.name,
                  input: toolInfo.input,
                  status: toolResultBlock.is_error ? 'error' : 'completed',
                  output: output,
                  error: toolResultBlock.is_error ? output : undefined,
                },
              });
            }
          }
        }
      }
      break;
    }

    case 'tool_progress': {
      // Update tool call as still running
      const toolInfo = toolCallsMap.get(message.tool_use_id);
      if (toolInfo) {
        safeSend(mainWindow, IpcChannels.CHAT_STREAM_TOOL, {
          sessionId: 'default',
          messageId,
          toolCall: {
            id: message.tool_use_id,
            name: toolInfo.name,
            input: toolInfo.input,
            status: 'running',
          },
        });
      }
      break;
    }

    case 'result': {
      safeSend(mainWindow, IpcChannels.CHAT_STREAM_END, {
        sessionId: 'default',
        messageId,
        success: message.subtype === 'success',
        error: message.subtype !== 'success' ? (message as { errors?: string[] }).errors?.join(', ') : undefined,
      });
      break;
    }

    case 'system': {
      const sysMsg = message as {
        subtype?: string;
        mcp_servers?: { name: string; status: string; error?: string; config?: unknown }[];
      };
      if (sysMsg.subtype === 'init' && sysMsg.mcp_servers) {
        console.log('[Chat] MCP server status (full):', JSON.stringify(sysMsg.mcp_servers, null, 2));
        const failed = sysMsg.mcp_servers.filter((s) => s.status !== 'connected');
        if (failed.length > 0) {
          console.error('[Chat] MCP servers failed to connect:', JSON.stringify(failed, null, 2));
          const errorDetails = failed.map((s) => `${s.name} (${s.status}${s.error ? ': ' + s.error : ''})`).join(', ');
          safeSend(mainWindow, IpcChannels.CHAT_STREAM_DELTA, {
            sessionId: 'default',
            messageId,
            delta: `⚠️ MCP connection failed: ${errorDetails}\n\n`,
          });
        }
      }
      break;
    }
  }
}

/**
 * Cancel the current chat
 */
export function cancelChat(): void {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
}

/**
 * Register IPC handlers for chat operations
 */
export function registerChatHandlers(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  ipcMain.handle(IpcChannels.CHAT_SEND, async (_event, message: string, context?: ChatContext) => {
    return sendMessage(message, context || {}, mainWindow);
  });

  ipcMain.handle(IpcChannels.CHAT_CANCEL, () => {
    cancelChat();
    return;
  });

  ipcMain.handle(IpcChannels.CHAT_CLEAR, () => {
    // Clear is handled client-side, but we can cancel any active query
    cancelChat();
    return;
  });
}
