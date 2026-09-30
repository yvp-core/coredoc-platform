import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpGraphReader } from './graph.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { changed?: boolean; otherRepo?: boolean; extraRepo?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-graph-'));
  roots.push(root);
  const cliPath = join(root, 'trusted-cli.mjs');
  const configPath = join(root, 'config.json');
  await writeFile(configPath, '{}');
  await writeFile(
    cliPath,
    `
import { createInterface } from 'node:readline';
const options = ${JSON.stringify(options)};
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (request.method === 'tools/call') {
    const lookup = request.params.name !== 'describe_repository';
    const rows = [{ name: 'repo', parsedCommit: (options.changed && lookup ? 'b' : 'a').repeat(40), parsedAt: '2026-09-16T00:00:00Z', parserVersion: 'fixture' }];
    if (options.extraRepo) rows.push({ ...rows[0], name: 'another' });
    const payload = lookup ? { args: request.params.arguments, name: request.params.name, metricsDisabled: process.env.COREDOC_MCP_METRICS_DISABLED, telemetryDisabled: process.env.COREDOC_TELEMETRY_DISABLED, backend: process.env.COREDOC_DB_BACKEND, inheritedModelKey: Boolean(process.env.COREDOC_REVIEW_LLM_API_KEY), cwd: process.cwd(), argv: process.argv.slice(2) }
      : { name: 'repo', gitRemoteUrl: options.otherRepo ? 'https://github.com/wrong/repo' : 'https://github.com/owner/repo.git' };
    result = { content: [{ type: 'text', text: JSON.stringify(payload) }, { type: 'text', text: 'Evidence metadata: ' + JSON.stringify({ staleness: { parsedAt: rows[0].parsedAt, repositories: rows } }) }] };
  } else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + String.fromCharCode(10));
});
`,
  );
  const graph = new McpGraphReader(
    {
      local: { cliPath, configPath, projectId: 'prepared-base', backend: 'ladybug' },
      scope: 'repo:repo',
      repoName: 'repo',
      locallyPreparedBase: true,
    },
    'owner/repo',
    '',
    new AbortController().signal,
  );
  return { graph, configPath, root };
}

describe('scoped graph capability', () => {
  it('uses the installed stdio reader with fixed scope and no model credential', async () => {
    vi.stubEnv('COREDOC_REVIEW_LLM_API_KEY', 'fixture-host-secret');
    const { graph, configPath, root } = await fixture();
    try {
      expect(await graph.snapshot()).toMatchObject({
        commit: 'a'.repeat(40),
        snapshotId: expect.stringMatching(/^parse:/),
      });
      const result = (await graph.query('find_callers', 'calculate')) as { evidence: Array<{ text: string }> };
      const payload = JSON.parse(result.evidence[0]!.text);
      expect(payload).toMatchObject({
        name: 'find_callers',
        args: { scope: 'repo:repo', functionName: 'calculate', depth: 1, format: 'raw' },
        metricsDisabled: '1',
        telemetryDisabled: '1',
        backend: 'ladybug',
        inheritedModelKey: false,
        cwd: await realpath(root),
        argv: ['mcp', '--config', configPath, '--project', 'prepared-base'],
      });
    } finally {
      await graph.close();
    }
  });
  it.each([
    { otherRepo: true },
    { extraRepo: true },
  ])('refuses evidence outside the configured repository: %j', async (options) => {
    const { graph } = await fixture(options);
    try {
      await expect(graph.snapshot()).rejects.toThrow(/GRAPH_(REPOSITORY|SCOPE)_MISMATCH/);
    } finally {
      await graph.close();
    }
  });
  it('refuses graph queries when the snapshot changes during the run', async () => {
    const { graph } = await fixture({ changed: true });
    try {
      await graph.snapshot();
      await expect(graph.query('search_symbols', 'calculate')).rejects.toThrow('GRAPH_CHANGED');
    } finally {
      await graph.close();
    }
  });
});
