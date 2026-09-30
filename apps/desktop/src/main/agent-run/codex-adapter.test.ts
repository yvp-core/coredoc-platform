import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunEventType, AgentRunPhase, AgentTodoStatus } from '../../shared/agent-run-types';
import type { AgentRunEvent } from '../../shared/agent-run-types';
import type { CodexAppServerRunOptions } from '../codex-app-server';
import { CodexAdapter } from './codex-adapter';
import type { AgentRunIO, AgentRunRequest } from './types';

const REPO = '/work/repo';
const KIT = '/work/kit';
const PARSER_DIR = '/work/parsers/repo';

function makeRequest(): AgentRunRequest {
  return {
    prompt: 'author a profile',
    cwd: REPO,
    model: 'gpt-5.4',
    additionalDirectories: [KIT, PARSER_DIR],
    policy: {
      repoDir: REPO,
      writeDirs: [PARSER_DIR],
      readDirs: [REPO, KIT, PARSER_DIR],
      toolchainReadDirs: ['/opt/toolchain'],
      safeCommandPrefixes: ['node score.js'],
    },
    env: { PATH: '/usr/bin' },
    nodeExecPath: '/usr/bin/node',
    abortController: new AbortController(),
  };
}

function makeIO(answer: string[][] = []): { io: AgentRunIO; events: AgentRunEvent[] } {
  const events: AgentRunEvent[] = [];
  return {
    events,
    io: {
      emit: (event) => events.push(event),
      askQuestion: async () => answer,
    },
  };
}

describe('CodexAdapter', () => {
  it('updates Desktop progress through the owned plan tool when Codex has no native update_plan', async () => {
    const { io, events } = makeIO();
    const adapter = new CodexAdapter('/bundled/codex', () => ({
      run: async (options) => {
        expect(options.dynamicTools?.some((tool) => tool.name === 'coredoc_update_plan')).toBe(true);
        await options.onDynamicToolCall!({
          tool: 'coredoc_update_plan',
          arguments: { plan: [{ step: 'Score & iterate', status: 'in_progress' }] },
        });
        return { status: 'completed', threadId: 'plan', turnId: 'turn', turns: 1 };
      },
    }));
    await adapter.run(makeRequest(), io);
    expect(events).toContainEqual({
      type: AgentRunEventType.Todos,
      items: [{ text: 'Score & iterate', status: AgentTodoStatus.InProgress }],
    });
  });
  it('exposes scoring as an app-owned tool with no command or path supplied by the agent', async () => {
    const request = makeRequest();
    request.scoreProfile = vi.fn().mockResolvedValue({ success: false, output: '=== Profile completion: BLOCKED ===' });
    const adapter = new CodexAdapter('/bundled/codex', () => ({
      run: async (options) => {
        expect(options.dynamicTools?.some((t) => t.name === 'coredoc_score_profile')).toBe(true);
        const result = await options.onDynamicToolCall!({ tool: 'coredoc_score_profile', arguments: {} });
        expect(result).toEqual({
          success: false,
          contentItems: [{ type: 'inputText', text: '=== Profile completion: BLOCKED ===' }],
        });
        expect(request.scoreProfile).toHaveBeenCalledWith();
        return { status: 'completed', threadId: 'score', turnId: 'turn', turns: 1, durationMs: 1 };
      },
    }));
    await adapter.run(request, makeIO().io);
  });
  it('does not reopen an exactly scored BLOCKED result when the author ends unsuccessfully', async () => {
    const request = makeRequest();
    request.verifyCompletion = () =>
      "The current profile's score result is BLOCKED by a category failure and cannot be accepted as a documented gap.";
    request.deliverableExists = () => true;
    const adapter = new CodexAdapter('/bundled/codex', () => ({
      run: async (options) => {
        expect(options.nextTurn?.(1)).toBeNull();
        return { status: 'completed', threadId: 'blocked', turnId: 'turn', turns: 1, durationMs: 1 };
      },
    }));
    await adapter.run(request, makeIO().io);
  });
  afterEach(() => {
    delete process.env.COREDOC_DESKTOP_E2E;
  });

  it('blocks E2E runs before spawning Codex', async () => {
    process.env.COREDOC_DESKTOP_E2E = '1';
    const run = vi.fn();
    const adapter = new CodexAdapter('/bundled/codex', () => ({ run }));

    await expect(adapter.run(makeRequest(), makeIO().io)).rejects.toThrow(/E2E mode/);
    expect(run).not.toHaveBeenCalled();
  });

  it('uses a least-privilege profile and maps plan, tool, text, and completion events', async () => {
    let runOptions: CodexAppServerRunOptions | undefined;
    const adapter = new CodexAdapter('/bundled/codex', () => ({
      run: async (options) => {
        runOptions = options;
        options.onNotification?.({
          method: 'turn/plan/updated',
          params: {
            plan: [
              { step: 'Ground in repo shape', status: 'completed' },
              { step: 'Draft profile', status: 'inProgress' },
              { step: 'Finalize profile', status: 'pending' },
            ],
          },
        });
        options.onNotification?.({
          method: 'item/started',
          params: { item: { id: 'tool-1', type: 'commandExecution', command: '/bin/zsh -c "node score.js"' } },
        });
        options.onNotification?.({
          method: 'item/completed',
          params: {
            item: {
              id: 'tool-1',
              type: 'commandExecution',
              command: '/bin/zsh -c "node score.js"',
              status: 'failed',
              exitCode: 1,
              durationMs: 12,
              aggregatedOutput: 'spawnSync node ENOENT',
            },
          },
        });
        options.onNotification?.({
          method: 'item/completed',
          params: {
            item: {
              id: 'fc-1',
              type: 'fileChange',
              changes: [{ path: '/work/parsers/repo/profile.ts', kind: { type: 'add' } }],
            },
          },
        });
        // Word-level deltas are noise; only the completed agentMessage becomes a [text] line.
        options.onNotification?.({ method: 'item/agentMessage/delta', params: { delta: 'Fin' } });
        options.onNotification?.({
          method: 'item/started',
          params: { item: { id: 'msg-1', type: 'agentMessage', text: '' } },
        });
        options.onNotification?.({
          method: 'item/completed',
          params: { item: { id: 'msg-1', type: 'agentMessage', text: 'Finished' } },
        });
        // Reasoning stubs and echoed prompts must not clutter the trace.
        options.onNotification?.({ method: 'item/started', params: { item: { id: 'r-1', type: 'reasoning' } } });
        options.onNotification?.({ method: 'item/started', params: { item: { id: 'u-1', type: 'userMessage' } } });
        options.onNotification?.({
          method: 'coredoc/operationApprovalDeclined',
          params: { operation: 'command' },
        });
        // File changes surface their target paths, not the raw diff payload.
        options.onNotification?.({
          method: 'item/started',
          params: {
            item: {
              id: 'fc-1',
              type: 'fileChange',
              changes: [{ path: '/work/parsers/repo/profile.ts', kind: { type: 'add' }, diff: 'export const x = 1;' }],
            },
          },
        });
        return { threadId: 'thread-1', turnId: 'turn-1', status: 'completed', turns: 1, durationMs: 42 };
      },
    }));
    const { io, events } = makeIO();
    const request = makeRequest();
    request.onCommandCompleted = vi.fn();

    await adapter.run(request, io);

    expect(runOptions).toMatchObject({
      prompt: 'author a profile',
      cwd: REPO,
      model: 'gpt-5.4',
      permissionProfile: 'coredoc-profile',
      runtimeWorkspaceRoots: [REPO, KIT, PARSER_DIR],
    });
    expect(runOptions).not.toHaveProperty('approvedCommands');
    expect(runOptions).not.toHaveProperty('approveSandboxedCommands');
    expect(runOptions).not.toHaveProperty('approveFileChanges');
    expect(runOptions?.config).toEqual({
      project_doc_max_bytes: 0,
      web_search: 'disabled',
      features: { multi_agent: true },
      tools: { experimental_request_user_input: { enabled: false } },
      permissions: {
        'coredoc-profile': {
          filesystem: {
            ':root': 'deny',
            ':minimal': 'read',
            [REPO]: 'read',
            [KIT]: 'read',
            '/opt/toolchain': 'read',
            [PARSER_DIR]: 'write',
            [path.join(REPO, '.env')]: 'deny',
            [path.join(REPO, '.env.*')]: 'deny',
            [path.join(REPO, '**/.env')]: 'deny',
            [path.join(REPO, '**/.env.*')]: 'deny',
            [path.join(KIT, '.env')]: 'deny',
            [path.join(KIT, '.env.*')]: 'deny',
            [path.join(KIT, '**/.env')]: 'deny',
            [path.join(KIT, '**/.env.*')]: 'deny',
            [path.join(PARSER_DIR, '.env')]: 'deny',
            [path.join(PARSER_DIR, '.env.*')]: 'deny',
            [path.join(PARSER_DIR, '**/.env')]: 'deny',
            [path.join(PARSER_DIR, '**/.env.*')]: 'deny',
            '/opt/toolchain/.env': 'deny',
            '/opt/toolchain/.env.*': 'deny',
            '/opt/toolchain/**/.env': 'deny',
            '/opt/toolchain/**/.env.*': 'deny',
          },
          network: { enabled: false },
        },
      },
    });
    expect(events[0]).toEqual({ type: AgentRunEventType.Phase, phase: AgentRunPhase.Running });
    expect(events).toContainEqual({
      type: AgentRunEventType.Todos,
      items: [
        { text: 'Ground in repo shape', status: AgentTodoStatus.Completed },
        { text: 'Draft profile', status: AgentTodoStatus.InProgress },
        { text: 'Finalize profile', status: AgentTodoStatus.Pending },
      ],
    });
    expect(events).toContainEqual({
      type: AgentRunEventType.Done,
      ok: true,
      sessionId: 'thread-1',
      numTurns: 1,
      toolCalls: 2,
      durationMs: 42,
    });
    const rawLines = events.flatMap((event) => (event.type === AgentRunEventType.Raw ? [event.text] : []));
    expect(rawLines).toContain('[text] Finished');
    // No per-token delta lines, no reasoning/userMessage noise.
    expect(rawLines.some((line) => line === '[text] Fin')).toBe(false);
    expect(rawLines.some((line) => line.includes('reasoning') || line.includes('userMessage'))).toBe(false);
    // File changes are summarized by their target paths, not the diff payload.
    expect(rawLines.some((line) => line === '[tool] fileChange /work/parsers/repo/profile.ts')).toBe(true);
    expect(rawLines.filter((line) => line.includes('/work/parsers/repo/profile.ts'))).toHaveLength(1);
    expect(rawLines.some((line) => line.includes('export const x'))).toBe(false);
    expect(rawLines.filter((line) => line.includes('node score.js'))).toHaveLength(1);
    expect(rawLines).toContain('[result] commandExecution failed exit=1 12ms · spawnSync node ENOENT');
    expect(rawLines).toContain('[warning] Coredoc declined an unexpected command approval request.');
    expect(request.onCommandCompleted).toHaveBeenCalledWith({
      command: 'node score.js',
      success: false,
      output: 'spawnSync node ENOENT',
    });
  });

  it('registers and round-trips the Coredoc user-input dynamic tool by question id', async () => {
    let response: unknown;
    let dynamicTools: CodexAppServerRunOptions['dynamicTools'];
    const adapter = new CodexAdapter('/bundled/codex', () => ({
      run: async (options) => {
        dynamicTools = options.dynamicTools;
        response = await options.onDynamicToolCall?.({
          tool: 'coredoc_request_user_input',
          arguments: {
            questions: [
              {
                id: 'coverage',
                header: 'Coverage',
                question: 'What should be covered?',
                multiSelect: false,
                options: [{ label: 'Full repo', description: 'All packages' }],
              },
            ],
          },
        });
        return { threadId: 'thread-1', turnId: 'turn-1', status: 'completed', turns: 1 };
      },
    }));

    const request = makeRequest();
    request.onQuestionAnswered = vi.fn();
    await adapter.run(request, makeIO([['Full repo']]).io);

    expect(dynamicTools).toEqual([
      expect.objectContaining({ type: 'function', name: 'coredoc_request_user_input' }),
      expect.objectContaining({ type: 'function', name: 'coredoc_update_plan' }),
    ]);
    expect(response).toEqual({
      success: true,
      contentItems: [
        { type: 'inputText', text: JSON.stringify({ answers: { coverage: { answers: ['Full repo'] } } }) },
      ],
    });
    expect(request.onQuestionAnswered).toHaveBeenCalledWith(
      [expect.objectContaining({ question: 'What should be covered?' })],
      [['Full repo']],
    );
  });

  it('nudges Codex with follow-up turns while the deliverable is missing, bounded by the turn cap', async () => {
    let nextTurn: ((completedTurns: number) => string | null) | undefined;
    const adapter = new CodexAdapter('/bundled/codex', () => ({
      run: async (options) => {
        nextTurn = options.nextTurn;
        return { threadId: 'thread-1', turnId: 'turn-1', status: 'completed', turns: 3 };
      },
    }));
    const { io, events } = makeIO();
    let candidateExists = false;
    let verificationFailure: string | null = 'The profile is not written.';
    const request = makeRequest();
    request.verifyCompletion = () => verificationFailure;
    request.deliverableExists = () => candidateExists;

    await adapter.run(request, io);

    // Deliverable missing → a continuation prompt that restates the failure.
    expect(nextTurn?.(1)).toContain('The profile is not written.');
    expect(nextTurn?.(1)).toContain('coredoc_request_user_input');
    expect(nextTurn?.(1)).toContain('every later profile edit, including comments, requires another score run');
    // Regeneration starts with a copied profile.ts. Its mere existence must not collapse the
    // normal scout/draft/score budget to the single final-recovery turn.
    candidateExists = true;
    expect(nextTurn?.(2)).toContain('The profile is not written.');
    expect(nextTurn?.(4)).toContain('The profile is not written.');
    // Deliverable present → stop nudging.
    verificationFailure = null;
    expect(nextTurn?.(4)).toBeNull();
    // A final scored PARTIAL needs a decision, not another score that discards that decision.
    verificationFailure = "The current profile's score result is FAIL with PARTIAL coverage only.";
    const acceptancePrompt = nextTurn?.(4);
    expect(acceptancePrompt).toContain('ask via coredoc_request_user_input now');
    expect(acceptancePrompt).toContain('finish without editing the profile or rerunning scoring');
    expect(acceptancePrompt).not.toContain('Run the exact score command before finalizing');
    // Four directional-scout hand-offs may consume turns 1–5; candidate repair has its own budget.
    verificationFailure = 'The current profile revision has not been scored after the latest edit.';
    expect(nextTurn?.(5)).toContain('Do not edit profile.ts before first rerunning the exact score command');
    // The independent final repair budget remains bounded.
    expect(nextTurn?.(6)).toBeNull();
    // The turns the client actually ran ride the Done event.
    expect(events).toContainEqual(expect.objectContaining({ type: AgentRunEventType.Done, ok: true, numTurns: 3 }));
  });
});
