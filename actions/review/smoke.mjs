// Zero-cost integration smoke: real bundled CLI/HTTP provider, fixture-only GitHub reads.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runner = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), 'review-smoke-'));
const base = 'a'.repeat(40), head = 'b'.repeat(40), oid = 'c'.repeat(40);
const source = 'export const answer = 2;\n';
let calls = 0;
let providerFailure;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.url, '/v1/chat/completions');
    assert.ok(!JSON.stringify(body).includes('fixture-private-key'));
    // The first call is the tool-less lens router; every investigating call offers the three read tools.
    const call = calls++;
    if (call === 0) assert.equal(body.tools, undefined, 'the router is sent without tools');
    else assert.deepEqual(body.tools.map(t => t.function.name).sort(), ['list_source', 'read_source', 'search_source']);
    const message = call === 0
      ? { role: 'assistant', content: JSON.stringify({ lenses: [] }) }
      : call === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'read1', type: 'function', function: { name: 'read_source', arguments: JSON.stringify({ revision: 'head', path: 'a.ts', startLine: 1, endLine: 1 }) } }] }
      : { role: 'assistant', content: JSON.stringify({ summary: 'No candidate defect.', findings: [] }) };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  } catch (error) { providerFailure = error; res.writeHead(500); res.end(); }
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const preload = join(root, 'fixture-github.mjs');
  await writeFile(preload, `
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname !== 'api.github.com') throw new Error('Unexpected network target');
  let body;
  if (url.pathname.includes('/compare/')) body = { files: [{ filename: 'a.ts', status: 'added', patch: '@@ -0,0 +1 @@' + String.fromCharCode(10) + '+export const answer = 2;' }] };
  else if (url.pathname.includes('/git/trees/')) body = { truncated: false, tree: [{ path: 'a.ts', type: 'blob', mode: '100644', sha: '${oid}', size: ${Buffer.byteLength(source)} }] };
  else if (url.pathname.includes('/git/blobs/')) body = { encoding: 'base64', size: ${Buffer.byteLength(source)}, content: '${Buffer.from(source).toString('base64')}' };
  else throw new Error('Unexpected GitHub read');
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
};
`);
  const request = join(root, 'request.json'), output = join(root, 'result.json'), markdown = join(root, 'result.md');
  await writeFile(request, JSON.stringify({ schemaVersion: 1, repository: 'owner/repo', pullNumber: 1, baseSha: base, mergeBaseSha: base, headSha: head, mode: 'historical', arm: 'A', policy: { version: 'fixture-v1', text: '' }, model: { provider: `http://127.0.0.1:${port}/v1`, id: 'fixture-model' } }));
  await promisify(execFile)(process.execPath, ['--import', preload, runner, 'review', 'run', '--request', request, '--output', output, '--markdown', markdown], {
    env: { PATH: process.env.PATH, HOME: root, GITHUB_TOKEN: '', COREDOC_REVIEW_LLM_API_KEY: 'fixture-private-key' }, timeout: 20000,
  });
  if (providerFailure) throw providerFailure;
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.status, 'completed');
  assert.equal(result.revision.headSha, head);
  assert.deepEqual(result.coverage.read, ['head:a.ts']);
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.usage.inputTokens, 300);
  assert.equal(calls, 3);
  assert.match(await readFile(markdown, 'utf8'), /fixture-model/);

  // Subscription path, case (a): `review event` on provider `claude-code` with neither credential
  // exported must fail the job before any GitHub read and leave a report naming the code.
  const claudeSettings = join(root, 'settings.claude.json');
  await writeFile(claudeSettings, JSON.stringify({ arm: 'A', policy: { version: 'fixture-v1', text: '' }, model: { provider: 'claude-code', id: 'sonnet' } }));
  const eventFile = join(root, 'event.json');
  await writeFile(eventFile, JSON.stringify({ number: 1 }));
  const credentialOutput = join(root, 'credential.json'), credentialMarkdown = join(root, 'credential.md');
  const credentialRun = await promisify(execFile)(process.execPath, [runner, 'review', 'event', '--settings', claudeSettings, '--output', credentialOutput, '--markdown', credentialMarkdown], {
    // Every credential is exported empty, exactly as the action exports an unset input.
    env: { PATH: process.env.PATH, HOME: root, GITHUB_REPOSITORY: 'owner/repo', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventFile, GITHUB_TOKEN: '', COREDOC_REVIEW_LLM_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' }, timeout: 20000,
  }).catch(error => error);
  assert.equal(credentialRun.code, 1, 'a misconfigured credential pair must fail the job');
  // safeText escapes the underscores so the code cannot render as Markdown emphasis.
  assert.match(await readFile(credentialMarkdown, 'utf8'), /MODEL\\?_CREDENTIAL\\?_MISCONFIGURED/);

  // Case (b): the same settings with a token, run from a directory where the external
  // @anthropic-ai/claude-agent-sdk cannot resolve. The run must report the runtime as unavailable
  // instead of crashing. `review run` is used because it needs no GitHub event or publication
  // fixtures; the dispatch and the import it exercises are the same ones `review event` reaches.
  const isolated = await mkdtemp(join(tmpdir(), 'review-smoke-unresolvable-'));
  try {
    const isolatedRunner = join(isolated, 'runner.mjs');
    await copyFile(runner, isolatedRunner);
    const claudeRequest = join(root, 'claude-request.json'), claudeOutput = join(root, 'claude-result.json'), claudeMarkdown = join(root, 'claude-result.md');
    await writeFile(claudeRequest, JSON.stringify({ schemaVersion: 1, repository: 'owner/repo', pullNumber: 1, baseSha: base, mergeBaseSha: base, headSha: head, mode: 'historical', arm: 'A', policy: { version: 'fixture-v1', text: '' }, model: { provider: 'claude-code', id: 'sonnet' } }));
    await promisify(execFile)(process.execPath, ['--import', preload, isolatedRunner, 'review', 'run', '--request', claudeRequest, '--output', claudeOutput, '--markdown', claudeMarkdown], {
      env: { PATH: process.env.PATH, HOME: isolated, GITHUB_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: 'smoke-token' }, timeout: 20000,
    });
    const unavailable = JSON.parse(await readFile(claudeOutput, 'utf8'));
    assert.equal(unavailable.status, 'incomplete');
    assert.ok(unavailable.coverage.gaps.includes('CLAUDE_RUNTIME_UNAVAILABLE'), 'the missing SDK is reported, not thrown');
    assert.equal(unavailable.configuration.auth, 'subscription');
    assert.match(await readFile(claudeMarkdown, 'utf8'), /CLAUDE\\?_RUNTIME\\?_UNAVAILABLE/);
    assert.ok(!JSON.stringify(unavailable).includes('smoke-token'));
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ smoke: 'passed', platform: process.platform, node: process.versions.node, modelCalls: calls, toolCalls: result.usage.toolCalls, paidCalls: 0 }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
