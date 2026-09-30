import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { requestSchema, type ReviewResult } from './contracts.js';

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('real headless review command', () => {
  it('runs the bundled CLI against Git and an HTTP provider without leaking credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-cli-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Review test');
    git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(root, 'a.ts'), 'export const answer = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(root, 'a.ts'), 'export const answer = 2;\n');
    git('add', '.');
    git('commit', '-qm', 'head');
    const head = git('rev-parse', 'HEAD');
    let calls = 0;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls++;
      expect(req.url).toBe('/v1/chat/completions');
      expect(JSON.stringify(body)).not.toContain('private-test-key');
      // The first call is the tool-less lens router; every investigating call offers the three read tools.
      if (calls > 1)
        expect(body.tools.map((t: { function: { name: string } }) => t.function.name).sort()).toEqual([
          'list_source',
          'read_source',
          'search_source',
        ]);
      const message =
        calls === 1
          ? { role: 'assistant', content: JSON.stringify({ lenses: [] }) }
          : calls === 2
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
            : {
                role: 'assistant',
                content: JSON.stringify({ summary: 'Constant changed; no verified defect.', findings: [] }),
              };
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'local-fixture',
          object: 'chat.completion',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
    });
    await new Promise<void>((r, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', r);
    });
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
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
      model: { provider: `http://127.0.0.1:${address.port}/v1`, id: 'fixture-model' },
    });
    const manifest = join(root, 'request.json');
    const output = join(root, 'result.json');
    const markdown = join(root, 'result.md');
    await writeFile(manifest, JSON.stringify(request));
    const bundle = join(root, 'runner.mjs');
    await build({
      entryPoints: [resolve('src/review/entry.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
      logLevel: 'silent',
    });
    const { stdout } = await exec(
      process.execPath,
      [bundle, 'review', 'run', '--request', manifest, '--repo-dir', root, '--output', output, '--markdown', markdown],
      { env: { ...process.env, GITHUB_TOKEN: '', COREDOC_REVIEW_LLM_API_KEY: 'private-test-key' }, timeout: 15_000 },
    );
    expect(stdout).toContain('Review completed');
    expect(calls).toBe(3);
    const report = JSON.parse(await readFile(output, 'utf8')) as ReviewResult;
    expect(report.revision.headSha).toBe(head);
    expect(report.status).toBe('completed');
    expect(report.coverage.read).toContain('head:a.ts');
    expect(report.usage.inputTokens).toBe(300);
    expect(report.usage.outputTokens).toBe(60);
    expect(await readFile(markdown, 'utf8')).toContain(head);
  });
});
