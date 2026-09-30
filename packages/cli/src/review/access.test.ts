import { describe, expect, it } from 'vitest';
import { changedLines, ReviewAccess, ReviewBudget } from './access.js';
import { requestSchema, type SourceReader } from './contracts.js';

function access(content: string) {
  const request = requestSchema.parse({
    schemaVersion: 1,
    repository: 'owner/repo',
    pullNumber: 1,
    baseSha: 'a'.repeat(40),
    mergeBaseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    mode: 'historical',
    arm: 'A',
    policy: { version: 'test', text: '' },
    model: { provider: 'openai', id: 'test' },
  });
  const source: SourceReader = {
    list: async () => ({ items: [], gaps: [] }),
    read: async () => content,
    changes: async () => ({ items: [], gaps: [] }),
  };
  return new ReviewAccess(request, source, new ReviewBudget(request, new AbortController().signal), [], []);
}

describe('bounded source windows', () => {
  it('allows a whole-file request beyond EOF and returns exact source for evidence', async () => {
    const a = access('export function charge() {\n  return 1200;\n}\n');
    const result = await a.read('head', 'src/gateway.ts', 1, 200);
    expect(result).toMatchObject({ startLine: 1, endLine: 3, totalLines: 3 });
    expect(result.text).toBe('export function charge() {\n  return 1200;\n}');
    expect(
      await a.evidence({ revision: 'head', path: 'src/gateway.ts', startLine: 1, endLine: 3, excerpt: result.text }),
    ).toEqual({ valid: true, shift: 0 });
  });

  it.each([
    [1, 200],
    [200, 1],
  ])('clips a window (%s..%s) without admitting unseen evidence', async (startLine, endLine) => {
    const lines = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`);
    const a = access(lines.join('\n'));
    const result = await a.read('head', 'src/large.ts', startLine, endLine);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(120);
    expect(result.totalLines).toBe(130);
    expect(result.text.split('\n')).toHaveLength(120);
    const evidence = {
      revision: 'head' as const,
      path: 'src/large.ts',
      startLine: 125,
      endLine: 125,
      excerpt: 'line 125',
    };
    expect(await a.evidence(evidence)).toEqual({ valid: false, code: 'EVIDENCE_NOT_READ_THIS_PHASE' });
    await a.read('head', 'src/large.ts', 121, 240);
    expect(await a.evidence(evidence)).toEqual({ valid: true, shift: 0 });
  });

  it('distinguishes malformed intervals, unseen evidence and altered quotes without echoing source', async () => {
    const a = access('  actual source\nsecond line\n');
    const evidence = {
      revision: 'head' as const,
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      excerpt: '  actual source',
    };
    expect(await a.evidence({ ...evidence, endLine: 0 })).toEqual({ valid: false, code: 'EVIDENCE_RANGE_INVALID' });
    expect(await a.evidence(evidence)).toEqual({ valid: false, code: 'EVIDENCE_NOT_READ_THIS_PHASE' });
    await a.read('head', 'src/a.ts', 1, 2);
    expect(await a.evidence({ ...evidence, excerpt: 'actual source' })).toEqual({
      valid: false,
      code: 'EVIDENCE_EXCERPT_MISMATCH',
    });
    expect(await a.evidence(evidence)).toEqual({ valid: true, shift: 0 });
    a.resetEvidence();
    expect(await a.evidence(evidence)).toEqual({ valid: false, code: 'EVIDENCE_NOT_READ_THIS_PHASE' });
  });

  it('relocates a miscounted quote that occurs exactly once inside a read window', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const a = access(`${lines.join('\n')}\n`);
    await a.read('head', 'src/a.ts', 1, 20);
    const evidence = {
      revision: 'head' as const,
      path: 'src/a.ts',
      startLine: 7,
      endLine: 8,
      excerpt: 'line 10\nline 11',
    };
    expect(await a.evidence(evidence)).toEqual({ valid: true, shift: 3 });
    expect(evidence).toMatchObject({ startLine: 10, endLine: 11 });
  });

  it('refuses a relocated quote that falls outside the window read in this phase', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const a = access(`${lines.join('\n')}\n`);
    await a.read('head', 'src/a.ts', 1, 9);
    expect(
      await a.evidence({ revision: 'head', path: 'src/a.ts', startLine: 7, endLine: 8, excerpt: 'line 10\nline 11' }),
    ).toEqual({ valid: false, code: 'EVIDENCE_NOT_READ_THIS_PHASE' });
  });

  it('refuses a quote whose location is ambiguous or absent', async () => {
    const a = access('alpha\nrepeated\nbeta\nrepeated\n');
    await a.read('head', 'src/a.ts', 1, 4);
    expect(
      await a.evidence({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 1, excerpt: 'repeated' }),
    ).toEqual({ valid: false, code: 'EVIDENCE_EXCERPT_AMBIGUOUS' });
    expect(
      await a.evidence({ revision: 'head', path: 'src/a.ts', startLine: 1, endLine: 1, excerpt: 'gamma' }),
    ).toEqual({
      valid: false,
      code: 'EVIDENCE_EXCERPT_MISMATCH',
    });
  });

  it('preserves a real blank final line while excluding the terminal line delimiter', async () => {
    const a = access('first\n\n');
    expect(await a.read('head', 'src/a.ts', 1, 120)).toMatchObject({ text: 'first\n', endLine: 2, totalLines: 2 });
  });

  it.each([
    // An absent quote is reported as a mismatch; a locatable one is still unread in this phase.
    ['line', 2, 1, 'EVIDENCE_NOT_READ_THIS_PHASE'],
    ['', 1, 0, 'EVIDENCE_EXCERPT_MISMATCH'],
  ] as const)('returns explicit EOF without admitting evidence (%s)', async (content, startLine, totalLines, code) => {
    const a = access(content);
    expect(await a.read('head', 'src/a.ts', startLine, 200)).toMatchObject({
      eof: true,
      text: '',
      startLine: null,
      endLine: null,
      totalLines,
    });
    expect(a.readPaths.size).toBe(0);
    expect(
      await a.evidence({
        revision: 'head',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        excerpt: content || 'invented',
      }),
    ).toEqual({ valid: false, code });
  });
  it('still refuses non-positive ranges', async () => {
    const a = access('line');
    await expect(a.read('head', 'src/a.ts', 1, 0)).rejects.toThrow('SOURCE_RANGE_INVALID');
    await expect(a.read('head', 'src/a.ts', 0, 1)).rejects.toThrow('SOURCE_RANGE_INVALID');
  });
});

describe('budget attribution', () => {
  function budget(maxSeconds: number, signal: AbortSignal) {
    const request = requestSchema.parse({
      schemaVersion: 1,
      repository: 'owner/repo',
      pullNumber: 1,
      baseSha: 'a'.repeat(40),
      mergeBaseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      mode: 'historical',
      arm: 'A',
      policy: { version: 'test', text: '' },
      model: { provider: 'openai', id: 'test' },
      limits: { maxSeconds },
    });
    return new ReviewBudget(request, signal);
  }
  it('reports the time limit rather than cancellation when the timeout aborted the signal', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // The engine merges its timeout into the same signal, so an expired budget must not read as cancelled.
    expect(() => budget(1, ctrl.signal).check()).toThrow('CANCELLED');
    const expired = budget(1, ctrl.signal);
    Object.assign(expired, { started: Date.now() - 2000 });
    expect(() => expired.check()).toThrow('TIME_LIMIT');
  });
});

describe('changed lines', () => {
  it('restarts line numbering at each file section instead of leaking the previous hunk', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '@@ -10,2 +10,2 @@',
      '-old a',
      '+new a',
      'diff --git a/src/b.ts b/src/b.ts',
      '+orphan without a hunk header',
      '@@ -40,2 +40,2 @@',
      '-old b',
      '+new b',
    ].join('\n');
    expect(changedLines(patch, 'head')).toEqual(new Set([10, 40]));
    expect(changedLines(patch, 'base')).toEqual(new Set([10, 40]));
  });
});
