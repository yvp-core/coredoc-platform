/**
 * `coredoc ci run` push step.
 *
 * The push is enqueued (202) and watched by polling the job endpoint — never
 * held open on one HTTP request, which proxies cut long before a large graph
 * write finishes. Everything below mocks the *network*, so the real enqueue +
 * poll code runs.
 */

import { gunzipSync } from 'node:zlib';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const pullParserFromServer = vi.hoisted(() => vi.fn());
const loadParser = vi.hoisted(() => vi.fn());

vi.mock('../parser-remote.js', () => ({ pullParserFromServer }));
vi.mock('../parser-loader.js', () => ({ loadParser }));

const PARSED_REPO = {
  id: 'repo:api',
  name: 'api',
  files: [],
  functions: [],
  classes: [],
  entrypoints: [],
  entities: [],
  externalCalls: [],
};

interface JobBody {
  id: string;
  status: string;
  lastError?: string | null;
  result?: unknown;
}

let requested: string[];
let sent: Array<{ url: string; body: unknown; authorization?: string }>;
let outputDir: string;

/** Route the endpoints the run touches; job polls follow `jobs`. */
function stubServer(jobs: JobBody[]): void {
  let poll = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string | Buffer; headers?: Record<string, string> }) => {
      requested.push(url);
      // Artifact uploads are gzipped on the wire; inflate before inspecting.
      const rawBody =
        init?.headers?.['Content-Encoding'] === 'gzip' ? gunzipSync(init.body as Buffer).toString() : init?.body;
      sent.push({
        url,
        body: rawBody ? JSON.parse(rawBody as string) : undefined,
        authorization: init?.headers?.Authorization,
      });
      const ok = (status: number, body: unknown) =>
        ({ ok: true, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
      if (url.includes('/results/upload')) {
        return ok(200, { version: 'parsed_v1', sizeBytes: 10, uploadedAt: 'now', duplicate: false });
      }
      if (url.includes('/push')) return ok(202, { jobId: 'job_1', status: 'queued' });
      if (url.includes('/jobs/')) {
        const body = jobs[Math.min(poll, jobs.length - 1)];
        poll += 1;
        return ok(200, { lastError: null, result: null, ...body });
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
}

beforeEach(() => {
  requested = [];
  sent = [];
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-ci-run-'));
  process.env.COREDOC_TOKEN = 'cdt_test';
  process.env.COREDOC_WORKSPACE_ID = 'ws_1';
  process.env.COREDOC_SERVER_URL = 'https://api.test';
  delete process.env.COREDOC_LLM_API_KEY;

  pullParserFromServer.mockClear();
  delete process.env.COREDOC_PROFILE_PATH;
  pullParserFromServer.mockImplementation(async ({ targetDir, repoName }: { targetDir: string; repoName: string }) => {
    fs.mkdirSync(path.join(targetDir, repoName), { recursive: true });
    return { version: '1' };
  });
  loadParser.mockResolvedValue({ parse: async () => structuredClone(PARSED_REPO) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(outputDir, { recursive: true, force: true });
});

async function run(overrides: Record<string, unknown> = {}) {
  const { runCi } = await import('./run.js');
  return runCi({ repo: 'api', output: outputDir, ...overrides });
}

describe('ci run push step', () => {
  it.each([false, true])('applies publication policy to real TS basic output (dry run: %s)', async (dryRun) => {
    const repoRoot = path.join(outputDir, 'source');
    fs.mkdirSync(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"fixture","private":true}');
    fs.writeFileSync(path.join(repoRoot, 'index.ts'), 'export function hello() { return "hello"; }');
    const { runProfile } = await import('@coredoc/profile-parser');
    loadParser.mockResolvedValue({
      parse: async () =>
        (
          await runProfile(
            {
              parserId: 'test/ci-basic',
              substrate: { language: 'ts', include: ['**/*.ts'] },
            },
            repoRoot,
            'api',
          )
        ).repo,
    });
    stubServer([{ id: 'job_1', status: 'succeeded' }]);
    const result = await run({ dryRun });
    expect(result.status).toBe(dryRun ? 'success' : 'error');
    expect(requested).toEqual([]);
    if (dryRun) {
      const parsed = JSON.parse(fs.readFileSync(path.join(outputDir, 'api.json'), 'utf8'));
      expect(parsed.functions.some((fn: { name: string }) => fn.name === 'hello')).toBe(true);
      expect(parsed.stats.analysis).toEqual([
        { language: 'ts', mode: 'basic', fallback: true, compilerReceiverTypes: false },
      ]);
    } else {
      expect(result.error).toContain('refusing to publish');
    }
    expect(fs.readdirSync(repoRoot).sort()).toEqual(['index.ts', 'package.json']);
  });

  it.each(
    ['ts', 'js'].flatMap((language) => ['call', 'external'].map((kind) => ({ language, kind }))),
  )('refuses a degraded $language target even with a resolved backend $kind edge', async ({ language, kind }) => {
    loadParser.mockResolvedValue({
      parse: async () => ({
        ...structuredClone(PARSED_REPO),
        files: [{ id: 'backend-file', path: 'server/api.cs', target: 'backend' }],
        functions: [{ id: 'backend-caller', fileId: 'backend-file' }],
        calls: kind === 'call' ? [{ id: 'call', callerId: 'backend-caller', calleeId: 'callee' }] : [],
        externalCalls: kind === 'external' ? [{ id: 'external', callerId: 'backend-caller' }] : [],
        stats: {
          analysis: [
            { language: 'csharp', target: 'backend', mode: 'enhanced', fallback: false, compilerReceiverTypes: true },
            { language, target: 'frontend', mode: 'basic', fallback: true, compilerReceiverTypes: false },
          ],
        },
        errors: [{ file: '.', message: 'Repository dependencies unavailable', severity: 'warning' }],
      }),
    });
    stubServer([{ id: 'job_1', status: 'succeeded' }]);
    const result = await run();
    expect(result.status).toBe('error');
    expect(result.error).toContain('refusing to publish');
    expect(result.error).toContain('frontend');
    expect(requested).toEqual([]);
  });

  it.each(['call', 'external', 'component'])('attributes a useful fallback %s edge to its own target', async (kind) => {
    loadParser.mockResolvedValue({
      parse: async () => ({
        ...structuredClone(PARSED_REPO),
        files: [{ id: 'frontend-file', path: 'client/app.ts', target: 'frontend' }],
        functions: kind === 'component' ? [] : [{ id: 'caller', fileId: 'frontend-file' }],
        calls: kind === 'call' ? [{ id: 'call', callerId: 'caller', calleeId: 'callee' }] : [],
        externalCalls:
          kind !== 'call' ? [{ id: 'external', callerId: 'caller', location: { filePath: 'client/app.ts' } }] : [],
        stats: {
          analysis: [
            { language: 'csharp', target: 'backend', mode: 'enhanced', fallback: false },
            { language: 'ts', target: 'frontend', mode: 'basic', fallback: true },
          ],
        },
      }),
    });
    stubServer([{ id: 'job_1', status: 'succeeded' }]);
    expect((await run()).status).toBe('success');
    expect(requested.some((url) => url.includes('/results/upload'))).toBe(true);
  });

  it.each(['basic', 'enhanced'])('allows a %s TS dry run without uploading', async (mode) => {
    loadParser.mockResolvedValue({
      parse: async () => ({
        ...structuredClone(PARSED_REPO),
        stats: { analysis: [{ language: 'ts', mode, fallback: mode === 'basic', compilerReceiverTypes: false }] },
      }),
    });
    const result = await run({ dryRun: true });
    expect(result.status).toBe('success');
    expect(fs.existsSync(path.join(outputDir, 'api.json'))).toBe(true);
    expect(requested).toEqual([]);
  });

  it.each([
    { language: 'ts', mode: 'enhanced', fallback: false, compilerReceiverTypes: false },
    { language: 'csharp', mode: 'basic', fallback: true, compilerReceiverTypes: false },
  ])('retains publication for $language $mode', async (analysis) => {
    loadParser.mockResolvedValue({
      parse: async () => ({ ...structuredClone(PARSED_REPO), stats: { analysis: [analysis] } }),
    });
    stubServer([{ id: 'job_1', status: 'succeeded' }]);
    expect((await run()).status).toBe('success');
    expect(requested.some((url) => url.includes('/results/upload'))).toBe(true);
  });

  it.each(['call', 'external'])('publishes useful TS fallback with a resolved %s edge', async (kind) => {
    loadParser.mockResolvedValue({
      parse: async () => ({
        ...structuredClone(PARSED_REPO),
        calls: kind === 'call' ? [{ id: 'call', callerId: 'caller', calleeId: 'callee' }] : [],
        externalCalls:
          kind === 'external' ? [{ id: 'external', callerId: 'caller', serviceName: 'api', method: 'GET' }] : [],
        stats: { analysis: [{ language: 'ts', mode: 'basic', fallback: true, compilerReceiverTypes: false }] },
      }),
    });
    stubServer([{ id: 'job_1', status: 'succeeded' }]);
    expect((await run()).status).toBe('success');
    expect(requested.some((url) => url.includes('/results/upload'))).toBe(true);
  });

  it('refuses to write or upload a graph with blocking extraction errors', async () => {
    loadParser.mockResolvedValue({
      parse: async () => ({
        ...structuredClone(PARSED_REPO),
        errors: [{ file: '.', message: 'semantic index is incomplete', severity: 'error' }],
      }),
    });

    const result = await run();

    expect(result.status).toBe('error');
    expect(result.error).toContain('refusing to publish a partial graph');
    expect(fs.existsSync(path.join(outputDir, 'api.json'))).toBe(false);
    expect(requested).toEqual([]);
  });

  it('boots from a checked-in profile without fetching a cloud parser', async () => {
    const profile = path.join(outputDir, 'checked-in-profile.ts');
    const source = 'export default { parserId: "api", substrate: { language: "ts", include: ["src/**/*.ts"] } };';
    fs.writeFileSync(profile, source);
    loadParser.mockImplementationOnce(async (storage: string, project: string, repo: string) => {
      expect(fs.readFileSync(path.join(storage, project, repo, 'profile.ts'), 'utf8')).toBe(source);
      return { parse: async () => structuredClone(PARSED_REPO) };
    });
    stubServer([{ id: 'job_1', status: 'succeeded' }]);
    const result = await run({ profile });
    expect(result.status).toBe('success');
    expect(pullParserFromServer).not.toHaveBeenCalled();
    expect(requested.some((url) => url.includes('/push'))).toBe(true);
  });

  it('refuses a missing configured profile before any upload or fallback', async () => {
    process.env.COREDOC_PROFILE_PATH = path.join(outputDir, 'missing-profile.ts');
    const result = await run();
    expect(result.status).toBe('error');
    expect(pullParserFromServer).not.toHaveBeenCalled();
    expect(requested).toEqual([]);
  });

  it('enqueues the push and polls the job to success', async () => {
    // One poll: the multi-poll walk (pending → running → succeeded) is covered
    // in push/remote.test.ts, and repeating it here would only buy a real 5s
    // sleep between polls.
    stubServer([{ id: 'job_1', status: 'succeeded', result: { nodes: 3 } }]);

    const result = await run();

    expect(result.status).toBe('success');
    const pushUrl = requested.find((url) => url.includes('/push'));
    expect(pushUrl).toBeDefined();
    // The whole point: no inline server-side push behind an open connection.
    expect(pushUrl).not.toContain('sync=true');
    expect(requested.filter((url) => url.includes('/jobs/job_1')).length).toBe(1);
  });

  it('fails the run with the job error when the push job fails', async () => {
    stubServer([{ id: 'job_1', status: 'failed', lastError: 'changeset apply rejected' }]);

    const result = await run();

    expect(result.status).toBe('error');
    expect(result.error).toContain('job_1');
    expect(result.error).toContain('changeset apply rejected');
  });

  it('reports the jobId and server-side continuation when watching times out, without claiming the push failed', async () => {
    stubServer([{ id: 'job_1', status: 'running' }]);

    const result = await run({ pushTimeoutMs: 20 });

    // status 'error' is what makes the CLI exit non-zero so an operator looks.
    expect(result.status).toBe('error');
    expect(result.error).toContain('job_1');
    expect(result.error).toMatch(/still running server-side/i);
    expect(result.error).not.toMatch(/push failed/i);
  });
});

/**
 * PR mapping → one sync call after the push, on the commit
 * this run published. A throwaway checkout proves branch/commit provenance;
 * legacy manifest fixtures prove that the retired input no longer affects the run.
 */
