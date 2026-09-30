import { createHash } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { ReviewError, shaSchema, type GraphReader, type GraphSnapshot, type ReviewRequest } from './contracts.js';

const metadataSchema = z.object({
  staleness: z.object({
    parsedAt: z.string(),
    parsedCommit: shaSchema.optional(),
    repositories: z
      .array(
        z.object({
          name: z.string(),
          parsedAt: z.string(),
          parsedCommit: shaSchema.optional(),
          parserVersion: z.string().optional(),
        }),
      )
      .optional(),
  }),
});
type ToolResult = Awaited<ReturnType<Client['callTool']>>;

export class McpGraphReader implements GraphReader {
  private readonly client = new Client({ name: 'coredoc-pr-review', version: '1.0.0' });
  private initial: GraphSnapshot | undefined;
  private connected = false;
  constructor(
    private readonly settings: NonNullable<ReviewRequest['graph']>,
    private readonly repository: string,
    private readonly token: string,
    private readonly signal: AbortSignal,
  ) {}

  private async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.signal.aborted) throw new ReviewError('CANCELLED');
    if (!this.connected) {
      if (this.settings.local) {
        const local = this.settings.local;
        if (!isAbsolute(local.cliPath) || !isAbsolute(local.configPath))
          throw new ReviewError('GRAPH_LOCAL_PATH_INVALID');
        // Paths come from maintainer settings, never PR content or model arguments.
        const transport = new StdioClientTransport({
          command: process.execPath,
          cwd: dirname(local.cliPath),
          args: [local.cliPath, 'mcp', '--config', local.configPath, '--project', local.projectId],
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            ...(process.env.COREDOC_HOME ? { COREDOC_HOME: process.env.COREDOC_HOME } : {}),
            COREDOC_MCP_METRICS_DISABLED: '1',
            COREDOC_TELEMETRY_DISABLED: '1',
            COREDOC_DB_BACKEND: local.backend,
          },
          stderr: 'pipe',
        });
        transport.stderr?.on('data', () => undefined);
        await this.client.connect(transport, { signal: this.signal, timeout: 20_000 });
      } else {
        const url = new URL(this.settings.url!);
        if (
          url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        )
          throw new ReviewError('GRAPH_URL_DENIED');
        if (url.username || url.password || url.search || url.hash) throw new ReviewError('GRAPH_URL_DENIED');
        await this.client.connect(
          new StreamableHTTPClientTransport(url, {
            requestInit: {
              headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
              redirect: 'error',
              signal: this.signal,
            },
          }),
          { signal: this.signal, timeout: 20_000 },
        );
      }
      this.connected = true;
    }
    const response = await this.client.callTool(
      {
        name,
        arguments: {
          ...args,
          scope: this.settings.scope,
          format: 'raw',
          ...(name === 'describe_repository' ? {} : { detailLevel: 'basic' }),
        },
      },
      undefined,
      { signal: this.signal, timeout: 20_000 },
    );
    if (response.isError) throw new ReviewError('GRAPH_READ_FAILED');
    return response;
  }
  private snapshotOf(response: ToolResult): GraphSnapshot {
    const blocks = response.content as Array<{ type: string; text?: string }>;
    const block = blocks.find((x) => x.type === 'text' && x.text?.startsWith('Evidence metadata: '));
    if (!block?.text) throw new ReviewError('GRAPH_PROVENANCE_MISSING');
    let metadata: z.infer<typeof metadataSchema>;
    try {
      metadata = metadataSchema.parse(JSON.parse(block.text.slice('Evidence metadata: '.length)));
    } catch {
      throw new ReviewError('GRAPH_PROVENANCE_INVALID');
    }
    const rows = metadata.staleness.repositories;
    if (!rows || rows.length !== 1 || rows[0]!.name !== this.settings.repoName)
      throw new ReviewError('GRAPH_SCOPE_MISMATCH');
    const row = rows[0]!;
    const known = Boolean(row.parsedCommit && row.parsedAt !== 'unknown');
    return {
      commit: row.parsedCommit ?? null,
      parsedAt: row.parsedAt === 'unknown' ? null : row.parsedAt,
      // The existing MCP exposes a parse identity, not the cloud snapshot object's key.
      snapshotId: known ? `parse:${createHash('sha256').update(JSON.stringify(row)).digest('hex')}` : null,
      capturedAt: new Date().toISOString(),
    };
  }
  async snapshot(): Promise<GraphSnapshot> {
    const response = await this.call('describe_repository', {});
    const text = (response.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text;
    let repo: { name?: string; gitRemoteUrl?: string };
    try {
      repo = JSON.parse(text ?? '');
    } catch {
      throw new ReviewError('GRAPH_REPOSITORY_INVALID');
    }
    const expected = `github.com/${this.repository}`.toLowerCase();
    const remote = (repo.gitRemoteUrl ?? '')
      .replace(/^https?:\/\//, '')
      .replace(/^git@github.com:/, 'github.com/')
      .replace(/\.git$/, '')
      .replace(/\/$/, '')
      .toLowerCase();
    if (repo.name !== this.settings.repoName || remote !== expected) throw new ReviewError('GRAPH_REPOSITORY_MISMATCH');
    const snapshot = this.snapshotOf(response);
    this.initial ??= snapshot;
    return snapshot;
  }
  async query(operation: Parameters<GraphReader['query']>[0], query: string): Promise<unknown> {
    const args =
      operation === 'search_symbols'
        ? { query, limit: 12 }
        : operation === 'find_callers'
          ? { functionName: query, depth: 1 }
          : { target: query, ...(operation === 'analyze_change_impact' ? { depth: 1 } : {}) };
    const response = await this.call(operation, args);
    const current = this.snapshotOf(response);
    if (!this.initial || current.snapshotId !== this.initial.snapshotId || current.commit !== this.initial.commit)
      throw new ReviewError('GRAPH_CHANGED');
    const text = JSON.stringify(response.content);
    if (Buffer.byteLength(text) > 20_000) throw new ReviewError('GRAPH_RESPONSE_LIMIT');
    return {
      evidence: response.content,
      warning: 'Graph is a discovery hint. Verify every claim against pinned source.',
    };
  }
  async close(): Promise<void> {
    // Initialization may fail after starting a local MCP process.
    await this.client.close();
  }
}
