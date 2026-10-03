import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessMode, TreatmentAdherence } from './types.js';

// Toggled per-test: 'abort' never resolves until the harness's own
// AbortController fires (mirrors the SDK's generic "Claude Code process
// aborted by user" message); 'complete' yields one terminal result message
// so runAgent finishes normally and we can inspect the returned model.
let mockBehavior: 'abort' | 'complete' = 'abort';
let capturedQueryOptions: Record<string, unknown> | undefined;
let mockMessages: unknown[] | null = null;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: { options: { abortController: AbortController } }) => {
    capturedQueryOptions = opts.options;
    return {
      [Symbol.asyncIterator]() {
        let delivered = false;
        let index = 0;
        return {
          next: () => {
            if (mockMessages) {
              if (index >= mockMessages.length) return Promise.resolve({ value: undefined, done: true });
              return Promise.resolve({ value: mockMessages[index++], done: false });
            }
            if (mockBehavior === 'complete') {
              if (delivered) return Promise.resolve({ value: undefined, done: true });
              delivered = true;
              return Promise.resolve({
                value: { type: 'result', subtype: 'success', usage: {} },
                done: false,
              });
            }
            return new Promise((_resolve, reject) => {
              opts.options.abortController.signal.addEventListener('abort', () => {
                reject(new Error('Claude Code process aborted by user'));
              });
            });
          },
        };
      },
    };
  },
}));

const {
  buildAllowedTools,
  decideConfinedToolUse,
  worktreeConfinementPolicy,
  runAgent,
  ClaudeMcpAvailability,
  EVAL_MCP_SERVER_NAME,
  evaluateInitMcpAvailability,
  classifyClaudeAdherence,
  REQUIRED_MCP_TOOL_NAMES,
} = await import('./agent.js');

/**
 * A cwd that satisfies the dispatch precondition: agents are only spawned into a
 * materialized checkout (see agentWorkspaceFault). No-checkout cases
 * deliberately keep using a bare mkdtempSync directory.
 */
function checkoutDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, 'source.ts'), 'export const truth = 1;\n');
  return dir;
}

describe('buildAllowedTools', () => {
  it('uses the provided base tools and appends extras', () => {
    expect(buildAllowedTools(['Read', 'Grep', 'Glob'], ['TodoWrite'], false)).toEqual([
      'Read', 'Grep', 'Glob', 'TodoWrite',
    ]);
  });

  it('appends only registered coredoc-eval MCP tools when includeMcp is true', () => {
    const tools = buildAllowedTools(['Read'], [], true);
    expect(tools).toContain('mcp__coredoc-eval__trace_cross_repo_call');
    expect(tools).toContain('mcp__coredoc-eval__describe_db_schema');
    expect(tools).toContain('mcp__coredoc-eval__get_extraction_coverage');
    // run_cypher_query is only listed/dispatchable by the server on
    // ladybug/neo4j backends; allowing it here is harmless on sqlite runs.
    expect(tools).toContain('mcp__coredoc-eval__run_cypher_query');
    expect(tools.filter((t) => !t.startsWith('mcp__coredoc-eval__'))).toEqual(['Read']);
    expect(tools).not.toContain('mcp__coredoc-eval__explain_function');
    expect(tools).not.toContain('mcp__coredoc-eval__explain_entrypoint');
    expect(tools).not.toContain('mcp__coredoc-eval__trace_execution_path');
    expect(tools).not.toContain('mcp__coredoc-eval__trace_data_flow');
    expect(tools).not.toContain('mcp__coredoc-eval__list_topics');
    expect(tools).not.toContain('mcp__coredoc-eval__trace_topic');
  });
});

describe('evaluateInitMcpAvailability', () => {
  function init(overrides: Record<string, unknown>): Record<string, unknown> {
    return { type: 'system', subtype: 'init', ...overrides };
  }

  /** The whole required toolset, as a session's init record would list it. */
  const requiredTools = [...REQUIRED_MCP_TOOL_NAMES];

  it('reports unknown for any message that is not a system/init record', () => {
    expect(evaluateInitMcpAvailability({ type: 'assistant' }, EVAL_MCP_SERVER_NAME)).toBe(
      ClaudeMcpAvailability.Unknown,
    );
    expect(
      evaluateInitMcpAvailability({ type: 'system', subtype: 'compact' }, EVAL_MCP_SERVER_NAME),
    ).toBe(ClaudeMcpAvailability.Unknown);
    expect(evaluateInitMcpAvailability(null, EVAL_MCP_SERVER_NAME)).toBe(
      ClaudeMcpAvailability.Unknown,
    );
  });

  it('reports available when the server is connected and advertises the whole required toolset', () => {
    expect(
      evaluateInitMcpAvailability(
        init({
          tools: ['Read', 'Bash', ...requiredTools],
          mcp_servers: [{ name: EVAL_MCP_SERVER_NAME, status: 'connected' }],
        }),
        EVAL_MCP_SERVER_NAME,
      ),
    ).toBe(ClaudeMcpAvailability.Available);
  });

  it('reports available for a required toolset without run_cypher_query, which only ladybug/neo4j advertise', () => {
    const tools = ['Read', ...requiredTools];
    expect(tools).not.toContain(`mcp__${EVAL_MCP_SERVER_NAME}__run_cypher_query`);
    expect(
      evaluateInitMcpAvailability(
        init({
          tools,
          mcp_servers: [{ name: EVAL_MCP_SERVER_NAME, status: 'connected' }],
        }),
        EVAL_MCP_SERVER_NAME,
      ),
    ).toBe(ClaudeMcpAvailability.Available);
  });

  it('reports unavailable when the connected server advertises only part of the required toolset', () => {
    expect(
      evaluateInitMcpAvailability(
        init({
          tools: [
            'Read',
            ...requiredTools.filter(
              (name) => name !== `mcp__${EVAL_MCP_SERVER_NAME}__find_dependents`,
            ),
          ],
          mcp_servers: [{ name: EVAL_MCP_SERVER_NAME, status: 'connected' }],
        }),
        EVAL_MCP_SERVER_NAME,
      ),
    ).toBe(ClaudeMcpAvailability.Unavailable);
  });

  it('reports unavailable when the server connected but advertises none of its tools', () => {
    expect(
      evaluateInitMcpAvailability(
        init({
          tools: ['Read', 'mcp__other__explain'],
          mcp_servers: [{ name: EVAL_MCP_SERVER_NAME, status: 'connected' }],
        }),
        EVAL_MCP_SERVER_NAME,
      ),
    ).toBe(ClaudeMcpAvailability.Unavailable);
  });

  it('reports unavailable when the required server is absent from the init record', () => {
    expect(
      evaluateInitMcpAvailability(
        init({
          tools: ['Read', ...requiredTools],
          mcp_servers: [{ name: 'some-other-server', status: 'connected' }],
        }),
        EVAL_MCP_SERVER_NAME,
      ),
    ).toBe(ClaudeMcpAvailability.Unavailable);
  });

  it('reports unavailable when the server is listed with a non-connected status', () => {
    expect(
      evaluateInitMcpAvailability(
        init({
          tools: ['Read', ...requiredTools],
          mcp_servers: [{ name: EVAL_MCP_SERVER_NAME, status: 'failed' }],
        }),
        EVAL_MCP_SERVER_NAME,
      ),
    ).toBe(ClaudeMcpAvailability.Unavailable);
  });

  it('reports unavailable — not unknown — for a malformed init record, which is itself the probe', () => {
    expect(evaluateInitMcpAvailability(init({}), EVAL_MCP_SERVER_NAME)).toBe(
      ClaudeMcpAvailability.Unavailable,
    );
    expect(
      evaluateInitMcpAvailability(
        init({ tools: 'Read', mcp_servers: [{ name: EVAL_MCP_SERVER_NAME, status: 'connected' }] }),
        EVAL_MCP_SERVER_NAME,
      ),
    ).toBe(ClaudeMcpAvailability.Unavailable);
    expect(
      evaluateInitMcpAvailability(
        init({ tools: requiredTools, mcp_servers: 'connected' }),
        EVAL_MCP_SERVER_NAME,
      ),
    ).toBe(ClaudeMcpAvailability.Unavailable);
  });
});

describe('classifyClaudeAdherence', () => {
  const base = {
    probeApplicable: true,
    availability: ClaudeMcpAvailability.Available,
    agentCompleted: true,
    madeRequiredMcpCall: false,
  };

  it('is not applicable when the arm or harness carries no MCP probe', () => {
    expect(
      classifyClaudeAdherence({ ...base, probeApplicable: false, madeRequiredMcpCall: true }),
    ).toBe(TreatmentAdherence.NotApplicable);
  });

  it('is compliant when a completed run called the required server', () => {
    expect(classifyClaudeAdherence({ ...base, madeRequiredMcpCall: true })).toBe(
      TreatmentAdherence.Compliant,
    );
  });

  it('is noncompliant when tools were provably available and a completed run used none', () => {
    expect(classifyClaudeAdherence(base)).toBe(TreatmentAdherence.Noncompliant);
  });

  it('is not applicable when availability is unknown, since noncompliance needs probe evidence', () => {
    expect(
      classifyClaudeAdherence({ ...base, availability: ClaudeMcpAvailability.Unknown }),
    ).toBe(TreatmentAdherence.NotApplicable);
  });

  it('is not applicable when tools were unavailable — the treatment was never applied', () => {
    expect(
      classifyClaudeAdherence({ ...base, availability: ClaudeMcpAvailability.Unavailable }),
    ).toBe(TreatmentAdherence.NotApplicable);
  });

  it('is not applicable when the run never completed', () => {
    expect(classifyClaudeAdherence({ ...base, agentCompleted: false })).toBe(
      TreatmentAdherence.NotApplicable,
    );
    expect(
      classifyClaudeAdherence({ ...base, agentCompleted: false, madeRequiredMcpCall: true }),
    ).toBe(TreatmentAdherence.NotApplicable);
  });
});

describe('runAgent MCP availability probe', () => {
  async function runMatrixCell(messages: unknown[]) {
    mockMessages = messages;
    const dir = checkoutDir('evals-agent-mcp-probe-');
    try {
      return await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withMcp',
        accessMode: AccessMode.Worktree,
        extraTools: [],
        mcpServerCommand: '/tmp/mcp-server.js',
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });
    } finally {
      mockMessages = null;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const connectedInit = {
    type: 'system',
    subtype: 'init',
    tools: ['Read', ...REQUIRED_MCP_TOOL_NAMES],
    mcp_servers: [{ name: EVAL_MCP_SERVER_NAME, status: 'connected' }],
  };

  it('aborts and reports infrastructure_error when the init record advertises no MCP tools', async () => {
    const result = await runMatrixCell([
      {
        type: 'system',
        subtype: 'init',
        tools: ['Read', 'Bash'],
        mcp_servers: [{ name: EVAL_MCP_SERVER_NAME, status: 'failed' }],
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'an ungraded answer' },
    ]);
    expect(result.agentStatus).toBe('infrastructure_error');
    expect(result.error).toContain(
      `required MCP server ${EVAL_MCP_SERVER_NAME} did not advertise its required toolset`,
    );
    expect(result.error).toContain('withMcp treatment was never applied');
    expect(result.treatmentAdherence).toBe(TreatmentAdherence.NotApplicable);
  });

  it('aborts when the connected server advertises only part of the required toolset', async () => {
    const result = await runMatrixCell([
      {
        type: 'system',
        subtype: 'init',
        tools: ['Read', `mcp__${EVAL_MCP_SERVER_NAME}__explain`],
        mcp_servers: [{ name: EVAL_MCP_SERVER_NAME, status: 'connected' }],
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'an ungraded answer' },
    ]);
    expect(result.agentStatus).toBe('infrastructure_error');
    expect(result.error).toContain(
      `required MCP server ${EVAL_MCP_SERVER_NAME} did not advertise its required toolset`,
    );
    expect(result.treatmentAdherence).toBe(TreatmentAdherence.NotApplicable);
  });

  it('marks a completed run that used the reachable server as compliant', async () => {
    const result = await runMatrixCell([
      connectedInit,
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: `mcp__${EVAL_MCP_SERVER_NAME}__explain`, input: {} },
          ],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'answer' },
    ]);
    expect(result.agentStatus).toBe('completed');
    expect(result.treatmentAdherence).toBe(TreatmentAdherence.Compliant);
  });

  it('marks a completed run that ignored the reachable server as noncompliant', async () => {
    const result = await runMatrixCell([
      connectedInit,
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'answer' },
    ]);
    expect(result.agentStatus).toBe('completed');
    expect(result.error).toBeNull();
    expect(result.treatmentAdherence).toBe(TreatmentAdherence.Noncompliant);
  });

  it('leaves adherence not applicable for harnesses that set no access mode', async () => {
    // run-planning.ts calls runAgent without accessMode and owns
    // its adherence semantics; the probe must not reclassify its runs.
    mockMessages = [
      {
        type: 'system',
        subtype: 'init',
        tools: ['Read'],
        mcp_servers: [{ name: EVAL_MCP_SERVER_NAME, status: 'failed' }],
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'answer' },
    ];
    const dir = checkoutDir('evals-agent-mcp-probe-unset-mode-');
    try {
      const result = await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withMcp',
        extraTools: [],
        mcpServerCommand: '/tmp/mcp-server.js',
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });
      expect(result.agentStatus).toBe('completed');
      expect(result.responseText).toBe('answer');
      expect(result.treatmentAdherence).toBe(TreatmentAdherence.NotApplicable);
    } finally {
      mockMessages = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAgent timeout error rewriting', () => {
  it('rewrites the SDK abort message into an unambiguous harness-timeout message', async () => {
    mockBehavior = 'abort';
    const dir = checkoutDir('evals-agent-');
    try {
      const transcriptPath = join(dir, 'transcript.json');
      const result = await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp',
        extraTools: [],
        maxTurns: 5,
        timeoutMs: 10,
        transcriptPath,
      });
      expect(result.error).toContain('harness timeout after 10ms');
      expect(result.error).toContain('SDK reported: Claude Code process aborted by user');
      expect(result.agentStatus).toBe('task_failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAgent terminal contract', () => {
  async function runWith(messages: unknown[], outputSchema?: Record<string, unknown>) {
    mockMessages = messages;
    const dir = checkoutDir('evals-agent-terminal-');
    try {
      return await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp',
        extraTools: [],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
        outputSchema,
        accessMode: AccessMode.HistorylessSnapshot,
      });
    } finally {
      mockMessages = null;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('uses structured output independently of prose and refuses missing structured results', async () => {
    const schema = { type: 'object', properties: { bindings: { type: 'array' } }, required: ['bindings'] };
    const result = await runWith([
      { type: 'result', subtype: 'success', is_error: false, result: 'Confirmed. See JSON below.', structured_output: {bindings: []} },
    ], schema);
    expect(result.responseText).toBe('{"bindings":[]}');
    expect(capturedQueryOptions?.outputFormat).toEqual({type: 'json_schema', schema});
    const hook = (capturedQueryOptions?.hooks as {PreToolUse: {hooks: ((input:unknown)=>Promise<unknown>)[]}[]}).PreToolUse[0]!.hooks[0]!;
    expect(await hook({hook_event_name:'PreToolUse',tool_name:'StructuredOutput',tool_input:{bindings:[]}})).toEqual({});
    const permit = capturedQueryOptions?.canUseTool as (name:string,input:Record<string,unknown>)=>Promise<unknown>;
    expect(await permit('StructuredOutput', {bindings:[]})).toMatchObject({behavior:'allow'});

    const missing = await runWith([
      { type: 'result', subtype: 'success', is_error: false, result: '{"bindings":[]}' },
    ], schema);
    expect(missing.agentStatus).toBe('task_failed');
    expect(missing.responseText).toBe('');
    expect(missing.error).toMatch(/structured output/i);
  });

  it('uses the SDK terminal success result, never short assistant progress text', async () => {
    const result = await runWith([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'progress preamble' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
    ]);
    expect(result.responseText).toBe('ok');
    expect(result.agentStatus).toBe('completed');
    expect(result.error).toBeNull();
  });

  it('keeps a substantive terminal result even when earlier turns are longer', async () => {
    const answer = `## Answer\n${'a'.repeat(500)}`;
    const result = await runWith([
      { type: 'assistant', message: { content: [{ type: 'text', text: `${'b'.repeat(5000)}` }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
      { type: 'result', subtype: 'success', is_error: false, result: answer },
    ]);
    expect(result.responseText).toBe(answer);
  });

  it('recovers the answer when a background task acknowledgment lands after it', async () => {
    // Observed 2026-08-24: a backgrounded Bash task completed after the agent
    // had written its plan, so the SDK's last turn — and `result` — was a
    // 328-byte "that background find is no longer needed" note.
    const plan = `## Plan: Fixed Daily Overtime Threshold\n${'detail. '.repeat(120)}`;
    const acknowledgment =
      'That task was the earlier `find` for the client package, which I already retrieved and used. ' +
      'No new information to add; it does not change the plan above.';
    const result = await runWith([
      { type: 'assistant', message: { content: [{ type: 'text', text: plan }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: acknowledgment }] } },
      { type: 'result', subtype: 'success', is_error: false, result: acknowledgment },
    ]);
    expect(result.responseText).toBe(plan.trim());
    expect(result.agentStatus).toBe('completed');
  });

  it('accepts a short terminal answer as completed', async () => {
    const result = await runWith([
      { type: 'result', subtype: 'success', is_error: false, result: 'yes' },
    ]);
    expect(result).toMatchObject({ responseText: 'yes', agentStatus: 'completed', error: null });
  });

  it('classifies max-turn exhaustion as task failure with no progress answer', async () => {
    const result = await runWith([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'still working' }] } },
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'limit' },
    ]);
    expect(result.agentStatus).toBe('task_failed');
    expect(result.responseText).toBe('');
  });

  it('classifies EOF without a result as infrastructure error', async () => {
    const result = await runWith([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'only progress' }] } },
    ]);
    expect(result.agentStatus).toBe('infrastructure_error');
    expect(result.responseText).toBe('');
    expect(result.error).toMatch(/ended before a terminal result/);
  });
});

describe('runAgent --claude-model passthrough', () => {
  it('records the requested model on the result (default claude-sonnet-5)', async () => {
    mockBehavior = 'complete';
    const dir = checkoutDir('evals-agent-');
    try {
      const result = await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp',
        extraTools: [],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });
      expect(result.model).toBe('claude-sonnet-5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records an overridden model (e.g. --claude-model=claude-opus-5-5)', async () => {
    mockBehavior = 'complete';
    const dir = checkoutDir('evals-agent-');
    try {
      const result = await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-opus-5-5',
        cwd: dir,
        arm: 'withoutMcp',
        extraTools: [],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });
      expect(result.model).toBe('claude-opus-5-5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAgent planning extensions', () => {
  it('passes local plugins and requested skills through SDK-supported options', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = checkoutDir('evals-agent-extensions-');
    try {
      await runAgent({
        prompt: 'hi',
        systemPrompt: 'planning system',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withMcp',
        baseTools: ['Read', 'Grep', 'Glob'],
        extraTools: [],
        pluginPaths: ['/plugins/superpowers', '/plugins/coredoc'],
        skills: ['superpowers:brainstorming', 'coredoc-eval-skills:coredoc-mcp'],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });

      expect(capturedQueryOptions?.plugins).toEqual([
        { type: 'local', path: '/plugins/superpowers' },
        { type: 'local', path: '/plugins/coredoc' },
      ]);
      expect(capturedQueryOptions?.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(capturedQueryOptions).not.toHaveProperty('skills');
      expect(capturedQueryOptions?.agent).toBe('coredoc-eval-main');
      expect(capturedQueryOptions?.agents).toEqual({
        'coredoc-eval-main': {
          description: 'Runs the configured Coredoc evaluation arm.',
          prompt: 'planning system',
          skills: ['superpowers:brainstorming', 'coredoc-eval-skills:coredoc-mcp'],
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([AccessMode.NoCheckout, AccessMode.HistorylessSnapshot])(
    'rejects plugin or skill loading in isolated mode %s before SDK dispatch',
    async (accessMode) => {
      mockBehavior = 'complete';
      capturedQueryOptions = undefined;
      const dir = checkoutDir('evals-agent-isolated-extensions-');
      try {
        await expect(
          runAgent({
            prompt: 'hi',
            systemPrompt: 'sys',
            model: 'claude-sonnet-5',
            cwd: dir,
            arm: 'withoutMcp',
            accessMode,
            extraTools: [],
            pluginPaths: ['/plugins/untrusted'],
            skills: ['plugin:skill'],
            maxTurns: 5,
            timeoutMs: 10_000,
            transcriptPath: join(dir, 'transcript.json'),
          }),
        ).rejects.toThrow(/plugin.*skill.*isolated/i);
        expect(capturedQueryOptions).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('runAgent no-checkout tool isolation', () => {
  it('exposes only coredoc-eval MCP tools in the with-MCP arm', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-'));
    try {
      const options = {
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withMcp' as const,
        accessMode: AccessMode.NoCheckout,
        extraTools: ['TodoWrite'],
        baseTools: ['Read'],
        mcpServerCommand: '/tmp/mcp-server.js',
        mcpServerEnv: { COREDOC_SCOPE: 'project:acme' },
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      };
      await runAgent(options);

      expect(capturedQueryOptions?.tools).toEqual([]);
      expect(capturedQueryOptions?.allowedTools).toEqual(buildAllowedTools([], [], true));
      expect(capturedQueryOptions?.allowedTools).toEqual(
        expect.arrayContaining([expect.stringMatching(/^mcp__coredoc-eval__/)]),
      );
      expect(
        (capturedQueryOptions?.allowedTools as string[]).every((tool) =>
          tool.startsWith('mcp__coredoc-eval__'),
        ),
      ).toBe(true);
      expect(capturedQueryOptions?.mcpServers).toEqual({
        'coredoc-eval': {
          command: 'node',
          args: ['/tmp/mcp-server.js'],
          env: {
            COREDOC_SCOPE: 'project:acme',
            COREDOC_MCP_METRICS_DISABLED: '1',
          },
        },
      });
      expect(capturedQueryOptions?.strictMcpConfig).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disables every built-in and connector in the without-MCP arm', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-'));
    try {
      const options = {
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp' as const,
        accessMode: AccessMode.NoCheckout,
        extraTools: ['TodoWrite'],
        baseTools: ['Read'],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      };
      await runAgent(options);

      expect(capturedQueryOptions?.tools).toEqual([]);
      expect(capturedQueryOptions?.allowedTools).toEqual([]);
      expect(capturedQueryOptions?.mcpServers).toEqual({});
      expect(capturedQueryOptions?.strictMcpConfig).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps worktree filesystem tools but suppresses every account MCP connector', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = checkoutDir('evals-agent-');
    try {
      await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp',
        extraTools: ['TodoWrite'],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });

      expect(capturedQueryOptions?.tools).toBeUndefined();
      expect(capturedQueryOptions?.allowedTools).toEqual([
        'Read',
        'Grep',
        'Glob',
        'Bash',
        'TodoWrite',
      ]);
      expect(capturedQueryOptions?.mcpServers).toEqual({});
      expect(capturedQueryOptions?.strictMcpConfig).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAgent workspace precondition', () => {
  it('reports infrastructure_error without dispatching when the cwd does not exist', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-missing-'));
    const missing = join(dir, 'eval-claude-target-withoutMcp-agent');
    try {
      const result = await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: missing,
        arm: 'withoutMcp',
        accessMode: AccessMode.Worktree,
        extraTools: [],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });

      expect(capturedQueryOptions).toBeUndefined();
      expect(result.agentStatus).toBe('infrastructure_error');
      expect(result.error).toContain(missing);
      expect(result.error).toContain('ENOENT');
      expect(result.responseText).toBe('');
      expect(result.usage.totalTokens).toBe(0);
      expect(readFileSync(join(dir, 'transcript.json'), 'utf8')).toBe('[]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports infrastructure_error without dispatching when a checkout cwd is empty', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-empty-'));
    try {
      const result = await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp',
        accessMode: AccessMode.Worktree,
        extraTools: [],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });

      expect(capturedQueryOptions).toBeUndefined();
      expect(result.agentStatus).toBe('infrastructure_error');
      expect(result.error).toMatch(/is empty; expected a materialized checkout/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an unspecified access mode as a checkout, not as no-checkout', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-default-'));
    try {
      const result = await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp',
        extraTools: [],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });

      expect(capturedQueryOptions).toBeUndefined();
      expect(result.agentStatus).toBe('infrastructure_error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still dispatches no-checkout runs, whose empty cwd is the treatment', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-no-checkout-'));
    try {
      const result = await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp',
        accessMode: AccessMode.NoCheckout,
        extraTools: [],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });

      expect(capturedQueryOptions).toBeDefined();
      expect(result.agentStatus).toBe('completed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAgent worktree permission envelope', () => {
  it('confines explicitly enabled Edit and Write tools to the current checkout', () => {
    const dir = checkoutDir('evals-agent-edit-');
    const outside = checkoutDir('evals-agent-outside-');
    try {
      const policy = worktreeConfinementPolicy(dir, false, ['Read', 'Edit', 'Write'], [outside]);
      symlinkSync(outside, join(dir, 'outside-link'));
      symlinkSync(join(outside, 'missing.ts'), join(dir, 'dangling-link.ts'));
      symlinkSync(dir, join(dir, 'inside-link'));
      for (const tool of ['Edit', 'Write']) {
        expect(decideConfinedToolUse(policy, tool, { file_path: join(dir, 'outside-link/new/sub/file.ts') })).toBe('deny');
        expect(decideConfinedToolUse(policy, tool, { file_path: join(dir, 'dangling-link.ts') })).toBe('deny');
        expect(decideConfinedToolUse(policy, tool, { file_path: join(dir, 'inside-link/new/sub/file.ts') })).toBe('allow');
        expect(decideConfinedToolUse(policy, tool, { file_path: join(dir, 'new.ts') })).toBe('allow');
        expect(decideConfinedToolUse(policy, tool, { file_path: join(outside, 'source.ts') })).toBe('deny');
        expect(decideConfinedToolUse({ ...policy, allowedTools: ['Read'] }, tool, { file_path: join(dir, 'source.ts') })).toBe('deny');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('confines filesystem tools to the pinned worktree while leaving MCP tools alone', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = checkoutDir('evals-agent-worktree-');
    const outside = checkoutDir('evals-agent-live-checkout-');
    const audit: Array<{ phase: string; toolName: string; behavior: string }> = [];
    try {
      symlinkSync(join(outside, 'source.ts'), join(dir, 'escape.ts'));
      symlinkSync('source.ts', join(dir, 'internal-link.ts'));
      await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withMcp',
        accessMode: AccessMode.Worktree,
        extraTools: ['TodoWrite'],
        mcpServerCommand: '/tmp/mcp-server.js',
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
        onPermissionAudit: (entry) => audit.push(entry),
      });
      const canUseTool = capturedQueryOptions?.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
      ) => Promise<{ behavior: string }>;

      // Worktree tooling is unchanged: the full base toolset stays advertised.
      expect(capturedQueryOptions?.tools).toBeUndefined();
      expect(capturedQueryOptions?.allowedTools).toContain('Bash');
      expect(capturedQueryOptions?.settingSources).toBeUndefined();
      expect(capturedQueryOptions?.persistSession).toBeUndefined();

      await expect(
        canUseTool('Read', { file_path: join(dir, 'source.ts') }),
      ).resolves.toMatchObject({ behavior: 'allow' });
      // A checkout may contain symlinks; only where they land matters.
      await expect(
        canUseTool('Read', { file_path: join(dir, 'internal-link.ts') }),
      ).resolves.toMatchObject({ behavior: 'allow' });
      // A path the agent guesses before it exists is still judged by location.
      await expect(
        canUseTool('Read', { file_path: join(dir, 'src/not-yet.ts') }),
      ).resolves.toMatchObject({ behavior: 'allow' });
      await expect(
        canUseTool('Grep', { path: dir, pattern: 'truth' }),
      ).resolves.toMatchObject({ behavior: 'allow' });
      await expect(canUseTool('Bash', { command: 'ls -la src 2>/dev/null' })).resolves.toMatchObject(
        { behavior: 'allow' },
      );
      await expect(canUseTool('TodoWrite', { todos: [] })).resolves.toMatchObject({
        behavior: 'allow',
      });
      // ToolSearch is the deferred-tool schema loader on newer CLI builds; a
      // deny here bricks the whole session before its first Read (live incident
      // 2026-08-28: every worktree agent turn died on the envelope).
      await expect(canUseTool('ToolSearch', { query: 'select:Read' })).resolves.toMatchObject({
        behavior: 'allow',
      });

      // The 2026-08-24 breach shape: a second, unpinned checkout of the repo.
      await expect(
        canUseTool('Read', { file_path: join(outside, 'source.ts') }),
      ).resolves.toMatchObject({ behavior: 'deny' });
      await expect(canUseTool('Read', { file_path: '../source.ts' })).resolves.toMatchObject({
        behavior: 'deny',
      });
      await expect(
        canUseTool('Read', { file_path: join(dir, 'escape.ts') }),
      ).resolves.toMatchObject({ behavior: 'deny' });
      await expect(canUseTool('Glob', { path: dir, pattern: '../**/*' })).resolves.toMatchObject({
        behavior: 'deny',
      });
      await expect(canUseTool('Bash', { command: `cat ${outside}/source.ts` })).resolves.toMatchObject(
        { behavior: 'deny' },
      );
      await expect(canUseTool('Bash', { command: 'cat ../source.ts' })).resolves.toMatchObject({
        behavior: 'deny',
      });
      await expect(canUseTool('Edit', { file_path: join(dir, 'source.ts') })).resolves.toMatchObject(
        { behavior: 'deny' },
      );

      // MCP is the treatment and is never path-gated.
      const mcpInput = {};
      await expect(
        canUseTool('mcp__coredoc-eval__describe_repository', mcpInput),
      ).resolves.toEqual({ behavior: 'allow', updatedInput: mcpInput });
      await expect(canUseTool('mcp__other__describe_repository', {})).resolves.toMatchObject({
        behavior: 'deny',
      });

      const preToolUse = (
        capturedQueryOptions?.hooks as {
          PreToolUse: Array<{
            hooks: Array<(
              input: Record<string, unknown>,
              toolUseId: string,
            ) => Promise<Record<string, unknown>>>;
          }>;
        }
      ).PreToolUse[0]!.hooks[0]!;
      await expect(
        preToolUse(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
            tool_input: { file_path: join(dir, 'source.ts') },
          },
          'inside-read',
        ),
      ).resolves.toEqual({});
      await expect(
        preToolUse(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
            tool_input: { file_path: join(outside, 'source.ts') },
          },
          'outside-read',
        ),
      ).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('worktree'),
        },
      });
      expect(audit).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'can-use-tool', toolName: 'Read', behavior: 'deny' }),
        expect.objectContaining({ phase: 'pre-tool-use', toolName: 'Read', behavior: 'deny' }),
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('extends the envelope to the pinned sibling roots and nothing else', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = checkoutDir('evals-agent-worktree-multi-');
    const sibling = checkoutDir('evals-agent-sibling-pinned-');
    const outside = checkoutDir('evals-agent-live-checkout-');
    try {
      await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withMcp',
        accessMode: AccessMode.Worktree,
        additionalReadRoots: [sibling],
        extraTools: [],
        mcpServerCommand: '/tmp/mcp-server.js',
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });
      const canUseTool = capturedQueryOptions?.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
      ) => Promise<{ behavior: string }>;

      await expect(
        canUseTool('Read', { file_path: join(sibling, 'source.ts') }),
      ).resolves.toMatchObject({ behavior: 'allow' });
      await expect(canUseTool('Grep', { path: sibling, pattern: 'truth' })).resolves.toMatchObject({
        behavior: 'allow',
      });
      await expect(
        canUseTool('Bash', { command: `cat ${sibling}/source.ts` }),
      ).resolves.toMatchObject({ behavior: 'allow' });
      // The cwd stays readable; a sibling root does not displace it.
      await expect(
        canUseTool('Read', { file_path: join(dir, 'source.ts') }),
      ).resolves.toMatchObject({ behavior: 'allow' });

      // An undeclared checkout is still outside the envelope.
      await expect(
        canUseTool('Read', { file_path: join(outside, 'source.ts') }),
      ).resolves.toMatchObject({ behavior: 'deny' });
      await expect(
        canUseTool('Bash', { command: `cat ${outside}/source.ts` }),
      ).resolves.toMatchObject({ behavior: 'deny' });
      // Traversal is rejected on its shape, regardless of where it would land.
      await expect(canUseTool('Read', { file_path: '../source.ts' })).resolves.toMatchObject({
        behavior: 'deny',
      });
      await expect(canUseTool('Bash', { command: 'cat ../source.ts' })).resolves.toMatchObject({
        behavior: 'deny',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('denies the control arm every MCP tool while keeping its filesystem access', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = checkoutDir('evals-agent-worktree-control-');
    try {
      await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp',
        accessMode: AccessMode.Worktree,
        extraTools: [],
        mcpServerCommand: '/tmp/mcp-server.js',
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });
      const canUseTool = capturedQueryOptions?.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
      ) => Promise<{ behavior: string }>;
      expect(capturedQueryOptions?.mcpServers).toEqual({});
      await expect(
        canUseTool('mcp__coredoc-eval__describe_repository', {}),
      ).resolves.toMatchObject({ behavior: 'deny' });
      await expect(
        canUseTool('Read', { file_path: join(dir, 'source.ts') }),
      ).resolves.toMatchObject({ behavior: 'allow' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds no envelope when the caller sets no explicit access mode', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = checkoutDir('evals-agent-unset-mode-');
    try {
      // The planning and intent harnesses call runAgent with no accessMode and
      // their own tool sets; adding an envelope there would silently deny them.
      await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp',
        extraTools: [],
        baseTools: ['Read', 'Grep', 'Glob'],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });
      expect(capturedQueryOptions?.canUseTool).toBeUndefined();
      expect(capturedQueryOptions?.hooks).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps no-checkout runs free of a filesystem envelope they have no cwd for', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-no-checkout-envelope-'));
    try {
      await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withMcp',
        accessMode: AccessMode.NoCheckout,
        extraTools: [],
        mcpServerCommand: '/tmp/mcp-server.js',
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });
      expect(capturedQueryOptions?.tools).toEqual([]);
      expect(capturedQueryOptions?.canUseTool).toBeUndefined();
      expect(capturedQueryOptions?.hooks).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAgent historyless snapshot tool confinement', () => {
  it('exposes only read tools plus the exact coredoc-eval server without auto-allowing tools', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-historyless-'));
    try {
      writeFileSync(join(dir, 'inside.ts'), 'export const inside = true;\n');
      await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withMcp',
        accessMode: AccessMode.HistorylessSnapshot,
        extraTools: ['TodoWrite'],
        baseTools: ['Read', 'Bash'],
        mcpServerCommand: '/tmp/mcp-server.js',
        mcpServerEnv: { COREDOC_SCOPE: 'target-repo' },
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });

      expect(capturedQueryOptions?.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(capturedQueryOptions?.allowedTools).toEqual([]);
      expect(capturedQueryOptions?.settingSources).toEqual([]);
      expect(capturedQueryOptions?.permissionMode).toBe('default');
      expect(capturedQueryOptions?.persistSession).toBe(false);
      expect(capturedQueryOptions?.hooks).toMatchObject({
        PreToolUse: [{ hooks: [expect.any(Function)] }],
      });
      expect(capturedQueryOptions?.mcpServers).toEqual({
        'coredoc-eval': {
          command: 'node',
          args: ['/tmp/mcp-server.js'],
          env: {
            COREDOC_SCOPE: 'target-repo',
            COREDOC_MCP_METRICS_DISABLED: '1',
          },
        },
      });
      expect(capturedQueryOptions?.strictMcpConfig).toBe(true);
      expect(capturedQueryOptions?.canUseTool).toBeTypeOf('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('confines every filesystem call and denies symlinks, unsafe patterns, and unknown tools', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-historyless-'));
    const outside = mkdtempSync(join(tmpdir(), 'evals-agent-outside-'));
    const audit: Array<{ phase: string; toolName: string; behavior: string }> = [];
    try {
      writeFileSync(join(dir, 'inside.ts'), 'export const inside = true;\n');
      writeFileSync(join(outside, 'secret.ts'), 'secret\n');
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'escape.ts'));
      symlinkSync('inside.ts', join(dir, 'inside-link.ts'));
      await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withMcp',
        accessMode: AccessMode.HistorylessSnapshot,
        extraTools: [],
        mcpServerCommand: '/tmp/mcp-server.js',
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
        onPermissionAudit: (entry) => audit.push(entry),
      });
      const canUseTool = capturedQueryOptions?.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
      ) => Promise<{ behavior: string }>;

      const readInput = { file_path: join(dir, 'inside.ts') };
      const grepInput = { path: dir, pattern: 'inside' };
      const globInput = { path: dir, pattern: '**/*.ts' };
      await expect(canUseTool('Read', readInput)).resolves.toEqual({
        behavior: 'allow',
        updatedInput: readInput,
      });
      await expect(canUseTool('Grep', grepInput)).resolves.toEqual({
        behavior: 'allow',
        updatedInput: grepInput,
      });
      await expect(canUseTool('Glob', globInput)).resolves.toEqual({
        behavior: 'allow',
        updatedInput: globInput,
      });
      await expect(canUseTool('Read', { file_path: join(outside, 'secret.ts') })).resolves.toMatchObject({ behavior: 'deny' });
      await expect(canUseTool('Read', { file_path: '../secret.ts' })).resolves.toMatchObject({ behavior: 'deny' });
      await expect(canUseTool('Read', { file_path: join(dir, 'escape.ts') })).resolves.toMatchObject({ behavior: 'deny' });
      await expect(canUseTool('Read', { file_path: join(dir, 'inside-link.ts') })).resolves.toMatchObject({ behavior: 'deny' });
      await expect(canUseTool('Glob', { path: dir, pattern: '../**/*' })).resolves.toMatchObject({ behavior: 'deny' });
      await expect(canUseTool('Glob', { path: dir, pattern: `${outside}/**/*` })).resolves.toMatchObject({ behavior: 'deny' });
      await expect(canUseTool('Bash', { command: 'pwd' })).resolves.toMatchObject({ behavior: 'deny' });
      await expect(canUseTool('Edit', { file_path: join(dir, 'inside.ts') })).resolves.toMatchObject({ behavior: 'deny' });
      const mcpInput = {};
      await expect(canUseTool('mcp__coredoc-eval__describe_repository', mcpInput)).resolves.toEqual({
        behavior: 'allow',
        updatedInput: mcpInput,
      });
      await expect(canUseTool('mcp__other__describe_repository', {})).resolves.toMatchObject({ behavior: 'deny' });

      const preToolUse = (
        capturedQueryOptions?.hooks as {
          PreToolUse: Array<{
            hooks: Array<(
              input: Record<string, unknown>,
              toolUseId: string,
            ) => Promise<Record<string, unknown>>>;
          }>;
        }
      ).PreToolUse[0]!.hooks[0]!;
      await expect(
        preToolUse(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
            tool_input: { file_path: join(dir, 'inside.ts') },
          },
          'inside-read',
        ),
      ).resolves.toEqual({});
      await expect(
        preToolUse(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
            tool_input: { file_path: join(outside, 'secret.ts') },
          },
          'outside-read',
        ),
      ).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
        },
      });
      expect(audit).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'pre-tool-use', toolName: 'Read', behavior: 'allow' }),
        expect.objectContaining({ phase: 'pre-tool-use', toolName: 'Read', behavior: 'deny' }),
        expect.objectContaining({ phase: 'can-use-tool', toolName: 'Bash', behavior: 'deny' }),
        expect.objectContaining({
          phase: 'can-use-tool',
          toolName: 'mcp__coredoc-eval__describe_repository',
          behavior: 'allow',
        }),
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('configures no MCP server or MCP permission in the control arm', async () => {
    mockBehavior = 'complete';
    capturedQueryOptions = undefined;
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-historyless-'));
    try {
      writeFileSync(join(dir, 'inside.ts'), 'export const inside = true;\n');
      await runAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'claude-sonnet-5',
        cwd: dir,
        arm: 'withoutMcp',
        accessMode: AccessMode.HistorylessSnapshot,
        extraTools: [],
        mcpServerCommand: '/tmp/mcp-server.js',
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });
      const canUseTool = capturedQueryOptions?.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
      ) => Promise<{ behavior: string }>;
      expect(capturedQueryOptions?.mcpServers).toEqual({});
      await expect(canUseTool('mcp__coredoc-eval__describe_repository', {})).resolves.toMatchObject({ behavior: 'deny' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
