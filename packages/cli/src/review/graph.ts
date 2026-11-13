import { createHash } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import {
  ReviewError,
  shaSchema,
  type GraphReader,
  type GraphSnapshot,
  type IntentRule,
  type ReviewRequest,
} from './contracts.js';

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
/** Files one context read accepts (the server's INTENT_CONTEXT_READ_LIMITS.nodeIds). */
const INTENT_FILES = 50;
/** The context read's answer, or one of its typed states (`status` is absent on success). */
const intentAnswerSchema = z.object({
  status: z.string().optional(),
  truncated: z.boolean().optional(),
  scanTruncated: z.boolean().optional(),
  matches: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        kind: z.string(),
        title: z.string(),
        authority: z.string(),
        statement: z.string(),
        body: z.array(z.string()).optional(),
        appliesWhen: z.unknown().optional(),
        inheritedConditions: z.unknown().optional(),
      }),
    )
    .optional(),
});

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

  private async call(name: string, args: Record<string, unknown>, graphArgs = true): Promise<ToolResult> {
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
        // The intent tools take a strict schema and refuse the graph tools' common arguments.
        arguments: graphArgs
          ? {
              ...args,
              scope: this.settings.scope,
              format: 'raw',
              ...(name === 'describe_repository' ? {} : { detailLevel: 'basic' }),
            }
          : args,
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
  async intent(paths: string[]): Promise<{ rules: IntentRule[]; truncated: boolean }> {
    const repoKey = this.settings.intent?.repoKey;
    if (!repoKey) throw new ReviewError('INTENT_NOT_ENABLED');
    const files = paths.slice(0, INTENT_FILES);
    let response: ToolResult;
    try {
      response = await this.call(
        'get_intent_context',
        // The server needs task text beside files; the paths are the only text the host trusts.
        { task: files.join(' ').slice(0, 2000), files: files.map((path) => ({ repoKey, path })), limit: 20 },
        false,
      );
    } catch (error) {
      if (error instanceof ReviewError && error.code === 'GRAPH_READ_FAILED')
        throw new ReviewError('INTENT_READ_FAILED');
      throw error;
    }
    const text = (response.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text;
    let answer: z.infer<typeof intentAnswerSchema>;
    try {
      answer = intentAnswerSchema.parse(JSON.parse(text ?? ''));
    } catch {
      throw new ReviewError('INTENT_RESPONSE_INVALID');
    }
    // A workspace with no intent content is not a failure: there is simply nothing to check.
    if (answer.status === 'not_configured') return { rules: [], truncated: false };
    if (answer.status === 'permission_denied') throw new ReviewError('INTENT_PERMISSION_DENIED');
    if (answer.status || !answer.matches) throw new ReviewError('INTENT_READ_FAILED');
    const rules: IntentRule[] = [];
    let bytes = 0;
    for (const match of answer.matches) {
      // Only accepted intent is policy; a candidate must never reach the lens.
      if (match.authority !== 'accepted') continue;
      const { id, kind, title, statement, body, appliesWhen, inheritedConditions } = match;
      const rule = { id, kind, title, statement, body, appliesWhen, inheritedConditions };
      bytes += Buffer.byteLength(JSON.stringify(rule));
      if (bytes > 20_000) return { rules, truncated: true };
      rules.push(rule);
    }
    return { rules, truncated: Boolean(answer.truncated || answer.scanTruncated) || paths.length > INTENT_FILES };
  }
  async close(): Promise<void> {
    // Initialization may fail after starting a local MCP process.
    await this.client.close();
  }
}
