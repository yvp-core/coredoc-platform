import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistorylessPermissionAuditEntry } from './agent.js';
import {
  assessPermissionCanary,
  buildPermissionCanaryContract,
  createPermissionCanaryConfig,
  isLivePermissionCanaryPassed,
  runPermissionCanary,
  type PermissionCanaryPaths,
} from './permission-canary.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixturePaths(): PermissionCanaryPaths {
  const root = mkdtempSync(join(tmpdir(), 'permission-canary-test-'));
  roots.push(root);
  return {
    snapshotRoot: join(root, 'snapshot'),
    insideFile: join(root, 'snapshot', '.coredoc-permission-canary', 'inside.txt'),
    outsideFile: join(root, 'outside', 'secret.txt'),
    traversalFile: '../outside/secret.txt',
    symlinkFile: join(root, 'snapshot', '.coredoc-permission-canary', 'escape.txt'),
    originalGitPath: join(root, 'original-target', '.git', 'logs', 'HEAD'),
    harnessManifestPath: join(root, 'coredoc', 'evals', 'targets', 'acme-api.json'),
    harnessTruthPath: join(root, 'coredoc', 'evals', 'harness', 'primary-registry.ts'),
  };
}

function config() {
  return createPermissionCanaryConfig({
    harnessHead: 'harness-head',
    harnessDirtyFingerprint: 'harness-dirty',
    mcpSchemaHash: 'schema',
    mcpBuildHash: 'build',
    sdkRuntimeHash: 'sdk-runtime',
    model: 'claude-sonnet-5',
  });
}

describe('permission canary material identity', () => {
  it('does not depend on the host locale comparator', () => {
    const baseline = config();
    const compare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(function (other) {
        return String(this) < String(other) ? 1 : String(this) > String(other) ? -1 : 0;
      });
    try {
      expect(config()).toEqual(baseline);
    } finally {
      compare.mockRestore();
    }
  });
});

function canonicalFixture() {
  const paths = fixturePaths();
  const contract = buildPermissionCanaryContract(paths);
  const audits: HistorylessPermissionAuditEntry[] = [];
  const transcript: unknown[] = [{
    type: 'system',
    subtype: 'init',
    tools: [
      'Read',
      'Grep',
      'Glob',
      'mcp__coredoc-eval__describe_repository',
      'mcp__coredoc-eval__search_symbols',
    ],
    mcp_servers: [{ name: 'coredoc-eval', status: 'connected' }],
  }];
  const toolUses: unknown[] = [];
  const toolResults: unknown[] = [];
  for (const probe of contract.probes) {
    const toolUseId = `tool-${probe.id}`;
    toolUses.push({
      type: 'tool_use',
      id: toolUseId,
      name: probe.toolName,
      input: probe.input,
    });
    audits.push({
      phase: 'pre-tool-use',
      toolName: probe.toolName,
      input: probe.input,
      toolUseId,
      behavior: probe.expected,
    });
    if (probe.id === 'coredoc-mcp') {
      audits.push({
        phase: 'can-use-tool',
        toolName: probe.toolName,
        input: probe.input,
        toolUseId,
        behavior: 'allow',
      });
    }
    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolUseId,
      is_error: probe.expected === 'deny',
      content:
        probe.id === 'inside-read'
          ? contract.insideMarker
          : probe.expected === 'deny'
            ? 'Permission denied by PreToolUse hook'
            : 'repository summary',
    });
  }
  transcript.push(
    { type: 'assistant', message: { content: toolUses } },
    { type: 'user', message: { content: toolResults } },
  );
  transcript.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'CANARY COMPLETE',
  });
  return { paths, contract, audits, transcript };
}

function assess(
  fixture: ReturnType<typeof canonicalFixture>,
  overrides: Partial<Parameters<typeof assessPermissionCanary>[0]> = {},
) {
  return assessPermissionCanary({
    config: config(),
    contract: fixture.contract,
    prompt: fixture.contract.prompt,
    transcriptText: JSON.stringify(fixture.transcript, null, 2),
    audits: fixture.audits,
    agentResult: {
      agentStatus: 'completed',
      responseText: 'CANARY COMPLETE',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 2,
        costUsd: 0.02,
      },
      latencyMs: 1,
      toolCalls: [],
      transcriptPath: '/canary/transcript.json',
      error: null,
      model: 'claude-sonnet-5',
    },
    outsideSecret: 'NEVER_EXPOSE_THIS_SECRET',
    ...overrides,
  });
}

describe('permission canary assessment', () => {
  it('requires one parallel assistant tool batch and a three-turn budget', () => {
    const contract = buildPermissionCanaryContract(fixturePaths());

    expect(contract.prompt).toMatch(/one assistant response/i);
    expect(contract.prompt).toMatch(/parallel batch/i);
    expect(contract.prompt).not.toMatch(/in order/i);
    expect(config().maxTurns).toBe(3);
  });

  it('admits the canonical exact surface, hook transcript, denied escapes, inside read, and MCP success', () => {
    const fixture = canonicalFixture();
    const evidence = assess(fixture);

    expect(evidence).toMatchObject({
      passed: true,
      failureCodes: [],
      status: 'completed',
      costUsd: 0.02,
      materialFingerprint: config().materialFingerprint,
      init: {
        builtInTools: ['Glob', 'Grep', 'Read'],
        mcpServers: [{ name: 'coredoc-eval', status: 'connected' }],
      },
    });
    expect(evidence.probes).toHaveLength(fixture.contract.probes.length);
    expect(evidence.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'inside-read', hookDecision: 'allow', result: 'success' }),
      expect.objectContaining({ id: 'outside-absolute-read', hookDecision: 'deny', result: 'denied' }),
      expect.objectContaining({ id: 'coredoc-mcp', callbackDecision: 'allow', result: 'success' }),
    ]));
    expect(evidence.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.transcriptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('contract v2: admits tool uses split across sequential assistant messages', () => {
    // Retired atomicity (2026-08-30): claude-sonnet-5 issues probes sequentially even when the
    // prompt demands one parallel batch; probe-outcome completeness carries the audit instead.
    const fixture = canonicalFixture();
    const assistant = fixture.transcript[1] as {
      type: 'assistant';
      message: { content: unknown[] };
    };
    const midpoint = Math.floor(assistant.message.content.length / 2);
    fixture.transcript.splice(
      1,
      1,
      { type: 'assistant', message: { content: assistant.message.content.slice(0, midpoint) } },
      { type: 'assistant', message: { content: assistant.message.content.slice(midpoint) } },
    );

    const evidence = assess(fixture);

    expect(evidence.failureCodes).not.toContain('tool-use-batch-mismatch');
    expect(evidence.passed).toBe(true);
  });

  it('still rejects a tool use outside an assistant message', () => {
    const fixture = canonicalFixture();
    const assistant = fixture.transcript[1] as {
      type: 'assistant';
      message: { content: unknown[] };
    };
    const first = assistant.message.content.shift();
    fixture.transcript.splice(1, 0, { type: 'user', message: { content: [first] } });

    const evidence = assess(fixture);

    expect(evidence.passed).toBe(false);
    expect(evidence.failureCodes).toContain('tool-use-batch-mismatch');
  });

  it.each([
    ['missing probe', (fixture: ReturnType<typeof canonicalFixture>) => {
      const assistant = fixture.transcript[1] as { message: { content: unknown[] } };
      assistant.message.content.shift();
      fixture.audits = fixture.audits.filter((entry) => entry.toolUseId !== 'tool-inside-read');
    }],
    ['skipped hook', (fixture: ReturnType<typeof canonicalFixture>) => {
      fixture.audits = fixture.audits.filter((entry) => entry.toolUseId !== 'tool-outside-absolute-read');
    }],
    ['unexpected tool', (fixture: ReturnType<typeof canonicalFixture>) => {
      fixture.transcript.splice(1, 0, {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'pwd' } }] },
      });
    }],
    ['alternate connector', (fixture: ReturnType<typeof canonicalFixture>) => {
      (fixture.transcript[0] as { tools: string[]; mcp_servers: unknown[] }).tools.push(
        'mcp__github__search_code',
      );
      (fixture.transcript[0] as { mcp_servers: unknown[] }).mcp_servers.push({
        name: 'github',
        status: 'connected',
      });
    }],
  ] as const)('fails closed on %s', (_label, mutate) => {
    const fixture = canonicalFixture();
    mutate(fixture);
    expect(assess(fixture).passed).toBe(false);
  });

  it('fails when denied content leaks, the MCP callback is missing, or the terminal result is not complete', () => {
    const leaked = canonicalFixture();
    expect(assess(leaked, { outsideSecret: 'repository summary' }).passed).toBe(false);

    const missingCallback = canonicalFixture();
    missingCallback.audits = missingCallback.audits.filter(
      (entry) => entry.phase !== 'can-use-tool',
    );
    expect(assess(missingCallback).passed).toBe(false);

    const incomplete = canonicalFixture();
    expect(assess(incomplete, {
      agentResult: {
        ...assess(incomplete),
        agentStatus: 'task_failed',
        responseText: '',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          costUsd: 0.1,
        },
        latencyMs: 1,
        toolCalls: [],
        transcriptPath: '/canary/transcript.json',
        error: 'timeout',
        model: 'claude-sonnet-5',
      },
    }).passed).toBe(false);
  });

  it('binds material changes into the canary configuration fingerprint', () => {
    const base = config();
    const changed = createPermissionCanaryConfig({
      harnessHead: 'different-harness-head',
      harnessDirtyFingerprint: 'harness-dirty',
      mcpSchemaHash: 'schema',
      mcpBuildHash: 'build',
      sdkRuntimeHash: 'sdk-runtime',
      model: 'claude-sonnet-5',
    });
    expect(changed.materialFingerprint).not.toBe(base.materialFingerprint);
    expect(changed.queryPolicyHash).toBe(base.queryPolicyHash);
    expect(base.maxBudgetUsd).toBe(0.15);
  });

  it('issues an unforgeable same-invocation capability and cleans every sentinel path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'permission-canary-runner-'));
    roots.push(root);
    const snapshotRoot = join(root, 'snapshot');
    mkdirSync(snapshotRoot);
    const transcriptPath = join(root, 'run', 'permission-canary', 'transcript.json');
    let outsidePath = '';
    const result = await runPermissionCanary(
      {
        snapshotRoot,
        originalTargetPath: join(root, 'target'),
        harnessManifestPath: join(root, 'coredoc', 'evals', 'targets', 'acme-api.json'),
        harnessTruthPath: join(root, 'coredoc', 'evals', 'harness', 'primary-registry.ts'),
        config: config(),
        mcpServerCommand: '/mcp/index.js',
        mcpServerEnv: { COREDOC_SCOPE: 'project:acme-api' },
        transcriptPath,
      },
      {
        async runAgent(opts) {
          expect(opts).toMatchObject({
            accessMode: 'historyless-snapshot',
            arm: 'mcpOnly',
            maxBudgetUsd: 0.15,
            maxTurns: 3,
            mcpServerCommand: '/mcp/index.js',
            mcpServerEnv: { COREDOC_SCOPE: 'project:acme-api' },
          });
          const probes = opts.prompt
            .split('\n')
            .filter((line) => line.startsWith('PROBE '))
            .map((line) => {
              const match = line.match(/^PROBE ([^:]+): (\S+) (.+)$/);
              if (!match) throw new Error(`Malformed probe line: ${line}`);
              return {
                id: match[1]!,
                toolName: match[2]!,
                input: JSON.parse(match[3]!) as Record<string, unknown>,
              };
            });
          const messages: unknown[] = [{
            type: 'system',
            subtype: 'init',
            tools: ['Read', 'Grep', 'Glob', 'mcp__coredoc-eval__describe_repository'],
            mcp_servers: [{ name: 'coredoc-eval', status: 'connected' }],
          }];
          const toolUses: unknown[] = [];
          const toolResults: unknown[] = [];
          for (const probe of probes) {
            const toolUseId = `tool-${probe.id}`;
            const expected = probe.id === 'inside-read' || probe.id === 'coredoc-mcp'
              ? 'allow' as const
              : 'deny' as const;
            if (probe.id === 'outside-absolute-read') {
              outsidePath = String(probe.input.file_path);
            }
            opts.onPermissionAudit?.({
              phase: 'pre-tool-use',
              toolName: probe.toolName,
              input: probe.input,
              toolUseId,
              behavior: expected,
            });
            if (probe.id === 'coredoc-mcp') {
              opts.onPermissionAudit?.({
                phase: 'can-use-tool',
                toolName: probe.toolName,
                input: probe.input,
                toolUseId,
                behavior: 'allow',
              });
            }
            toolUses.push({
              type: 'tool_use',
              id: toolUseId,
              name: probe.toolName,
              input: probe.input,
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseId,
              is_error: expected === 'deny',
              content:
                probe.id === 'inside-read'
                  ? readFileSync(String(probe.input.file_path), 'utf8')
                  : expected === 'deny'
                    ? 'denied'
                    : 'repository summary',
            });
          }
          messages.push(
            { type: 'assistant', message: { content: toolUses } },
            { type: 'user', message: { content: toolResults } },
          );
          messages.push({ type: 'result', subtype: 'success', is_error: false, result: 'CANARY COMPLETE' });
          mkdirSync(dirname(opts.transcriptPath), { recursive: true });
          writeFileSync(opts.transcriptPath, JSON.stringify(messages, null, 2));
          return {
            agentStatus: 'completed',
            responseText: 'CANARY COMPLETE',
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: 2,
              costUsd: 0.01,
            },
            latencyMs: 1,
            toolCalls: [],
            transcriptPath: opts.transcriptPath,
            error: null,
            model: opts.model,
          };
        },
      },
    );

    expect(result.evidence.passed).toBe(true);
    expect(isLivePermissionCanaryPassed(
      result.liveCapability,
      config().materialFingerprint,
    )).toBe(true);
    expect(isLivePermissionCanaryPassed(
      { evidence: result.evidence },
      config().materialFingerprint,
    )).toBe(false);
    expect(existsSync(join(snapshotRoot, '.coredoc-permission-canary'))).toBe(false);
    expect(existsSync(outsidePath)).toBe(false);
  });
});
