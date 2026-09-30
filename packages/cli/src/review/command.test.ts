import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capturePull,
  errorCode,
  executeReview,
  registerReviewCommand,
  resolveModelCredential,
  settingsSchema,
  eventPullNumber,
} from './command.js';
import { GithubReadClient, GithubSourceReader } from './source.js';
import { requestSchema, ReviewAuthMode, ReviewError, type ReviewResult } from './contracts.js';
import { safeText } from './report.js';

/** The SDK is stubbed so no test spawns the Claude runtime; `tool()` hands back its own handler. */
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

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const settings = settingsSchema.parse({
  policy: { version: 'v1', text: '' },
  model: { provider: 'openai', id: 'test' },
  limits: {},
  arm: 'A',
});
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function github(overrides: Record<string, unknown> = {}) {
  const paths: string[] = [];
  const pull = {
    number: 7,
    state: 'open',
    draft: false,
    user: { login: 'maintainer' },
    base: { sha: base, ref: 'main', repo: { id: 1, full_name: 'owner/repo' } },
    head: { sha: head, repo: { id: 1, full_name: 'owner/repo' } },
    ...overrides,
  };
  const fetcher = (async (input: string, options: RequestInit) => {
    paths.push(input);
    expect(options.method).toBeUndefined();
    expect(options.redirect).toBe('error');
    const body = input.includes('/pulls/')
      ? pull
      : input.includes('/compare/')
        ? { merge_base_commit: { sha: merge } }
        : { default_branch: 'main', full_name: 'owner/repo' };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return { client: new GithubReadClient('owner/repo', '', undefined, fetcher), paths };
}
describe('live PR capture', () => {
  it('requires canonical PR numbers so dispatch cannot bypass the concurrency group', () => {
    expect(eventPullNumber('1')).toBe(1);
    expect(eventPullNumber(1)).toBe(1);
    for (const value of ['001', '1 ', ' 1', '1.0', '1e0', '0', undefined, -1, 1.5])
      expect(() => eventPullNumber(value)).toThrow('PR_NUMBER_INVALID');
  });
  it('captures explicit head and merge-base, ignoring Actions merge SHA', async () => {
    const g = github();
    const result = await capturePull(g.client, 7, settings);
    expect(result.request).toMatchObject({ headSha: head, baseSha: base, mergeBaseSha: merge, mode: 'prospective' });
    expect(g.paths).toContain(`https://api.github.com/repos/owner/repo/compare/${base}...${head}?per_page=1`);
  });
  it.each([
    [{ draft: true }, 'PR_DRAFT'],
    [{ state: 'closed' }, 'PR_NOT_OPEN'],
    [{ user: { login: 'dependabot[bot]' } }, 'PR_DEPENDABOT'],
    [{ head: { sha: head, repo: { id: 2, full_name: 'fork/repo' } } }, 'PR_FORK'],
    [{ base: { sha: base, ref: 'release', repo: { id: 1, full_name: 'owner/repo' } } }, 'PR_NON_DEFAULT_BASE'],
  ])('excludes %j before collecting a diff', async (override, reason) => {
    const g = github(override);
    expect(await capturePull(g.client, 7, settings)).toEqual({ skipReason: reason });
    expect(g.paths.some((p) => p.includes('compare'))).toBe(false);
  });
  it('refuses malformed metadata instead of accepting an empty object', async () => {
    const g = new GithubReadClient('owner/repo', '', undefined, (async () => new Response('{}')) as typeof fetch);
    await expect(capturePull(g, 7, settings)).rejects.toThrow();
  });
  it('reports API file-list truncation and uses top-level distance counts', async () => {
    const request = requestSchema.parse({
      ...settings,
      schemaVersion: 1,
      repository: 'owner/repo',
      pullNumber: 7,
      baseSha: base,
      mergeBaseSha: merge,
      headSha: head,
      mode: 'historical',
    });
    const g = new GithubReadClient(
      'owner/repo',
      '',
      undefined,
      (async () =>
        new Response(
          JSON.stringify({
            status: 'ahead',
            ahead_by: 8,
            behind_by: 0,
            commits: [{}],
            files: Array.from({ length: 300 }, (_, i) => ({ filename: `src/${i}.ts`, status: 'modified' })),
          }),
        )) as typeof fetch,
    );
    const reader = new GithubSourceReader(request, g);
    expect((await reader.changes()).gaps).toContain('COMPARE_FILES_MAY_BE_TRUNCATED');
    expect(await reader.distance(head)).toMatchObject({ ahead: 8, source: 'api' });
  });
  it('never publishes a cancelled run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-cancel-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const settingsPath = join(dir, 'settings.json');
    const eventPath = join(dir, 'event.json');
    const output = join(dir, 'result.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        arm: 'A',
        policy: { version: 'v1', text: '' },
        model: { provider: 'http://127.0.0.1:1/v1', id: 'fixture' },
      }),
    );
    await writeFile(eventPath, JSON.stringify({ number: 7 }));
    const writes: string[] = [];
    const source = 'export const divide = (n) => n / 0;';
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    const originalExit = process.exitCode;
    cleanups.push(async () => {
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
      process.exitCode = originalExit;
    });
    globalThis.fetch = (async (input: string | Request, options: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname !== 'api.github.com') {
        // The maintainer interrupted the run while the model call was in flight.
        process.emit('SIGINT');
        return Response.json({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"summary":"","findings":[]}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        });
      }
      if (options.method) writes.push(`${options.method} ${url.pathname}`);
      const path = url.pathname.replace('/repos/owner/repo', '');
      if (path === '') return Response.json({ default_branch: 'main', full_name: 'owner/repo' });
      if (path === '/pulls/7')
        return Response.json({
          number: 7,
          state: 'open',
          draft: false,
          user: { login: 'maintainer' },
          head: { sha: head, repo: { id: 1, full_name: 'owner/repo' } },
          base: { sha: base, ref: 'main', repo: { id: 1, full_name: 'owner/repo' } },
        });
      if (path.startsWith('/compare/'))
        return Response.json({
          merge_base_commit: { sha: merge },
          files: [{ filename: 'a.ts', status: 'modified', patch: `@@ -1 +1 @@\n-x\n+${source}` }],
        });
      return Response.json([]);
    }) as typeof fetch;
    process.env = {
      ...originalEnv,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_TOKEN: 'fixture-token',
      COREDOC_REVIEW_LLM_API_KEY: 'fixture-key',
    };
    const program = new Command();
    registerReviewCommand(program);
    await program.parseAsync(['node', 'review', 'review', 'event', '--settings', settingsPath, '--output', output]);
    const result = JSON.parse(await readFile(output, 'utf8')) as ReviewResult;
    expect(result.status).toBe('cancelled');
    expect(result.publication).toEqual({ status: 'superseded', commentIds: [], reason: 'CANCELLED' });
    expect(writes).toEqual([]);
    // A cancelled run is an infrastructure outcome: the job must go red.
    expect(process.exitCode).toBe(1);
  });
  it.each([
    ['publishes an incomplete review and leaves the job green', false, 'published', 0],
    ['fails the job when the publication itself failed', true, 'failed', 1],
  ])('%s', async (_name, breakSummaryList, publication, exitCode) => {
    const dir = await mkdtemp(join(tmpdir(), 'review-exit-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const settingsPath = join(dir, 'settings.json');
    const eventPath = join(dir, 'event.json');
    const output = join(dir, 'result.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        arm: 'A',
        policy: { version: 'v1', text: '' },
        model: { provider: 'http://127.0.0.1:1/v1', id: 'fixture' },
      }),
    );
    await writeFile(eventPath, JSON.stringify({ number: 7 }));
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    const originalExit = process.exitCode;
    cleanups.push(async () => {
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
      process.exitCode = originalExit;
    });
    const summaries: unknown[] = [];
    globalThis.fetch = (async (input: string | Request, options: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname !== 'api.github.com') {
        // The router is tool-less; discovery then answers without reading source, which is
        // reported as SOURCE_NOT_INSPECTED and makes the review incomplete.
        const tools = (JSON.parse(String(options.body)) as { tools?: unknown[] }).tools?.length;
        return Response.json({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: tools ? '{"summary":"","findings":[]}' : '{"lenses":[]}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        });
      }
      const path = url.pathname.replace('/repos/owner/repo', '');
      if (options.method) {
        summaries.push(`${options.method} ${path}`);
        return Response.json({});
      }
      if (path === '') return Response.json({ default_branch: 'main', full_name: 'owner/repo' });
      if (path === '/pulls/7')
        return Response.json({
          number: 7,
          state: 'open',
          draft: false,
          user: { login: 'maintainer' },
          head: { sha: head, repo: { id: 1, full_name: 'owner/repo' } },
          base: { sha: base, ref: 'main', repo: { id: 1, full_name: 'owner/repo' } },
        });
      if (path.startsWith('/compare/'))
        return Response.json({
          merge_base_commit: { sha: merge },
          files: [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' }],
        });
      if (path === '/actions/workflows/pr-review.yml') return Response.json({ state: 'active' });
      // The summary listing is the first publication read after the finding pass, so refusing it
      // fails the publication before any write was attempted.
      if (breakSummaryList && path.startsWith('/issues/7/comments')) return new Response('nope', { status: 500 });
      return Response.json([]);
    }) as typeof fetch;
    process.env = {
      ...originalEnv,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_TOKEN: 'fixture-token',
      COREDOC_REVIEW_LLM_API_KEY: 'fixture-key',
    };
    process.exitCode = 0;
    const program = new Command();
    registerReviewCommand(program);
    await program.parseAsync(['node', 'review', 'review', 'event', '--settings', settingsPath, '--output', output]);
    const result = JSON.parse(await readFile(output, 'utf8')) as ReviewResult;
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('SOURCE_NOT_INSPECTED');
    expect(result.publication?.status).toBe(publication);
    expect(process.exitCode).toBe(exitCode);
  });
  it('reports only the machine-readable code or error class, never the message', () => {
    expect(errorCode(new ReviewError('PUBLICATION_SUPERSEDED'))).toBe('PUBLICATION_SUPERSEDED');
    const typed = errorCode(new TypeError('token ghp_fixture_secret leaked'));
    expect(typed).toBe('TypeError');
    expect(typed).not.toContain('ghp_fixture_secret');
    expect(errorCode('token ghp_fixture_secret leaked')).toBe('UNKNOWN');
    expect(errorCode(undefined)).toBe('UNKNOWN');
  });
  it('neutralizes mentions, markup and model-generated links', () => {
    const safe = safeText('<img src=x> @team [click](https://evil.invalid)');
    expect(safe).not.toContain('<img');
    expect(safe).not.toContain('@team');
    expect(safe).not.toContain('https://');
  });
  it('sends OpenRouter reasoning and price-ceiling settings as model settings, independent of maxUsd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-openrouter-settings-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Review test');
    git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(dir, 'a.ts'), 'export const answer = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const gitBase = git('rev-parse', 'HEAD');
    await writeFile(join(dir, 'a.ts'), 'export const answer = 2;\n');
    git('add', '.');
    git('commit', '-qm', 'head');
    const gitHead = git('rev-parse', 'HEAD');
    const requests: unknown[] = [];
    const originalFetch = globalThis.fetch;
    cleanups.push(async () => {
      globalThis.fetch = originalFetch;
    });
    let modelCalls = 0;
    globalThis.fetch = (async (input: string | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname !== 'openrouter.ai') throw new Error(`Unexpected network target: ${url.hostname}`);
      requests.push(JSON.parse(init.body as string));
      modelCalls++;
      const message =
        // The tool-less first call is the lens router.
        !(JSON.parse(init.body as string) as { tools?: unknown[] }).tools?.length
          ? { role: 'assistant', content: '{"lenses":[]}' }
          : modelCalls === 2
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'read1',
                    type: 'function',
                    function: {
                      name: 'read_source',
                      arguments: JSON.stringify({ revision: 'head', path: 'a.ts', startLine: 1, endLine: 1 }),
                    },
                  },
                ],
              }
            : { role: 'assistant', content: '{"summary":"","findings":[]}' };
      return Response.json({
        id: 'fixture',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemini-3.8-flash',
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      });
    }) as typeof fetch;
    const output = join(dir, 'result.json');
    const request = requestSchema.parse({
      schemaVersion: 1,
      repository: 'owner/repo',
      pullNumber: 1,
      baseSha: gitBase,
      mergeBaseSha: gitBase,
      headSha: gitHead,
      mode: 'historical',
      arm: 'A',
      policy: { version: 'fixture-v1', text: '' },
      model: {
        provider: 'openrouter',
        id: 'google/gemini-3.8-flash',
        inputUsdPerMillion: 0.75,
        outputUsdPerMillion: 3.75,
      },
    });
    const result = await executeReview(request, { repoDir: dir, output }, { COREDOC_REVIEW_LLM_API_KEY: 'k' });
    expect(result.status).toBe('completed');
    expect(result.billing).toBeUndefined();
    expect(requests.length).toBeGreaterThan(0);
    for (const body of requests as Array<{
      reasoning: unknown;
      provider: Record<string, unknown>;
      session_id?: unknown;
      tools?: unknown[];
      messages: Array<{ content: unknown }>;
    }>) {
      // The lens calls carry the prompt-cache breakpoints on the shared prefix and the task message.
      if (body.tools?.length) {
        for (const index of [1, 2]) {
          const content = body.messages[index]?.content;
          expect(Array.isArray(content)).toBe(true);
          const parts = content as Array<Record<string, unknown>>;
          expect(parts.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
        }
      }
      expect(body.reasoning).toEqual({ effort: 'low' });
      expect(body.provider).toMatchObject({
        allow_fallbacks: true,
        max_price: { prompt: 0.75, completion: 3.75, request: 0 },
      });
      // `sort` would disable sticky routing, so the run would lose its per-endpoint prompt cache.
      expect(body.provider.sort).toBeUndefined();
      expect(body.session_id).toEqual(expect.any(String));
    }
  });
});

describe('credential and runtime selection', () => {
  it.each([
    ['openrouter', { COREDOC_REVIEW_LLM_API_KEY: 'k' }, ReviewAuthMode.ApiKey],
    ['openai', { COREDOC_REVIEW_LLM_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: '   ' }, ReviewAuthMode.ApiKey],
    ['claude-code', { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, ReviewAuthMode.Subscription],
    ['claude-code', { COREDOC_REVIEW_LLM_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, ReviewAuthMode.Subscription],
  ])('accepts the single credential that matches %s', (provider, env, mode) => {
    expect(resolveModelCredential(provider, env)).toBe(mode);
  });
  it.each([
    ['both', 'openrouter', { COREDOC_REVIEW_LLM_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }],
    ['both', 'claude-code', { COREDOC_REVIEW_LLM_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }],
    ['neither', 'openrouter', {}],
    ['neither', 'claude-code', { COREDOC_REVIEW_LLM_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '  ' }],
    ['the wrong one', 'claude-code', { COREDOC_REVIEW_LLM_API_KEY: 'k' }],
    ['the wrong one', 'openrouter', { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }],
  ])('refuses %s for %s', (_case, provider, env) => {
    expect(() => resolveModelCredential(provider, env)).toThrow('MODEL_CREDENTIAL_MISCONFIGURED');
  });
  it('fails the event before any GitHub read and names the code in the Markdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-credential-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const settingsPath = join(dir, 'settings.json');
    const eventPath = join(dir, 'event.json');
    const output = join(dir, 'result.json');
    const markdown = join(dir, 'result.md');
    await writeFile(
      settingsPath,
      JSON.stringify({
        arm: 'A',
        policy: { version: 'v1', text: '' },
        model: { provider: 'claude-code', id: 'sonnet' },
      }),
    );
    await writeFile(eventPath, JSON.stringify({ number: 7 }));
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    const originalExit = process.exitCode;
    cleanups.push(async () => {
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
      process.exitCode = originalExit;
    });
    const fetchSpy = vi.fn(async () => new Response('{}'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    process.env = {
      ...originalEnv,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_TOKEN: 'fixture-token',
      // Both credentials at once: the run must stop before it can choose one.
      COREDOC_REVIEW_LLM_API_KEY: 'fixture-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token-value',
    };
    process.exitCode = 0;
    const program = new Command();
    registerReviewCommand(program);
    await program.parseAsync([
      'node',
      'review',
      'review',
      'event',
      '--settings',
      settingsPath,
      '--output',
      output,
      '--markdown',
      markdown,
    ]);
    expect(process.exitCode).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const report = await readFile(markdown, 'utf8');
    // safeText escapes the underscores so the code cannot render as Markdown emphasis.
    expect(report).toContain('MODEL\\_CREDENTIAL\\_MISCONFIGURED');
    expect(report).toContain('Coredoc review — incomplete');
    expect(report).toContain('Configure exactly one model credential');
    await expect(readFile(output, 'utf8')).rejects.toThrow();
  });
  it('leaves an already written report Markdown intact when a later write fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-late-failure-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    // Only the JSON report's directory is frozen mid-run, so the catch could still rewrite the
    // Markdown if the guard were missing.
    const outputDir = join(dir, 'json');
    await mkdir(outputDir);
    const settingsPath = join(dir, 'settings.json');
    const eventPath = join(dir, 'event.json');
    const output = join(outputDir, 'result.json');
    const markdown = join(dir, 'result.md');
    await writeFile(
      settingsPath,
      JSON.stringify({
        arm: 'A',
        policy: { version: 'v1', text: '' },
        model: { provider: 'http://127.0.0.1:1/v1', id: 'fixture' },
      }),
    );
    await writeFile(eventPath, JSON.stringify({ number: 7 }));
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    const originalExit = process.exitCode;
    cleanups.push(async () => {
      await chmod(outputDir, 0o700);
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
      process.exitCode = originalExit;
    });
    globalThis.fetch = (async (input: string | Request, options: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname !== 'api.github.com')
        return Response.json({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: (JSON.parse(String(options.body)) as { tools?: unknown[] }).tools?.length
                  ? '{"summary":"","findings":[]}'
                  : '{"lenses":[]}',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        });
      const path = url.pathname.replace('/repos/owner/repo', '');
      if (options.method) {
        // Publication has started, so both reports are already on disk: freeze the JSON directory.
        await chmod(outputDir, 0o500);
        return Response.json({});
      }
      if (path === '') return Response.json({ default_branch: 'main', full_name: 'owner/repo' });
      if (path === '/pulls/7')
        return Response.json({
          number: 7,
          state: 'open',
          draft: false,
          user: { login: 'maintainer' },
          head: { sha: head, repo: { id: 1, full_name: 'owner/repo' } },
          base: { sha: base, ref: 'main', repo: { id: 1, full_name: 'owner/repo' } },
        });
      if (path.startsWith('/compare/'))
        return Response.json({
          merge_base_commit: { sha: merge },
          files: [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' }],
        });
      if (path === '/actions/workflows/pr-review.yml') return Response.json({ state: 'active' });
      return Response.json([]);
    }) as typeof fetch;
    process.env = {
      ...originalEnv,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_TOKEN: 'fixture-token',
      COREDOC_REVIEW_LLM_API_KEY: 'fixture-key',
    };
    process.exitCode = 0;
    const program = new Command();
    registerReviewCommand(program);
    await program.parseAsync([
      'node',
      'review',
      'review',
      'event',
      '--settings',
      settingsPath,
      '--output',
      output,
      '--markdown',
      markdown,
    ]);
    expect(process.exitCode).toBe(1);
    const report = await readFile(markdown, 'utf8');
    expect(report).toContain('Coredoc review —');
    expect(report).not.toContain('the run failed before a review was produced');
    expect(report).not.toContain('# Coredoc review — incomplete\n\n`Error');
  });
  it('runs the Claude runtime on the subscription credential without leaking the token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-claude-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const output = join(dir, 'result.json');
    const markdown = join(dir, 'result.md');
    const token = 'tok-secret-123';
    const source = 'export const answer = 2;\n';
    const originalFetch = globalThis.fetch;
    cleanups.push(async () => {
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = (async (input: string | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname !== 'api.github.com') throw new Error(`Unexpected network target: ${url.hostname}`);
      if (url.pathname.includes('/compare/'))
        return Response.json({
          merge_base_commit: { sha: base },
          files: [{ filename: 'a.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+export const answer = 2;' }],
        });
      if (url.pathname.includes('/git/trees/'))
        return Response.json({
          truncated: false,
          tree: [{ path: 'a.ts', type: 'blob', mode: '100644', sha: merge, size: source.length }],
        });
      if (url.pathname.includes('/git/blobs/'))
        return Response.json({
          encoding: 'base64',
          size: source.length,
          content: Buffer.from(source).toString('base64'),
        });
      throw new Error(`Unexpected GitHub read: ${url.pathname}`);
    }) as typeof fetch;
    const environments: Array<Record<string, string>> = [];
    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for the SDK's loosely typed options
    const query = (({ options }: { options: Record<string, any> }) => {
      environments.push(options.env);
      const withTools = (options.allowedTools ?? []).length > 0;
      return (async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 's1',
          tools: options.allowedTools ?? [],
          mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: 'connected' })),
          agents: [],
          plugins: [],
          skills: [],
        };
        yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'done' }] } };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 's1',
          permission_denials: [],
          usage: { input_tokens: 10, output_tokens: 4 },
          structured_output: withTools ? { summary: '', findings: [] } : { lenses: [] },
        };
      })();
      // biome-ignore lint/suspicious/noExplicitAny: same reason as above
    }) as any;
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args.join(' ')));
    const errorLog = vi.spyOn(console, 'error').mockImplementation((...args) => void logs.push(args.join(' ')));
    cleanups.push(async () => {
      log.mockRestore();
      errorLog.mockRestore();
    });
    const request = requestSchema.parse({
      schemaVersion: 1,
      repository: 'owner/repo',
      pullNumber: 1,
      baseSha: base,
      mergeBaseSha: base,
      headSha: head,
      mode: 'historical',
      arm: 'A',
      policy: { version: 'fixture-v1', text: '' },
      model: { provider: 'claude-code', id: 'sonnet' },
    });
    const result = await executeReview(
      request,
      { output, markdown, claudeCodeQuery: query },
      {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        ANTHROPIC_API_KEY: 'leak',
        HTTPS_PROXY: 'x',
        GITHUB_TOKEN: 'gh',
      },
    );
    expect(result.configuration.auth).toBe('subscription');
    expect(result.configuration.runtime).toBe('claude-agent-sdk');
    expect(environments.length).toBeGreaterThan(0);
    for (const env of environments) {
      expect(Object.keys(env).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME']);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
      expect(env.HOME).toBe(env.CLAUDE_CONFIG_DIR);
    }
    expect(await readFile(output, 'utf8')).not.toContain(token);
    expect(await readFile(markdown, 'utf8')).not.toContain(token);
    expect(logs.join('\n')).not.toContain(token);
  });
});
