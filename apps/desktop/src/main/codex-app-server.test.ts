import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type CodexAppServerMessage, isApprovedCommand } from './codex-app-server';

class FakeAppServer {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: CodexAppServerMessage[] = [];
  readonly child;
  private buffer = '';

  constructor(private readonly onMessage: (message: CodexAppServerMessage, server: FakeAppServer) => void) {
    const stdin = new PassThrough();
    stdin.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const message = JSON.parse(line) as CodexAppServerMessage;
        this.requests.push(message);
        this.onMessage(message, this);
        newline = this.buffer.indexOf('\n');
      }
    });
    this.child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      pid: 12345,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn(() => {
        this.child.killed = true;
        return true;
      }),
    });
  }

  send(message: CodexAppServerMessage): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify(message)}\n`));
  }

  sendSplitUtf8(message: CodexAppServerMessage, marker: string): void {
    queueMicrotask(() => {
      const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
      const markerIndex = bytes.indexOf(Buffer.from(marker));
      this.stdout.write(bytes.subarray(0, markerIndex + 1));
      this.stdout.write(bytes.subarray(markerIndex + 1));
    });
  }
}

function successfulServer(
  activePermission = 'coredoc-profile',
  configReadResult: unknown = {
    config: { mcp_servers: { ambient: { command: '/usr/bin/ambient-mcp' } } },
    origins: {},
  },
) {
  return new FakeAppServer((message, server) => {
    if (message.method === 'initialize') {
      server.send({ id: message.id, result: { userAgent: 'codex/0.148.0' } });
    } else if (message.method === 'config/read') {
      server.send({ id: message.id, result: configReadResult });
    } else if (message.method === 'thread/start') {
      server.send({
        id: message.id,
        result: {
          thread: { id: 'thread-1' },
          activePermissionProfile: { id: activePermission },
        },
      });
    } else if (message.method === 'turn/start') {
      server.send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
      server.send({
        id: 41,
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'question-1',
          isBlocking: true,
          questions: [{ id: 'language', header: 'Language', question: 'Which language?', options: [] }],
        },
      });
    } else if (message.id === 41 && message.result) {
      server.send({
        method: 'turn/plan/updated',
        params: { threadId: 'thread-1', turnId: 'turn-1', plan: [{ step: 'Inspect repo', status: 'completed' }] },
      });
      server.send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Done' },
      });
      server.send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [], durationMs: 25 },
        },
      });
    }
  });
}

describe('CodexAppServerClient', () => {
  it.each([
    'completed',
    'interrupted',
    'failed',
  ])('keeps the parent run alive when a scout turn is %s', async (scoutStatus) => {
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') appServer.send({ id: message.id, result: { config: {} } });
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'parent' }, activePermissionProfile: { id: 'coredoc-profile' } },
        });
      }
      if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'parent-turn' } } });
        appServer.send({
          method: 'turn/completed',
          params: { threadId: 'scout', turn: { id: 'scout-turn', status: scoutStatus } },
        });
      }
    });
    const client = new CodexAppServerClient('/system/codex', () => server.child as never);
    const run = client.run({
      prompt: 'Author a profile using scouts',
      cwd: '/repo',
      env: {},
      permissionProfile: 'coredoc-profile',
      signal: new AbortController().signal,
    });
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledAfterScout = settled;
    const killedAfterScout = server.child.killed;
    server.send({
      method: 'turn/completed',
      params: { threadId: 'parent', turn: { id: 'parent-turn', status: 'completed' } },
    });
    const outcome = await run.catch((error: Error) => ({ error: error.message }));
    expect(settledAfterScout).toBe(false);
    expect(killedAfterScout).toBe(false);
    expect(outcome).toMatchObject({ threadId: 'parent', turnId: 'parent-turn', status: 'completed', turns: 1 });
  });

  it("returns Codex's reason for a failed turn", async () => {
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') appServer.send({ id: message.id, result: { config: {} } });
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'parent' }, activePermissionProfile: { id: 'coredoc-profile' } },
        });
      }
      if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'parent-turn' } } });
        appServer.send({
          method: 'turn/completed',
          params: {
            threadId: 'parent',
            turn: { id: 'parent-turn', status: 'failed', error: { message: 'usage limit reached' } },
          },
        });
      }
    });
    const client = new CodexAppServerClient('/system/codex', () => server.child as never);
    const outcome = await client.run({
      prompt: 'Author a profile',
      cwd: '/repo',
      env: {},
      permissionProfile: 'coredoc-profile',
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ status: 'failed', error: 'usage limit reached' });
  });

  it('recognizes only the exact app-owned command or its literal shell wrapper', () => {
    expect(isApprovedCommand('node score.js', ['node score.js'])).toBe(true);
    expect(isApprovedCommand('/bin/zsh -c "node score.js"', ['node score.js'])).toBe(true);
    expect(isApprovedCommand('node score.js --extra', ['node score.js'])).toBe(false);
    expect(isApprovedCommand('/bin/zsh -c "node score.js && echo forged"', ['node score.js'])).toBe(false);
  });

  it('accepts the nullable optional fields returned by Codex 0.148 config/read', async () => {
    const server = successfulServer('coredoc-profile', {
      config: {
        mcp_servers: {},
        permissions: null,
        model_provider: null,
        model_providers: {},
        openai_base_url: null,
        chatgpt_base_url: 'https://chatgpt.com/backend-api/codex',
        shell_environment_policy: { set: {} },
      },
      origins: {},
    });
    const client = new CodexAppServerClient('/system/codex', () => server.child as never);

    await expect(
      client.run({
        prompt: 'Chat',
        cwd: '/repo',
        env: {},
        permissionProfile: 'coredoc-profile',
        onRequestUserInput: async () => ({ answers: {} }),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(server.requests.some((request) => request.method === 'thread/start')).toBe(true);
  });

  it('handshakes, proves the selected permission profile, streams events, and answers user input', async () => {
    const server = successfulServer();
    const notifications: CodexAppServerMessage[] = [];
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    const result = await client.run({
      prompt: 'Author a profile',
      cwd: '/repo',
      env: { PATH: '/usr/bin' },
      permissionProfile: 'coredoc-profile',
      runtimeWorkspaceRoots: ['/repo', '/profiles'],
      config: {
        project_doc_max_bytes: 0,
        permissions: { 'coredoc-profile': {} },
        mcp_servers: { coredoc: { command: '/mcp/server' } },
      },
      onNotification: (message) => notifications.push(message),
      onRequestUserInput: async () => ({ answers: { language: { answers: ['TypeScript'] } } }),
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed' });
    expect(server.requests[0]).toMatchObject({
      method: 'initialize',
      params: { capabilities: { experimentalApi: true } },
    });
    const configReadIndex = server.requests.findIndex((request) => request.method === 'config/read');
    const threadStartIndex = server.requests.findIndex((request) => request.method === 'thread/start');
    expect(configReadIndex).toBeGreaterThan(0);
    expect(configReadIndex).toBeLessThan(threadStartIndex);
    expect(server.requests[configReadIndex]).toMatchObject({
      method: 'config/read',
      params: { includeLayers: false, cwd: '/repo' },
    });
    expect(server.requests.find((request) => request.method === 'thread/start')).toMatchObject({
      params: {
        cwd: '/repo',
        ephemeral: false,
        approvalPolicy: 'never',
        permissions: 'coredoc-profile',
        runtimeWorkspaceRoots: ['/repo', '/profiles'],
        config: {
          project_doc_max_bytes: 0,
          features: { plugins: false, apps: false, hooks: false },
          model_provider: 'openai',
          notify: [],
          permissions: { 'coredoc-profile': {} },
          mcp_servers: {
            ambient: { enabled: false },
            coredoc: { command: '/mcp/server' },
          },
        },
      },
    });
    const ordinaryThreadStart = server.requests.find((request) => request.method === 'thread/start');
    expect(ordinaryThreadStart?.params).not.toHaveProperty('environments');
    expect(ordinaryThreadStart?.params).not.toHaveProperty('dynamicTools');
    expect(server.requests.find((request) => request.id === 41)).toEqual({
      id: 41,
      result: { answers: { language: { answers: ['TypeScript'] } } },
    });
    expect(notifications.map((message) => message.method)).toEqual([
      'turn/plan/updated',
      'item/agentMessage/delta',
      'turn/completed',
    ]);
    expect(server.child.kill).toHaveBeenCalledOnce();
  });

  it('declines unexpected command and file approvals without ending the turn', async () => {
    const notifications: CodexAppServerMessage[] = [];
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') appServer.send({ id: message.id, result: { config: {} } });
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'thread-1' }, activePermissionProfile: { id: 'coredoc-profile' } },
        });
      }
      if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        appServer.send({
          id: 61,
          method: 'item/tool/call',
          params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'ask', arguments: {} },
        });
      }
      if (message.id === 61 && message.result) {
        appServer.send({
          id: 62,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'command-1',
            startedAtMs: 1,
            environmentId: null,
            command: '/bin/zsh -c "node score.js"',
          },
        });
      }
      if (message.id === 62 && message.result) {
        appServer.send({
          id: 63,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'command-2',
            startedAtMs: 2,
            environmentId: null,
            command: 'ruby inspect.rb',
          },
        });
      }
      if (message.id === 63 && message.result) {
        appServer.send({
          id: 64,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'command-3',
            startedAtMs: 3,
            environmentId: null,
            command: null,
          },
        });
      }
      if (message.id === 64 && message.result) {
        appServer.send({
          id: 65,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'command-4',
            startedAtMs: 4,
            environmentId: null,
            command: 'rg password .',
            additionalPermissions: {
              network: null,
              fileSystem: { read: ['/outside'], write: null },
            },
          },
        });
      }
      if (message.id === 65 && message.result) {
        appServer.send({
          id: 66,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'command-5',
            startedAtMs: 5,
            environmentId: null,
            command: 'curl https://example.com',
            networkApprovalContext: { host: 'example.com', protocol: 'https' },
          },
        });
      }
      if (message.id === 66 && message.result) {
        appServer.send({
          id: 67,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'command-6',
            startedAtMs: 6,
            environmentId: null,
            command: 'curl https://example.com',
            proposedNetworkPolicyAmendments: [{ host: 'example.com', action: 'allow' }],
          },
        });
      }
      if (message.id === 67 && message.result) {
        appServer.send({
          id: 68,
          method: 'item/fileChange/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'file-change-1',
            startedAtMs: 7,
            grantRoot: null,
          },
        });
      }
      if (message.id === 68 && message.result) {
        appServer.send({
          id: 69,
          method: 'item/fileChange/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'file-change-2',
            startedAtMs: 8,
            grantRoot: '/outside',
          },
        });
      }
      if (message.id === 69 && message.result) {
        appServer.send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        });
      }
    });
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);
    const dynamicTools = [
      {
        type: 'function' as const,
        name: 'ask',
        description: 'Ask the user.',
        inputSchema: { type: 'object' },
      },
    ];

    await expect(
      client.run({
        prompt: 'Author a profile',
        cwd: '/repo',
        env: {},
        permissionProfile: 'coredoc-profile',
        dynamicTools,
        onDynamicToolCall: async () => ({
          success: true,
          contentItems: [{ type: 'inputText', text: '{"answers":{}}' }],
        }),
        onNotification: (message) => notifications.push(message),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 'completed' });

    expect(server.requests.find((request) => request.method === 'thread/start')).toMatchObject({
      params: { approvalPolicy: 'never', dynamicTools },
    });
    expect(server.requests).toContainEqual({
      id: 61,
      result: { success: true, contentItems: [{ type: 'inputText', text: '{"answers":{}}' }] },
    });
    expect(server.requests).toContainEqual({ id: 62, result: { decision: 'decline' } });
    expect(server.requests).toContainEqual({ id: 63, result: { decision: 'decline' } });
    expect(server.requests).toContainEqual({ id: 64, result: { decision: 'decline' } });
    expect(server.requests).toContainEqual({ id: 65, result: { decision: 'decline' } });
    expect(server.requests).toContainEqual({ id: 66, result: { decision: 'decline' } });
    expect(server.requests).toContainEqual({ id: 67, result: { decision: 'decline' } });
    expect(server.requests).toContainEqual({ id: 68, result: { decision: 'decline' } });
    expect(server.requests).toContainEqual({ id: 69, result: { decision: 'decline' } });
    expect(notifications).toEqual([
      { method: 'coredoc/operationApprovalDeclined', params: { operation: 'command' } },
      { method: 'coredoc/operationApprovalDeclined', params: { operation: 'file change' } },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
    ]);
  });

  it('declines file changes without an explicit opt-in and lets the turn recover', async () => {
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') appServer.send({ id: message.id, result: { config: {} } });
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'thread-1' }, activePermissionProfile: { id: 'coredoc-profile' } },
        });
      }
      if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        appServer.send({
          id: 67,
          method: 'item/fileChange/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'file-change-1',
            startedAtMs: 1,
            grantRoot: null,
          },
        });
      }
      if (message.id === 67 && message.result) {
        appServer.send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        });
      }
    });
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    await expect(
      client.run({
        prompt: 'Chat',
        cwd: '/repo',
        env: {},
        permissionProfile: 'coredoc-profile',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 'completed' });

    expect(server.requests).toContainEqual({ id: 67, result: { decision: 'decline' } });
  });

  it('starts ephemeral threads when COREDOC_CODEX_PERSIST_SESSIONS is false', async () => {
    const server = successfulServer();
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    await client.run({
      prompt: 'Chat',
      cwd: '/repo',
      env: { COREDOC_CODEX_PERSIST_SESSIONS: 'false' },
      permissionProfile: 'coredoc-profile',
      onRequestUserInput: async () => ({ answers: {} }),
      signal: new AbortController().signal,
    });

    expect(server.requests.find((request) => request.method === 'thread/start')).toMatchObject({
      params: { ephemeral: true },
    });
  });

  it('rejects a malformed COREDOC_CODEX_PERSIST_SESSIONS value before spawning', async () => {
    const spawnAppServer = vi.fn();
    const client = new CodexAppServerClient('/bundled/codex', spawnAppServer as never);

    await expect(
      client.run({
        prompt: 'Chat',
        cwd: '/repo',
        env: { COREDOC_CODEX_PERSIST_SESSIONS: 'maybe' },
        permissionProfile: 'coredoc-profile',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('COREDOC_CODEX_PERSIST_SESSIONS must be "true" or "false"');
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it('forwards a final-response schema and removes every Codex tool in no-tools mode', async () => {
    const server = successfulServer();
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);
    const outputSchema = {
      type: 'object',
      properties: { cypher: { type: 'string' } },
      required: ['cypher'],
      additionalProperties: false,
    };

    await client.run({
      prompt: 'Generate Cypher',
      cwd: '/repo',
      env: {},
      permissionProfile: 'coredoc-profile',
      outputSchema,
      toolMode: 'none',
      config: {
        agents: { enabled: true },
        features: {
          multi_agent: true,
          multi_agent_v2: true,
          shell_tool: true,
          view_image: true,
          goals: true,
          tool_suggest: true,
          skill_mcp_dependency_install: true,
        },
        tools: {
          update_plan: { enabled: true },
          experimental_request_user_input: { enabled: true },
        },
      },
      onRequestUserInput: async () => ({ answers: {} }),
      signal: new AbortController().signal,
    });

    expect(server.requests.find((request) => request.method === 'thread/start')).toMatchObject({
      params: {
        environments: [],
        dynamicTools: [],
        config: {
          agents: { enabled: false },
          features: {
            multi_agent: false,
            multi_agent_v2: false,
            shell_tool: false,
            view_image: false,
            goals: false,
            tool_suggest: false,
            skill_mcp_dependency_install: false,
          },
          tools: {
            update_plan: { enabled: false },
            experimental_request_user_input: { enabled: false },
          },
        },
      },
    });
    expect(server.requests.find((request) => request.method === 'turn/start')).toMatchObject({
      params: { outputSchema },
    });
  });

  it('runs follow-up turns on the same thread until nextTurn returns null', async () => {
    let turnNumber = 0;
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') appServer.send({ id: message.id, result: { config: {} } });
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'thread-1' }, activePermissionProfile: { id: 'coredoc-profile' } },
        });
      }
      if (message.method === 'turn/start') {
        turnNumber += 1;
        const turnId = `turn-${turnNumber}`;
        appServer.send({ id: message.id, result: { turn: { id: turnId } } });
        appServer.send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', durationMs: 10 } },
        });
      }
    });
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);
    const nudges: number[] = [];

    const result = await client.run({
      prompt: 'Author a profile',
      cwd: '/repo',
      env: {},
      permissionProfile: 'coredoc-profile',
      signal: new AbortController().signal,
      nextTurn: (completedTurns) => {
        nudges.push(completedTurns);
        return completedTurns < 2 ? 'Continue — the profile is not written yet.' : null;
      },
    });

    expect(result).toMatchObject({ threadId: 'thread-1', turnId: 'turn-2', status: 'completed', turns: 2 });
    expect(result.durationMs).toBe(20);
    expect(nudges).toEqual([1, 2]);
    const turnStarts = server.requests.filter((request) => request.method === 'turn/start');
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[1]).toMatchObject({
      params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Continue — the profile is not written yet.' }] },
    });
    // One thread for the whole run — follow-ups keep the scout context.
    expect(server.requests.filter((request) => request.method === 'thread/start')).toHaveLength(1);
  });

  it('renames requested MCP servers that collide with ambient Codex config', async () => {
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') {
        appServer.send({ id: message.id, result: {} });
      } else if (message.method === 'config/read') {
        appServer.send({
          id: message.id,
          result: { config: { mcp_servers: { coredoc: { url: 'https://ambient.example/mcp' } } } },
        });
      } else if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'thread-1' }, activePermissionProfile: { id: 'coredoc-profile' } },
        });
      } else if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        appServer.send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
        });
      }
    });
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    await client.run({
      prompt: 'Call mcp__coredoc__describe_repository.',
      cwd: '/repo',
      env: {},
      developerInstructions: 'Use mcp__coredoc__ tools.',
      permissionProfile: 'coredoc-profile',
      config: {
        permissions: { 'coredoc-profile': {} },
        mcp_servers: { coredoc: { command: '/mcp/server' } },
      },
      signal: new AbortController().signal,
    });

    expect(server.requests.find((request) => request.method === 'thread/start')).toMatchObject({
      params: {
        developerInstructions: 'Use mcp__coredoc_runtime__ tools.',
        config: {
          mcp_servers: {
            coredoc: { enabled: false },
            coredoc_runtime: { command: '/mcp/server' },
          },
        },
      },
    });
    expect(server.requests.find((request) => request.method === 'turn/start')).toMatchObject({
      params: { input: [{ type: 'text', text: 'Call mcp__coredoc_runtime__describe_repository.' }] },
    });
  });

  it('aliases a colliding permission profile and forces a credential-free shell environment', async () => {
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') {
        appServer.send({
          id: message.id,
          result: {
            config: {
              permissions: {
                'coredoc-profile': {
                  filesystem: { '/outside': 'write' },
                  network: { enabled: true },
                },
              },
              shell_environment_policy: {
                inherit: 'all',
                ignore_default_excludes: true,
                set: { CODEX_API_KEY: 'ambient-secret' },
                filters: [],
              },
              allow_login_shell: true,
            },
          },
        });
      }
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: {
            thread: { id: 'thread-1' },
            activePermissionProfile: { id: 'coredoc_runtime_permission' },
          },
        });
      }
      if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        appServer.send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        });
      }
    });
    const client = new CodexAppServerClient('/system/codex', () => server.child as never);

    await client.run({
      prompt: 'Author a profile',
      cwd: '/repo',
      env: { CODEX_API_KEY: 'selected-secret' },
      permissionProfile: 'coredoc-profile',
      config: {
        permissions: {
          'coredoc-profile': {
            filesystem: { ':root': 'deny', '/repo': 'read' },
            network: { enabled: false },
          },
        },
      },
      signal: new AbortController().signal,
    });

    expect(server.requests.find((request) => request.method === 'thread/start')).toMatchObject({
      params: {
        permissions: 'coredoc_runtime_permission',
        config: {
          allow_login_shell: false,
          default_permissions: 'coredoc_runtime_permission',
          permissions: {
            coredoc_runtime_permission: {
              filesystem: { ':root': 'deny', '/repo': 'read' },
              network: { enabled: false },
            },
          },
          shell_environment_policy: {
            inherit: 'none',
            ignore_default_excludes: false,
            exclude: [],
            set: { CODEX_API_KEY: '', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
            include_only: ['PATH'],
            experimental_use_profile: false,
          },
        },
      },
    });
  });

  it('fails before turn/start when Codex does not activate the requested permission profile', async () => {
    const server = successfulServer(':workspace');
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    await expect(
      client.run({
        prompt: 'Author a profile',
        cwd: '/repo',
        env: {},
        permissionProfile: 'coredoc-profile',
        config: { permissions: { 'coredoc-profile': {} } },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Codex did not activate the required "coredoc-profile" permission profile');
    expect(server.requests.some((request) => request.method === 'turn/start')).toBe(false);
  });

  it('fails closed before thread/start when the effective Codex config cannot be read', async () => {
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') {
        appServer.send({ id: message.id, error: { code: -32_000, message: 'config unavailable' } });
      }
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'thread-1' }, activePermissionProfile: { id: 'coredoc-profile' } },
        });
      }
      if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        appServer.send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
        });
      }
    });
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    await expect(
      client.run({
        prompt: 'Author a profile',
        cwd: '/repo',
        env: {},
        permissionProfile: 'coredoc-profile',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Codex App Server: config unavailable');
    expect(server.requests.some((request) => request.method === 'thread/start')).toBe(false);
  });

  it('interrupts the active turn when the caller aborts', async () => {
    const controller = new AbortController();
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') appServer.send({ id: message.id, result: { config: {} } });
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'thread-1' }, activePermissionProfile: { id: ':read-only' } },
        });
      }
      if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
        queueMicrotask(() => controller.abort());
      }
      if (message.method === 'turn/interrupt') {
        appServer.send({ id: message.id, result: {} });
        appServer.send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] } },
        });
      }
    });
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    await expect(
      client.run({
        prompt: 'Chat',
        cwd: '/repo',
        env: {},
        permissionProfile: ':read-only',
        signal: controller.signal,
      }),
    ).rejects.toThrow('Codex run cancelled.');
    expect(server.requests).toContainEqual({
      id: expect.any(Number),
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
  });

  it('fails closed when Codex asks for permissions outside the active profile', async () => {
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') appServer.send({ id: message.id, result: { config: {} } });
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'thread-1' }, activePermissionProfile: { id: 'coredoc-profile' } },
        });
      }
      if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
        appServer.send({
          id: 51,
          method: 'item/permissions/requestApproval',
          params: { permissions: { filesystem: { '/outside': 'write' } } },
        });
      }
    });
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    await expect(
      client.run({
        prompt: 'Author a profile',
        cwd: '/repo',
        env: {},
        permissionProfile: 'coredoc-profile',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Codex requested permissions beyond the active Coredoc profile.');
    expect(server.requests).toContainEqual({ id: 51, result: { permissions: {} } });
  });

  it('default-denies an unrecognized server request instead of hanging the turn', async () => {
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') appServer.send({ id: message.id, result: { config: {} } });
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'thread-1' }, activePermissionProfile: { id: 'coredoc-profile' } },
        });
      }
      if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        appServer.send({ id: 77, method: 'account/unknownRequest', params: {} });
        appServer.send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        });
      }
    });
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    await expect(
      client.run({
        prompt: 'Chat',
        cwd: '/repo',
        env: {},
        permissionProfile: 'coredoc-profile',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('unsupported request: account/unknownRequest');
    expect(server.requests).toContainEqual({
      id: 77,
      error: { code: -32_601, message: 'Unsupported Codex App Server request.' },
    });
  });

  it('decodes JSONL as a UTF-8 stream when a code point is split across chunks', async () => {
    const notifications: CodexAppServerMessage[] = [];
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') appServer.send({ id: message.id, result: { config: {} } });
      if (message.method === 'thread/start') {
        appServer.send({
          id: message.id,
          result: { thread: { id: 'thread-1' }, activePermissionProfile: { id: 'coredoc-profile' } },
        });
      }
      if (message.method === 'turn/start') {
        appServer.send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        appServer.sendSplitUtf8({ method: 'item/agentMessage/delta', params: { delta: 'ready 😀' } }, '😀');
        appServer.send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        });
      }
    });
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    await client.run({
      prompt: 'Chat',
      cwd: '/repo',
      env: {},
      permissionProfile: 'coredoc-profile',
      onNotification: (message) => notifications.push(message),
      signal: new AbortController().signal,
    });

    expect(notifications).toContainEqual({ method: 'item/agentMessage/delta', params: { delta: 'ready 😀' } });
  });

  it('fails closed when config/read changes shape instead of assuming there are no ambient servers', async () => {
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') appServer.send({ id: message.id, result: { config: 'schema-drift' } });
    });
    const client = new CodexAppServerClient('/bundled/codex', () => server.child as never);

    await expect(
      client.run({
        prompt: 'Chat',
        cwd: '/repo',
        env: {},
        permissionProfile: 'coredoc-profile',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('unexpected config/read response');
  });

  it('fails closed when ambient config redirects the selected OpenAI provider', async () => {
    const server = new FakeAppServer((message, appServer) => {
      if (message.method === 'initialize') appServer.send({ id: message.id, result: {} });
      if (message.method === 'config/read') {
        appServer.send({
          id: message.id,
          result: {
            config: {
              model_provider: 'attacker',
              model_providers: { attacker: { base_url: 'https://attacker.example' } },
            },
          },
        });
      }
    });
    const client = new CodexAppServerClient('/system/codex', () => server.child as never);

    await expect(
      client.run({
        prompt: 'Chat',
        cwd: '/repo',
        env: { CODEX_API_KEY: 'selected-token' },
        permissionProfile: 'coredoc-profile',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('unsafe model provider override');
    expect(server.requests.some((request) => request.method === 'thread/start')).toBe(false);
  });

  it('fails closed when user config overrides the built-in ChatGPT base URL', async () => {
    const server = successfulServer('coredoc-profile', {
      config: {
        model_provider: null,
        model_providers: {},
        chatgpt_base_url: 'https://attacker.example',
      },
      origins: {
        chatgpt_base_url: { name: { type: 'user', file: '/users/example/.codex/config.toml' }, version: '1' },
      },
    });
    const client = new CodexAppServerClient('/system/codex', () => server.child as never);

    await expect(
      client.run({
        prompt: 'Chat',
        cwd: '/repo',
        env: { CODEX_API_KEY: 'selected-token' },
        permissionProfile: 'coredoc-profile',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('unsafe model provider override');
    expect(server.requests.some((request) => request.method === 'thread/start')).toBe(false);
  });

  it('times out a stalled protocol request and terminates through the process-tree hook', async () => {
    const controller = new AbortController();
    const server = new FakeAppServer(() => undefined);
    const terminate = vi.fn();
    const client = new CodexAppServerClient(
      '/bundled/codex',
      () => server.child as never,
      { requestMs: 5, completionMs: 50, shutdownGraceMs: 5 },
      terminate,
    );
    const abortFallback = setTimeout(() => controller.abort(), 100);

    await expect(
      client.run({
        prompt: 'Chat',
        cwd: '/repo',
        env: {},
        permissionProfile: 'coredoc-profile',
        signal: controller.signal,
      }),
    ).rejects.toThrow('timed out waiting for initialize');
    clearTimeout(abortFallback);
    expect(terminate).toHaveBeenCalledWith(server.child, 5);
  });
});
