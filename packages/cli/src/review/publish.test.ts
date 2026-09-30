import { describe, expect, it } from 'vitest';
import { requestSchema, type Finding, type ReviewResult } from './contracts.js';
import { previousFindings, publishReview, type PublishApi } from './publish.js';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const request = requestSchema.parse({
  schemaVersion: 1,
  repository: 'owner/repo',
  pullNumber: 1,
  baseSha: base,
  headSha: head,
  mergeBaseSha: base,
  mode: 'prospective',
  arm: 'A',
  policy: { version: 'test', text: '' },
  model: { provider: 'openai', id: 'test' },
});
const finding: Finding = {
  id: 'division',
  cause: 'division by zero',
  severity: 'P1',
  title: 'Invalid divisor',
  trigger: 'Call divide(2)',
  impact: 'Returns Infinity',
  changedCode: 'Divisor is zero',
  existingHandling: 'No guard',
  anchor: { path: 'src/a.ts', revision: 'head', line: 1 },
  evidence: [{ path: 'src/a.ts', revision: 'head', startLine: 1, endLine: 1, excerpt: 'return n / 0;' }],
};
function result(findings = [finding]): ReviewResult {
  return {
    schemaVersion: 1,
    runId: 'test',
    revision: { repository: request.repository, pullNumber: 1, baseSha: base, headSha: head, mergeBaseSha: base },
    mode: 'prospective',
    arm: 'A',
    status: 'completed',
    summary: findings.length ? 'Verified finding' : 'No new findings',
    findings,
    verification: [],
    configuration: {
      runtime: 'ai-sdk-6',
      model: request.model,
      policyVersion: 'test',
      policyDigest: 'test',
      promptVersion: 'test',
      runnerVersion: base,
      limits: request.limits,
      unsupportedSampling: [],
    },
    coverage: { changed: ['src/a.ts'], read: [], excluded: [], gaps: [] },
    graph: null,
    usage: {
      steps: 1,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      costUsd: null,
      costKind: 'unknown',
    },
  };
}
type Comment = { id: number; body: string; user: { login: string; type: string }; in_reply_to_id?: number };
class Github implements PublishApi {
  repository = 'owner/repo';
  comments: Comment[] = [];
  summaries: Comment[] = [];
  calls: Array<{ method: string; path: string; body: { body: string; comments: Array<{ body: string }> } }> = [];
  head = head;
  base = base;
  state = 'open';
  path = 'src/a.ts';
  previousPath: string | undefined;
  patch = '@@ -1 +1 @@\n-return n / 2;\n+return n / 0;';
  uncertain = false;
  reject = false;
  afterWrite?: () => void;
  resolved: string[] = [];
  async graphql(query: string, variables: Record<string, unknown>) {
    if (query.startsWith('mutation')) {
      this.resolved.push(String(variables.id));
      return {};
    }
    return {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: this.comments.map((c) => ({
              id: `T${c.id}`,
              isResolved: this.resolved.includes(`T${c.id}`),
              comments: { nodes: [{ databaseId: c.id }] },
            })),
          },
        },
      },
    };
  }
  async get(path: string) {
    if (path === '/pulls/1')
      return {
        number: 1,
        state: this.state,
        draft: false,
        head: { sha: this.head, repo: { full_name: this.repository } },
        base: { sha: this.base, repo: { full_name: this.repository } },
      };
    const all = path.startsWith('/pulls/1/comments?') ? this.comments : this.summaries;
    const page = Number(new URL(`https://example.test${path}`).searchParams.get('page'));
    return structuredClone(all.slice((page - 1) * 100, page * 100));
  }
  async compare() {
    return {
      files: [{ filename: this.path, previous_filename: this.previousPath, status: 'modified', patch: this.patch }],
    };
  }
  async distance() {
    return { relation: 'equal' as const, ahead: 0, behind: 0, source: 'api' as const };
  }
  async write(method: 'POST' | 'PATCH', path: string, body: { body: string; comments: Array<{ body: string }> }) {
    this.calls.push({ method, path, body });
    if (this.reject) throw new Error('rejected');
    const create = (text: string): Comment => ({
      id: this.comments.length + this.summaries.length + 1,
      body: text,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    });
    if (method === 'PATCH') {
      const id = Number(path.split('/').at(-1));
      [...this.comments, ...this.summaries].find((c) => c.id === id)!.body = body.body;
    } else if (path.endsWith('/reviews'))
      this.comments.push(...body.comments.map((c: { body: string }) => create(c.body)));
    else this.summaries.push(create(body.body));
    this.afterWrite?.();
    if (this.uncertain) throw new Error('connection lost after acceptance');
    return {};
  }
}
const enabled = async () => true;

describe('GitHub publication', () => {
  it('posts a COMMENT review at the captured head and converges without duplicate writes', async () => {
    const api = new Github();
    expect(await publishReview(request, result(), api, enabled)).toMatchObject({
      status: 'published',
      commentIds: [1],
    });
    expect(api.calls[0]!.body).toMatchObject({
      commit_id: head,
      event: 'COMMENT',
      comments: [{ path: 'src/a.ts', line: 1, side: 'RIGHT' }],
    });
    expect(await previousFindings(api, 1)).toEqual([{ ...finding, id: expect.stringMatching(/^prior_[a-f0-9]{64}$/) }]);
    expect((await publishReview(request, result(), api, enabled)).status).toBe('published');
    expect(api.calls).toHaveLength(2);
    expect(api.comments).toHaveLength(1);
    expect(api.summaries).toHaveLength(1);
  });
  it('counts candidates in the summary without naming the ones that were not published', async () => {
    const api = new Github();
    const next = result();
    next.candidates = [
      {
        id: 'division',
        lens: 'logic',
        severity: 'P1',
        title: finding.title,
        anchor: finding.anchor,
        verdict: 'confirm',
        outcome: 'published',
      },
      {
        id: 'naming',
        lens: 'logic',
        severity: 'P2',
        title: 'REJECTED_CANDIDATE_TITLE',
        anchor: finding.anchor,
        verdict: 'reject',
        outcome: 'rejected',
      },
      {
        id: 'stale',
        lens: 'contracts',
        severity: 'P1',
        title: 'DROPPED_CANDIDATE_TITLE',
        anchor: finding.anchor,
        verdict: 'unresolved',
        outcome: 'dropped',
        reason: 'EVIDENCE_EXCERPT_MISMATCH',
      },
    ];
    expect((await publishReview(request, next, api, enabled)).status).toBe('published');
    const summary = api.summaries[0]!.body;
    expect(summary).toContain('1 inline findings.');
    expect(summary).toContain('3 candidate(s): 1 published, 1 rejected, 0 unresolved, 1 dropped.');
    expect(summary).not.toContain('REJECTED_CANDIDATE_TITLE');
    expect(summary).not.toContain('DROPPED_CANDIDATE_TITLE');
    expect(summary).not.toContain('EVIDENCE_EXCERPT_MISMATCH');
  });
  it('does not rewrite an unchanged summary just because the Actions run id changed', async () => {
    const api = new Github();
    const previous = process.env.GITHUB_RUN_ID;
    try {
      process.env.GITHUB_RUN_ID = '1001';
      await publishReview(request, result(), api, enabled);
      expect(api.summaries[0]!.body).toContain('/actions/runs/1001');
      process.env.GITHUB_RUN_ID = '1002';
      const writes = api.calls.length;
      expect((await publishReview(request, result(), api, enabled)).status).toBe('published');
      expect(api.calls).toHaveLength(writes);
      expect(api.summaries).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_RUN_ID;
      else process.env.GITHUB_RUN_ID = previous;
    }
  });
  it('assigns distinct host-owned recheck IDs when different historical defects reused F1', async () => {
    const api = new Github();
    await publishReview(request, result([{ ...finding, id: 'F1' }]), api, enabled);
    await publishReview(
      request,
      result([{ ...finding, id: 'F1', cause: 'another defect', title: 'Another' }]),
      api,
      enabled,
    );
    const previous = await previousFindings(api, 1);
    expect(previous).toHaveLength(2);
    expect(new Set(previous.map((f) => f.id)).size).toBe(2);
    const next = result([]);
    next.rechecks = previous.map((f, index) => ({
      id: f.id,
      decision: index === 0 ? 'reject' : 'confirm',
      reason: 'Fresh source checked',
      evidence: f.evidence,
    }));
    expect((await publishReview(request, next, api, enabled)).status).toBe('published');
    expect(api.comments[0]!.body).toContain('No longer applies');
    expect(api.comments[1]!.body).toContain('Still applies');
  });
  it('retains the thread across a rename and line shift', async () => {
    const api = new Github();
    await publishReview(request, result(), api, enabled);
    api.path = 'src/renamed.ts';
    api.previousPath = 'src/a.ts';
    const next = result([{ ...finding, anchor: { ...finding.anchor, path: api.path, line: 3 } }]);
    expect((await publishReview(request, next, api, enabled)).commentIds).toEqual([1]);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain('src/renamed.ts#L3');
  });
  it('keeps the thread when the model rewords the cause but keeps the title on the same line', async () => {
    const api = new Github();
    await publishReview(request, result(), api, enabled);
    const next = result([{ ...finding, cause: 'the same defect, described differently' }]);
    expect((await publishReview(request, next, api, enabled)).commentIds).toEqual([1]);
    expect(api.comments).toHaveLength(1);
  });
  it('ignores forged markers and human replies and paginates bot comments', async () => {
    const api = new Github();
    await publishReview(request, result(), api, enabled);
    const bot = api.comments[0]!;
    api.comments = Array.from({ length: 100 }, (_, i) => ({
      ...bot,
      id: i + 10,
      user: { login: 'human', type: 'User' },
    }));
    api.comments.push({ ...bot, id: 120, in_reply_to_id: 1 }, { ...bot, id: 121 });
    expect(await previousFindings(api, 1)).toEqual([{ ...finding, id: expect.stringMatching(/^prior_[a-f0-9]{64}$/) }]);
    api.calls = [];
    await publishReview(request, result(), api, enabled);
    expect(api.calls.every((c) => !c.path.includes('/pulls/comments/'))).toBe(true);
  });
  it.each([
    'head',
    'base',
    'closed',
    'disabled',
    'mismatch',
  ] as const)('refuses stale or disabled writes: %s', async (kind) => {
    const api = new Github();
    const report = result();
    if (kind === 'head') api.head = 'c'.repeat(40);
    if (kind === 'base') api.base = 'c'.repeat(40);
    if (kind === 'closed') api.state = 'closed';
    if (kind === 'mismatch') report.revision.repository = 'different/repo';
    expect((await publishReview(request, report, api, async () => kind !== 'disabled')).status).not.toBe('published');
    expect(api.calls).toHaveLength(0);
  });
  it('reads back an uncertain accepted review and summary without repeating either POST', async () => {
    const api = new Github();
    api.uncertain = true;
    expect((await publishReview(request, result(), api, enabled)).status).toBe('published');
    expect(api.calls).toHaveLength(2);
    expect((await publishReview(request, result(), api, enabled)).status).toBe('published');
    expect(api.calls).toHaveLength(2);
  });
  it('stops after an uncertain missing write; the next run can recover', async () => {
    const api = new Github();
    api.reject = true;
    expect((await publishReview(request, result(), api, enabled)).status).toBe('partial');
    expect(api.calls).toHaveLength(1);
    api.reject = false;
    expect((await publishReview(request, result(), api, enabled)).status).toBe('published');
    expect(api.comments).toHaveLength(1);
  });
  it('stops when the head moves after an accepted batch, preserving its explicit old SHA', async () => {
    const api = new Github();
    api.afterWrite = () => {
      api.head = 'c'.repeat(40);
    };
    expect((await publishReview(request, result(), api, enabled)).status).toBe('superseded');
    expect(api.calls).toHaveLength(1);
    expect(api.comments[0]!.body).toContain(head);
    expect(api.summaries).toHaveLength(0);
  });
  it.each([
    'confirm',
    'reject',
    'unresolved',
  ] as const)('reconciles previous findings only with explicit rechecks: %s', async (decision) => {
    const api = new Github();
    await publishReview(request, result(), api, enabled);
    const next = result([]);
    next.rechecks = [
      {
        id: (await previousFindings(api, 1))[0]!.id,
        decision,
        reason: 'Fresh source checked',
        evidence: finding.evidence,
      },
    ];
    const publication = await publishReview(request, next, api, enabled);
    expect(publication.status).toBe('published');
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain(
      decision === 'reject' ? 'No longer applies' : decision === 'confirm' ? 'Still applies' : 'Not reverified',
    );
    expect(publication.commentIds).toEqual(decision === 'confirm' ? [1] : []);
    expect(api.resolved).toEqual(decision === 'reject' ? ['T1'] : []);
  });
  it('carries a fix prompt and a Codex link that survive fences and parentheses in the finding', async () => {
    const api = new Github();
    const hostile = { ...finding, title: 'Breaks (a) ```fence```', impact: 'Uses foo() twice' };
    await publishReview(request, result([hostile]), api, enabled);
    const body = api.comments[0]!.body;
    expect(body).toContain('<details><summary>Prompt to fix with AI</summary>\n\n`````text\n');
    expect(body).toContain('P1: Breaks (a) ``fence``\n');
    expect(body).toMatch(/\[Fix in Codex\]\(https:\/\/chatgpt\.com\/codex\/deeplink\?prompt=[^()\s]+\)\n/);
    expect(decodeURIComponent(/prompt=([^)\s]+)\)/.exec(body)![1]!)).toContain('Uses foo() twice');
  });
  it('leaves every earlier comment and thread untouched when a subscription failure cleared the rechecks', async () => {
    const api = new Github();
    await publishReview(request, result(), api, enabled);
    const before = structuredClone(api.comments);
    const next = result([]);
    next.status = 'incomplete';
    // The engine clears rechecks on SUBSCRIPTION_* so nothing is reinterpreted from a run that
    // never reached the source.
    next.rechecks = [];
    next.coverage.gaps = ['SUBSCRIPTION_PLAN_EXHAUSTED'];
    const publication = await publishReview(request, next, api, enabled);
    expect(publication.status).toBe('published');
    expect(api.comments).toEqual(before);
    expect(api.resolved).toEqual([]);
    // The single summary comment is updated in place; it is the only thing publication writes.
    expect(api.summaries).toHaveLength(1);
    expect(api.summaries[0]!.body).toContain('SUBSCRIPTION\\_PLAN\\_EXHAUSTED');
  });
  it('publishes verified findings from an incomplete run', async () => {
    const api = new Github();
    const report = result();
    report.status = 'incomplete';
    report.coverage.gaps = ['COMPARE_FILES_MAY_BE_TRUNCATED'];
    expect(await publishReview(request, report, api, enabled)).toMatchObject({
      status: 'published',
      commentIds: [1],
    });
    expect(api.comments).toHaveLength(1);
    expect(api.calls[0]!.body).toMatchObject({ comments: [{ path: 'src/a.ts', line: 1 }] });
    expect(api.summaries[0]!.body).toContain('incomplete');
  });
  it('reconciles rechecked previous findings on an incomplete run and leaves unverified ones alone', async () => {
    const api = new Github();
    await publishReview(request, result(), api, enabled);
    await publishReview(request, result([{ ...finding, cause: 'another defect', title: 'Other' }]), api, enabled);
    const [first] = await previousFindings(api, 1);
    const next = result([]);
    next.status = 'incomplete';
    next.coverage.gaps = ['FINDING_UNRESOLVED'];
    next.rechecks = [{ id: first!.id, decision: 'reject', reason: 'Fresh source checked', evidence: finding.evidence }];
    expect((await publishReview(request, next, api, enabled)).status).toBe('published');
    expect(api.comments[0]!.body).toContain('No longer applies');
    expect(api.resolved).toEqual(['T1']);
    expect(api.comments[1]!.body).not.toContain('Not reverified');
  });
  it('writes nothing when the run is cancelled before publication', async () => {
    const api = new Github();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await publishReview(request, result(), api, enabled, ctrl.signal)).toMatchObject({
      status: 'superseded',
      reason: 'PUBLICATION_CANCELLED',
      commentIds: [],
    });
    expect(api.calls).toHaveLength(0);
    expect(api.comments).toHaveLength(0);
    expect(api.summaries).toHaveLength(0);
  });
  it.each(['workflow', 'pull'])('writes nothing when cancelled during the pre-write %s check', async (stage) => {
    const api = new Github();
    const ctrl = new AbortController();
    const get = api.get.bind(api);
    let pullReads = 0;
    let workflowReads = 0;
    api.get = async (path) => {
      const reply = await get(path);
      if (path === '/pulls/1' && ++pullReads === 2 && stage === 'pull') ctrl.abort();
      return reply;
    };
    const liveEnabled = async () => {
      if (++workflowReads === 2 && stage === 'workflow') ctrl.abort();
      return true;
    };
    const publication = await publishReview(request, result(), api, liveEnabled, ctrl.signal);
    expect(ctrl.signal.aborted).toBe(true);
    expect(publication).toEqual({ status: 'superseded', reason: 'PUBLICATION_CANCELLED', commentIds: [] });
    expect(api.calls).toHaveLength(0);
    expect(api.comments).toHaveLength(0);
    expect(api.summaries).toHaveLength(0);
  });
  it.each([
    'incomplete',
    'cancelled',
  ] as const)('leaves prior finding comments untouched on a %s run, updating only the summary', async (status) => {
    const api = new Github();
    await publishReview(request, result(), api, enabled);
    const published = api.comments[0]!.body;
    const next = result([]);
    next.status = status;
    next.rechecks = [
      {
        id: (await previousFindings(api, 1))[0]!.id,
        // An incomplete run writes an explicit verdict; only an unresolved one leaves the thread alone.
        decision: status === 'incomplete' ? 'unresolved' : 'reject',
        reason: 'Claimed fix',
        evidence: finding.evidence,
      },
    ];
    api.calls = [];
    await publishReview(request, next, api, enabled);
    expect(api.comments[0]!.body).toBe(published);
    expect(api.comments[0]!.body).not.toContain('Claimed fix');
    expect(api.calls.every((c) => !c.path.includes('/pulls/comments/'))).toBe(true);
    expect(api.summaries[0]!.body).toContain(status);
  });
});
