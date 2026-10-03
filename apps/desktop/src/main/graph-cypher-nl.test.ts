import { describe, expect, it, vi } from 'vitest';

const { captureChatHarnessMock, codexRunMock, claudeQueryMock } = vi.hoisted(() => ({
  captureChatHarnessMock: vi.fn(),
  codexRunMock: vi.fn(),
  claudeQueryMock: vi.fn(),
}));

// graph-cypher-nl statically imports the chat harness (which pulls in electron)
// and the Codex/runtime plumbing used by the default run. Stub those modules so
// provider-contract tests can inspect the real adapter without spawning a CLI.
// @coredoc/mcp stays REAL so prompt assertions exercise the schema vocabulary.
vi.mock('./chat-service.js', () => ({ captureChatHarness: captureChatHarnessMock }));
vi.mock('./codex-app-server.js', () => ({
  CodexAppServerClient: class {
    run = codexRunMock;
  },
}));
vi.mock('./runtime-paths.js', () => ({ requireProjectRoot: () => '/tmp/root' }));
vi.mock('./e2e-mode.js', () => ({ isE2EMode: () => false }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: claudeQueryMock }));

import { CYPHER_VOCABULARY } from '@coredoc/mcp';
import {
  buildClaudeOneShotOptions,
  cleanCypherResponse,
  defaultOneShotRun,
  generateCypherFromNl,
} from './graph-cypher-nl.js';

describe('buildClaudeOneShotOptions (tool-less contract)', () => {
  const harness = { env: { FOO: 'bar' }, nodeExecPath: '/bin/node', claudeCliPath: '/bin/claude' };

  it('disables ALL built-in tools via `tools: []` (not the no-op `allowedTools`)', () => {
    const opts = buildClaudeOneShotOptions('sys', harness);
    // The load-bearing regression guard: `tools: []` removes tools from context;
    // `allowedTools: []` would NOT — it is only an auto-approval allowlist, which
    // let the model run Read/Grep/Bash as a coding agent.
    expect(opts.tools).toEqual([]);
    expect('allowedTools' in opts).toBe(false);
  });

  it('attaches no MCP servers and does not cap the StructuredOutput finalization loop', () => {
    const opts = buildClaudeOneShotOptions('sys', harness);
    expect(opts.mcpServers).toEqual({});
    // The schema tool can be retried even after a valid call. A fixed cap can
    // discard that validated value as `error_max_turns` before terminal success.
    expect('maxTurns' in opts).toBe(false);
    expect(opts.settingSources).toEqual([]);
  });

  it('constrains the final response to one cypher string field', () => {
    const opts = buildClaudeOneShotOptions('sys', harness);
    expect(opts.outputFormat).toEqual({
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: { cypher: { type: 'string' } },
        required: ['cypher'],
        additionalProperties: false,
      },
    });
  });

  it('carries the custom system prompt and harness wiring', () => {
    const opts = buildClaudeOneShotOptions('MY-PROMPT', harness);
    expect(opts.systemPrompt).toBe('MY-PROMPT');
    expect(opts.model).toBe('claude-opus-5-5');
    expect(opts.env).toEqual({ FOO: 'bar' });
    expect(opts.pathToClaudeCodeExecutable).toBe('/bin/claude');
  });
});

describe('cleanCypherResponse', () => {
  it('unwraps a ```cypher fenced block', () => {
    expect(cleanCypherResponse('```cypher\nMATCH (n:GraphNode) RETURN n.name\n```')).toBe(
      'MATCH (n:GraphNode) RETURN n.name',
    );
  });

  it('unwraps a bare ``` fenced block', () => {
    expect(cleanCypherResponse('```\nMATCH (n) RETURN n\n```')).toBe('MATCH (n) RETURN n');
  });

  it('drops a trailing semicolon and surrounding whitespace', () => {
    expect(cleanCypherResponse('  MATCH (n) RETURN n ;  ')).toBe('MATCH (n) RETURN n');
  });

  it('preserves a terminal backtick-quoted identifier', () => {
    expect(cleanCypherResponse('MATCH (n) RETURN n.`type`')).toBe('MATCH (n) RETURN n.`type`');
  });

  it('returns empty string for whitespace/fence-only input', () => {
    expect(cleanCypherResponse('```cypher\n\n```')).toBe('');
    expect(cleanCypherResponse('   ')).toBe('');
  });
});

describe('defaultOneShotRun provider contracts', () => {
  it('runs Codex with no tools and reads only the completed final answer', async () => {
    captureChatHarnessMock.mockReturnValue({
      provider: 'codex',
      env: {},
      mcpEnv: {},
      nodeExecPath: '/bin/node',
      codexCliPath: '/bin/codex',
    });
    codexRunMock.mockImplementation(async (options: { onNotification?: (message: unknown) => void }) => {
      options.onNotification?.({
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            phase: 'commentary',
            text: 'I will inspect the repository before answering.',
          },
        },
      });
      options.onNotification?.({
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            phase: 'final_answer',
            text: '{"cypher":"MATCH (n) RETURN n"}',
          },
        },
      });
      return { status: 'completed' };
    });

    await expect(defaultOneShotRun({ systemPrompt: 'schema', userText: 'all nodes' })).resolves.toBe(
      'MATCH (n) RETURN n',
    );
    expect(codexRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.6-terra',
        toolMode: 'none',
        outputSchema: {
          type: 'object',
          properties: { cypher: { type: 'string' } },
          required: ['cypher'],
          additionalProperties: false,
        },
        config: expect.objectContaining({
          mcp_servers: {},
        }),
      }),
    );
  });

  it('uses the last completed phase-less Codex message for protocol compatibility', async () => {
    captureChatHarnessMock.mockReturnValue({
      provider: 'codex',
      env: {},
      mcpEnv: {},
      nodeExecPath: '/bin/node',
      codexCliPath: '/bin/codex',
    });
    codexRunMock.mockImplementation(async (options: { onNotification?: (message: unknown) => void }) => {
      options.onNotification?.({
        method: 'item/completed',
        params: { item: { type: 'agentMessage', text: '{"cypher":"MATCH (old) RETURN old"}' } },
      });
      options.onNotification?.({
        method: 'item/completed',
        params: { item: { type: 'agentMessage', text: '{"cypher":"MATCH (n) RETURN n"}' } },
      });
      return { status: 'completed' };
    });

    await expect(defaultOneShotRun({ systemPrompt: 'schema', userText: 'all nodes' })).resolves.toBe(
      'MATCH (n) RETURN n',
    );
  });

  it('uses only Claude terminal structured output, not assistant prose', async () => {
    captureChatHarnessMock.mockReturnValue({
      provider: 'claude',
      env: {},
      mcpEnv: {},
      nodeExecPath: '/bin/node',
      claudeCliPath: '/bin/claude',
    });
    claudeQueryMock.mockImplementation((args: { options?: { maxTurns?: number } }) =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'StructuredOutput', input: { cypher: 'MATCH (n) RETURN n' } }],
          },
        };
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', content: 'Structured output provided successfully' }] },
        };
        // The real CLI may emit StructuredOutput again before its final text.
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'StructuredOutput', input: { cypher: 'MATCH (n) RETURN n' } }],
          },
        };
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', content: 'Structured output provided successfully' }] },
        };
        if (args.options?.maxTurns !== undefined && args.options.maxTurns < 3) {
          yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] };
          return;
        }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"cypher":"MATCH (wrong) RETURN wrong"}',
          structured_output: { cypher: 'MATCH (n) RETURN n' },
        };
      })(),
    );

    await expect(defaultOneShotRun({ systemPrompt: 'schema', userText: 'all nodes' })).resolves.toBe(
      'MATCH (n) RETURN n',
    );
    expect(claudeQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ tools: [], outputFormat: expect.any(Object) }) }),
    );
  });

  it('surfaces the Claude terminal subtype when structured generation fails', async () => {
    captureChatHarnessMock.mockReturnValue({
      provider: 'claude',
      env: {},
      mcpEnv: {},
      nodeExecPath: '/bin/node',
      claudeCliPath: '/bin/claude',
    });
    claudeQueryMock.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          subtype: 'error_max_structured_output_retries',
          is_error: true,
          errors: [],
        };
      })(),
    );

    await expect(defaultOneShotRun({ systemPrompt: 'schema', userText: 'all nodes' })).rejects.toThrow(
      /error_max_structured_output_retries/,
    );
  });
});

describe('generateCypherFromNl', () => {
  it('cleans a fenced, trailing-semicolon response into bare Cypher', async () => {
    const run = vi.fn().mockResolvedValue('```cypher\nMATCH (n:GraphNode) RETURN n.name;\n```');
    const res = await generateCypherFromNl({ text: 'all node names', dialect: 'ladybug', run });
    expect(res).toEqual({ cypher: 'MATCH (n:GraphNode) RETURN n.name' });
  });

  it('forwards the user question and a schema-bearing system prompt to run', async () => {
    const run = vi.fn().mockResolvedValue('MATCH (n) RETURN n');
    await generateCypherFromNl({ text: 'entrypoints per repo', dialect: 'ladybug', run });
    const args = run.mock.calls[0]![0] as { systemPrompt: string; userText: string };
    expect(args.userText).toBe('entrypoints per repo');
    // Ladybug shape names the single node table `GraphNode`; the instruction is appended.
    expect(args.systemPrompt).toContain('GraphNode');
    expect(args.systemPrompt).toMatch(/read-only Cypher query/i);
    // No parameter schema to point at here, so the node and edge kinds are inlined.
    expect(args.systemPrompt).toContain(CYPHER_VOCABULARY);
    expect(args.systemPrompt).not.toContain('see the `query` parameter');
  });

  it('adds the graph-canvas return contract and external-call topology to the prompt', async () => {
    const run = vi.fn().mockResolvedValue('MATCH (n:GraphNode) RETURN n');

    await generateCypherFromNl({
      text: 'components making external calls to cli and server entrypoints',
      dialect: 'ladybug',
      run,
    });

    const args = run.mock.calls[0]![0] as { systemPrompt: string };
    expect(args.systemPrompt).toMatch(/RETURN.*node and relationship variables/i);
    expect(args.systemPrompt).toMatch(/function.*MAKES_EXTERNAL_CALL.*external_call.*RESOLVES_TO.*entrypoint/i);
    expect(args.systemPrompt).toMatch(/component.*React|Vue/i);
    expect(args.systemPrompt).toMatch(/entrypoint.*name.*opaque/i);
    expect(args.systemPrompt).toMatch(/filePath.*repoId/i);
    expect(args.systemPrompt).toContain('RETURN caller, makesCall, externalCall, resolvesTo, entrypoint');
  });

  it('forbids source-bearing fields and gives native CLI/server filters in the canvas prompt', async () => {
    const run = vi.fn().mockResolvedValue('MATCH (n:GraphNode) RETURN n');

    await generateCypherFromNl({
      text: 'components making external calls to cli and server entrypoints',
      dialect: 'ladybug',
      run,
    });

    const args = run.mock.calls[0]![0] as { systemPrompt: string };
    expect(args.systemPrompt).toMatch(/desktop graph canvas source contract/i);
    expect(args.systemPrompt).toMatch(/never reference.*properties.*sourceCode/i);
    expect(args.systemPrompt).toContain("entrypoint.name CONTAINS ':entrypoint:cli:'");
    expect(args.systemPrompt).toMatch(/server.*entrypoint\.filePath/i);
  });

  it.each([
    ['ladybug', 'MATCH (n:GraphNode) RETURN n.properties'],
    ['neo4j', 'MATCH (n:CodeNode) RETURN n.sourceCode'],
  ] as const)('rejects source-bearing %s output before it reaches the editor', async (dialect, cypher) => {
    const run = vi.fn().mockResolvedValue(cypher);

    await expect(generateCypherFromNl({ text: 'show details', dialect, run })).rejects.toThrow(
      /generated graph-canvas Cypher cannot reference "properties" or "sourceCode"/i,
    );
  });

  it('passes the neo4j dialect shape when asked', async () => {
    const run = vi.fn().mockResolvedValue('MATCH (n) RETURN n');
    await generateCypherFromNl({ text: 'x', dialect: 'neo4j', run });
    const args = run.mock.calls[0]![0] as { systemPrompt: string };
    // Neo4j shape documents the shared CodeNode label rather than a GraphNode table.
    expect(args.systemPrompt).toContain('CodeNode');
    expect(args.systemPrompt).toContain('(caller:Function)');
    expect(args.systemPrompt).toContain('(externalCall:ExternalCall)');
    expect(args.systemPrompt).toContain('(entrypoint:Entrypoint)');
  });

  it('throws a friendly error when the model returns nothing usable', async () => {
    const run = vi.fn().mockResolvedValue('```cypher\n\n```');
    await expect(generateCypherFromNl({ text: 'anything', dialect: 'ladybug', run })).rejects.toThrow(
      /Could not generate a Cypher query/i,
    );
  });

  it('rejects prose instead of passing it through as Cypher', async () => {
    const run = vi.fn().mockResolvedValue('I inspected the graph.\nMATCH (n) RETURN n');
    await expect(generateCypherFromNl({ text: 'anything', dialect: 'ladybug', run })).rejects.toThrow(
      /read-only Cypher|could not generate/i,
    );
  });

  it('rejects multiple or mutating statements before returning them to the UI', async () => {
    const multiple = vi.fn().mockResolvedValue('MATCH (n) RETURN n; MATCH (m) RETURN m');
    await expect(generateCypherFromNl({ text: 'anything', dialect: 'ladybug', run: multiple })).rejects.toThrow(
      /single read-only Cypher|multiple statements/i,
    );

    const mutating = vi.fn().mockResolvedValue('MATCH (n) DELETE n RETURN n');
    await expect(generateCypherFromNl({ text: 'anything', dialect: 'neo4j', run: mutating })).rejects.toThrow(
      /read-only Cypher/i,
    );
  });

  it('rejects an empty question before calling run', async () => {
    const run = vi.fn();
    await expect(generateCypherFromNl({ text: '   ', dialect: 'ladybug', run })).rejects.toThrow(/Enter a question/i);
    expect(run).not.toHaveBeenCalled();
  });
});
