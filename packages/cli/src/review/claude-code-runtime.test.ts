import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ReviewAccess, ReviewBudget } from './access.js';
import {
  claudeCodeEnv,
  claudeCodePhase,
  createClaudeCodeRuntime,
  isAbortedControlWrite,
  type ClaudeQuery,
  type ClaudeCodeRuntime,
} from './claude-code-runtime.js';
import { requestSchema, ReviewError, type GraphReader, type ReviewRequest, type SourceReader } from './contracts.js';

/** The SDK is stubbed so the tests never spawn the runtime; `tool()` hands back its own handler. */
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw new Error('the real query must never run in a unit test');
  },
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({
    name,
    description,
    shape,
    handler,
  }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ type: 'sdk', name, tools }),
}));

type Handler = (args: unknown) => Promise<{ content: Array<{ text: string }> }>;
// biome-ignore lint/suspicious/noExplicitAny: the fake stands in for the SDK's loosely typed options
type Options = Record<string, any>;
const schema = z.object({ answer: z.string() });
const source: SourceReader = {
  list: async () => ({ items: [{ path: 'src/a.ts', oid: 'a'.repeat(40), mode: '100644' }], gaps: [] }),
  read: async () => 'const a = 1;\nconst b = 2;\n',
  changes: async () => ({ items: [{ path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' }], gaps: [] }),
};
function request(overrides: Partial<ReviewRequest> = {}) {
  return requestSchema.parse({
    schemaVersion: 1,
    repository: 'owner/repo',
    pullNumber: 1,
    baseSha: 'a'.repeat(40),
    mergeBaseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    mode: 'historical',
    arm: 'A',
    policy: { version: 'test', text: '' },
    model: { provider: 'claude-code', id: 'sonnet' },
    ...overrides,
  });
}
function access(secrets: string[] = [], graph?: GraphReader) {
  const req = request();
  const budget = new ReviewBudget(req, new AbortController().signal);
  return new ReviewAccess(req, source, budget, [], secrets, graph);
}
/** Hard-coded so an init assertion checks the runtime's own allowlist, not the fixture's echo. */
const HOST_TOOLS = [
  'mcp__coredoc-review__list_source',
  'mcp__coredoc-review__read_source',
  'mcp__coredoc-review__search_source',
];
const GRAPH_TOOL = 'mcp__coredoc-review__graph_lookup';
const init = (options: Options, overrides: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  tools: options.allowedTools?.length ? HOST_TOOLS : [],
  mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: 'connected' })),
  agents: [],
  plugins: [],
  skills: [],
  ...overrides,
});
let messageIds = 0;
/** Each fixture turn gets its own message id; pass `message.id` explicitly to model one turn split into blocks. */
const assistant = (overrides: Record<string, unknown> = {}) => ({
  type: 'assistant',
  session_id: 's1',
  message: { id: `m${++messageIds}`, content: [{ type: 'text', text: 'thinking' }] },
  ...overrides,
});
const result = (overrides: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  session_id: 's1',
  permission_denials: [],
  usage: { input_tokens: 10, output_tokens: 4 },
  structured_output: { answer: 'done' },
  ...overrides,
});
const handlers = (options: Options): Record<string, Handler> =>
  Object.fromEntries(
    ((options.mcpServers?.['coredoc-review']?.tools ?? []) as Array<{ name: string; handler: Handler }>).map((t) => [
      t.name,
      t.handler,
    ]),
  );
const payload = (value: { content: Array<{ text: string }> }) =>
  JSON.parse(value.content[0]!.text) as { error?: string; startLine?: number };

/** A fake `query`: one scripted turn per call, with the options it was given captured. */
function fake(
  script: (options: Options, call: number, tools: Record<string, Handler>) => AsyncGenerator<unknown> | unknown[],
) {
  const calls: Options[] = [];
  const prompts: string[] = [];
  let n = 0;
  const query = ((params: { prompt: string; options: Options }) => {
    const options = params.options;
    calls.push(options);
    prompts.push(params.prompt);
    const produced = script(options, n++, handlers(options));
    return (async function* () {
      if (Array.isArray(produced)) yield* produced;
      else yield* produced;
    })();
  }) as unknown as ClaudeQuery;
  return { query, calls, prompts };
}
async function runtime(query: ClaudeQuery): Promise<ClaudeCodeRuntime> {
  return createClaudeCodeRuntime(
    { model: 'sonnet', env: { PATH: '/usr/bin' }, query },
    'SYSTEM',
    new AbortController().signal,
  );
}
const call = (acc: ReviewAccess, overrides: Record<string, unknown> = {}) => ({
  schema,
  prefix: 'PREFIX',
  task: { task: 'do it' },
  model: 'unused' as never,
  access: acc,
  diagnostics: { phase: 'discovery' as const, record: () => undefined },
  ...overrides,
});

describe('claudeCodeEnv', () => {
  it('copies only the allowlisted keys', () => {
    expect(
      claudeCodeEnv({
        PATH: '/usr/bin',
        TMPDIR: '/tmp',
        LANG: 'C',
        TERM: 'dumb',
        CLAUDE_CODE_OAUTH_TOKEN: 'tok',
        ANTHROPIC_API_KEY: 'sk-secret',
        ANTHROPIC_BASE_URL: 'https://evil.test',
        CLAUDE_CODE_USE_BEDROCK: '1',
        HTTPS_PROXY: 'http://proxy',
        DEBUG: '1',
        HOME: '/home/runner',
        LC_ALL: '',
      }),
    ).toEqual({ PATH: '/usr/bin', TMPDIR: '/tmp', LANG: 'C', TERM: 'dumb', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  });
});

describe('claude code phase options', () => {
  it('isolates the runtime and offers only the host tools', async () => {
    const f = fake((options) => [init(options), assistant(), result()]);
    const rt = await runtime(f.query);
    const acc = access();
    const answer = await claudeCodePhase(call(acc), rt);
    expect(answer).toEqual({ answer: 'done' });
    const options = f.calls[0]!;
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([
      'mcp__coredoc-review__list_source',
      'mcp__coredoc-review__read_source',
      'mcp__coredoc-review__search_source',
    ]);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.persistSession).toBeUndefined();
    expect(options.model).toBe('sonnet');
    expect(options.cwd).toBe(rt.dir);
    expect(options.env).toEqual({ PATH: '/usr/bin', HOME: rt.dir, CLAUDE_CONFIG_DIR: rt.dir });
    expect(options.stderr).toBeUndefined();
    expect(options.pathToClaudeCodeExecutable).toBeUndefined();
    expect(f.prompts[0]!.startsWith('PREFIX\n\n')).toBe(true);
    await rt.close();
  });

  it('offers graph_lookup only when a graph is admitted', async () => {
    const f = fake((options) => [init(options, { tools: [...HOST_TOOLS, GRAPH_TOOL] }), assistant(), result()]);
    const rt = await runtime(f.query);
    const graph: GraphReader = {
      snapshot: async () => ({ commit: null, snapshotId: null, parsedAt: null, capturedAt: '' }),
      query: async () => ({}),
      close: async () => undefined,
    };
    await claudeCodePhase(call(access([], graph)), rt);
    expect(f.calls[0]!.allowedTools).toContain('mcp__coredoc-review__graph_lookup');
    await rt.close();
  });

  it('denies a tool outside the allowlist and records the gap', async () => {
    const f = fake((options) => [init(options), assistant(), result()]);
    const rt = await runtime(f.query);
    const acc = access();
    await claudeCodePhase(call(acc), rt);
    const denied = await f.calls[0]!.canUseTool('Bash', { command: 'rm -rf /' }, {});
    expect(denied).toEqual({ behavior: 'deny', message: 'TOOL_DENIED' });
    expect(acc.gaps).toContain('TOOL_DENIED');
    await rt.close();
  });
});

describe('claude code mcp adapter', () => {
  it('refuses coerced, unknown and out-of-enum arguments', async () => {
    const acc = access();
    const f = fake(async function* (options) {
      yield init(options);
      const tools = handlers(options);
      expect(
        payload(await tools.read_source!({ revision: 'head', path: 'src/a.ts', startLine: '1', endLine: 2 })),
      ).toEqual({
        error: 'TOOL_INPUT_INVALID',
      });
      expect(
        payload(await tools.read_source!({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 2, extra: 1 })),
      ).toEqual({ error: 'TOOL_INPUT_INVALID' });
      expect(payload(await tools.list_source!({ revision: 'HEAD', prefix: 'src/' }))).toEqual({
        error: 'TOOL_INPUT_INVALID',
      });
      yield assistant();
      yield result();
    });
    const rt = await runtime(f.query);
    await claudeCodePhase(call(acc), rt);
    expect(acc.gaps.filter((g) => g === 'TOOL_INPUT_INVALID')).toHaveLength(3);
    await rt.close();
  });

  it('routes a valid read through ReviewAccess so the phase records the evidence', async () => {
    const acc = access();
    const f = fake(async function* (options) {
      yield init(options);
      const body = payload(
        await handlers(options).read_source!({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 2 }),
      );
      expect(body.startLine).toBe(1);
      yield assistant();
      yield result();
    });
    const rt = await runtime(f.query);
    await claudeCodePhase(call(acc), rt);
    expect(acc.observedThisPhase('head', 'src/a.ts', 1, 2)).toBe(true);
    expect([...acc.readPaths]).toContain('head:src/a.ts');
    await rt.close();
  });

  it('latches a fatal tool failure and refuses the answer', async () => {
    const acc = access([]);
    const failing: SourceReader = {
      ...source,
      read: async () => {
        throw new ReviewError('SOURCE_LIMIT');
      },
    };
    const req = request();
    const budget = new ReviewBudget(req, new AbortController().signal);
    const leakAccess = new ReviewAccess(req, failing, budget, [], []);
    const f = fake(async function* (options) {
      yield init(options);
      await handlers(options).read_source!({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 2 });
      yield assistant();
      yield result();
    });
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(leakAccess), rt)).rejects.toMatchObject({ code: 'SOURCE_LIMIT' });
    expect(acc.gaps).not.toContain('SOURCE_LIMIT');
    await rt.close();
  });

  it('latches a graph admission failure thrown inside graph_lookup', async () => {
    const graph: GraphReader = {
      snapshot: async () => ({ commit: null, snapshotId: null, parsedAt: null, capturedAt: '' }),
      query: async () => {
        throw new ReviewError('GRAPH_SCOPE_INVALID');
      },
      close: async () => undefined,
    };
    const f = fake(async function* (options) {
      yield init(options, { tools: [...HOST_TOOLS, GRAPH_TOOL] });
      await handlers(options).graph_lookup!({ operation: 'explain', query: 'divide' });
      yield assistant();
      yield result();
    });
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access([], graph)), rt)).rejects.toMatchObject({ code: 'GRAPH_SCOPE_INVALID' });
    await rt.close();
  });
});

describe('claude code init check and failure mapping', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['an extra tool', { tools: ['mcp__coredoc-review__list_source', 'Bash'] }],
    [
      'an extra mcp server',
      {
        mcp_servers: [
          { name: 'coredoc-review', status: 'connected' },
          { name: 'other', status: 'connected' },
        ],
      },
    ],
    ['a plugin', { plugins: ['coredoc'] }],
    ['a skill', { skills: ['deploy'] }],
  ];
  for (const [label, overrides] of cases) {
    it(`ends the phase when init reports ${label}`, async () => {
      const f = fake((options) => [init(options, overrides), assistant(), result()]);
      const rt = await runtime(f.query);
      await expect(claudeCodePhase(call(access()), rt)).rejects.toMatchObject({
        code: 'CLAUDE_RUNTIME_TOOLS_UNEXPECTED',
      });
      await rt.close();
    });
  }

  it('names the mismatched init dimension as a gap', async () => {
    const acc = access();
    const f = fake((options) => [init(options, { tools: [...HOST_TOOLS, 'Bash'] }), assistant(), result()]);
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(acc), rt)).rejects.toMatchObject({ code: 'CLAUDE_RUNTIME_TOOLS_UNEXPECTED' });
    expect(acc.gaps).toContain('INIT_TOOLS_MISMATCH');
    await rt.close();
  });

  it('accepts the built-in subagent catalogue Claude Code lists even with no Agent tool', async () => {
    // Observed on the live runner and locally (Claude Code 2.1.12): `agents` names built-in types
    // regardless of `tools: []`; without an Agent tool none of them can be spawned.
    const f = fake((options) => [
      init(options, { agents: ['Bash', 'general-purpose', 'statusline-setup', 'Explore', 'Plan'] }),
      assistant(),
      result(),
    ]);
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).resolves.toEqual({ answer: 'done' });
    await rt.close();
  });

  it('records a permission denial as a gap', async () => {
    const acc = access();
    const f = fake((options) => [init(options), assistant(), result({ permission_denials: [{ tool_name: 'Bash' }] })]);
    const rt = await runtime(f.query);
    await claudeCodePhase(call(acc), rt);
    expect(acc.gaps).toContain('TOOL_DENIED');
    await rt.close();
  });

  const failures: Array<[string, Record<string, unknown>, string]> = [
    ['authentication_failed', { error: 'authentication_failed' }, 'SUBSCRIPTION_CREDENTIAL_REJECTED'],
    ['rate_limit', { error: 'rate_limit' }, 'SUBSCRIPTION_PLAN_EXHAUSTED'],
    ['billing_error', { error: 'billing_error' }, 'SUBSCRIPTION_PLAN_EXHAUSTED'],
    ['server_error', { error: 'server_error' }, 'CLAUDE_RUNTIME_FAILED'],
  ];
  for (const [label, overrides, code] of failures) {
    it(`maps an assistant ${label} turn to ${code}`, async () => {
      const f = fake((options) => [init(options), assistant(overrides)]);
      const rt = await runtime(f.query);
      await expect(claudeCodePhase(call(access()), rt)).rejects.toMatchObject({ code });
      await rt.close();
    });
  }

  it('maps an auth_status error to a rejected credential', async () => {
    const f = fake((options) => [init(options), { type: 'auth_status', session_id: 's1', error: 'expired' }]);
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_CREDENTIAL_REJECTED',
    });
    await rt.close();
  });

  it('maps exhausted structured-output retries and an unknown subtype', async () => {
    const invalid = fake((options) => [
      init(options),
      assistant(),
      result({ subtype: 'error_max_structured_output_retries', structured_output: undefined }),
    ]);
    const one = await runtime(invalid.query);
    await expect(claudeCodePhase(call(access()), one)).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
    await one.close();
    const other = fake((options) => [
      init(options),
      assistant(),
      result({ subtype: 'error_during_execution', structured_output: undefined }),
    ]);
    const two = await runtime(other.query);
    await expect(claudeCodePhase(call(access()), two)).rejects.toMatchObject({ code: 'CLAUDE_RUNTIME_FAILED' });
    await two.close();
  });
});

describe('claude code turn accounting', () => {
  it('counts one step per turn when the runtime splits a turn into one message per block', async () => {
    const acc = access();
    const records: unknown[] = [];
    const recorded: Array<{ step: number; toolCalls: number; textBytes: number }> = [];
    const f = fake((options) => [
      init(options),
      assistant({ message: { id: 'turn-1', content: [{ type: 'text', text: 'let me read' }] } }),
      assistant({ message: { id: 'turn-1', content: [{ type: 'tool_use', name: 'x' }] } }),
      assistant({ message: { id: 'turn-1', content: [{ type: 'tool_use', name: 'y' }] } }),
      assistant({ message: { id: 'turn-2', content: [{ type: 'text', text: 'done' }] } }),
      result(),
    ]);
    const rt = await runtime(f.query);
    await claudeCodePhase(
      call(acc, {
        diagnostics: {
          phase: 'discovery' as const,
          record: (d: { step: number; toolCalls: number; textBytes: number }) => {
            records.push(d);
            if (!recorded.includes(d)) recorded.push(d);
          },
        },
      }),
      rt,
    );
    expect(acc.budget.steps).toBe(2);
    // Exactly one log line per turn: the last one is recorded once the result enriches it.
    expect(records).toHaveLength(2);
    expect(recorded.map((d) => [d.step, d.toolCalls, d.textBytes])).toEqual([
      [1, 2, Buffer.byteLength('let me read')],
      [2, 0, Buffer.byteLength('done')],
    ]);
    await rt.close();
  });
});

describe('claude code answer text fallback and schema repair', () => {
  it('takes the last fenced block when an earlier fence holds an example', async () => {
    const f = fake((options) => [
      init(options),
      assistant(),
      result({
        structured_output: undefined,
        result: 'For example:\n```json\n{"answer":"example"}\n```\nMy answer:\n```json\n{"answer":"done"}\n```',
      }),
    ]);
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).resolves.toEqual({ answer: 'done' });
    expect(f.calls).toHaveLength(1);
    await rt.close();
  });

  it('parses a fenced JSON block even when the surrounding prose contains braces', async () => {
    const f = fake((options) => [
      init(options),
      assistant(),
      result({
        structured_output: undefined,
        result: 'The object {a} above was odd.\n```json\n{"answer":"done"}\n```\nSee {b} for details.',
      }),
    ]);
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).resolves.toEqual({ answer: 'done' });
    expect(f.calls).toHaveLength(1);
    await rt.close();
  });

  it('parses fenced JSON from the result text when structured_output is absent', async () => {
    const f = fake((options) => [
      init(options),
      assistant(),
      result({ structured_output: undefined, result: 'Here you go:\n```json\n{\n  "answer": "done"\n}\n```' }),
    ]);
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).resolves.toEqual({ answer: 'done' });
    expect(f.calls).toHaveLength(1);
    await rt.close();
  });

  it('repairs an off-schema answer once on the same session without tools', async () => {
    const f = fake((options, n) => [
      init(options),
      assistant(),
      n === 0
        ? result({ structured_output: undefined, result: '{"reply":"wrong shape"}' })
        : result({ structured_output: undefined, result: '{"answer":"fixed"}' }),
    ]);
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).resolves.toEqual({ answer: 'fixed' });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.resume).toBe('s1');
    expect(f.calls[1]!.mcpServers).toBeUndefined();
    expect(f.calls[1]!.maxTurns).toBe(1);
    expect(f.prompts[1]).toContain('did not match the required JSON schema');
    await rt.close();
  });

  it('ends the phase MODEL_OUTPUT_INVALID when the repaired answer is still off-schema', async () => {
    const f = fake((options) => [
      init(options),
      assistant(),
      result({ structured_output: undefined, result: 'no json here' }),
    ]);
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
    expect(f.calls).toHaveLength(2);
    await rt.close();
  });
});

describe('claude code forced final answer', () => {
  it('resumes without tools when the runtime hits its turn ceiling', async () => {
    const f = fake((options, n) =>
      n === 0
        ? [init(options), assistant(), result({ subtype: 'error_max_turns', structured_output: undefined })]
        : [init(options), assistant(), result()],
    );
    const rt = await runtime(f.query);
    expect(await claudeCodePhase(call(access()), rt)).toEqual({ answer: 'done' });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.resume).toBe('s1');
    expect(f.calls[1]!.mcpServers).toBeUndefined();
    expect(f.calls[1]!.allowedTools).toEqual([]);
    expect(f.calls[1]!.maxTurns).toBe(1);
    // The runtime locates the session by cwd and config dir, so a resumed call must keep both.
    expect(f.calls[1]!.cwd).toBe(rt.dir);
    expect(f.calls[1]!.env).toEqual(f.calls[0]!.env);
    expect(f.calls[1]!.env).toEqual({ PATH: '/usr/bin', HOME: rt.dir, CLAUDE_CONFIG_DIR: rt.dir });
    expect(f.prompts[1]).toContain('Tools are unavailable for this final step');
    await rt.close();
  });

  it('raises STEP_LIMIT when the forced answer also fails', async () => {
    const f = fake((options) => [
      init(options),
      assistant(),
      result({ subtype: 'error_max_turns', structured_output: undefined }),
    ]);
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).rejects.toMatchObject({ code: 'STEP_LIMIT' });
    await rt.close();
  });

  it('still forces the tool-less final answer when a query ends at the turn ceiling after TOOL_LIMIT', async () => {
    const req = requestSchema.parse({ ...request(), limits: { ...request().limits, maxToolCalls: 1 } });
    const acc = new ReviewAccess(req, source, new ReviewBudget(req, new AbortController().signal), [], []);
    const f = fake((options, n) =>
      n === 0
        ? (async function* () {
            yield init(options);
            const tools = handlers(options);
            await tools.read_source!({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 2 });
            expect(
              payload(await tools.read_source!({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 2 })),
            ).toEqual({ error: 'TOOL_LIMIT' });
            yield assistant();
            yield result({ subtype: 'error_max_turns', structured_output: undefined });
          })()
        : [init(options), assistant(), result()],
    );
    const rt = await runtime(f.query);
    expect(await claudeCodePhase(call(acc), rt)).toEqual({ answer: 'done' });
    expect(acc.gaps).toContain('TOOL_LIMIT');
    expect(f.calls[1]!.allowedTools).toEqual([]);
    await rt.close();
  });

  it('surfaces a subscription failure raised on the forced call instead of STEP_LIMIT', async () => {
    const f = fake((options, n) =>
      n === 0
        ? [init(options), assistant(), result({ subtype: 'error_max_turns', structured_output: undefined })]
        : [init(options), assistant({ error: 'rate_limit' })],
    );
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_PLAN_EXHAUSTED',
    });
    await rt.close();
  });

  it('surfaces an init mismatch on the forced call instead of STEP_LIMIT', async () => {
    const f = fake((options, n) =>
      n === 0
        ? [init(options), assistant(), result({ subtype: 'error_max_turns', structured_output: undefined })]
        : [init(options, { tools: ['Bash'] }), assistant(), result()],
    );
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).rejects.toMatchObject({
      code: 'CLAUDE_RUNTIME_TOOLS_UNEXPECTED',
    });
    await rt.close();
  });
});

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

describe('claude code abort surfacing', () => {
  it('reports the latched fatal source failure when the aborted generator throws', async () => {
    const req = request();
    const failing: SourceReader = {
      ...source,
      read: async () => {
        throw new ReviewError('SOURCE_LIMIT');
      },
    };
    const leakAccess = new ReviewAccess(req, failing, new ReviewBudget(req, new AbortController().signal), [], []);
    const f = fake(async function* (options) {
      let aborted = false;
      options.abortController.signal.addEventListener('abort', () => {
        aborted = true;
      });
      yield init(options);
      await handlers(options).read_source!({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 2 });
      if (aborted) throw abortError();
      yield assistant();
      yield result();
    });
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(leakAccess), rt)).rejects.toMatchObject({ code: 'SOURCE_LIMIT' });
    await rt.close();
  });

  it('reports the latched graph admission failure when the aborted generator throws', async () => {
    const graph: GraphReader = {
      snapshot: async () => ({ commit: null, snapshotId: null, parsedAt: null, capturedAt: '' }),
      query: async () => {
        throw new ReviewError('GRAPH_SCOPE_INVALID');
      },
      close: async () => undefined,
    };
    const f = fake(async function* (options) {
      let aborted = false;
      options.abortController.signal.addEventListener('abort', () => {
        aborted = true;
      });
      yield init(options, { tools: [...HOST_TOOLS, GRAPH_TOOL] });
      await handlers(options).graph_lookup!({ operation: 'explain', query: 'divide' });
      if (aborted) throw abortError();
      yield assistant();
      yield result();
    });
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access([], graph)), rt)).rejects.toMatchObject({ code: 'GRAPH_SCOPE_INVALID' });
    await rt.close();
  });
});

describe('claude code runtime errors', () => {
  it('reports a runtime that fails to start or stream as CLAUDE_RUNTIME_FAILED', async () => {
    const f = fake(() => {
      throw new Error('spawn failed');
    });
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).rejects.toMatchObject({ code: 'CLAUDE_RUNTIME_FAILED' });
    await rt.close();
  });

  it('reports a missing runtime executable as CLAUDE_RUNTIME_UNAVAILABLE', async () => {
    const f = fake(() => {
      throw Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
    });
    const rt = await runtime(f.query);
    await expect(claudeCodePhase(call(access()), rt)).rejects.toMatchObject({ code: 'CLAUDE_RUNTIME_UNAVAILABLE' });
    await rt.close();
  });

  it("keeps a cancellation ahead of the aborted stream's own error", async () => {
    const req = request();
    const ctrl = new AbortController();
    const acc = new ReviewAccess(req, source, new ReviewBudget(req, ctrl.signal), [], []);
    const f = fake(async function* (options) {
      yield init(options);
      ctrl.abort();
      throw abortError();
    });
    const rt = await createClaudeCodeRuntime(
      { model: 'sonnet', env: { PATH: '/usr/bin' }, query: f.query },
      'SYSTEM',
      ctrl.signal,
    );
    await expect(claudeCodePhase(call(acc), rt)).rejects.toMatchObject({ code: 'CANCELLED' });
    await rt.close();
  });
});

describe('claude code nudges', () => {
  it('sends a coverage nudge as a full resumed query with tools', async () => {
    const acc = access();
    const f = fake(async function* (options, n) {
      yield init(options);
      const tools = handlers(options);
      // The first answer reads base only, so the head coverage floor is still open.
      await tools.read_source!({ revision: 'base', path: 'src/a.ts', startLine: 1, endLine: 2 });
      if (n > 0) await tools.read_source!({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 2 });
      yield assistant();
      yield result();
    });
    const rt = await runtime(f.query);
    expect(await claudeCodePhase(call(acc, { required: ['src/a.ts'] }), rt)).toEqual({ answer: 'done' });
    expect(f.calls).toHaveLength(2);
    const resumed = f.calls[1]!;
    expect(resumed.resume).toBe('s1');
    expect(resumed.mcpServers).toBeDefined();
    expect(resumed.allowedTools.length).toBeGreaterThan(0);
    expect(resumed.maxTurns).toBeGreaterThan(1);
    expect(acc.gaps).not.toContain('SOURCE_COVERAGE_PARTIAL');
    await rt.close();
  });

  it('spends exactly one extra resumed query on an accept nudge', async () => {
    const acc = access();
    const f = fake((options) => [init(options), assistant(), result()]);
    const rt = await runtime(f.query);
    let asked = 0;
    const accept = async () => (asked++ === 0 ? 'say more' : undefined);
    expect(await claudeCodePhase(call(acc, { accept }), rt)).toEqual({ answer: 'done' });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.resume).toBe('s1');
    expect(f.calls[1]!.maxTurns).toBeGreaterThan(1);
    expect(acc.gaps).not.toContain('VERIFICATION_EVIDENCE_PARTIAL');
    await rt.close();
  });
});

describe('isAbortedControlWrite', () => {
  it('matches only the SDK control-reply write after abort', () => {
    // Mirrors the SDK: the class sets no `name`.
    class AbortError extends Error {}
    const write = () => {
      throw new AbortError('Operation aborted');
    };
    const handleControlRequest = () => {
      try {
        write();
      } catch (error) {
        return error;
      }
    };
    expect(isAbortedControlWrite(handleControlRequest())).toBe(true);
    expect(isAbortedControlWrite(abortError())).toBe(false);
    expect(isAbortedControlWrite(new Error('Operation aborted'))).toBe(false);
    expect(isAbortedControlWrite('Operation aborted')).toBe(false);
  });
});
