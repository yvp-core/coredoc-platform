import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { derivePatch, runReview } from './engine.js';
import type { ClaudeQuery } from './claude-code-runtime.js';
import { renderReview } from './report.js';
import { ReviewAccess, ReviewBudget, changedLines } from './access.js';
import {
  requestSchema,
  ReviewError,
  type ChangedFile,
  type Finding,
  type ModelCallDiagnostic,
  type SourceReader,
  type ReviewRequest,
} from './contracts.js';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const bad = 'export const divide = (n: number) => n / 0;';
const good = 'export const divide = (n: number) => n / 2;';
function request(overrides: Partial<ReviewRequest> = {}) {
  return requestSchema.parse({
    schemaVersion: 1,
    repository: 'owner/repo',
    pullNumber: 1,
    baseSha: base,
    mergeBaseSha: base,
    headSha: head,
    mode: 'historical',
    arm: 'A',
    policy: { version: 'test', text: '' },
    model: { provider: 'openai', id: 'test-model' },
    ...overrides,
  });
}
function source(existingHandling = false): SourceReader {
  return {
    list: async () => ({ items: [{ path: 'src/a.ts', oid: base, mode: '100644' }], gaps: [] }),
    read: async (revision) => (revision === 'base' || existingHandling ? good : bad),
    changes: async () => ({
      items: [
        { path: 'src/a.ts', status: 'modified', patch: `@@ -1 +1 @@\n-${good}\n+${existingHandling ? good : bad}` },
      ],
      gaps: [],
    }),
  };
}
/** Two changed files with patches, so discovery can answer with one of them unread. */
function twoFiles(unreadable?: string): SourceReader {
  const patch = `@@ -1 +1 @@\n-${good}\n+${bad}`;
  return {
    list: async () => ({
      items: ['src/a.ts', 'src/b.ts'].map((path) => ({ path, oid: base, mode: '100644' })),
      gaps: [],
    }),
    read: async (revision, path) => {
      if (path === unreadable) throw new ReviewError('SOURCE_NOT_FOUND');
      return revision === 'base' ? good : bad;
    },
    changes: async () => ({
      items: [
        { path: 'src/a.ts', status: 'modified', patch },
        { path: 'src/b.ts', status: 'modified', patch },
      ],
      gaps: [],
    }),
  };
}
const finding: Finding = {
  id: 'division',
  cause: 'division by zero in divide',
  severity: 'P1',
  title: 'Division returns infinity',
  trigger: 'Call divide(2)',
  impact: 'Returns Infinity instead of a finite value',
  changedCode: 'Divisor changed from 2 to 0',
  existingHandling: 'No branch handles a zero divisor',
  anchor: { path: 'src/a.ts', revision: 'head', line: 1 },
  evidence: [{ path: 'src/a.ts', revision: 'head', startLine: 1, endLine: 1, excerpt: bad }],
};
function patchAccess(files: Record<string, string>, overrides: Partial<ReviewRequest> = {}) {
  const req = request(overrides);
  const source: SourceReader = {
    list: async () => ({ items: [], gaps: [] }),
    read: async (revision, path) => {
      const content = files[`${revision}:${path}`];
      if (content === undefined) throw new ReviewError('SOURCE_NOT_FOUND');
      return content;
    },
    changes: async () => ({ items: [], gaps: [] }),
  };
  return new ReviewAccess(req, source, new ReviewBudget(req, new AbortController().signal), [], []);
}
const numbered = (count: number, from = 0) => Array.from({ length: count }, (_, i) => `line ${from + i + 1}`);
// Verdict fixtures written before `evidence` became a required (possibly empty) array.
const withEvidence = (value: unknown) =>
  value && typeof value === 'object' && Array.isArray((value as { verdicts?: unknown[] }).verdicts)
    ? {
        ...value,
        verdicts: (value as { verdicts: Array<Record<string, unknown>> }).verdicts.map((v) => ({ evidence: [], ...v })),
      }
    : value;
const text = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(withEvidence(value)) });
const read = (id: string) => ({
  type: 'tool-call' as const,
  toolCallId: id,
  toolName: 'read_source',
  input: JSON.stringify({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 1 }),
});
const readFile = (id: string, path: string) => ({
  ...read(id),
  input: JSON.stringify({ revision: 'head', path, startLine: 1, endLine: 1 }),
});
type Content = Array<ReturnType<typeof text> | ReturnType<typeof read>>;
const userMessages = (options: unknown) =>
  (options as { prompt: Array<{ role: string; content: string | Array<{ text?: string }> }> }).prompt
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('')));
/** User message 1: the shared prefix, which must be byte-identical on every call of a run. */
const firstUser = (options: unknown) => userMessages(options)[0]!;
/**
 * A model that answers by what the call asks for, so parallel lenses can be served in any order.
 * The task message (user message 2) identifies the router, the lens, verification and the recheck.
 */
function dispatch(handlers: {
  route: unknown;
  lens: (id: string, call: number) => Content;
  verify?: (call: number) => Content;
  recheck?: (call: number) => Content;
  before?: (options: unknown, kind: 'router' | 'lens' | 'verify' | 'recheck') => void | Promise<void>;
}) {
  const counts = new Map<string, number>();
  const nth = (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const task = JSON.parse(userMessages(options)[1]!) as {
        lenses?: unknown;
        lens?: { id: string };
        candidates?: unknown;
      };
      const kind = task.lenses ? 'router' : task.lens ? 'lens' : task.candidates ? 'verify' : 'recheck';
      await handlers.before?.(options, kind);
      const content: Content =
        kind === 'router'
          ? [text(handlers.route)]
          : kind === 'lens'
            ? handlers.lens(task.lens!.id, nth(task.lens!.id))
            : kind === 'verify'
              ? (handlers.verify ?? (() => [text({ verdicts: [] })]))(nth('verify'))
              : (handlers.recheck ?? (() => [text({ verdicts: [] })]))(nth('recheck'));
      return {
        content,
        finishReason: { unified: content.some((c) => c.type === 'tool-call') ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 50, noCache: 10, cacheRead: 40, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}
/** A router answer: every review with eligible changes spends its first call choosing lenses. */
const route = (lenses: Array<{ id: string; reason?: string; focusFiles?: string[] }> = []) =>
  text({ lenses: lenses.map((lens) => ({ reason: 'fixture', focusFiles: [], ...lens })) });
function model(
  responses: Array<Array<ReturnType<typeof text> | ReturnType<typeof read>>>,
  observe?: (options: unknown) => void,
  /** The first reply, answering the router. `null` sends the responses from the first call instead. */
  router: ReturnType<typeof text> | null = route(),
) {
  const queue = router ? [[router], ...responses] : responses;
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      observe?.(options);
      const content = queue[call++];
      if (!content) throw new Error('unexpected model call');
      return {
        content,
        finishReason: { unified: content.some((c) => c.type === 'tool-call') ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

describe('derived patches', () => {
  const file: ChangedFile = { path: 'src/a.ts', status: 'modified' };
  it('marks only the edited lines when two changes are far apart', async () => {
    const lines = numbered(600);
    const edited = [...lines];
    edited[4] = 'line 5 edited';
    edited[499] = 'line 500 edited';
    const { patch, anchorable } = await derivePatch(
      file,
      patchAccess({ 'base:src/a.ts': lines.join('\n'), 'head:src/a.ts': edited.join('\n') }),
    );
    expect(anchorable).toBeUndefined();
    expect(changedLines(patch, 'head')).toEqual(new Set([5, 500]));
    expect(changedLines(patch, 'base')).toEqual(new Set([5, 500]));
  });
  it('anchors a mid-file insertion on the inserted line only', async () => {
    const { patch } = await derivePatch(
      file,
      patchAccess({ 'base:src/a.ts': 'a\nb\nc', 'head:src/a.ts': 'a\nb\ninserted\nc' }),
    );
    expect(changedLines(patch, 'head')).toEqual(new Set([3]));
    expect(changedLines(patch, 'base')).toEqual(new Set());
  });
  it('covers every line of a pure addition and a pure deletion', async () => {
    const body = numbered(3).join('\n');
    const added = await derivePatch({ path: 'src/a.ts', status: 'added' }, patchAccess({ 'head:src/a.ts': body }));
    expect(changedLines(added.patch, 'head')).toEqual(new Set([1, 2, 3]));
    const removed = await derivePatch({ path: 'src/a.ts', status: 'removed' }, patchAccess({ 'base:src/a.ts': body }));
    expect(changedLines(removed.patch, 'base')).toEqual(new Set([1, 2, 3]));
    expect(changedLines(removed.patch, 'head')).toEqual(new Set());
  });
  it('treats a terminal newline as a line ending, not an extra line', async () => {
    const { patch } = await derivePatch(file, patchAccess({ 'base:src/a.ts': 'b', 'head:src/a.ts': 'x\nz\n' }));
    expect(changedLines(patch, 'head')).toEqual(new Set([1, 2]));
    expect(changedLines(patch, 'base')).toEqual(new Set([1]));
    const added = await derivePatch({ path: 'src/a.ts', status: 'added' }, patchAccess({ 'head:src/a.ts': 'x\n' }));
    expect(changedLines(added.patch, 'head')).toEqual(new Set([1]));
  });
  it('emits no patch for identical content', async () => {
    const body = numbered(4).join('\n');
    expect(await derivePatch(file, patchAccess({ 'base:src/a.ts': body, 'head:src/a.ts': body }))).toEqual({
      patch: '',
    });
  });
  it('reads the base side of a rename at its previous path', async () => {
    const renamed: ChangedFile = { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed' };
    const { patch } = await derivePatch(
      renamed,
      patchAccess({ 'base:src/old.ts': 'a\nb\nc', 'head:src/new.ts': 'a\nchanged\nc' }),
    );
    expect(changedLines(patch, 'head')).toEqual(new Set([2]));
    expect(changedLines(patch, 'base')).toEqual(new Set([2]));
  });
  it('refuses to guess on a change too large to diff exactly', async () => {
    const before = Array.from({ length: 2100 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 2100 }, (_, i) => `new ${i}`).join('\n');
    expect(await derivePatch(file, patchAccess({ 'base:src/a.ts': before, 'head:src/a.ts': after }))).toEqual({
      patch: '',
      anchorable: false,
    });
  });
});

describe('review engine', () => {
  it('never forces a tool choice; the host check requires a source read before the first discovery answer', async () => {
    const choices: unknown[] = [];
    const result = await runReview(request(), {
      source: source(true),
      model: model([[read('inspect')], [text({ summary: 'Guard handles this', findings: [] })]], (options) => {
        choices.push((options as { toolChoice?: unknown }).toolChoice);
      }),
    });
    // AI SDK 7 enforces a forced tool choice by throwing, which would discard a non-compliant reply.
    expect(choices).toEqual([{ type: 'auto' }, { type: 'auto' }, { type: 'auto' }]);
    expect(result.status).toBe('completed');
    expect(result.coverage.read).toEqual(['head:src/a.ts']);
  });
  it.each([
    'none',
    'listing',
    'eof',
  ] as const)('rejects an empty answer without inspected source (%s)', async (kind) => {
    const calls: Parameters<typeof model>[0] = [];
    if (kind === 'listing')
      calls.push([
        { ...read('list'), toolName: 'list_source', input: JSON.stringify({ revision: 'head', prefix: 'src/' }) },
      ]);
    if (kind === 'eof')
      calls.push([
        { ...read('eof'), input: JSON.stringify({ revision: 'head', path: 'src/a.ts', startLine: 20, endLine: 30 }) },
      ]);
    calls.push([text({ summary: '', findings: [] })]);
    const result = await runReview(request(), { source: source(), model: model(calls) });
    expect(result.status).toBe('incomplete');
    expect(result.findings).toEqual([]);
    expect(result.coverage.read).toEqual([]);
    expect(result.coverage.gaps).toContain('SOURCE_NOT_INSPECTED');
    expect(renderReview(result)).toContain('The model did not inspect any source through the read tool.');
  });
  it('still nudges after a schema repair and carries the earlier reads into the nudge history', async () => {
    const roles: string[][] = [];
    const result = await runReview(request(), {
      source: twoFiles(),
      model: model(
        [
          [readFile('a', 'src/a.ts')],
          [{ type: 'text', text: JSON.stringify({ findings: [] }) }],
          [text({ summary: 'Repaired', findings: [] })],
          [readFile('b', 'src/b.ts')],
          [text({ summary: 'No defects', findings: [] })],
        ],
        (options) => roles.push((options as { prompt: Array<{ role: string }> }).prompt.map((m) => m.role)),
      ),
    });
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).toEqual([]);
    expect(result.coverage.read).toEqual(['head:src/a.ts', 'head:src/b.ts']);
    expect(result.usage.steps).toBe(6);
    // Call 5 is the nudge: the cached prefix and task, the first read (assistant + tool), the
    // repaired answer, the nudge, the step reminder.
    expect(roles[4]).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'assistant', 'user', 'user']);
  });
  it('sends discovery back to read a changed file it answered without reading', async () => {
    const userMessages: string[][] = [];
    const tools: number[] = [];
    const answer = [text({ summary: 'No defects', findings: [] })];
    const result = await runReview(request(), {
      source: twoFiles(),
      model: model([[readFile('a', 'src/a.ts')], answer, [readFile('b', 'src/b.ts')], answer], (options) => {
        const o = options as {
          tools?: unknown[];
          prompt: Array<{ role: string; content: string | Array<{ text?: string }> }>;
        };
        tools.push(o.tools?.length ?? 0);
        userMessages.push(
          o.prompt
            .filter((m) => m.role === 'user')
            .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''))),
        );
      }),
    });
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).toEqual([]);
    expect(result.coverage.read).toEqual(['head:src/a.ts', 'head:src/b.ts']);
    expect(result.usage.steps).toBe(5);
    // The nudge is the last instruction of the third discovery call, which still offers the read tools.
    expect(tools[3]).toBe(3);
    expect(userMessages[3]!.at(-2)).toBe(
      'Before answering, read these changed files at head with read_source (a listing or an EOF response does not count): src/b.ts. Then return the final JSON.',
    );
  });
  it('accepts an answer that stays partial after three nudges and reports the coverage gap', async () => {
    const answer = [text({ summary: 'No defects', findings: [] })];
    const result = await runReview(request(), {
      source: twoFiles(),
      model: model([[readFile('a', 'src/a.ts')], answer, answer, answer, answer]),
    });
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toEqual(['SOURCE_COVERAGE_PARTIAL']);
    expect(result.coverage.read).toEqual(['head:src/a.ts']);
    expect(result.usage.steps).toBe(6);
    expect(result.modelCalls?.map((c) => c.phase)).toEqual(['router', ...Array(5).fill('discovery')]);
  });
  it('treats a file the host refused to read as attempted instead of nudging for it again', async () => {
    const result = await runReview(request(), {
      source: twoFiles('src/b.ts'),
      model: model([
        [readFile('a', 'src/a.ts')],
        [readFile('b', 'src/b.ts')],
        [text({ summary: 'No defects', findings: [] })],
      ]),
    });
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).toEqual(['SOURCE_NOT_FOUND']);
    expect(result.usage.steps).toBe(4);
  });
  it('does not require a model read when there are no eligible changes', async () => {
    const result = await runReview(request({ exclude: ['src/'] }), { source: source(), model: model([]) });
    expect(result.status).toBe('completed');
    expect(result.usage.steps).toBe(0);
    expect(result.coverage.gaps).toEqual([]);
  });

  it.each([
    { files: 150, extraLines: 0, gap: undefined, sent: 150 },
    { files: 151, extraLines: 0, gap: 'CHANGED_FILE_LIMIT', sent: 150 },
    { files: 150, extraLines: 1, gap: 'DIFF_LINE_LIMIT', sent: 149 },
  ])('reviews up to 150 files and 15000 added/deleted lines ($files files, $extraLines extra)', async ({
    files,
    extraLines,
    gap,
    sent,
  }) => {
    const items = Array.from({ length: files }, (_, i) => {
      const count = 100 + (i === files - 1 ? extraLines : 0);
      return {
        path: `src/file${i}.ts`,
        status: 'added',
        patch: `@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, () => '+' + 'x'.repeat(60)).join('\n')}`,
      };
    });
    let sentFiles = 0;
    const result = await runReview(request(), {
      source: { ...source(), changes: async () => ({ items, gaps: [] }) },
      model: model(
        [
          [
            {
              ...read('inspect'),
              input: JSON.stringify({ revision: 'head', path: 'src/file0.ts', startLine: 1, endLine: 1 }),
            },
          ],
          // One read of one file out of 150: the coverage floor nudges three times, then reports it.
          ...Array.from({ length: 4 }, () => [text({ summary: 'No defects', findings: [] })]),
        ],
        (options) => {
          const prompt = (options as { prompt: Array<{ role: string; content: Array<{ text: string }> }> }).prompt;
          sentFiles = JSON.parse(prompt.find((m) => m.role === 'user')!.content[0]!.text).diff.length;
        },
      ),
    });
    expect(sentFiles).toBe(sent);
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toEqual(gap ? [gap, 'SOURCE_COVERAGE_PARTIAL'] : ['SOURCE_COVERAGE_PARTIAL']);
  });
  it('counts removed lines as well as added lines without counting diff headers or context', async () => {
    const patch = `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,7502 +1,7501 @@\n context\n${Array.from({ length: 7501 }, () => '-old').join('\n')}\n${Array.from({ length: 7500 }, () => '+new').join('\n')}`;
    const result = await runReview(request(), {
      source: {
        ...source(),
        changes: async () => ({ items: [{ path: 'src/a.ts', status: 'modified', patch }], gaps: [] }),
      },
      model: model([]),
    });
    expect(result.coverage.gaps).toEqual(['DIFF_LINE_LIMIT']);
    expect(result.usage.steps).toBe(0);
  });
  it('constrains only the tool-less call and carries the phase schema in the prompt on tool calls', async () => {
    const calls: Array<{ tools: number; responseFormat?: unknown; outputSchema: { properties?: object } }> = [];
    const result = await runReview(request(), {
      source: source(),
      previousFindings: [{ ...finding, id: 'prior', cause: 'previous claim', title: 'Previous claim' }],
      model: model(
        [
          [read('discovery')],
          [text({ summary: 'Candidate', findings: [finding] })],
          [read('verification')],
          [text({ verdicts: [{ id: finding.id, decision: 'confirm', reason: 'Verified' }] })],
          [read('recheck')],
          [text({ verdicts: [{ id: 'prior', decision: 'reject', reason: 'Checked', evidence: finding.evidence }] })],
        ],
        (options) => {
          const o = options as {
            tools?: unknown[];
            responseFormat?: unknown;
            prompt: Array<{ role: string; content: Array<{ text: string }> }>;
          };
          calls.push({
            tools: o.tools?.length ?? 0,
            responseFormat: o.responseFormat,
            // The task message is the second one: the first is the shared, cached prefix.
            outputSchema: JSON.parse(o.prompt.filter((m) => m.role === 'user')[1]!.content[0]!.text).outputSchema,
          });
        },
      ),
    });
    expect(result.status).toBe('completed');
    expect(calls).toHaveLength(7);
    // The router is tool-less and provider-constrained; it carries its own schema.
    expect(calls[0]).toMatchObject({ tools: 0 });
    expect(Object.keys(calls[0]!.outputSchema.properties ?? {})).toEqual(['lenses']);
    for (const [i, call] of calls.slice(1).entries()) {
      // A provider-enforced schema on a tool step makes some models answer {} instead of reading source.
      expect(call.tools).toBe(3);
      expect(call.responseFormat).toBeUndefined();
      // The required shape still reaches the model, as data in the phase request.
      expect(Object.keys(call.outputSchema.properties ?? {})).toEqual(i < 2 ? ['summary', 'findings'] : ['verdicts']);
    }
  });
  it('constrains the tool-less final call with the phase response format', async () => {
    const calls: Array<{ tools: number; responseFormat?: unknown }> = [];
    // Three steps: the router, discovery and verification each get their one tool-less call.
    const result = await runReview(request({ limits: { ...request().limits, maxSteps: 3 } }), {
      source: source(),
      model: model(
        [
          [text({ summary: 'Candidate', findings: [finding] })],
          [text({ verdicts: [{ id: finding.id, decision: 'reject', reason: 'Guarded' }] })],
        ],
        (options) => {
          const o = options as { tools?: unknown[]; responseFormat?: unknown };
          calls.push({ tools: o.tools?.length ?? 0, responseFormat: o.responseFormat });
        },
      ),
    });
    expect(result.findings).toEqual([]);
    expect(calls.map((c) => c.tools)).toEqual([0, 0, 0]);
    for (const [i, call] of calls.entries()) {
      expect(call.responseFormat).toMatchObject({
        type: 'json',
        schema: { type: 'object', additionalProperties: false },
      });
      const schema = (call.responseFormat as { schema: { properties: Record<string, unknown> } }).schema;
      expect(Object.keys(schema.properties)).toEqual([['lenses'], ['summary', 'findings'], ['verdicts']][i]);
    }
  });
  it('withdraws tools on the final affordable call so the model must finish instead of investigating again', async () => {
    let calls = 0;
    // One step for the router, then two affordable discovery steps.
    const result = await runReview(request({ limits: { ...request().limits, maxSteps: 6 } }), {
      source: source(),
      model: model([[read('investigate')], [text({ summary: 'No defects', findings: [] })]], (options) => {
        if (++calls === 3) {
          expect(options).toMatchObject({
            tools: undefined,
            responseFormat: { type: 'json', schema: { type: 'object', properties: { findings: { type: 'array' } } } },
          });
          const prompt = (options as { prompt: Array<{ role: string; content: Array<{ text: string }> }> }).prompt;
          expect(prompt.some((m) => m.role === 'assistant' || m.role === 'tool')).toBe(false);
          expect(prompt.find((m) => m.role === 'user')!.content[0]!.text).toContain(bad);
        }
      }),
    });
    expect(calls).toBe(3);
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).toEqual([]);
  });
  it('accepts a fenced JSON answer from an unconstrained tool step', async () => {
    const fenced = `Here is the result:\n\`\`\`json\n${JSON.stringify({ summary: 'Guard handles ```this```', findings: [] })}\n\`\`\`\nDone.`;
    const result = await runReview(request(), {
      source: source(true),
      model: model([[read('inspect')], [{ type: 'text', text: fenced }]]),
    });
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).toEqual([]);
    expect(result.usage.steps).toBe(3);
  });
  it('repairs a schema-invalid answer from a tool step with one tool-less call under the enforced schema', async () => {
    const { cause: _omitted, ...missingCause } = finding;
    const options: unknown[] = [];
    const result = await runReview(request(), {
      source: source(),
      model: model(
        [
          [read('inspect')],
          [text({ summary: 'Missing a required field', findings: [missingCause] })],
          [text({ summary: 'Repaired', findings: [finding] })],
          [read('verify')],
          [text({ verdicts: [{ id: finding.id, decision: 'reject', reason: 'Guarded' }] })],
        ],
        (o) => options.push(o),
      ),
    });
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).toEqual([]);
    expect(result.usage.steps).toBe(6);
    const repair = options[3] as {
      tools?: unknown[];
      responseFormat?: { type: string };
      prompt: Array<{ role: string }>;
    };
    expect(repair.tools ?? []).toHaveLength(0);
    expect(repair.responseFormat?.type).toBe('json');
    // The repair keeps the cached prefix and task messages and appends the invalid answer.
    expect(repair.prompt.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'user']);
    expect(result.modelCalls?.[2]?.outputValidation).toMatchObject({
      format: 'json',
      schemaValid: false,
      issues: ['invalid_type'],
    });
    expect(result.modelCalls?.[3]).toMatchObject({ final: true, toolCalls: 0 });
    expect(result.verification).toEqual([{ id: finding.id, decision: 'reject', reason: 'Guarded', evidence: [] }]);
  });
  it('gives an unstructured answer one repair call and never promotes the prose to evidence', async () => {
    const options: unknown[] = [];
    const result = await runReview(request(), {
      source: source(),
      model: model(
        [
          [read('investigate')],
          [{ type: 'text', text: 'UNSTRUCTURED_ALLEGATION: the code looks broken.' }],
          [text({ summary: 'No substantiated defect', findings: [] })],
        ],
        (o) => options.push(o),
      ),
    });
    expect(result.status).toBe('completed');
    expect(result.findings).toEqual([]);
    expect(result.usage.steps).toBe(4);
    expect(JSON.stringify(result)).not.toContain('UNSTRUCTURED_ALLEGATION');
    expect(result.modelCalls?.[2]?.outputValidation).toMatchObject({ format: 'text', schemaValid: false });
    expect((options[3] as { tools?: unknown[] }).tools ?? []).toHaveLength(0);
  });
  it('ends the phase when the repair call is invalid too', async () => {
    const result = await runReview(request(), {
      source: source(),
      model: model([
        [read('investigate')],
        [{ type: 'text', text: 'UNSTRUCTURED_ALLEGATION: the code looks broken.' }],
        [{ type: 'text', text: 'STILL_NOT_JSON' }],
        [text({ summary: 'Must not be reached after two invalid answers', findings: [] })],
      ]),
    });
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toEqual(['LENS_FAILED', 'MODEL_OUTPUT_INVALID']);
    expect(result.usage.steps).toBe(4);
    expect(JSON.stringify(result)).not.toContain('STILL_NOT_JSON');
    expect(result.modelCalls?.at(-1)).toMatchObject({
      final: true,
      outputValidation: { format: 'text', schemaValid: false },
    });
  });
  it('reports a provider error finish instead of mislabelling its empty text as invalid JSON', async () => {
    const providerError = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [],
        finishReason: { unified: 'other', raw: 'error' },
        usage: {
          inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 0, text: 0, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const result = await runReview(request(), { source: source(), model: providerError });
    expect(result.coverage.gaps).toEqual(['MODEL_PROVIDER_ERROR']);
    expect(result.modelCalls?.[0]).toMatchObject({ finishReason: 'other', rawFinishReason: 'error' });
    expect(result.usage.inputTokens).toBe(50);
  });
  it.each([2, 32])('diagnoses reasoning exhaustion even on JSON-only finalization (steps=%s)', async (maxSteps) => {
    const events: unknown[] = [];
    const result = await runReview(request({ limits: { ...request().limits, maxSteps } }), {
      source: source(),
      onModelCall: (event) => events.push(event),
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }],
          finishReason: { unified: 'length', raw: 'length' },
          usage: {
            inputTokens: { total: 12000, noCache: 12000, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 4000, text: 0, reasoning: 4000 },
          },
          warnings: [],
        }),
      }),
    });
    expect(result.status).toBe('incomplete');
    // The router is the first casualty; the logic lens then fails the same way.
    expect(result.coverage.gaps).toEqual([
      'ROUTER_UNAVAILABLE',
      'LENS_FAILED',
      'MODEL_OUTPUT_LIMIT',
      'SOURCE_NOT_INSPECTED',
    ]);
    expect(result.modelCalls).toEqual(events);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: 'router', step: 1 });
    expect(events[1]).toMatchObject({
      phase: 'discovery',
      lens: 'logic',
      step: 2,
      final: maxSteps === 2,
      finishReason: 'length',
      rawFinishReason: 'length',
      inputTokens: 12000,
      outputTokens: 4000,
      reasoningTokens: 4000,
      textBytes: 0,
      toolCalls: 0,
    });
    expect(result.usage.outputTokens).toBe(8000);
    const report = renderReview(result);
    expect(report).toContain('Model call diagnostics');
    expect(report).toContain('length');
    expect(JSON.stringify(events) + report).not.toContain('PRIVATE_REASONING');
  });
  it('logs only safe metadata for successful tool and text calls', async () => {
    const events: unknown[] = [];
    const result = await runReview(request(), {
      source: source(),
      onModelCall: (event) => events.push(event),
      model: model([[read('private-tool-id')], [text({ summary: 'PRIVATE_MODEL_TEXT', findings: [] })]]),
    });
    expect(result.status).toBe('completed');
    expect(result.modelCalls).toEqual(events);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ phase: 'router', toolCalls: 0 });
    expect(events[1]).toMatchObject({ finishReason: 'tool-calls', toolCalls: 1, lens: 'logic' });
    expect(events[2]).toMatchObject({ finishReason: 'stop', toolCalls: 0 });
    for (const privateValue of ['src/a.ts', bad, 'private-tool-id', 'PRIVATE_MODEL_TEXT'])
      expect(JSON.stringify(events)).not.toContain(privateValue);
  });
  it('normalizes untrusted finish reasons and never logs provider exception messages', async () => {
    const events: unknown[] = [];
    const result = await runReview(request(), {
      source: source(),
      onModelCall: (event) => events.push(event),
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [text({ summary: '', findings: [] })],
          finishReason: { unified: 'stop', raw: 'SECRET\n::error::spoof' },
          usage: {
            inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: 20, reasoning: undefined },
          },
          warnings: [],
        }),
      }),
    });
    expect(result.status).toBe('incomplete');
    // The fixture answers every call with a candidates object, so the router cannot be routed.
    expect(result.coverage.gaps).toEqual(['ROUTER_UNAVAILABLE', 'SOURCE_NOT_INSPECTED']);
    expect(events[0]).toMatchObject({ rawFinishReason: 'unknown' });
    // Four router events: two calls, each logged again once its output failed validation.
    expect(events).toHaveLength(5);
    const failed = await runReview(request(), {
      source: source(),
      onModelCall: (event) => events.push(event),
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error('PRIVATE_PROVIDER_ERROR');
        },
      }),
    });
    expect(failed.status).toBe('incomplete');
    expect(events[5]).toMatchObject({ finishReason: 'exception', inputTokens: null, outputTokens: null });
    expect(JSON.stringify(events)).not.toMatch(/SECRET|spoof|PRIVATE_PROVIDER_ERROR/);
  });
  it.each(['json', 'schema'])('counts tokens and fails closed on invalid final %s output', async (failure) => {
    const result = await runReview(request({ limits: { ...request().limits, maxSteps: 2 } }), {
      source: source(),
      model: model([[failure === 'json' ? { type: 'text', text: 'not JSON' } : text({ summary: 123, findings: [] })]]),
    });
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toEqual(['LENS_FAILED', 'MODEL_OUTPUT_INVALID', 'SOURCE_NOT_INSPECTED']);
    expect(result.modelCalls?.[1]?.outputValidation).toMatchObject({
      format: failure === 'json' ? 'text' : 'json',
      schemaValid: false,
    });
    expect(result.findings).toEqual([]);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(40);
  });
  it('records every merged candidate with its lens, verdict, outcome and host drop code', async () => {
    const rejected = { ...finding, id: 'naming', cause: 'unclear name', title: 'Unclear name' };
    // A quote that does not match the pinned head: the host drops it after verification confirms it.
    const stale = {
      ...finding,
      id: 'stale',
      cause: 'stale guard claim',
      title: 'Ghost guard',
      evidence: [{ ...finding.evidence[0]!, excerpt: good }],
    };
    const result = await runReview(request(), {
      source: source(),
      model: dispatch({
        route: { lenses: [] },
        lens: () => [text({ summary: 'Three candidates', findings: [finding, rejected, stale] })],
        verify: (call) =>
          call === 1
            ? [read('verify')]
            : [
                text({
                  verdicts: [
                    { id: finding.id, decision: 'confirm', reason: 'Divisor is zero at head' },
                    { id: rejected.id, decision: 'reject', reason: 'Naming is not a defect' },
                    { id: stale.id, decision: 'confirm', reason: 'Guard is missing' },
                  ],
                }),
              ],
      }),
    });
    expect(result.findings.map((f) => f.id)).toEqual([finding.id]);
    expect(result.candidates).toEqual([
      {
        id: finding.id,
        lens: 'logic',
        severity: 'P1',
        title: finding.title,
        anchor: finding.anchor,
        verdict: 'confirm',
        outcome: 'published',
      },
      {
        id: rejected.id,
        lens: 'logic',
        severity: 'P1',
        title: rejected.title,
        anchor: rejected.anchor,
        verdict: 'reject',
        outcome: 'rejected',
      },
      {
        id: stale.id,
        lens: 'logic',
        severity: 'P1',
        title: stale.title,
        anchor: stale.anchor,
        // The host rewrites a confirm it cannot corroborate as unresolved; the row says why.
        verdict: 'unresolved',
        outcome: 'dropped',
        reason: 'EVIDENCE_EXCERPT_MISMATCH',
      },
    ]);
  });
  it('binds a rediscovered root cause to the prior identity before verification', async () => {
    const prior = { ...finding, id: 'prior_stable' };
    const result = await runReview(request(), {
      source: source(),
      previousFindings: [prior],
      model: model([
        [text({ summary: 'Candidate with new model-local id', findings: [finding] })],
        [read('verify')],
        [text({ verdicts: [{ id: prior.id, decision: 'confirm', reason: 'Still broken' }] })],
      ]),
    });
    expect(result.status).toBe('completed');
    expect(result.findings).toEqual([prior]);
    expect(result.rechecks).toBeUndefined();
  });
  it('binds a candidate to a previous finding whose cause the model reworded on the same line', async () => {
    const prior = { ...finding, id: 'prior_stable', cause: 'worded differently by the previous run' };
    const result = await runReview(request(), {
      source: source(),
      previousFindings: [prior],
      model: model([
        [text({ summary: 'Same defect again', findings: [finding] })],
        [read('verify')],
        [text({ verdicts: [{ id: prior.id, decision: 'confirm', reason: 'Still broken' }] })],
      ]),
    });
    expect(result.status).toBe('completed');
    expect(result.findings).toEqual([{ ...finding, id: 'prior_stable' }]);
    expect(result.rechecks).toBeUndefined();
  });
  it('settles a rejected prior finding in verification instead of paying for a recheck call', async () => {
    const prior = { ...finding, id: 'prior_stable' };
    const rejection = {
      id: prior.id,
      decision: 'reject',
      reason: 'The divisor is 2 at the current head',
      evidence: [{ ...finding.evidence[0]!, endLine: 200, excerpt: good }],
    };
    const result = await runReview(request(), {
      source: source(true),
      previousFindings: [prior],
      model: model([
        [text({ summary: 'Candidate with new model-local id', findings: [finding] })],
        [read('verify')],
        [text({ verdicts: [rejection] })],
      ]),
    });
    expect(result.status).toBe('completed');
    expect(result.findings).toEqual([]);
    // No recheck phase ran: every model response above was consumed by discovery and verification.
    expect(result.modelCalls?.at(-1)?.phase).toBe('verification');
    expect(result.rechecks).toEqual([{ ...rejection, evidence: [{ ...rejection.evidence[0]!, endLine: 1 }] }]);
  });
  it.each([
    true,
    false,
  ])('requires a fresh source read before marking a previous finding fixed (read=%s)', async (fresh) => {
    const recheck = {
      id: finding.id,
      decision: 'reject',
      reason: 'Divisor is 2 at the new head',
      evidence: [{ ...finding.evidence[0]!, excerpt: good }],
    };
    const responses: Parameters<typeof model>[0] = [[text({ summary: 'No new defects', findings: [] })]];
    if (fresh) responses.push([read('recheck')]);
    const answer = [text({ verdicts: [{ ...recheck, evidence: [{ ...recheck.evidence[0]!, endLine: 200 }] }] })];
    // An unread answer is sent back for the read up to three times before it is accepted as partial.
    for (let i = 0; i < (fresh ? 1 : 4); i++) responses.push(answer);
    const result = await runReview(request(), {
      source: source(true),
      model: model(responses),
      previousFindings: [finding],
    });
    expect(result.status).toBe(fresh ? 'completed' : 'incomplete');
    expect(result.modelCalls?.at(-1)?.phase).toBe('recheck');
    if (fresh) expect(result.rechecks).toEqual([recheck]);
    else {
      expect(result.rechecks?.[0]).toMatchObject({ decision: 'unresolved' });
      expect(result.rechecks?.[0]?.reason).toContain('[evidence failed host validation]');
      expect(result.coverage.gaps).toContain('PREVIOUS_FINDING_UNRESOLVED');
      expect(result.coverage.gaps).not.toContain('RECHECK_EVIDENCE_INVALID');
    }
  });
  it('sends a recheck answered without reading back for the read, then accepts the fresh verdict', async () => {
    const recheck = {
      id: finding.id,
      decision: 'reject',
      reason: 'Divisor is 2 at the new head',
      evidence: [{ ...finding.evidence[0]!, excerpt: good }],
    };
    const answer = [text({ verdicts: [{ ...recheck, evidence: [{ ...recheck.evidence[0]!, endLine: 200 }] }] })];
    const result = await runReview(request(), {
      source: source(true),
      previousFindings: [finding],
      model: model([[text({ summary: 'No new defects', findings: [] })], answer, [read('recheck')], answer]),
    });
    expect(result.status).toBe('completed');
    expect(result.rechecks).toEqual([recheck]);
    expect(result.coverage.gaps).not.toContain('PREVIOUS_FINDING_UNRESOLVED');
  });
  it('sends a recheck back when it returns no verdict for a previous finding', async () => {
    const recheck = { id: finding.id, decision: 'confirm', reason: 'Zero divisor remains', evidence: finding.evidence };
    const result = await runReview(request(), {
      source: source(),
      previousFindings: [finding],
      model: model([
        [text({ summary: 'No new defects', findings: [] })],
        [read('prior')],
        [text({ verdicts: [] })],
        [text({ verdicts: [recheck] })],
      ]),
    });
    expect(result.status).toBe('completed');
    expect(result.rechecks).toEqual([recheck]);
    expect(result.coverage.gaps).not.toContain('RECHECK_INCOMPLETE');
  });
  it('keeps an unresolved previous finding distinct from a verified fix', async () => {
    const recheck = { id: finding.id, decision: 'unresolved', reason: 'Insufficient evidence', evidence: [] };
    const result = await runReview(request(), {
      source: source(),
      previousFindings: [finding],
      // An unresolved answer is accepted once the previous evidence was read again in this phase.
      model: model([
        [text({ summary: 'No new defects', findings: [] })],
        [read('prior')],
        [text({ verdicts: [recheck] })],
      ]),
    });
    expect(result.rechecks?.[0]?.decision).toBe('unresolved');
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('PREVIOUS_FINDING_UNRESOLVED');
  });
  it('does not claim no verified findings when a historical defect still applies', async () => {
    const recheck = { id: finding.id, decision: 'confirm', reason: 'Zero divisor remains', evidence: finding.evidence };
    const result = await runReview(request(), {
      source: source(),
      previousFindings: [finding],
      model: model([
        [text({ summary: 'No new defects', findings: [] })],
        [read('prior')],
        [text({ verdicts: [recheck] })],
      ]),
    });
    expect(result.status).toBe('completed');
    expect(result.summary).toContain('1 previous finding(s) still apply');
    expect(result.summary).not.toContain('No verified findings');
  });
  it.each([
    [false, 1],
    [true, 1],
    [false, 200],
    [true, 200],
  ])('derives the evidence end line from its quote (forged=%s, declared end=%s)', async (forged, endLine) => {
    const extra = 'export const marker = 1;';
    const src = source();
    src.read = async (revision) => `${revision === 'base' ? good : bad}\n${extra}`;
    const candidate = {
      ...finding,
      evidence: [
        { ...finding.evidence[0]!, endLine, excerpt: `${bad}\n${forged ? 'export const marker = 2;' : extra}` },
      ],
    };
    const readBoth = (id: string) => ({
      ...read(id),
      input: JSON.stringify({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 2 }),
    });
    const result = await runReview(request(), {
      source: src,
      model: model([
        [readBoth('candidate')],
        [text({ summary: 'Candidate', findings: [candidate] })],
        [readBoth('verification')],
        // A forged quote is sent back on every nudge before the host settles for dropping the claim.
        ...Array.from({ length: 4 }, () => [
          text({ verdicts: [{ id: finding.id, decision: 'confirm', reason: 'Reachable defect' }] }),
        ]),
      ]),
    });
    if (forged) {
      expect(result.status).toBe('incomplete');
      expect(result.findings).toEqual([]);
      expect(result.coverage.gaps).toContain('FINDING_EVIDENCE_INVALID');
    } else {
      expect(result.status).toBe('completed');
      expect(result.findings[0]!.evidence[0]).toMatchObject({ startLine: 1, endLine: 2, excerpt: `${bad}\n${extra}` });
    }
  });
  describe('miscounted line numbers', () => {
    // The model counts lines itself in unnumbered source and is routinely a few lines off.
    const body = (divisor: string) =>
      `const a = 1;\nconst b = 2;\nexport const divide = (n: number) => n / ${divisor};\nconst c = 3;`;
    const offSource = (): SourceReader => ({
      list: async () => ({ items: [{ path: 'src/a.ts', oid: base, mode: '100644' }], gaps: [] }),
      read: async (revision) => (revision === 'base' ? body('2') : body('0')),
      changes: async () => ({
        items: [
          {
            path: 'src/a.ts',
            status: 'modified',
            patch: `@@ -1,4 +1,4 @@\n const a = 1;\n const b = 2;\n-${good}\n+${bad}\n const c = 3;`,
          },
        ],
        gaps: [],
      }),
    });
    const readAll = (id: string) => ({
      ...read(id),
      input: JSON.stringify({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 4 }),
    });
    const run = (candidate: Finding) =>
      runReview(request(), {
        source: offSource(),
        model: model([
          [readAll('candidate')],
          [text({ summary: 'Candidate', findings: [candidate] })],
          [readAll('verification')],
          [text({ verdicts: [{ id: candidate.id, decision: 'confirm', reason: 'Reachable defect' }] })],
        ]),
      });

    it('publishes a finding whose quote and anchor are off by the same delta, with corrected numbers', async () => {
      const result = await run({ ...finding, evidence: [{ ...finding.evidence[0]!, excerpt: bad }] });
      expect(result.status).toBe('completed');
      expect(result.findings[0]!.anchor.line).toBe(3);
      expect(result.findings[0]!.evidence[0]).toMatchObject({ startLine: 3, endLine: 3, excerpt: bad });
    });

    it('still drops a finding whose corrected anchor is not a changed line', async () => {
      const result = await run({
        ...finding,
        anchor: { ...finding.anchor, line: 2 },
        evidence: [{ ...finding.evidence[0]!, endLine: 2, excerpt: `${bad}\nconst c = 3;` }],
      });
      expect(result.findings).toEqual([]);
      expect(result.coverage.gaps).toContain('FINDING_ANCHOR_NOT_CHANGED');
    });
  });

  it('emits a verified changed-line finding only after fresh evidence reads', async () => {
    const result = await runReview(request(), {
      source: source(),
      model: model([
        [read('first')],
        [text({ summary: 'Divisor changes', findings: [finding] })],
        [read('verify')],
        [
          text({
            verdicts: [
              { id: finding.id, decision: 'confirm', reason: 'Read the head implementation; no guard exists.' },
            ],
          }),
        ],
      ]),
    });
    expect(result.status).toBe('completed');
    expect(result.findings).toEqual([finding]);
    expect(result.modelCalls?.map((call) => call.phase)).toEqual([
      'router',
      'discovery',
      'discovery',
      'verification',
      'verification',
    ]);
    expect(result.usage.steps).toBe(5);
    expect(result.usage.inputTokens).toBe(250);
    expect(result.coverage.read).toEqual(['head:src/a.ts']);
  });
  it('pairs the seed with existing handling: a rejected allegation produces no finding', async () => {
    const result = await runReview(request(), {
      source: source(true),
      model: model([
        [text({ summary: 'Division is broken and returns Infinity', findings: [finding] })],
        [read('handled')],
        [text({ verdicts: [{ id: finding.id, decision: 'reject', reason: 'The divisor is still 2.' }] })],
      ]),
    });
    expect(result.status).toBe('completed');
    expect(result.findings).toEqual([]);
    expect(result.summary).not.toContain('Division is broken');
    expect(result.summary).toContain('No verified findings');
  });
  it('reports cost exhaustion even when the final model reply has no tool calls', async () => {
    const result = await runReview(
      request({
        model: { ...request().model, maxUsd: 0.000001, inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      }),
      {
        source: source(),
        model: model([[text({ summary: 'No defects', findings: [] })]]),
      },
    );
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('COST_OR_USAGE_LIMIT');
    expect(result.usage.inputTokens).toBe(50);
  });
  it('gates on settled charges instead of the declared-price estimate when the transport reports them', async () => {
    const req = request({
      model: { ...request().model, maxUsd: 0.000001, inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
    });
    const result = await runReview(req, {
      source: source(true),
      model: model([[read('inspect')], [text({ summary: 'Guard handles this', findings: [] })]]),
      settledUsd: () => 0,
    });
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).toEqual([]);
  });
  it('finishes a large-context review within its price budget without a second token budget', async () => {
    let calls = 0;
    const largeContext = new MockLanguageModelV3({
      doGenerate: async (options) => ({
        // The tool-less first call is the router; the investigating call reads, then answers.
        content: !options.tools?.length
          ? [route()]
          : ++calls === 1
            ? [read('inspect')]
            : [text({ summary: 'No defects', findings: [] })],
        finishReason: {
          unified: options.tools?.length && calls === 1 ? 'tool-calls' : 'stop',
          raw: options.tools?.length && calls === 1 ? 'tool_calls' : 'stop',
        },
        usage: {
          inputTokens: { total: 200000, noCache: 200000, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const result = await runReview(
      request({ model: { ...request().model, maxUsd: 1, inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }),
      { source: source(), model: largeContext },
    );
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).toEqual([]);
    expect(result.usage.inputTokens).toBe(600000);
  });
  it('preserves a truncated tree gap when the only tool is a direct source read', async () => {
    const truncated = source();
    const listing = await truncated.list('head');
    truncated.list = async () => ({ ...listing, gaps: ['SOURCE_TREE_TRUNCATED'] });
    const result = await runReview(request(), {
      source: truncated,
      model: model([[read('direct')], [text({ summary: 'No defects', findings: [] })]]),
    });
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('SOURCE_TREE_TRUNCATED');
  });
  it('sends verification back to read the evidence of a candidate it confirmed unread', async () => {
    const confirm = [text({ verdicts: [{ id: finding.id, decision: 'confirm', reason: 'Looks correct' }] })];
    const messages: string[][] = [];
    const result = await runReview(request(), {
      source: source(),
      model: model(
        [[read('candidate')], [text({ summary: 'Change', findings: [finding] })], confirm, [read('verify')], confirm],
        (options) => messages.push(userMessages(options)),
      ),
    });
    // The nudge is the last instruction of the second verification call, before the step reminder.
    expect(messages[4]!.at(-2)).toBe(
      `You confirmed ${finding.id} without reading their evidence in this phase. Do not answer in text now: call read_source for exactly these intervals first, then return ALL verdicts (confirm only if the quoted lines match verbatim): head src/a.ts 1-1`,
    );
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).toEqual([]);
    expect(result.findings).toEqual([finding]);
    // The router, discovery's read and answer, and verification's three: the refused answer,
    // the read it was sent back for and the answer that repeats it.
    expect(result.modelCalls?.map((c) => c.phase)).toEqual([
      'router',
      'discovery',
      'discovery',
      'verification',
      'verification',
      'verification',
    ]);
  });
  it('refuses a confirmed finding that stays unread after every verification nudge', async () => {
    const confirm = [text({ verdicts: [{ id: finding.id, decision: 'confirm', reason: 'Looks correct' }] })];
    const result = await runReview(request(), {
      source: source(),
      model: model([
        [read('candidate')],
        [text({ summary: 'Change', findings: [finding] })],
        confirm,
        confirm,
        confirm,
        confirm,
      ]),
    });
    expect(result.status).toBe('incomplete');
    expect(result.findings).toEqual([]);
    expect(result.coverage.gaps).toEqual([
      'VERIFICATION_EVIDENCE_PARTIAL',
      'FINDING_EVIDENCE_INVALID',
      'EVIDENCE_NOT_READ_THIS_PHASE',
    ]);
    expect(result.verification[0]).toMatchObject({ decision: 'unresolved' });
    expect(result.verification[0]?.reason).toContain('EVIDENCE_NOT_READ_THIS_PHASE');
    expect(result.modelCalls?.filter((c) => c.phase === 'verification')).toHaveLength(4);
    expect(renderReview(result)).toContain(
      'Verification confirmed a candidate without fresh reads of its evidence, even after being sent back to read it.',
    );
  });
  it('does not send verification back for a rejected or unresolved verdict', async () => {
    const second = { ...finding, id: 'second', cause: 'second cause' };
    const result = await runReview(request(), {
      source: source(),
      model: model([
        [read('candidate')],
        [text({ summary: 'Change', findings: [finding, second] })],
        [
          text({
            verdicts: [
              { id: finding.id, decision: 'reject', reason: 'Guarded' },
              { id: second.id, decision: 'unresolved', reason: 'No evidence' },
            ],
          }),
        ],
      ]),
    });
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toEqual(['FINDING_UNRESOLVED']);
    expect(result.modelCalls?.filter((c) => c.phase === 'verification')).toHaveLength(1);
  });
  it('does not equate missing source or tool errors with no issues', async () => {
    const missing = source();
    missing.read = async () => {
      throw new Error('unavailable');
    };
    const result = await runReview(request(), {
      source: missing,
      model: model([[read('missing')], [text({ summary: 'Nothing found', findings: [] })]]),
    });
    expect(result.modelCalls?.[1]?.toolLimitations).toEqual(['TOOL_READ_FAILED']);
    expect(result.modelCalls?.[2]?.toolLimitations).toBeUndefined();
    expect(result.status).toBe('incomplete');
    expect(result.findings).toEqual([]);
  });
  it('gives every phase one call on the smallest budget instead of failing before the first call', async () => {
    const req = request();
    // The router, discovery and verification each get their single call.
    req.limits.maxSteps = 3;
    const toolAvailability: boolean[] = [];
    const result = await runReview(req, {
      source: source(),
      model: model(
        [
          [text({ summary: 'x', findings: [finding] })],
          [text({ verdicts: [{ id: finding.id, decision: 'reject', reason: 'r' }] })],
        ],
        (options) => toolAvailability.push(Boolean((options as { tools?: unknown[] }).tools?.length)),
      ),
    });
    expect(toolAvailability).toEqual([false, false, false]);
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toEqual(['SOURCE_NOT_INSPECTED']);
    expect(result.usage.steps).toBe(3);
  });
  it('forces finalization when the tool budget runs out instead of discarding the investigation', async () => {
    const req = request();
    req.limits.maxToolCalls = 2;
    const toolAvailability: boolean[] = [];
    const result = await runReview(req, {
      source: source(),
      model: model(
        [
          [read('first')],
          [read('second')],
          [read('third')],
          [text({ summary: 'Divisor changes', findings: [finding] })],
          [text({ verdicts: [{ id: finding.id, decision: 'reject', reason: 'The divisor is 2' }] })],
        ],
        (options) => toolAvailability.push(Boolean((options as { tools?: unknown[] }).tools?.length)),
      ),
    });
    // The third read is refused as a tool result; every later call is tool-less, so the
    // phases must answer with the evidence they already read.
    expect(toolAvailability).toEqual([false, true, true, true, false, false]);
    expect(result.coverage.gaps).toContain('TOOL_LIMIT');
    expect(result.status).toBe('incomplete');
    expect(result.usage.toolCalls).toBe(2);
    // The paid discovery and its verdict survive the exhausted budget.
    expect(result.verification).toEqual([
      { id: finding.id, decision: 'reject', reason: 'The divisor is 2', evidence: [] },
    ]);
    expect(result.modelCalls?.map((c) => c.phase)).toEqual([
      'router',
      'discovery',
      'discovery',
      'discovery',
      'discovery',
      'verification',
    ]);
  });
  it('stops at the step budget even when the model keeps requesting tools', async () => {
    const req = request();
    req.limits.maxSteps = 2;
    // The router spends the first step; the lens has one tool-less step left.
    const result = await runReview(req, { source: source(), model: model([[read('a')], [read('b')]]) });
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('STEP_LIMIT');
  });
  describe('long evidence quotes', () => {
    /** A file of `count` lines whose changed line 3 carries the defect, for multi-line quotes. */
    const longSource = (count: number): SourceReader => {
      const body = (divisor: string) => [
        ...numbered(2),
        `export const divide = (n: number) => n / ${divisor};`,
        ...numbered(count - 3, 3),
      ];
      return {
        list: async () => ({ items: [{ path: 'src/a.ts', oid: base, mode: '100644' }], gaps: [] }),
        read: async (revision) => body(revision === 'base' ? '2' : '0').join('\n'),
        changes: async () => ({
          items: [
            {
              path: 'src/a.ts',
              status: 'modified',
              patch: [
                `@@ -1,${count} +1,${count} @@`,
                ...numbered(2).map((l) => ` ${l}`),
                `-${good}`,
                `+${bad}`,
                ...numbered(count - 3, 3).map((l) => ` ${l}`),
              ].join('\n'),
            },
          ],
          gaps: [],
        }),
      };
    };
    const readRange = (id: string, startLine: number, endLine: number) => ({
      ...read(id),
      input: JSON.stringify({ revision: 'head', path: 'src/a.ts', startLine, endLine }),
    });
    const quote = async (src: SourceReader, from: number, to: number) =>
      (await src.read('head', 'src/a.ts'))
        .split('\n')
        .slice(from - 1, to)
        .join('\n');
    const anchored = { ...finding, anchor: { ...finding.anchor, line: 3 } };

    it('publishes a candidate whose evidence spans 20 lines', async () => {
      const src = longSource(25);
      const candidate = {
        ...anchored,
        evidence: [{ ...finding.evidence[0]!, startLine: 1, endLine: 20, excerpt: await quote(src, 1, 20) }],
      };
      const result = await runReview(request(), {
        source: src,
        model: model([
          [readRange('candidate', 1, 20)],
          [text({ summary: 'Long quote', findings: [candidate] })],
          [readRange('verify', 1, 20)],
          [text({ verdicts: [{ id: candidate.id, decision: 'confirm', reason: 'Reachable defect' }] })],
        ]),
      });
      expect(result.status).toBe('completed');
      expect(result.findings[0]!.evidence[0]).toMatchObject({ startLine: 1, endLine: 20 });
      expect(result.coverage.gaps).not.toContain('EVIDENCE_RANGE_INVALID');
    });

    it('nudges a 60-line quote instead of dropping it, and publishes the re-quote', async () => {
      const src = longSource(65);
      const candidate = {
        ...anchored,
        evidence: [{ ...finding.evidence[0]!, startLine: 1, endLine: 60, excerpt: await quote(src, 1, 60) }],
      };
      const requote = { ...finding.evidence[0]!, startLine: 1, endLine: 5, excerpt: await quote(src, 1, 5) };
      const prompts: string[] = [];
      const result = await runReview(request(), {
        source: src,
        model: model(
          [
            [readRange('candidate', 1, 60)],
            [text({ summary: 'Over-long quote', findings: [candidate] })],
            [readRange('verify', 1, 60)],
            [text({ verdicts: [{ id: candidate.id, decision: 'confirm', reason: 'Reachable defect' }] })],
            [
              text({
                verdicts: [{ id: candidate.id, decision: 'confirm', reason: 'Reachable defect', evidence: [requote] }],
              }),
            ],
          ],
          (options) => prompts.push(...userMessages(options)),
        ),
      });
      expect(prompts.some((m) => m.includes('src/a.ts:1-60 is longer than 40 lines or malformed'))).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.findings[0]!.evidence).toEqual([requote]);
      expect(result.candidates?.[0]).toMatchObject({ outcome: 'published' });
    });

    it('nudges a confirm whose evidence covers no anchor line, and publishes the re-quote', async () => {
      const src = longSource(25);
      const candidate = {
        ...anchored,
        evidence: [{ ...finding.evidence[0]!, startLine: 5, endLine: 8, excerpt: await quote(src, 5, 8) }],
      };
      const requote = { ...finding.evidence[0]!, startLine: 1, endLine: 5, excerpt: await quote(src, 1, 5) };
      const prompts: string[] = [];
      const result = await runReview(request(), {
        source: src,
        model: model(
          [
            [readRange('candidate', 1, 8)],
            [text({ summary: 'Uncovered anchor', findings: [candidate] })],
            [readRange('verify', 1, 8)],
            [text({ verdicts: [{ id: candidate.id, decision: 'confirm', reason: 'Reachable defect' }] })],
            [
              text({
                verdicts: [{ id: candidate.id, decision: 'confirm', reason: 'Reachable defect', evidence: [requote] }],
              }),
            ],
          ],
          (options) => prompts.push(...userMessages(options)),
        ),
      });
      expect(prompts.some((m) => m.includes('no evidence interval covers the anchor src/a.ts:3'))).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.findings[0]!.evidence).toEqual([requote]);
    });
  });
  it('drops an unverifiable confirmed finding without discarding the verified one', async () => {
    const unanchored = { ...finding, id: 'unanchored', cause: 'other cause', anchor: { ...finding.anchor, line: 9 } };
    const result = await runReview(request(), {
      source: source(),
      model: model([
        [text({ summary: 'Two candidates', findings: [unanchored, finding] })],
        [read('verify')],
        [
          text({
            verdicts: [
              { id: unanchored.id, decision: 'confirm', reason: 'Claimed' },
              { id: finding.id, decision: 'confirm', reason: 'Reachable defect' },
            ],
          }),
        ],
      ]),
    });
    expect(result.findings).toEqual([finding]);
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('FINDING_EVIDENCE_INVALID');
    expect(result.verification.find((v) => v.id === unanchored.id)).toMatchObject({ decision: 'unresolved' });
    expect(result.verification.find((v) => v.id === unanchored.id)?.reason).toContain(
      '[evidence failed host validation]',
    );
  });
  it.each([
    // An anchor on an unchanged line is not a quote problem, so it is dropped without a nudge.
    ['FINDING_ANCHOR_NOT_CHANGED', { ...finding, anchor: { ...finding.anchor, line: 9 } }, false],
    // Evidence is validated before the anchor, so an uncovered anchor needs otherwise valid
    // evidence: head evidence cannot cover a base anchor. It is nudged for a re-quote, and
    // dropped only after the verifier repeats the same uncovered evidence.
    ['FINDING_ANCHOR_NOT_COVERED', { ...finding, anchor: { ...finding.anchor, revision: 'base' as const } }, true],
    [
      'EVIDENCE_EXCERPT_MISMATCH',
      { ...finding, evidence: [{ ...finding.evidence[0]!, excerpt: 'invented quote' }] },
      true,
    ],
  ] as const)('explains a rejected confirmation as %s in the report without publishing the claim', async (code, candidate, nudged) => {
    const verdict = [text({ verdicts: [{ id: candidate.id, decision: 'confirm', reason: 'Claimed defect' }] })];
    const responses = [
      [read('candidate')],
      [text({ summary: '', findings: [candidate] })],
      [read('verify')],
      // A nudged phase repeats the same unbacked confirm until the host settles for dropping it.
      ...(nudged ? [verdict, verdict, verdict, verdict] : [verdict]),
    ];
    const result = await runReview(request(), { source: source(), model: model(responses) });
    expect(result.status).toBe('incomplete');
    expect(result.findings).toEqual([]);
    expect(result.coverage.gaps).toEqual([
      ...(nudged ? ['VERIFICATION_EVIDENCE_PARTIAL'] : []),
      'FINDING_EVIDENCE_INVALID',
      code,
    ]);
    expect(result.verification[0]).toMatchObject({ decision: 'unresolved' });
    expect(result.verification[0]?.reason).toContain(code);
    const report = renderReview(result);
    expect(report).toContain(code.replaceAll('_', '\\_'));
    expect(report).not.toContain('invented quote');
    // The claim is listed as a dropped candidate with its host code, never as a rendered finding.
    expect(report).not.toContain(`## ${candidate.severity}: ${candidate.title}`);
    expect(report).toContain(`| dropped | ${code.replaceAll('_', '\\_')} |`);
  });

  it('shows the complete file manifest when a bounded diff omits a file', async () => {
    const req = request();
    req.limits.maxFiles = 1;
    const src = source();
    const original = await src.changes();
    src.changes = async () => ({
      items: [...original.items, { path: 'src/omitted.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+new' }],
      gaps: [],
    });
    const prompts: string[] = [];
    const result = await runReview(req, {
      source: src,
      model: model([[text({ summary: '', findings: [] })]], (options) => prompts.push(JSON.stringify(options))),
    });
    expect(result.coverage.gaps).toContain('CHANGED_FILE_LIMIT');
    expect(prompts[0]).toContain('src/omitted.ts');
    expect(prompts[0]).toContain('CHANGED_FILE_LIMIT');
  });

  it('says so in the summary when every confirmed candidate failed evidence validation', async () => {
    const unanchored = { ...finding, anchor: { ...finding.anchor, line: 9 } };
    const result = await runReview(request(), {
      source: source(),
      model: model([
        [text({ summary: 'One candidate', findings: [unanchored] })],
        [read('verify')],
        [text({ verdicts: [{ id: unanchored.id, decision: 'confirm', reason: 'Claimed' }] })],
      ]),
    });
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe(
      '1 candidate(s) failed evidence validation; no verified findings in the analyzed scope; this is not proof of correctness.',
    );
  });
  it('lets the model recover from invalid tool arguments instead of ending the run', async () => {
    const invalid = {
      ...read('invalid'),
      input: JSON.stringify({ revision: 'head', path: 'src/a.ts', startLine: 0, endLine: 1 }),
    };
    const result = await runReview(request(), {
      source: source(),
      model: model([
        [invalid],
        [text({ summary: 'Divisor changes', findings: [finding] })],
        [read('verify')],
        [text({ verdicts: [{ id: finding.id, decision: 'confirm', reason: 'Reachable defect' }] })],
      ]),
    });
    expect(result.findings).toEqual([finding]);
    expect(result.coverage.gaps).toContain('TOOL_INPUT_INVALID');
    expect(result.coverage.gaps).not.toContain('MODEL_TOOL_FAILED');
    // A recovered tool mistake is a reported limitation, not an incomplete review.
    expect(result.status).toBe('completed');
    expect(result.usage.toolCalls).toBe(2);
  });
  it('reports a denied source path as a tool result, not as an argument-validation error', async () => {
    const prompts: string[] = [];
    const result = await runReview(request(), {
      source: source(),
      model: model(
        [
          [
            {
              ...read('denied'),
              input: JSON.stringify({ revision: 'head', path: '.npmrc', startLine: 1, endLine: 1 }),
            },
          ],
          [text({ summary: 'No candidate after the denied read', findings: [] })],
        ],
        (options) => prompts.push(JSON.stringify(options)),
      ),
    });
    expect(prompts[2]).toContain('SOURCE_PATH_DENIED');
    expect(result.coverage.gaps).toContain('SOURCE_PATH_DENIED');
    expect(result.coverage.gaps).not.toContain('TOOL_INPUT_INVALID');
    expect(result.summary).toContain('No verified findings');
  });
  it('masks a host secret and a private-key block in what the model reads, and keeps reviewing', async () => {
    const secret = 'ghp_fixture_secret_value';
    const leaking = source();
    leaking.read = async () =>
      `const token = '${secret}'; const key = '-----BEGIN RSA PRIVATE KEY-----MIIE-----END RSA PRIVATE KEY-----';`;
    const prompts: string[] = [];
    const result = await runReview(request(), {
      source: leaking,
      secrets: [secret],
      model: model([[read('leak')], [text({ summary: 'done', findings: [] })]], (options) =>
        prompts.push(JSON.stringify(options)),
      ),
    });
    expect(result.coverage.gaps).not.toContain('SENSITIVE_OUTPUT');
    const seen = prompts.join('');
    expect(seen).not.toContain(secret);
    expect(seen).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(seen).toContain('[REDACTED]');
    expect(seen).toContain('[REDACTED PRIVATE KEY]');
  });
  it('keeps verified findings when a recheck verdict fails host evidence validation', async () => {
    const prior = { ...finding, id: 'prior_other', cause: 'unrelated historical claim', title: 'Unrelated' };
    const result = await runReview(request(), {
      source: source(),
      previousFindings: [prior],
      model: model([
        [text({ summary: 'One candidate', findings: [finding] })],
        [read('verify')],
        [text({ verdicts: [{ id: finding.id, decision: 'confirm', reason: 'Reachable defect' }] })],
        [text({ verdicts: [{ id: prior.id, decision: 'reject', reason: 'Claimed fix', evidence: [] }] })],
      ]),
    });
    expect(result.findings).toEqual([finding]);
    expect(result.rechecks?.[0]).toMatchObject({ decision: 'unresolved' });
    expect(result.rechecks?.[0]?.reason).toContain('[evidence failed host validation]');
    expect(result.coverage.gaps).toContain('PREVIOUS_FINDING_UNRESOLVED');
    expect(result.status).toBe('incomplete');
  });
  it('returns a recoverable read failure to the model as a tool result instead of ending the run', async () => {
    const missing = source();
    const readable = missing.read;
    missing.read = async (revision, path) => {
      if (path === 'src/missing.ts') throw new ReviewError('SOURCE_NOT_FOUND');
      return readable(revision, path);
    };
    const prompts: string[] = [];
    const result = await runReview(request(), {
      source: missing,
      model: model(
        [
          [
            {
              ...read('gone'),
              input: JSON.stringify({ revision: 'head', path: 'src/missing.ts', startLine: 1, endLine: 1 }),
            },
          ],
          [read('retry')],
          [text({ summary: 'No candidate after retrying the read', findings: [] })],
        ],
        (options) => prompts.push(JSON.stringify(options)),
      ),
    });
    expect(prompts[2]).toContain('SOURCE_NOT_FOUND');
    expect(result.coverage.gaps).toContain('SOURCE_NOT_FOUND');
    expect(result.coverage.gaps).not.toContain('MODEL_TOOL_FAILED');
    expect(result.summary).toContain('No verified findings');
  });
  it('keeps a fatal tool failure code instead of reporting a generic tool error', async () => {
    const req = request();
    req.limits.maxSourceBytes = 1;
    const result = await runReview(req, {
      source: source(),
      model: model([[read('too-large')], [text({ summary: 'unreachable', findings: [] })]]),
    });
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('SOURCE_LIMIT');
    expect(result.coverage.gaps).not.toContain('MODEL_TOOL_FAILED');
  });
  it('reserves enough steps for verification to read more than once before it must answer', async () => {
    const req = request();
    req.limits.maxSteps = 5;
    const toolAvailability: boolean[] = [];
    const result = await runReview(req, {
      source: source(),
      model: model(
        [
          [text({ summary: 'Divisor changes', findings: [finding] })],
          [read('verify')],
          [read('again')],
          [text({ verdicts: [{ id: finding.id, decision: 'confirm', reason: 'Reachable defect' }] })],
        ],
        (options) => toolAvailability.push(Boolean((options as { tools?: unknown[] }).tools?.length)),
      ),
    });
    expect(toolAvailability).toEqual([false, false, true, true, false]);
    expect(result.status).toBe('completed');
    expect(result.findings).toEqual([finding]);
    expect(result.usage.steps).toBe(5);
  });
  it('completes a review whose only gaps are reads the model routed around', async () => {
    const missing = source();
    const readable = missing.read;
    missing.read = async (revision, path) => {
      if (path === 'src/missing.ts') throw new ReviewError('SOURCE_NOT_FOUND');
      return readable(revision, path);
    };
    const result = await runReview(request(), {
      source: missing,
      model: model([
        [
          {
            ...read('gone'),
            input: JSON.stringify({ revision: 'head', path: 'src/missing.ts', startLine: 1, endLine: 1 }),
          },
        ],
        [read('retry')],
        [text({ summary: 'No defects', findings: [] })],
      ]),
    });
    expect(result.coverage.gaps).toEqual(['SOURCE_NOT_FOUND']);
    expect(result.status).toBe('completed');
  });
  it('truncates and deduplicates candidates instead of ending the run', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...finding, id: `f${i}`, cause: `cause ${i}` }));
    const result = await runReview(request(), {
      source: source(),
      model: model([
        [text({ summary: 'Too many candidates', findings: [...many, { ...finding, id: 'f0', cause: 'same id' }] })],
        [read('verify')],
        [
          text({
            verdicts: many.slice(0, 10).map((f) => ({ id: f.id, decision: 'reject', reason: 'Guarded' })),
          }),
        ],
      ]),
    });
    expect(result.coverage.gaps).toContain('DUPLICATE_CANDIDATE_ID');
    expect(result.coverage.gaps).toContain('FINDING_LIMIT');
    expect(result.verification.map((v) => v.id)).toEqual(many.slice(0, 10).map((f) => f.id));
    expect(result.findings).toEqual([]);
  });
  it('asks verification again for a candidate it left without a verdict', async () => {
    const second = { ...finding, id: 'second', cause: 'second cause', title: 'Second' };
    const result = await runReview(request(), {
      source: source(),
      model: model([
        [text({ summary: 'Two candidates', findings: [finding, second] })],
        [read('verify')],
        [text({ verdicts: [{ id: finding.id, decision: 'confirm', reason: 'Reachable defect' }] })],
        [
          text({
            verdicts: [
              { id: finding.id, decision: 'confirm', reason: 'Reachable defect' },
              { id: second.id, decision: 'reject', reason: 'Guarded' },
            ],
          }),
        ],
      ]),
    });
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).not.toContain('VERIFICATION_INCOMPLETE');
    expect(result.verification?.map((v) => v.decision)).toEqual(['confirm', 'reject']);
  });
  it('leaves an unjudged candidate unresolved and drops a verdict for an unknown id', async () => {
    const second = { ...finding, id: 'second', cause: 'second cause' };
    const answer = [
      text({
        verdicts: [
          { id: finding.id, decision: 'confirm', reason: 'Reachable defect' },
          { id: 'not-a-candidate', decision: 'confirm', reason: 'Unknown id' },
        ],
      }),
    ];
    const result = await runReview(request(), {
      source: source(),
      // The incomplete answer is sent back three times before it is accepted as partial.
      model: model([
        [text({ summary: 'Two candidates', findings: [finding, second] })],
        [read('verify')],
        ...Array(4).fill(answer),
      ]),
    });
    expect(result.findings).toEqual([finding]);
    expect(result.verification).toEqual([
      { id: finding.id, decision: 'confirm', reason: 'Reachable defect', evidence: [] },
      { id: second.id, decision: 'unresolved', reason: 'No verdict returned', evidence: [] },
    ]);
    expect(result.coverage.gaps).toContain('VERIFICATION_INCOMPLETE');
    expect(result.status).toBe('incomplete');
  });
  it('leaves an unjudged previous finding unresolved instead of ending the run', async () => {
    const result = await runReview(request(), {
      source: source(),
      previousFindings: [finding],
      // An empty verdict list is sent back three times before it is accepted as partial.
      model: model([[text({ summary: 'No new defects', findings: [] })], ...Array(4).fill([text({ verdicts: [] })])]),
    });
    expect(result.rechecks).toEqual([
      { id: finding.id, decision: 'unresolved', reason: 'No verdict returned', evidence: [] },
    ]);
    expect(result.coverage.gaps).toContain('RECHECK_INCOMPLETE');
    expect(result.coverage.gaps).toContain('PREVIOUS_FINDING_UNRESOLVED');
  });
  it.each([
    ['temperature', 'MODEL_SAMPLING_UNSUPPORTED'],
    ['logprobs', 'MODEL_FEATURE_UNSUPPORTED'],
  ])('classifies an unsupported %s warning as %s', async (feature, gap) => {
    const warned = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [text({ summary: 'No defects', findings: [] })],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [{ type: 'unsupported', feature }],
      }),
    });
    const result = await runReview(request({ model: { ...request().model, temperature: 0 } }), {
      source: source(),
      model: warned,
    });
    expect(result.coverage.gaps).toContain(gap);
    // Only refused sampling controls invalidate the review itself.
    expect(result.coverage.gaps).toContain(gap === 'MODEL_SAMPLING_UNSUPPORTED' ? gap : 'SOURCE_NOT_INSPECTED');
  });
  it('offers no shell, fetch, github, write or raw graph tool', async () => {
    const result = await runReview(request(), {
      source: source(),
      model: model([[text({ summary: 'No defects', findings: [] })]], (options) => {
        // The router is deliberately tool-less; every investigating call offers exactly these three.
        const tools = (options as { tools?: Array<{ name: string }> }).tools;
        if (tools) expect(tools.map((x) => x.name).sort()).toEqual(['list_source', 'read_source', 'search_source']);
      }),
    });
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toEqual(['SOURCE_NOT_INSPECTED']);
  });
  it('records a failed graph treatment and reviews the source without graph_lookup', async () => {
    const offered: unknown[] = [];
    const result = await runReview(
      request({
        arm: 'B',
        graph: { url: 'https://example.invalid/mcp', scope: 'repo', repoName: 'repo', locallyPreparedBase: false },
      }),
      {
        source: source(true),
        model: model([[read('inspect')], [text({ summary: 'Guard handles this', findings: [] })]], (o) =>
          offered.push(((o as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name)),
        ),
      },
    );
    expect(result.arm).toBe('B');
    expect(result.status).toBe('incomplete');
    expect(result.graph).toMatchObject({ status: 'failed', admissibility: 'diagnostic', reason: 'GRAPH_UNAVAILABLE' });
    expect(result.coverage.gaps).toEqual(['GRAPH_UNAVAILABLE']);
    expect(result.usage.steps).toBe(3);
    expect(offered[0]).not.toContain('graph_lookup');
  });
  it('sends one byte-identical prefix to the router, every lens and verification', async () => {
    const prefixes: string[] = [];
    const result = await runReview(request(), {
      source: source(),
      model: dispatch({
        route: { lenses: [{ id: 'data-safety', reason: 'touches sql', focusFiles: ['src/a.ts'] }] },
        lens: (id, n) =>
          n === 1 ? [read(`${id}-read`)] : [text({ summary: id, findings: id === 'logic' ? [finding] : [] })],
        verify: () => [text({ verdicts: [{ id: 'logic-division', decision: 'reject', reason: 'Guarded' }] })],
        before: (options) => prefixes.push(firstUser(options)),
      }),
    });
    expect(result.status).toBe('completed');
    // The router, two calls per lens and verification: one prefix, sent seven times unchanged.
    expect(prefixes).toHaveLength(6);
    expect(new Set(prefixes).size).toBe(1);
    expect(JSON.parse(prefixes[0]!)).toMatchObject({
      revision: { headSha: head },
      changedFiles: [{ path: 'src/a.ts' }],
      diff: [{ path: 'src/a.ts' }],
    });
    expect(result.verification.map((v) => v.id)).toEqual(['logic-division']);
  });
  it('runs the lenses the router chose, always adds logic and drops unknown ids', async () => {
    const result = await runReview(request(), {
      source: twoFiles(),
      model: dispatch({
        route: {
          lenses: [
            { id: 'not-a-lens', reason: 'invented', focusFiles: [] },
            { id: 'data-safety', reason: 'touches sql', focusFiles: ['src/b.ts', 'src/never-changed.ts'] },
          ],
        },
        lens: (id, n) =>
          n <= 2 ? [readFile(`${id}-${n}`, n === 1 ? 'src/a.ts' : 'src/b.ts')] : [text({ summary: id, findings: [] })],
      }),
    });
    expect(result.status).toBe('completed');
    expect(result.coverage.lenses).toEqual([
      { id: 'logic', reason: 'Always reviewed', focusFiles: [], steps: 3, candidates: 0 },
      { id: 'data-safety', reason: 'touches sql', focusFiles: ['src/b.ts'], steps: 3, candidates: 0 },
    ]);
    expect(result.modelCalls?.filter((c) => c.lens === 'data-safety')).toHaveLength(3);
    expect(renderReview(result)).toContain('touches sql');
  });
  it('holds a focused lens to its own reads even when a sibling lens already read the file', async () => {
    const result = await runReview(request({ limits: { ...request().limits, maxParallelLenses: 1 } }), {
      source: source(),
      model: dispatch({
        route: { lenses: [{ id: 'data-safety', reason: 'touches sql', focusFiles: ['src/a.ts'] }] },
        // logic reads src/a.ts first; data-safety answers without reading and must be sent back.
        lens: (id, n) =>
          id === 'logic'
            ? n === 1
              ? [read('logic')]
              : [text({ summary: 'no defects', findings: [] })]
            : n === 2
              ? [read('data-safety')]
              : [text({ summary: 'no defects', findings: [] })],
      }),
    });
    expect(result.status).toBe('completed');
    expect(result.coverage.gaps).not.toContain('SOURCE_COVERAGE_PARTIAL');
    expect(result.coverage.lenses?.find((l) => l.id === 'data-safety')?.steps).toBe(3);
  });
  it('continues with the logic lens alone when the router cannot answer', async () => {
    const result = await runReview(request(), {
      source: source(),
      model: dispatch({
        // Invalid for the router schema on both the answer and its one repair call.
        route: { summary: 'I reviewed it myself', findings: [] },
        lens: (id, n) => (n === 1 ? [read(id)] : [text({ summary: 'no defects', findings: [] })]),
      }),
    });
    expect(result.coverage.gaps).toContain('ROUTER_UNAVAILABLE');
    expect(result.status).toBe('incomplete');
    expect(result.coverage.lenses?.map((l) => l.id)).toEqual(['logic']);
    expect(result.modelCalls?.filter((c) => c.phase === 'router')).toHaveLength(2);
    // The candidate ids of a single lens are left exactly as the model returned them.
    expect(renderReview(result)).toContain('The lens router did not return a usable answer');
  });
  it('runs lenses concurrently up to maxParallelLenses', async () => {
    let inFlight = 0;
    let peak = 0;
    let release: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await runReview(request({ limits: { ...request().limits, maxLenses: 3, maxParallelLenses: 2 } }), {
      source: source(),
      model: dispatch({
        route: {
          lenses: [
            { id: 'data-safety', reason: 'sql', focusFiles: [] },
            { id: 'concurrency', reason: 'async', focusFiles: [] },
          ],
        },
        lens: (id, n) => (n === 1 ? [read(id)] : [text({ summary: id, findings: [] })]),
        before: async (_options, kind) => {
          if (kind !== 'lens') return;
          peak = Math.max(peak, ++inFlight);
          if (inFlight >= 2) release!();
          // Held until a sibling lens is in flight too; a sequential pool times out here instead.
          await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 1000))]);
          inFlight--;
        },
      }),
    });
    expect(result.status).toBe('completed');
    expect(result.coverage.lenses?.map((l) => l.id)).toEqual(['logic', 'data-safety', 'concurrency']);
    // Three lenses, two in flight: the guard holds the third until one of them finishes.
    expect(peak).toBe(2);
  });
  it('splits the discovery step budget between the lenses and keeps the global ceiling', async () => {
    const result = await runReview(request({ limits: { ...request().limits, maxSteps: 9 } }), {
      source: source(),
      model: dispatch({
        route: { lenses: [{ id: 'ui', reason: 'renders', focusFiles: [] }] },
        // Both lenses keep reading; each one may only spend its own share of the steps.
        lens: (id, n) => [read(`${id}-${n}`)],
      }),
    });
    // 9 steps less 3 reserved for verification, less the router call, split over two lenses.
    expect(result.usage.steps).toBe(5);
    expect(result.coverage.lenses?.map((l) => l.failed)).toEqual(['STEP_LIMIT', 'STEP_LIMIT']);
    expect(result.coverage.gaps).toContain('LENS_FAILED');
    expect(result.coverage.gaps).toContain('STEP_LIMIT');
  });
  it('keeps one lens candidates when another lens cannot answer', async () => {
    const result = await runReview(request(), {
      source: source(),
      model: dispatch({
        route: { lenses: [{ id: 'trust-boundary', reason: 'auth', focusFiles: [] }] },
        lens: (id, n) => {
          if (id === 'trust-boundary') return [{ type: 'text', text: 'NOT_JSON_AT_ALL' }];
          return n === 1 ? [read(id)] : [text({ summary: id, findings: [finding] })];
        },
        verify: (n) =>
          n === 1
            ? [read('verify')]
            : [text({ verdicts: [{ id: 'logic-division', decision: 'confirm', reason: 'Reachable defect' }] })],
      }),
    });
    expect(result.findings).toEqual([{ ...finding, id: 'logic-division' }]);
    expect(result.coverage.gaps).toContain('LENS_FAILED');
    expect(result.coverage.lenses).toEqual([
      { id: 'logic', reason: 'Always reviewed', focusFiles: [], steps: 2, candidates: 1 },
      {
        id: 'trust-boundary',
        reason: 'auth',
        focusFiles: [],
        steps: 2,
        candidates: 0,
        failed: 'MODEL_OUTPUT_INVALID',
      },
    ]);
    expect(renderReview(result)).toContain('MODEL\\_OUTPUT\\_INVALID');
  });
  it('keeps one lens candidates when another lens is lost to a provider rate limit', async () => {
    const result = await runReview(request(), {
      source: source(),
      model: dispatch({
        route: { lenses: [{ id: 'data-safety', reason: 'sql', focusFiles: [] }] },
        lens: (id, n) => {
          // The transport has already waited out its back-off ladder before it gives up on this lens.
          if (id === 'data-safety' && n === 2) throw new ReviewError('OPENROUTER_HTTP_429');
          return n === 1 ? [read(id)] : [text({ summary: id, findings: [finding] })];
        },
        verify: (n) =>
          n === 1
            ? [read('verify')]
            : [text({ verdicts: [{ id: 'logic-division', decision: 'confirm', reason: 'Reachable defect' }] })],
      }),
    });
    expect(result.findings).toEqual([{ ...finding, id: 'logic-division' }]);
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('LENS_FAILED');
    expect(result.coverage.gaps).toContain('OPENROUTER_HTTP_429');
    expect(result.coverage.lenses?.map((l) => l.failed)).toEqual([undefined, 'OPENROUTER_HTTP_429']);
  });
  it('keeps two lenses that reuse the same model-local id apart, then dedupes by root cause', async () => {
    const result = await runReview(request(), {
      source: source(),
      model: dispatch({
        route: { lenses: [{ id: 'data-safety', reason: 'sql', focusFiles: [] }] },
        lens: (id, n) => (n === 1 ? [read(id)] : [text({ summary: id, findings: [{ ...finding, id: 'f1' }] })]),
        verify: (n) =>
          n === 1
            ? [read('verify')]
            : [
                text({
                  verdicts: ['logic-f1', 'data-safety-f1'].map((id) => ({
                    id,
                    decision: 'confirm',
                    reason: 'Reachable defect',
                  })),
                }),
              ],
      }),
    });
    // Both candidates are judged; the second is dropped as the same root cause, not as the same id.
    expect(result.verification.map((v) => v.id)).toEqual(['logic-f1', 'data-safety-f1']);
    expect(result.coverage.gaps).not.toContain('DUPLICATE_CANDIDATE_ID');
    expect(result.findings.map((f) => f.id)).toEqual(['logic-f1']);
  });
  it('records the lens and the cached prompt tokens of every model call', async () => {
    const events: ModelCallDiagnostic[] = [];
    await runReview(request(), {
      source: source(),
      onModelCall: (event) => events.push(event),
      model: dispatch({
        route: { lenses: [{ id: 'ui', reason: 'renders', focusFiles: [] }] },
        lens: (id, n) => (n === 1 ? [read(id)] : [text({ summary: id, findings: [] })]),
      }),
    });
    expect(events[0]).toMatchObject({ phase: 'router', cachedInputTokens: 40 });
    expect(events[0]!.lens).toBeUndefined();
    expect(new Set(events.slice(1).map((e) => e.lens))).toEqual(new Set(['logic', 'ui']));
    expect(events.every((e) => e.cachedInputTokens === 40)).toBe(true);
  });
  it('reports cancellation before any paid work', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await runReview(request(), { source: source(), model: model([]), signal: ctrl.signal });
    expect(result.status).toBe('cancelled');
    expect(result.usage.steps).toBe(0);
  });
  it.each([
    ['prospective', false, 'primary'],
    ['historical', false, 'diagnostic'],
    ['historical', true, 'primary'],
  ] as const)('records %s graph admission with prepared base=%s', async (mode, locallyPreparedBase, admissibility) => {
    const pinned = source();
    pinned.distance = async () => ({ relation: 'equal', ahead: 0, behind: 0, source: 'api' });
    const result = await runReview(
      request({
        mode,
        arm: 'B',
        graph: { url: 'https://example.invalid/mcp', scope: 'repo', repoName: 'repo', locallyPreparedBase },
      }),
      {
        source: pinned,
        model: model([[text({ summary: 'No candidate', findings: [] })]]),
        graph: {
          snapshot: async () => ({
            commit: base,
            snapshotId: 'parse:fixture',
            parsedAt: '2026-09-16',
            capturedAt: '2026-09-16',
          }),
          query: async () => ({}),
          close: async () => undefined,
        },
      },
    );
    expect(result.graph?.admissibility).toBe(admissibility);
    expect(result.graph?.distance.source).toBe('api');
    expect(result.arm).toBe('B');
  });
});

/** The Agent SDK is stubbed: the Claude runtime is driven by a fake `query`, never a real process. */
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

// biome-ignore lint/suspicious/noExplicitAny: the fake stands in for the SDK's loosely typed options
type ClaudeOptions = Record<string, any>;
type ClaudeKind = 'router' | 'lens' | 'verify' | 'recheck' | 'nudge';
type ClaudeTools = Record<string, (args: unknown) => Promise<{ content: Array<{ text: string }> }>>;
const claudeTools = (options: ClaudeOptions): ClaudeTools =>
  Object.fromEntries(
    (
      (options.mcpServers?.['coredoc-review']?.tools ?? []) as Array<{ name: string; handler: ClaudeTools[string] }>
    ).map((t) => [t.name, t.handler]),
  );
/** Which phase a prompt belongs to: the task JSON is the prompt's last line, a nudge is plain text. */
function claudeKind(prompt: string): ClaudeKind {
  try {
    const task = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as Record<string, unknown>;
    if (task.lenses) return 'router';
    if (task.lens) return 'lens';
    if (task.candidates) return 'verify';
    return 'recheck';
  } catch {
    return 'nudge';
  }
}
/**
 * A fake Claude Code runtime: one init, one assistant turn and one result per query. The handler
 * may call the host's MCP tools, which run in-process exactly as they do under the real runtime.
 */
function claudeQuery(
  handler: (kind: ClaudeKind, tools: ClaudeTools) => Promise<Record<string, unknown> | { error: string }>,
) {
  const kinds: ClaudeKind[] = [];
  const query = ((params: { prompt: string; options: ClaudeOptions }) => {
    const options = params.options;
    const kind = claudeKind(params.prompt);
    kinds.push(kind);
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
      const output = await handler(kind, claudeTools(options));
      if ('error' in output && typeof output.error === 'string') {
        yield { type: 'assistant', session_id: 's1', message: { content: [] }, error: output.error };
        return;
      }
      yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'ok' }] } };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 's1',
        permission_denials: [],
        usage: { input_tokens: 10, output_tokens: 4 },
        structured_output: output,
      };
    })();
  }) as unknown as ClaudeQuery;
  return { query, kinds };
}
const claudeRequest = () => request({ model: { provider: 'claude-code', id: 'sonnet' } });
const claudeOptions = (query: ClaudeQuery) => ({ model: 'sonnet', env: { PATH: '/usr/bin' }, query });
const readEvidence = (tools: ClaudeTools) =>
  tools.read_source!({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 1 });

describe('claude code runtime end to end', () => {
  it('records the subscription runtime in the configuration', async () => {
    const { query } = claudeQuery(async (kind) =>
      kind === 'router' ? { lenses: [] } : { summary: 'No candidate', findings: [] },
    );
    const result = await runReview(claudeRequest(), { source: source(), claudeCode: claudeOptions(query) });
    expect(result.configuration.runtime).toBe('claude-agent-sdk');
    expect(result.configuration.auth).toBe('subscription');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it('refuses the run when no runtime options are supplied', async () => {
    const result = await runReview(claudeRequest(), { source: source() });
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('CLAUDE_RUNTIME_UNAVAILABLE');
    expect(result.findings).toEqual([]);
  });

  it('refuses an AI SDK run with no model instead of calling the provider with none', async () => {
    const result = await runReview(request(), { source: source() });
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('MODEL_CREDENTIAL_MISCONFIGURED');
    expect(result.findings).toEqual([]);
  });

  it('publishes a finding whose evidence was read through the host tools in the phase', async () => {
    const { query } = claudeQuery(async (kind, tools) => {
      if (kind === 'router') return { lenses: [] };
      if (kind === 'lens') return { summary: 'Change', findings: [finding] };
      await readEvidence(tools);
      return {
        verdicts: [{ id: 'division', decision: 'confirm', reason: 'reproduced', evidence: [] }],
      };
    });
    const result = await runReview(claudeRequest(), { source: source(), claudeCode: claudeOptions(query) });
    expect(result.findings.map((f) => f.id)).toEqual(['division']);
    expect(result.coverage.read).toContain('head:src/a.ts');
  });

  it('rejects a candidate whose evidence was never read through read_source', async () => {
    const { query } = claudeQuery(async (kind) => {
      if (kind === 'router') return { lenses: [] };
      if (kind === 'lens') return { summary: 'Change', findings: [finding] };
      return {
        verdicts: [{ id: 'division', decision: 'confirm', reason: 'looks bad', evidence: [] }],
      };
    });
    const result = await runReview(claudeRequest(), { source: source(), claudeCode: claudeOptions(query) });
    expect(result.findings).toEqual([]);
    expect(result.coverage.gaps).toContain('EVIDENCE_NOT_READ_THIS_PHASE');
  });

  it('ends the run on an exhausted plan and writes no recheck verdict', async () => {
    const other: Finding = { ...finding, id: 'other' };
    const { query, kinds } = claudeQuery(async (kind, tools) => {
      if (kind === 'router') return { lenses: [] };
      if (kind === 'lens') return { summary: 'Change', findings: [finding] };
      if (kind === 'verify') {
        await readEvidence(tools);
        return {
          verdicts: [
            {
              id: 'division',
              decision: 'reject',
              reason: 'already fixed',
              evidence: [{ path: 'src/a.ts', revision: 'head', startLine: 1, endLine: 1, excerpt: bad }],
            },
          ],
        };
      }
      // The plan window closes in the recheck phase, after a recheck verdict was already produced.
      return { error: 'rate_limit' };
    });
    const result = await runReview(claudeRequest(), {
      source: source(),
      claudeCode: claudeOptions(query),
      previousFindings: [finding, other],
    });
    expect(kinds).toContain('recheck');
    expect(result.status).toBe('incomplete');
    expect(result.coverage.gaps).toContain('SUBSCRIPTION_PLAN_EXHAUSTED');
    expect(result.coverage.gaps).not.toContain('LENS_FAILED');
    expect(result.findings).toEqual([]);
    expect(result.rechecks ?? []).toEqual([]);
  });

  it('never treats a rejected credential inside a lens as a recoverable lens failure', async () => {
    const { query } = claudeQuery(async (kind) =>
      kind === 'router' ? { lenses: [] } : { error: 'authentication_failed' },
    );
    const result = await runReview(claudeRequest(), { source: source(), claudeCode: claudeOptions(query) });
    expect(result.coverage.gaps).toContain('SUBSCRIPTION_CREDENTIAL_REJECTED');
    expect(result.coverage.gaps).not.toContain('LENS_FAILED');
    expect(result.findings).toEqual([]);
  });
});
