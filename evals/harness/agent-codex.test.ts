import { afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexArgs,
  buildCodexPrompt,
  buildMcpServerOverride,
  classifyCodexOutcome,
  codexItemToToolName,
  McpAvailability,
  parseCodexStream,
  probeMcpToolAvailability,
  runCodexAgent,
} from './agent-codex.js';
import { REQUIRED_MCP_TOOL_SUFFIXES } from './agent.js';
import {
  AccessMode,
  AgentProvider,
  GraphBackend,
  parseBackend,
  parseProvider,
  TreatmentAdherence,
} from './types.js';

// Fixture lines captured verbatim from a live `codex exec --json` run on
// codex-cli 0.148.0 (mcp arm, coredoc stdio server).
const STREAM = [
  'Reading additional input from stdin...',
  '{"type":"thread.started","thread_id":"01a021f7-e319-7161-b463-6ccf8725d0d9"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I\'ll invoke the tool."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"coredoc","tool":"describe_repository","arguments":{},"result":null,"error":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"coredoc","tool":"describe_repository","arguments":{},"result":{"content":[{"type":"text","text":"## Repository: coredoc-parser"}]},"error":null,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \'cat f.txt\'","aggregated_output":"hello\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"DONE"}}',
  '{"type":"turn.completed","usage":{"input_tokens":73076,"cached_input_tokens":57344,"cache_write_input_tokens":0,"output_tokens":232,"reasoning_output_tokens":62}}',
].join('\n');

describe('parseCodexStream', () => {
  it('takes the last agent_message as the response', () => {
    expect(parseCodexStream(STREAM).responseText).toBe('DONE');
  });

  it('maps MCP and shell items onto harness tool names', () => {
    const names = parseCodexStream(STREAM).toolCalls;
    expect(names).toContainEqual({ name: 'mcp__coredoc__describe_repository', count: 1 });
    expect(names).toContainEqual({ name: 'Bash', count: 1 });
    // item.started must not double-count the same tool call.
    expect(names.find((t) => t.name.startsWith('mcp__'))?.count).toBe(1);
  });

  it('maps usage without double-counting the cached prompt', () => {
    const { usage } = parseCodexStream(STREAM);
    expect(usage.inputTokens).toBe(73076 - 57344);
    expect(usage.cacheReadTokens).toBe(57344);
    expect(usage.cacheCreationTokens).toBe(0);
    expect(usage.outputTokens).toBe(232);
    expect(usage.totalTokens).toBe(73076 - 57344 + 57344 + 232);
    // Codex reports no dollar cost; never invent pricing.
    expect(usage.costUsd).toBe(0);
  });

  it('keeps non-JSON lines in the transcript instead of dropping them', () => {
    const { events } = parseCodexStream(STREAM);
    expect(events[0]).toEqual({ type: 'raw', text: 'Reading additional input from stdin...' });
    expect(events).toHaveLength(9);
  });

  it('surfaces turn.failed as a stream error', () => {
    const parsed = parseCodexStream('{"type":"turn.failed","error":{"message":"usage limit"}}');
    expect(parsed.streamError).toContain('turn.failed');
    expect(parsed.streamError).toContain('usage limit');
    expect(parsed.responseText).toBe('');
  });

  it('recovers from a transient error event when the turn later completes', () => {
    const parsed = parseCodexStream(
      [
        '{"type":"error","message":"temporary reconnect"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
        '{"type":"turn.completed","usage":{}}',
      ].join('\n'),
    );
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.streamError).toBeNull();
  });

  it('returns an empty response for an empty stream', () => {
    const parsed = parseCodexStream('');
    expect(parsed.responseText).toBe('');
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.usage.totalTokens).toBe(0);
  });
});

describe('codexItemToToolName', () => {
  it('ignores non-tool items', () => {
    expect(codexItemToToolName({ type: 'agent_message' })).toBeNull();
    expect(codexItemToToolName({ type: 'reasoning' })).toBeNull();
  });
  it('namespaces MCP tools like the Claude SDK does', () => {
    expect(codexItemToToolName({ type: 'mcp_tool_call', server: 'coredoc', tool: 'explain' })).toBe(
      'mcp__coredoc__explain',
    );
  });
});

describe('classifyCodexOutcome', () => {
  it('accepts only a completed turn with the output-last-message content', () => {
    const parsed = parseCodexStream(STREAM);
    expect(
      classifyCodexOutcome({ parsed, exitCode: 0, timedOut: false, stderr: '', lastMessage: 'short' }),
    ).toEqual({
      agentStatus: 'completed',
      responseText: 'short',
      error: null,
      treatmentAdherence: TreatmentAdherence.NotApplicable,
    });
  });

  it('marks a run that used the required MCP server compliant', () => {
    const parsed = parseCodexStream(STREAM);
    expect(
      classifyCodexOutcome({
        parsed,
        exitCode: 0,
        timedOut: false,
        stderr: '',
        lastMessage: 'short',
        requiredMcpServerName: 'coredoc',
        requiredMcpAvailability: McpAvailability.Available,
      }),
    ).toEqual({
      agentStatus: 'completed',
      responseText: 'short',
      error: null,
      treatmentAdherence: TreatmentAdherence.Compliant,
    });
  });

  it('records zero required MCP calls as noncompliant treatment, not a failed task', () => {
    const parsed = parseCodexStream(STREAM);
    expect(
      classifyCodexOutcome({
        parsed,
        exitCode: 0,
        timedOut: false,
        stderr: '',
        lastMessage: 'short',
        requiredMcpServerName: 'coredoc-eval',
      }),
    ).toEqual({
      agentStatus: 'completed',
      responseText: 'short',
      error: null,
      treatmentAdherence: TreatmentAdherence.Noncompliant,
    });
  });

  it('keeps the answer and marks noncompliance when the server advertised its tools', () => {
    const parsed = parseCodexStream(STREAM);
    expect(
      classifyCodexOutcome({
        parsed,
        exitCode: 0,
        timedOut: false,
        stderr: '',
        lastMessage: 'a real answer',
        requiredMcpServerName: 'coredoc-eval',
        requiredMcpAvailability: McpAvailability.Available,
      }),
    ).toMatchObject({
      agentStatus: 'completed',
      responseText: 'a real answer',
      treatmentAdherence: TreatmentAdherence.Noncompliant,
    });
  });

  it('classifies an unregistered MCP server as infrastructure, not treatment integrity', () => {
    // Observed 2026-08-24: the server subprocess never started, codex ran
    // tool-less and silent, and the cell was scored ITT 0 as a task failure.
    const parsed = parseCodexStream(STREAM);
    const outcome = classifyCodexOutcome({
      parsed,
      exitCode: 0,
      timedOut: false,
      stderr: '',
      lastMessage: 'short',
      requiredMcpServerName: 'coredoc-eval',
      requiredMcpAvailability: McpAvailability.Unavailable,
    });
    expect(outcome.agentStatus).toBe('infrastructure_error');
    expect(outcome.error).toContain('advertised no tools');
    // The treatment was never applied, so there is no dose to judge adherence on.
    expect(outcome.treatmentAdherence).toBe(TreatmentAdherence.NotApplicable);
  });

  it('classifies timeout as task failure and process/EOF failures as infrastructure', () => {
    const parsed = parseCodexStream('');
    expect(
      classifyCodexOutcome({ parsed, exitCode: null, timedOut: true, stderr: '', lastMessage: null }),
    ).toMatchObject({ agentStatus: 'task_failed', responseText: '' });
    expect(
      classifyCodexOutcome({ parsed, exitCode: 1, timedOut: false, stderr: 'boom', lastMessage: null }),
    ).toMatchObject({ agentStatus: 'infrastructure_error', responseText: '' });
    expect(
      classifyCodexOutcome({ parsed, exitCode: 0, timedOut: false, stderr: '', lastMessage: 'progress' }),
    ).toMatchObject({ agentStatus: 'infrastructure_error', responseText: '' });
  });
});

describe('buildMcpServerOverride', () => {
  it('emits a required TOML inline table with env and auto-approval', () => {
    const override = buildMcpServerOverride('/srv/index.js', {
      MCP_CONFIG_PATH: '/repo/coredoc.config.json',
      COREDOC_SCOPE: 'project:cd',
    });
    expect(override).toBe(
      'mcp_servers.coredoc-eval={command="node",args=["/srv/index.js"],' +
        'env={MCP_CONFIG_PATH="/repo/coredoc.config.json",COREDOC_SCOPE="project:cd"},' +
        'startup_timeout_sec=60,required=true,default_tools_approval_mode="approve"}',
    );
  });

  it('escapes quotes and backslashes in paths', () => {
    expect(buildMcpServerOverride('/a"b\\c/index.js', undefined)).toContain(
      'args=["/a\\"b\\\\c/index.js"]',
    );
  });
});

describe('buildCodexArgs', () => {
  const base = { cwd: '/wt', lastMessagePath: '/out/last.txt', prompt: 'hi' };

  it('pins the read-only worktree profile, hermetic config and JSONL stream', () => {
    const args = buildCodexArgs({ ...base, withMcp: false });
    const overrides = args.filter((_, i) => args[i - 1] === '-c');
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--strict-config');
    // The sandbox flag bounds writes but not reads; the profile bounds both.
    expect(args).not.toContain('--sandbox');
    expect(overrides).toContain('default_permissions="coredoc-eval-worktree"');
    expect(overrides).toContain(
      'permissions.coredoc-eval-worktree.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
    );
    expect(args).toEqual(expect.arrayContaining(['-C', '/wt']));
    expect(args).toEqual(expect.arrayContaining(['--output-last-message', '/out/last.txt']));
    expect(args.at(-1)).toBe('hi');
  });

  it('grants read on each pinned sibling root alongside the worktree cwd', () => {
    const args = buildCodexArgs({
      ...base,
      withMcp: false,
      additionalReadRoots: ['/pinned/acme-core', '/pinned/acme-core', '/pinned/schedules'],
    });
    const overrides = args.filter((_, i) => args[i - 1] === '-c');
    expect(overrides).toContain(
      'permissions.coredoc-eval-worktree.filesystem=' +
        '{":minimal"="read",":workspace_roots"={"."="read"},' +
        '"/pinned/acme-core"="read","/pinned/schedules"="read"}',
    );
  });

  it('limits historyless runs to read access on the current workspace root', () => {
    const args = buildCodexArgs({
      ...base,
      withMcp: false,
      historylessWorkspaceOnly: true,
    });
    const overrides = args.filter((_, i) => args[i - 1] === '-c');
    expect(args).not.toContain('--sandbox');
    expect(overrides).toContain('default_permissions="coredoc-eval-historyless"');
    expect(overrides).toContain(
      'permissions.coredoc-eval-historyless.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
    );
  });

  it('separates the prompt with `--` so a leading `---` is not parsed as a flag', () => {
    const args = buildCodexArgs({ ...base, withMcp: false, prompt: '--- task ---\ndo it' });
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('--- task ---\ndo it');
  });

  it('omits the MCP override on the control arm', () => {
    const args = buildCodexArgs({ ...base, withMcp: false, mcpServerCommand: '/srv/index.js' });
    expect(args.some((a) => a.startsWith('mcp_servers.'))).toBe(false);
  });

  it('adds the MCP override on the with-MCP arm', () => {
    const args = buildCodexArgs({
      ...base,
      withMcp: true,
      mcpServerCommand: '/srv/index.js',
      mcpServerEnv: { COREDOC_SCOPE: 'project:cd' },
    });
    // Several -c overrides exist (project_doc_max_bytes is always present);
    // find the MCP one among them rather than assuming position.
    const overrides = args.filter((_, i) => args[i - 1] === '-c');
    const mcpOverride = overrides.find((v) => v.includes('mcp_servers.coredoc-eval='));
    expect(mcpOverride).toBeDefined();
    expect(mcpOverride).toContain('COREDOC_SCOPE="project:cd"');
    expect(mcpOverride).toContain('COREDOC_MCP_METRICS_DISABLED="1"');
  });

  it('always disables project-doc injection (AGENTS.md) for hermetic arms', () => {
    const args = buildCodexArgs({ ...base, withMcp: false });
    const overrides = args.filter((_, i) => args[i - 1] === '-c');
    expect(overrides).toContain('project_doc_max_bytes=1');
  });

  it('omits -m/--model when no model is given', () => {
    const args = buildCodexArgs({ ...base, withMcp: false });
    expect(args).not.toContain('-m');
  });

  it('passes -m <model> through to codex exec when given', () => {
    const args = buildCodexArgs({ ...base, withMcp: false, model: 'gpt-5-codex' });
    const idx = args.indexOf('-m');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('gpt-5-codex');
  });
});

describe('buildCodexPrompt', () => {
  it('passes the controlled system prompt through without an alternate skill/plugin path', () => {
    const prompt = buildCodexPrompt({
      systemPrompt: 'sys\n\n<trusted-coredoc-product-guide>\nGUIDE\n</trusted-coredoc-product-guide>',
      prompt: 'task',
    });
    expect(prompt).toContain('<trusted-coredoc-product-guide>');
    expect(prompt).toContain('GUIDE');
    expect(prompt).toContain('--- task ---\ntask');
    expect(prompt).not.toContain('--- coredoc-mcp usage guide ---');
  });
});

describe('parseProvider', () => {
  it('defaults to claude', () => {
    expect(parseProvider(undefined, undefined)).toBe(AgentProvider.Claude);
  });
  it('prefers the flag over the env fallback', () => {
    expect(parseProvider('codex', 'claude')).toBe(AgentProvider.Codex);
    expect(parseProvider(undefined, 'codex')).toBe(AgentProvider.Codex);
  });
  it('rejects unknown providers loudly', () => {
    expect(() => parseProvider('gemini', undefined)).toThrow(/Unknown --provider "gemini"/);
  });
});

describe('parseBackend', () => {
  it('defaults to ladybug', () => {
    expect(parseBackend(undefined, undefined)).toBe(GraphBackend.Ladybug);
  });
  it('prefers the flag over the env fallback', () => {
    expect(parseBackend('sqlite', 'ladybug')).toBe(GraphBackend.Sqlite);
    expect(parseBackend(undefined, 'sqlite')).toBe(GraphBackend.Sqlite);
  });
  it('rejects unknown backends loudly', () => {
    expect(() => parseBackend('neo4j', undefined)).toThrow(/Unknown --backend "neo4j"/);
  });
});

describe('probeMcpToolAvailability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evals-mcp-probe-'));
  const serverPath = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Minimal stdio JSON-RPC servers: enough of the MCP handshake for the probe,
  // no SDK dependency, no network, no graph.
  const stdioServer = (toolsExpression: string) => `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: ${toolsExpression} } }) + '\\n',
      );
    }
  }
});
`;

  const toolList = (names: readonly string[]) => JSON.stringify(names.map((name) => ({ name })));

  it('reports Available when the server advertises the whole required toolset', async () => {
    const path = serverPath(
      'ok-server.cjs',
      stdioServer(toolList([...REQUIRED_MCP_TOOL_SUFFIXES, 'run_cypher_query'])),
    );
    await expect(probeMcpToolAvailability(path, undefined, 15_000)).resolves.toBe(
      McpAvailability.Available,
    );
  });

  // Symmetry with the Claude runner: a server that registered only part of its
  // toolset never applied the treatment, so it is infrastructure, not an agent
  // that had tools and ignored them.
  it('reports Unavailable when the server advertises only part of the required toolset', async () => {
    const partial = REQUIRED_MCP_TOOL_SUFFIXES.filter((name) => name !== 'find_dependents');
    expect(partial.length).toBeGreaterThan(0);
    const path = serverPath('partial-server.cjs', stdioServer(toolList(partial)));
    await expect(probeMcpToolAvailability(path, undefined, 15_000)).resolves.toBe(
      McpAvailability.Unavailable,
    );
  });

  it('reports Unavailable when the server advertises no tools', async () => {
    const path = serverPath('empty-server.cjs', stdioServer('[]'));
    await expect(probeMcpToolAvailability(path, undefined, 15_000)).resolves.toBe(
      McpAvailability.Unavailable,
    );
  });

  it('reports Unavailable when the server cannot start', async () => {
    const path = serverPath('broken-server.cjs', 'throw new Error("boom");\n');
    await expect(probeMcpToolAvailability(path, undefined, 15_000)).resolves.toBe(
      McpAvailability.Unavailable,
    );
  });
});

describe('runCodexAgent workspace precondition', () => {
  it('reports infrastructure_error without spawning codex when the checkout cwd is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-codex-empty-'));
    try {
      const result = await runCodexAgent({
        prompt: 'hi',
        systemPrompt: 'sys',
        model: 'unused',
        codexModel: 'gpt-5-codex',
        cwd: dir,
        arm: 'withoutMcp',
        accessMode: AccessMode.Worktree,
        extraTools: [],
        maxTurns: 5,
        timeoutMs: 10_000,
        transcriptPath: join(dir, 'transcript.json'),
      });
      expect(result.agentStatus).toBe('infrastructure_error');
      expect(result.error).toMatch(/is empty; expected a materialized checkout/);
      expect(result.model).toBe('gpt-5-codex');
      expect(result.usage.totalTokens).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
