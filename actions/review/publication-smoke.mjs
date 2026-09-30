// Real bundled event adapter; fixture provider/GitHub state. No external network or paid calls.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runner = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), 'review-publication-'));
const base = 'a'.repeat(40), head = 'b'.repeat(40), fixed = 'd'.repeat(40);
const statePath = join(root, 'github.json');
try {
  await writeFile(statePath, JSON.stringify({ head, comments: [], summaries: [], modelCalls: 0, writes: 0 }));
  const preload = join(root, 'fixture.mjs');
  await writeFile(preload, `
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const statePath = ${JSON.stringify(statePath)};
const base = '${base}', fixed = '${fixed}';
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const source = 'export const divide = n => n / ' + (state.head === fixed ? '2' : '0') + ';';
  // The model overstates the end; the host must derive it from the exact quote.
  const evidence = { path: 'a.ts', revision: 'head', startLine: 1, endLine: 200, excerpt: source };
  const finding = { id: 'division', cause: 'zero divisor', severity: 'P1', title: 'Division returns infinity',
    trigger: 'Call divide(2)', impact: 'Returns Infinity', changedCode: 'Divisor changed to zero', existingHandling: 'No guard exists',
    anchor: { path: 'a.ts', revision: 'head', line: 1 }, evidence: [evidence] };
  let response;
  if (url.hostname === 'openrouter.ai') {
    assert.equal(url.pathname, '/api/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'google/gemini-3.8-flash');
    assert.ok(!options.body.includes('fixture-private-key'));
    assert.ok(!options.body.includes('fixture-github-token'));
    // The lens router is tool-less; every investigating call offers the three read tools.
    const router = !body.tools;
    if (!router) assert.deepEqual(body.tools.map(t => t.function.name).sort(), ['list_source', 'read_source', 'search_source']);
    // User message 1 is the shared cached prefix; user message 2 is this call's task.
    const users = body.messages.filter(m => m.role === 'user');
    const prefix = JSON.parse(users[0].content);
    const prompt = JSON.parse(users[1].content);
    assert.ok(Array.isArray(prefix.changedFiles), 'the prefix carries the changed-file manifest');
    // Tool-enabled calls must not be provider-constrained (a strict response_format makes models answer
    // instead of investigating); the phase schema travels in the prompt instead.
    if (!router) assert.equal(body.response_format, undefined, 'no response_format while tools are offered');
    else assert.equal(body.response_format?.type, 'json_schema', 'the tool-less router is provider-constrained');
    assert.equal(prompt.outputSchema?.type, 'object');
    assert.deepEqual(Object.keys(prompt.outputSchema.properties), router ? ['lenses'] : prompt.lens ? ['summary', 'findings'] : ['verdicts']);
    assert.ok(body.tool_choice === undefined || body.tool_choice === 'auto', 'tool choice is never forced');
    const read = body.messages.some(m => m.role === 'tool');
    const reasoning = [{ type: 'reasoning.encrypted', id: 'fixture-reasoning', data: 'opaque-fixture-signature', format: 'google-gemini-v1', index: 0 }];
    if (read) assert.deepEqual(body.messages.find(m => m.role === 'assistant' && m.tool_calls?.length)?.reasoning_details, reasoning, 'Gemini continuation must retain the exact provider signature');
    let value;
    if (router) value = { lenses: [] };
    else if (prompt.lens) value = { summary: 'Fixture analysis', findings: state.head === fixed ? [] : [finding] };
    else value = { verdicts: [{ id: prompt.previousFindings?.[0]?.id ?? prompt.candidates?.[0]?.id ?? 'division', decision: state.head === fixed ? 'reject' : 'confirm', reason: 'Fresh source checked', evidence: prompt.task.startsWith('Recheck') ? [evidence] : [] }] };
    const message = router || read || state.ignoreReadRequirement ? { role: 'assistant', content: JSON.stringify(value) } : { role: 'assistant', content: null, reasoning_details: reasoning,
      tool_calls: [{ id: 'read' + state.modelCalls, type: 'function', function: { name: 'read_source', arguments: JSON.stringify({ revision: 'head', path: 'a.ts', startLine: 1, endLine: 1 }) } }] };
    state.modelCalls++;
    response = { id: 'fixture', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message, finish_reason: router || read || state.ignoreReadRequirement ? 'stop' : 'tool_calls' }],
      usage: { cost: 0.001, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
  } else {
    assert.equal(url.hostname, 'api.github.com');
    const path = url.pathname.replace('/repos/owner/repo', '');
    if (options.method === 'POST' || options.method === 'PATCH') {
      const body = JSON.parse(options.body); state.writes++;
      const comment = text => ({ id: state.comments.length + state.summaries.length + 1, body: text, user: { login: 'github-actions[bot]', type: 'Bot' } });
      if (path === '/pulls/1/reviews') { assert.equal(body.commit_id, state.head); assert.equal(body.event, 'COMMENT'); state.comments.push(...body.comments.map(c => comment(c.body))); }
      else if (path === '/issues/1/comments') state.summaries.push(comment(body.body));
      else { assert.equal(options.method, 'PATCH'); const id = Number(path.split('/').at(-1)); [...state.comments, ...state.summaries].find(c => c.id === id).body = body.body; }
      response = {};
    } else if (path === '') response = { default_branch: 'main', full_name: 'owner/repo' };
    else if (path === '/pulls/1') response = { number: 1, state: 'open', draft: false, user: { login: 'owner' }, head: { sha: state.head, repo: { id: 1, full_name: 'owner/repo' } }, base: { sha: base, ref: 'main', repo: { id: 1, full_name: 'owner/repo' } } };
    else if (path.startsWith('/compare/')) response = { merge_base_commit: { sha: base }, files: [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\\n-export const divide = n => n / 2;\\n+' + source }] };
    else if (path.startsWith('/git/trees/')) response = { truncated: false, tree: [{ path: 'a.ts', type: 'blob', mode: '100644', sha: 'c'.repeat(40), size: source.length }] };
    else if (path.startsWith('/git/blobs/')) response = { encoding: 'base64', size: source.length, content: Buffer.from(source).toString('base64') };
    else if (path === '/pulls/1/comments') response = state.comments;
    else if (path === '/issues/1/comments') response = state.summaries;
    else if (path === '/actions/workflows/pr-review.yml') response = { state: 'active' };
    else throw new Error('Unexpected fixture GitHub path');
  }
  writeFileSync(statePath, JSON.stringify(state));
  return Response.json(response);
};
`);
  const settings = join(root, 'settings.json'), event = join(root, 'event.json');
  await writeFile(settings, JSON.stringify({ arm: 'A', policy: { version: 'fixture', text: '' }, model: {
    provider: 'openrouter', id: 'google/gemini-3.8-flash', inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75, maxUsd: 0.24,
  } }));
  await writeFile(event, JSON.stringify({ number: 1 }));
  // An incomplete review that published its summary is a green job: exit 1 is reserved for a failed
  // or partial publication and for a cancelled run, so every run here must exit 0.
  const run = async (expectIncomplete = false) => {
    const output = join(root, 'result.json');
    await promisify(execFile)(process.execPath, ['--import', preload, runner, 'review', 'event', '--settings', settings, '--output', output], {
      env: { PATH: process.env.PATH, HOME: root, GITHUB_TOKEN: 'fixture-github-token', COREDOC_REVIEW_LLM_API_KEY: 'fixture-private-key',
        GITHUB_REPOSITORY: 'owner/repo', GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'pull_request' }, timeout: 20000,
    });
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.status, expectIncomplete ? 'incomplete' : 'completed'); assert.equal(result.publication.status, 'published');
    assert.equal(result.billing.uncertain, false);
    return result;
  };
  const first = await run();
  assert.equal(first.findings[0].evidence[0].endLine, 1);
  assert.deepEqual(first.candidates.map(c => [c.lens, c.verdict, c.outcome]), [['logic', 'confirm', 'published']]);
  let state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.comments.length, 1); assert.equal(state.summaries.length, 1);
  // The public summary carries counts only; the candidate table lives in the step summary.
  assert.match(state.summaries[0].body, /1 candidate\(s\): 1 published, 0 rejected, 0 unresolved, 0 dropped\./);
  await run();
  state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.comments.length, 1, 'same-head rerun must retain one root-cause thread');
  assert.equal(state.summaries.length, 1, 'same-head rerun must retain one summary');
  assert.equal(state.writes, 2, 'same-head rerun must not write unchanged output');
  state.head = fixed; await writeFile(statePath, JSON.stringify(state));
  const final = await run();
  assert.equal(final.rechecks[0].decision, 'reject');
  assert.equal(final.rechecks[0].evidence[0].endLine, 1);
  state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.comments.length, 1); assert.equal(state.summaries.length, 1);
  assert.match(state.comments[0].body, /No longer applies after re-review/);
  assert.ok(state.summaries[0].body.includes(fixed));
  state.ignoreReadRequirement = true; await writeFile(statePath, JSON.stringify(state));
  const incomplete = await run(true);
  // Discovery answered without a read; the retained prior finding is still rechecked (third call).
  assert.equal(incomplete.modelCalls.length, 3);
  assert.equal(incomplete.modelCalls[0].phase, 'router');
  assert.equal(incomplete.modelCalls[1].toolCalls, 0);
  assert.equal(incomplete.modelCalls[1].lens, 'logic');
  assert.equal(incomplete.modelCalls[2].phase, 'recheck');
  assert.deepEqual(incomplete.coverage.read, []);
  assert.ok(incomplete.coverage.gaps.includes('SOURCE_NOT_INSPECTED'));
  state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.comments.length, 1); assert.equal(state.summaries.length, 1);
  // The summary lists limitation codes; the human-readable explanation lives in the Markdown report.
  assert.match(state.summaries[0].body, /SOURCE\\_NOT\\_INSPECTED/); // safeText escapes underscores
  console.log(JSON.stringify({ smoke: 'publication passed', platform: process.platform, node: process.versions.node,
    runs: 4, inlineThreads: state.comments.length, summaries: state.summaries.length, modelCalls: state.modelCalls, paidCalls: 0, githubWrites: 0 }));
} finally { await rm(root, { recursive: true, force: true }); }
