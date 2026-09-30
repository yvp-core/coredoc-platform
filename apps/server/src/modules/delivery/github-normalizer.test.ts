import { describe, it, expect } from 'vitest';
import { CODE_CHANGE_NORM_VERSION, normalizePullRequest } from './github-normalizer.js';

/**
 * A realistic merged PR fixture that exercises every normalization rule:
 * - draft=false, merged_at set  -> state 'merged'
 * - review sequence COMMENTED -> CHANGES_REQUESTED -> APPROVED
 * - 2 files, 2 commits (2nd carries a Claude co-author trailer + Spec-Id trailer)
 * - head.ref carries an uppercase issue key (PROD-42)
 *
 * The diff-stat fields (commits/additions/deletions/changed_files/review_comments) here
 * are deliberate WRONG sentinels: the list endpoint that produces this shape never carries
 * them, so the normalizer must IGNORE them and read the diff stats from `mergedPrDetail`
 * (the single-PR GET) instead. If the normalizer regressed to reading the list object,
 * these sentinels would surface and fail the happy-path assertions.
 */
const mergedPr: Record<string, unknown> = {
  number: 42,
  title: 'Fix the thing for PROD-42',
  state: 'closed',
  draft: false,
  created_at: '2026-07-01T09:00:00Z',
  merged_at: '2026-07-01T12:00:00Z',
  closed_at: '2026-07-01T12:00:00Z',
  body: 'This resolves the flakiness.',
  user: { login: 'octodev' },
  head: { ref: 'PROD-42-fix-thing' },
  base: { ref: 'main' },
  commits: 999,
  additions: 999,
  deletions: 999,
  changed_files: 99,
  review_comments: 99,
};

/** The single-PR GET body — the ONLY authoritative source of the diff-stat counts. */
const mergedPrDetail: Record<string, unknown> = {
  commits: 2,
  additions: 30,
  deletions: 5,
  changed_files: 2,
  review_comments: 4,
  html_url: 'https://github.com/acme/widgets/pull/42',
  comments: 3,
};

const mergedReviews: unknown[] = [
  { state: 'COMMENTED', submitted_at: '2026-07-01T10:00:00Z' },
  { state: 'CHANGES_REQUESTED', submitted_at: '2026-07-01T10:30:00Z' },
  { state: 'APPROVED', submitted_at: '2026-07-01T11:00:00Z' },
];

const mergedFiles: unknown[] = [{ filename: 'src/app.ts' }, { filename: 'src/util.ts' }];

const mergedCommits: unknown[] = [
  { sha: 'a1', commit: { message: 'Initial work' } },
  {
    sha: 'b2',
    commit: {
      message: 'Finish it\n\nSpec-Id: SF-20260701-first-thing\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>',
    },
  },
];

describe('normalizePullRequest — merged PR happy path', () => {
  const n = normalizePullRequest(mergedPr, mergedReviews, mergedFiles, mergedCommits, mergedPrDetail)!;

  it('is not null', () => {
    expect(n).not.toBeNull();
  });

  it('maps identity + branches + counts (str/num passthrough)', () => {
    expect(n.externalId).toBe('42');
    expect(n.number).toBe(42);
    expect(n.title).toBe('Fix the thing for PROD-42');
    expect(n.sourceBranch).toBe('PROD-42-fix-thing');
    expect(n.targetBranch).toBe('main');
    expect(n.commitsCount).toBe(2);
    expect(n.additions).toBe(30);
    expect(n.deletions).toBe(5);
    expect(n.changedFiles).toBe(2);
    expect(n.attrs.authorLogin).toBe('octodev');
  });

  it('resolves merged state and draft flag', () => {
    expect(n.state).toBe('merged');
    expect(n.isDraft).toBe(false);
  });

  it('passes dates through as ISO strings (no parsing)', () => {
    expect(n.createdAtSource).toBe('2026-07-01T09:00:00Z');
    expect(n.mergedAt).toBe('2026-07-01T12:00:00Z');
    expect(n.closedAt).toBe('2026-07-01T12:00:00Z');
  });

  it('approximates readyForReviewAt as created_at for a non-draft PR', () => {
    expect(n.readyForReviewAt).toBe('2026-07-01T09:00:00Z');
  });

  it('derives firstReviewAt (min submitted_at) and approvedAt (max APPROVED)', () => {
    expect(n.firstReviewAt).toBe('2026-07-01T10:00:00Z');
    expect(n.approvedAt).toBe('2026-07-01T11:00:00Z');
  });

  it('computes reviewRounds v1 heuristic: CHANGES_REQUESTED count + 1 for other reviews', () => {
    expect(n.reviewRounds).toBe(2);
  });

  it('reads reviewComments numerically', () => {
    expect(n.reviewComments).toBe(4);
  });

  it('reads externalUrl/commentCount from prDetail and counts review SUBMISSIONS, not inline comments (A3)', () => {
    expect(n.externalUrl).toBe('https://github.com/acme/widgets/pull/42');
    expect(n.commentCount).toBe(3);
    // 3 review submissions in mergedReviews; the detail's review_comments (4 inline
    // comments) must NOT leak into this field — it renders as "N reviews".
    expect(n.reviewCount).toBe(3);
  });

  it('collects changedPaths from files[].filename', () => {
    expect(n.changedPaths).toEqual(['src/app.ts', 'src/util.ts']);
  });

  it('detects aiAssisted from a co-author trailer', () => {
    expect(n.aiAssisted).toBe(true);
  });

  it('extracts unique specIds from body + commit messages', () => {
    expect(n.attrs.specIds).toEqual(['SF-20260701-first-thing']);
  });

  it('extracts unique uppercase issueKeys from head.ref + title + body', () => {
    expect(n.attrs.issueKeys).toEqual(['PROD-42']);
  });
});

describe('normalizePullRequest — open draft PR', () => {
  const draftPr: Record<string, unknown> = {
    number: 7,
    title: 'WIP',
    state: 'open',
    draft: true,
    created_at: '2026-07-02T08:00:00Z',
    merged_at: null,
    body: '',
    head: { ref: 'feature/wip' },
    base: { ref: 'main' },
  };

  it('leaves readyForReviewAt undefined while draft and state open', () => {
    const n = normalizePullRequest(draftPr, [], [], [])!;
    expect(n).not.toBeNull();
    expect(n.state).toBe('open');
    expect(n.isDraft).toBe(true);
    expect(n.readyForReviewAt).toBeUndefined();
  });
});

describe('normalizePullRequest — closed (unmerged) PR', () => {
  it('maps state closed when pr.state closed and no merged_at', () => {
    const n = normalizePullRequest(
      { number: 8, state: 'closed', draft: false, closed_at: '2026-07-03T00:00:00Z' },
      [],
      [],
      [],
    )!;
    expect(n.state).toBe('closed');
    expect(n.mergedAt).toBeUndefined();
    expect(n.closedAt).toBe('2026-07-03T00:00:00Z');
  });
});

describe('normalizePullRequest — invalid input', () => {
  it('returns null when pr lacks a usable number', () => {
    expect(normalizePullRequest({ title: 'no number' }, [], [], [])).toBeNull();
    expect(normalizePullRequest({ number: 'nope' }, [], [], [])).toBeNull();
  });
});

describe('normalizePullRequest — hostile / tolerant coercion', () => {
  it('caps changedPaths at 300 entries and 512 chars each', () => {
    const longName = 'a'.repeat(400);
    const files = Array.from({ length: 350 }, (_, i) => ({ filename: `${longName}-${i}` }));
    const n = normalizePullRequest({ number: 1 }, [], files, [])!;
    expect(n.changedPaths).toHaveLength(300);
    for (const p of n.changedPaths) {
      expect(p.length).toBeLessThanOrEqual(512);
    }
  });

  it('does NOT invent phantom issueKeys from a lowercase branch (uppercase-only anchor)', () => {
    const n = normalizePullRequest(
      { number: 2, head: { ref: 'fix/react-18-upgrade' }, title: 'react 18 upgrade', body: '' },
      [],
      [],
      [],
    )!;
    expect(n.attrs.issueKeys).toEqual([]);
  });

  it('reports aiAssisted undefined when commits array is empty (unknown)', () => {
    const n = normalizePullRequest({ number: 3 }, [], [], [])!;
    expect(n.aiAssisted).toBeUndefined();
  });

  it('reports aiAssisted false when commits exist but none match', () => {
    const n = normalizePullRequest({ number: 4 }, [], [], [{ sha: 'x', commit: { message: 'plain human work' } }])!;
    expect(n.aiAssisted).toBe(false);
  });

  it('tolerates non-array reviews/files/commits (treated as [])', () => {
    const n = normalizePullRequest(
      { number: 5 },
      null as unknown as unknown[],
      undefined as unknown as unknown[],
      'nope' as unknown as unknown[],
    )!;
    expect(n.reviewRounds).toBe(0);
    expect(n.firstReviewAt).toBeUndefined();
    expect(n.approvedAt).toBeUndefined();
    expect(n.changedPaths).toEqual([]);
    expect(n.aiAssisted).toBeUndefined();
  });

  it('coerces non-string fields to undefined via str()', () => {
    const n = normalizePullRequest(
      { number: 6, title: 123, head: { ref: { nested: true } }, base: { ref: null } },
      [],
      [],
      [],
    )!;
    expect(n.title).toBeUndefined();
    expect(n.sourceBranch).toBeUndefined();
    expect(n.targetBranch).toBeUndefined();
  });

  it('caps title at 512 and branches at 256 chars', () => {
    const n = normalizePullRequest(
      {
        number: 9,
        title: 't'.repeat(600),
        head: { ref: 'h'.repeat(300) },
        base: { ref: 'b'.repeat(300) },
      },
      [],
      [],
      [],
    )!;
    expect(n.title).toHaveLength(512);
    expect(n.sourceBranch).toHaveLength(256);
    expect(n.targetBranch).toHaveLength(256);
  });

  it('dedupes and caps specIds at 10 entries', () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({
      commit: { message: `Spec-Id: SF-${i}` },
    }));
    // include a duplicate to prove dedupe
    messages.push({ commit: { message: 'Spec-Id: SF-0' } });
    const n = normalizePullRequest({ number: 10, body: '' }, [], [], messages)!;
    expect(n.attrs.specIds).toHaveLength(10);
    expect(new Set(n.attrs.specIds).size).toBe(10);
  });

  it('reviewRounds counts each CHANGES_REQUESTED plus one when a non-CR review exists', () => {
    const reviews = [
      { state: 'CHANGES_REQUESTED', submitted_at: '2026-07-01T10:00:00Z' },
      { state: 'CHANGES_REQUESTED', submitted_at: '2026-07-01T11:00:00Z' },
      { state: 'APPROVED', submitted_at: '2026-07-01T12:00:00Z' },
    ];
    const n = normalizePullRequest({ number: 11 }, reviews, [], [])!;
    expect(n.reviewRounds).toBe(3);
  });

  it('reviewRounds is just the CHANGES_REQUESTED count when no other review exists', () => {
    const reviews = [{ state: 'CHANGES_REQUESTED', submitted_at: '2026-07-01T10:00:00Z' }];
    const n = normalizePullRequest({ number: 12 }, reviews, [], [])!;
    expect(n.reviewRounds).toBe(1);
    expect(n.approvedAt).toBeUndefined();
  });
});

describe('normalizePullRequest — lastCommitAt capture', () => {
  it('is the max committer date across commits (ISO passthrough, no parsing)', () => {
    const commits = [
      { sha: 'a', commit: { committer: { date: '2026-07-01T10:00:00Z' } } },
      { sha: 'b', commit: { committer: { date: '2026-07-01T12:00:00Z' } } },
      { sha: 'c', commit: { committer: { date: '2026-07-01T11:00:00Z' } } },
    ];
    const n = normalizePullRequest({ number: 30 }, [], [], commits)!;
    expect(n.lastCommitAt).toBe('2026-07-01T12:00:00Z');
  });

  it('falls back to author.date per commit when committer.date is missing', () => {
    const commits = [
      { sha: 'a', commit: { author: { date: '2026-07-01T09:00:00Z' } } },
      { sha: 'b', commit: { committer: { date: '2026-07-01T08:00:00Z' }, author: { date: '2026-07-01T13:00:00Z' } } },
    ];
    // commit b has a committer date (08:00) that WINS over its own author date;
    // commit a contributes its author date (09:00). Max over the two = 09:00.
    const n = normalizePullRequest({ number: 31 }, [], [], commits)!;
    expect(n.lastCommitAt).toBe('2026-07-01T09:00:00Z');
  });

  it('is undefined when commits are empty or non-array', () => {
    expect(normalizePullRequest({ number: 32 }, [], [], [])!.lastCommitAt).toBeUndefined();
    expect(normalizePullRequest({ number: 33 }, [], [], 'nope' as unknown as unknown[])!.lastCommitAt).toBeUndefined();
  });

  it('is undefined when commits carry no usable dates', () => {
    const commits = [{ sha: 'a', commit: { message: 'no dates here' } }];
    const n = normalizePullRequest({ number: 34 }, [], [], commits)!;
    expect(n.lastCommitAt).toBeUndefined();
  });
});

describe('normalizePullRequest — spec-id vs issue-key disambiguation (F1)', () => {
  it('never leaks a Spec-Id prefix into issueKeys (trailer line in body + spec id in title)', () => {
    const n = normalizePullRequest(
      {
        number: 20,
        title: 'Implements SF-20260701-first-thing for PROD-42',
        body: 'Some context.\nSpec-Id: SF-20260701-first-thing\nmore text',
        head: { ref: 'feature/prod-42' },
      },
      [],
      [],
      [],
    )!;
    // Guard (a) strips the body trailer line; guard (b) drops SF-20260701 (a spec-id
    // prefix) that the title otherwise contributes. Only the real tracker key remains.
    expect(n.attrs.issueKeys).toEqual(['PROD-42']);
    expect(n.attrs.specIds).toEqual(['SF-20260701-first-thing']);
  });
});

describe('normalizePullRequest — coverage debt (F2)', () => {
  it('defaults reviewComments to 0 when review_comments is absent', () => {
    const n = normalizePullRequest({ number: 21 }, [], [], [])!;
    expect(n.reviewComments).toBe(0);
  });

  it('drops an over-long specId (>128 chars) rather than truncating it', () => {
    const longId = 'X'.repeat(129);
    const n = normalizePullRequest({ number: 22, body: `Spec-Id: ${longId}\nSpec-Id: SF-ok` }, [], [], [])!;
    expect(n.attrs.specIds).toEqual(['SF-ok']);
  });

  it('caps issueKeys at 10 in first-occurrence order', () => {
    const title = 'ABC-1 ABC-2 ABC-3 ABC-4 ABC-5 ABC-6';
    const body = 'ABC-7 ABC-8 ABC-9 ABC-10 ABC-11 ABC-12';
    const n = normalizePullRequest({ number: 23, title, body }, [], [], [])!;
    expect(n.attrs.issueKeys).toEqual([
      'ABC-1',
      'ABC-2',
      'ABC-3',
      'ABC-4',
      'ABC-5',
      'ABC-6',
      'ABC-7',
      'ABC-8',
      'ABC-9',
      'ABC-10',
    ]);
  });

  it('tolerates a numeric-string number (untrusted-input coercion)', () => {
    const n = normalizePullRequest({ number: '42' }, [], [], []);
    expect(n).not.toBeNull();
    expect(n!.externalId).toBe('42');
    expect(n!.number).toBe(42);
  });
});

describe('normalizePullRequest — v2 per-source issue keys (attrs.issueKeySources)', () => {
  it('records the HIGHEST-priority source for a key present in branch + body → branch', () => {
    const n = normalizePullRequest(
      { number: 40, head: { ref: 'PROD-42-fix' }, title: 'unrelated work', body: 'relates to PROD-42' },
      [],
      [],
      [],
    )!;
    expect(n.attrs.issueKeys).toEqual(['PROD-42']);
    expect(n.attrs.issueKeySources).toEqual({ 'PROD-42': 'branch' });
  });

  it('records source title for a key only in the title', () => {
    const n = normalizePullRequest(
      { number: 41, head: { ref: 'feature/wip' }, title: 'ships PROD-7', body: '' },
      [],
      [],
      [],
    )!;
    expect(n.attrs.issueKeys).toEqual(['PROD-7']);
    expect(n.attrs.issueKeySources).toEqual({ 'PROD-7': 'title' });
  });

  it('records source body for a body-only key', () => {
    const n = normalizePullRequest(
      { number: 42, head: { ref: 'feature/wip' }, title: 'no key here', body: 'fixes PROD-99' },
      [],
      [],
      [],
    )!;
    expect(n.attrs.issueKeys).toEqual(['PROD-99']);
    expect(n.attrs.issueKeySources).toEqual({ 'PROD-99': 'body' });
  });

  it('omits the sources map entirely when there are no issue keys', () => {
    const n = normalizePullRequest(
      { number: 43, head: { ref: 'feature/wip' }, title: 'nothing here', body: '' },
      [],
      [],
      [],
    )!;
    expect(n.attrs.issueKeys).toEqual([]);
    expect(n.attrs.issueKeySources).toBeUndefined();
  });

  it('exports CODE_CHANGE_NORM_VERSION === 10 (single source of truth)', () => {
    expect(CODE_CHANGE_NORM_VERSION).toBe(10);
  });
});

/**
 * The retired flow's `Coredoc-Run-Id` trailer remains a compatibility input beside
 * `Spec-Id` over the same body-plus-commit-messages corpus.
 */
const RUN_A = 'cdr-20260728-a1b2c3';
const RUN_B = 'cdr-20260728-0f0f0f';
const RUN_C = 'cdr-20260101-deadbe';

describe('normalizePullRequest — legacy Coredoc-Run-Id trailer capture', () => {
  it('captures Coredoc-Run-Id trailers from the body and every commit message, deduplicated', () => {
    const n = normalizePullRequest(
      { number: 60, body: `Ships the thing.\nCoredoc-Run-Id: ${RUN_A}`, head: { ref: 'feature/x' } },
      [],
      [],
      [
        { sha: 'a', commit: { message: `first\n\nCoredoc-Run-Id: ${RUN_B}` } },
        { sha: 'b', commit: { message: `second\n\nCoredoc-Run-Id: ${RUN_C}` } },
        { sha: 'c', commit: { message: `third\n\nCoredoc-Run-Id: ${RUN_A}` } }, // duplicate of the body's
      ],
    )!;
    expect(n.attrs.runIds).toEqual([RUN_A, RUN_B, RUN_C]);
    expect(n.attrs.runIdsPartial).toBeUndefined();
  });

  it('leaves Spec-Id capture byte-identical on a change carrying both trailers', () => {
    const withRun = normalizePullRequest(
      {
        number: 61,
        title: 'Implements SF-20260701-first-thing for PROD-42',
        body: `Context.\nSpec-Id: SF-20260701-first-thing\nCoredoc-Run-Id: ${RUN_A}\nfixes PROD-42`,
        head: { ref: 'PROD-42-fix' },
      },
      [],
      [],
      [{ sha: 'a', commit: { message: `work\n\nSpec-Id: SF-20260702-second\nCoredoc-Run-Id: ${RUN_B}` } }],
    )!;
    const withoutRun = normalizePullRequest(
      {
        number: 61,
        title: 'Implements SF-20260701-first-thing for PROD-42',
        body: 'Context.\nSpec-Id: SF-20260701-first-thing\nfixes PROD-42',
        head: { ref: 'PROD-42-fix' },
      },
      [],
      [],
      [{ sha: 'a', commit: { message: 'work\n\nSpec-Id: SF-20260702-second' } }],
    )!;
    expect(withRun.attrs.specIds).toEqual(withoutRun.attrs.specIds);
    expect(withRun.attrs.issueKeys).toEqual(withoutRun.attrs.issueKeys);
    expect(withRun.attrs.issueKeySources).toEqual(withoutRun.attrs.issueKeySources);
    // …and the independently captured run ids are here in the same output.
    expect(withRun.attrs.runIds).toEqual([RUN_A, RUN_B]);
  });

  it('caps the run id set at 50, keeping the first of them, and marks the set partial', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      commit: { message: `Coredoc-Run-Id: cdr-20260728-${i.toString(16).padStart(6, '0')}` },
    }));
    const n = normalizePullRequest({ number: 62, body: '' }, [], [], many)!;
    expect(n.attrs.runIds).toHaveLength(50);
    expect(n.attrs.runIds![0]).toBe('cdr-20260728-000000');
    expect(n.attrs.runIds).not.toContain('cdr-20260728-000032'); // the 51st, dropped by the cap
    expect(n.attrs.runIdsPartial).toBe(true);
  });

  it('drops an over-long Coredoc-Run-Id value rather than truncating it, keeping a well-formed one', () => {
    const overLong = `${RUN_A}${'f'.repeat(300)}`;
    const n = normalizePullRequest(
      { number: 63, body: `Coredoc-Run-Id: ${overLong}\nCoredoc-Run-Id: ${RUN_B}` },
      [],
      [],
      [],
    )!;
    expect(n.attrs.runIds).toEqual([RUN_B]);
  });

  it('omits attrs.runIds entirely when the change carries no Coredoc-Run-Id trailer', () => {
    const n = normalizePullRequest(
      { number: 64, title: 'plain work for PROD-42', body: 'nothing here', head: { ref: 'feature/plain' } },
      [],
      [],
      [{ sha: 'a', commit: { message: 'plain human work' } }],
    )!;
    // Absent — never an empty stub and never a default.
    expect(n.attrs.runIds).toBeUndefined();
    expect(n.attrs.runIdsPartial).toBeUndefined();
    // …and nothing else the previous normalization version produced has moved.
    expect(n).toEqual({
      externalId: '64',
      number: 64,
      title: 'plain work for PROD-42',
      sourceBranch: 'feature/plain',
      targetBranch: undefined,
      state: 'open',
      isDraft: false,
      createdAtSource: undefined,
      readyForReviewAt: undefined,
      firstReviewAt: undefined,
      approvedAt: undefined,
      mergedAt: undefined,
      closedAt: undefined,
      lastCommitAt: undefined,
      commitsCount: 1,
      additions: undefined,
      deletions: undefined,
      changedFiles: undefined,
      changedPaths: [],
      reviewRounds: 0,
      reviewComments: 0,
      reworkReviews: [],
      aiAssisted: false,
      // LIST-shaped pass: the detail-only trio stays undefined and the flag says why.
      detailShaped: false,
      attrs: {
        authorLogin: undefined,
        specIds: [],
        issueKeys: ['PROD-42'],
        issueKeySources: { 'PROD-42': 'title' },
      },
    });
  });

  it('strips the Coredoc-Run-Id trailer line from the body before the issue-key scan, as it strips Spec-Id', () => {
    const n = normalizePullRequest(
      {
        number: 65,
        title: 'no key here',
        body: `Coredoc-Run-Id: ${RUN_A} PROD-9\nfixes PROD-42`,
        head: { ref: 'feature/x' },
      },
      [],
      [],
      [],
    )!;
    // PROD-9 sat on the trailer line, so the whole-line strip took it with the trailer —
    // the same rule and expression the Spec-Id line obeys.
    expect(n.attrs.issueKeys).toEqual(['PROD-42']);
    expect(n.attrs.runIds).toEqual([RUN_A]);
  });

  // ── adversarial twins ────────────────────────────────────────────────────────
  // Each co-asserts the right capture PRESENT in the same output as the wrong one
  // ABSENT, per the spec's precision-first rule.

  it('captures Coredoc-Run-Id trailers from the body and every commit message, deduplicated__over_capture', () => {
    const n = normalizePullRequest(
      { number: 70, body: 'Coredoc-Run-Id: whatever-the-author-typed' },
      [],
      [],
      [
        { sha: 'a', commit: { message: 'Coredoc-Run-Id: cdr-2026-xyz' } }, // wrong date + non-hex
        { sha: 'b', commit: { message: 'Coredoc-Run-Id: CDR-20260728-A1B2C3' } }, // uppercase
        { sha: 'c', commit: { message: 'Coredoc-Run-Id: ../../etc/passwd' } }, // a path, not an id
        { sha: 'd', commit: { message: `Coredoc-Run-Id: ${RUN_A}` } }, // the one well-formed value
      ],
    )!;
    // Only the value the plugin's grammar admits — a trailer key is trusted for its
    // VALUE, never for its name, because this column steers a network fetch.
    expect(n.attrs.runIds).toEqual([RUN_A]);
  });

  it('omits attrs.runIds entirely when the change carries no Coredoc-Run-Id trailer__absent_vs_ambiguous', () => {
    const none = normalizePullRequest({ number: 71, body: 'no trailer at all' }, [], [], [])!;
    const one = normalizePullRequest({ number: 72, body: `Coredoc-Run-Id: ${RUN_A}` }, [], [], [])!;
    // A repository with no compatible run must be distinguishable from one that
    // emitted a run with no retained ids; absence avoids a fabricated zero.
    expect(none.attrs.runIds).toBeUndefined();
    expect(Object.hasOwn(none.attrs, 'runIds')).toBe(false);
    expect(one.attrs.runIds).toEqual([RUN_A]);
  });

  it('strips the Coredoc-Run-Id trailer line from the body before the issue-key scan, as it strips Spec-Id__collision', () => {
    const n = normalizePullRequest(
      {
        number: 73,
        title: 'no key here',
        // A value the grammar REFUSES, whose shape is exactly a tracker key. The
        // grammar's refusal means nothing is captured to filter issue keys by, so the
        // strip is the only thing standing between it and a phantom ticket.
        body: 'Coredoc-Run-Id: CDR-20260728\nfixes PROD-42',
        head: { ref: 'feature/x' },
      },
      [],
      [],
      [],
    )!;
    expect(n.attrs.issueKeys).toEqual(['PROD-42']);
    expect(n.attrs.issueKeys).not.toContain('CDR-20260728');
    expect(n.attrs.runIds).toBeUndefined();
  });
});

describe('normalizePullRequest — diff-stat counts (authoritative detail vs derived fallback)', () => {
  it('prefers prDetail (single-PR GET) for all five counts, ignoring the list PR object', () => {
    const n = normalizePullRequest(
      { number: 50, additions: 999, deletions: 999, changed_files: 99, commits: 99, review_comments: 99 },
      [],
      [{ filename: 'a.ts', additions: 1, deletions: 1 }],
      [{ sha: 'a' }],
      { additions: 120, deletions: 30, changed_files: 4, commits: 6, review_comments: 8 },
    )!;
    expect(n.additions).toBe(120);
    expect(n.deletions).toBe(30);
    expect(n.changedFiles).toBe(4);
    expect(n.commitsCount).toBe(6);
    expect(n.reviewComments).toBe(8);
  });

  it('reads externalUrl/commentCount from prDetail and reviewCount from the reviews list (A3)', () => {
    const n = normalizePullRequest({ number: 54 }, [{ state: 'APPROVED' }, { state: 'COMMENTED' }], [], [], {
      html_url: 'https://github.com/acme/widgets/pull/54',
      comments: 5,
      review_comments: 9,
    })!;
    expect(n.externalUrl).toBe('https://github.com/acme/widgets/pull/54');
    expect(n.commentCount).toBe(5);
    expect(n.reviewCount).toBe(2);
  });

  it('leaves externalUrl/commentCount/reviewCount absent when the payload is LIST-shaped (A3 passes-while-broken guard)', () => {
    // LIST-shaped: no prDetail arg at all — the shape the PR-list endpoint feeds. The
    // reviews list rides both flows, so even a non-empty one must not leak a count here.
    const noDetail = normalizePullRequest(
      { number: 55, html_url: 'https://github.com/acme/widgets/pull/55', comments: 9, review_comments: 9 },
      [{ state: 'APPROVED' }],
      [],
      [],
    )!;
    expect(noDetail.externalUrl).toBeUndefined();
    expect(noDetail.commentCount).toBeUndefined();
    expect(noDetail.reviewCount).toBeUndefined();

    // LIST-shaped: prDetail present but degraded to {} (getPull's documented failure mode).
    const degradedDetail = normalizePullRequest({ number: 56 }, [], [], [], {})!;
    expect(degradedDetail.externalUrl).toBeUndefined();
    expect(degradedDetail.commentCount).toBeUndefined();
    expect(degradedDetail.reviewCount).toBeUndefined();

    // A genuine zero from a real detail fetch must stay distinguishable from "not fetched".
    const zeroDetail = normalizePullRequest({ number: 57 }, [], [], [], {
      html_url: 'https://github.com/acme/widgets/pull/57',
      comments: 0,
      review_comments: 0,
    })!;
    expect(zeroDetail.commentCount).toBe(0);
    expect(zeroDetail.reviewCount).toBe(0);
  });

  it('accepts only a well-formed http(s) externalUrl within the column width, rejecting rather than truncating', () => {
    const https = normalizePullRequest({ number: 60 }, [], [], [], {
      html_url: 'https://github.com/acme/widgets/pull/60',
    })!;
    expect(https.externalUrl).toBe('https://github.com/acme/widgets/pull/60');

    // GitHub Enterprise over plain http is a legitimate deployment.
    const http = normalizePullRequest({ number: 61 }, [], [], [], {
      html_url: 'http://ghe.internal/acme/widgets/pull/61',
    })!;
    expect(http.externalUrl).toBe('http://ghe.internal/acme/widgets/pull/61');

    // Over the VARCHAR(2048) column width: dropped, never sliced — a truncated URL is
    // garbage that reads as a link, and the over-long value would abort the write.
    const oversized = normalizePullRequest({ number: 62 }, [], [], [], {
      html_url: `https://github.com/acme/widgets/pull/62?q=${'x'.repeat(2100)}`,
    })!;
    expect(oversized.externalUrl).toBeUndefined();

    // A value at exactly the cap still passes.
    const atCap = `https://ghe.internal/a?q=${'x'.repeat(2048 - 'https://ghe.internal/a?q='.length)}`;
    expect(atCap).toHaveLength(2048);
    const capped = normalizePullRequest({ number: 63 }, [], [], [], { html_url: atCap })!;
    expect(capped.externalUrl).toBe(atCap);

    // Non-URL strings and non-http(s) schemes are not links we may render.
    for (const html_url of ['not a url', '/acme/widgets/pull/64', 'javascript:alert(1)', 'data:text/html,x', '']) {
      const rejected = normalizePullRequest({ number: 64 }, [], [], [], { html_url, comments: 1 })!;
      expect(rejected.externalUrl).toBeUndefined();
      // Rejecting the URL must not disturb the other detail-only fields.
      expect(rejected.commentCount).toBe(1);
    }

    // Non-string html_url degrades like every other untrusted field.
    expect(normalizePullRequest({ number: 65 }, [], [], [], { html_url: 42 })!.externalUrl).toBeUndefined();
  });

  it('reports detailShaped so persistence can tell "no detail seen" from "detail said nothing"', () => {
    expect(normalizePullRequest({ number: 66 }, [], [], [])!.detailShaped).toBe(false);
    expect(normalizePullRequest({ number: 67 }, [], [], [], {})!.detailShaped).toBe(false);
    expect(normalizePullRequest({ number: 68 }, [], [], [], { comments: 0 })!.detailShaped).toBe(true);
  });

  it('falls back to summing per-file additions/deletions + list lengths when no detail is given', () => {
    const n = normalizePullRequest(
      { number: 51 },
      [],
      [
        { filename: 'a.ts', additions: 20, deletions: 3 },
        { filename: 'b.ts', additions: 10, deletions: 2 },
      ],
      [{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }],
    )!;
    expect(n.additions).toBe(30); // 20 + 10
    expect(n.deletions).toBe(5); // 3 + 2
    expect(n.changedFiles).toBe(2); // file count
    expect(n.commitsCount).toBe(3); // commit count
    expect(n.reviewComments).toBe(0); // no detail, not derivable
  });

  it('leaves counts undefined (→ null) when neither a detail nor the sub-resource is present', () => {
    const n = normalizePullRequest({ number: 52 }, [], [], [])!;
    expect(n.additions).toBeUndefined();
    expect(n.deletions).toBeUndefined();
    expect(n.changedFiles).toBeUndefined();
    expect(n.commitsCount).toBeUndefined();
    expect(n.reviewComments).toBe(0);
  });

  it('honors an authoritative 0 from the detail over a non-empty sub-resource', () => {
    const n = normalizePullRequest(
      { number: 53 },
      [],
      [{ filename: 'a.ts', additions: 5, deletions: 5 }],
      [{ sha: 'a' }],
      { additions: 0, deletions: 0, changed_files: 0, commits: 0, review_comments: 0 },
    )!;
    expect(n.additions).toBe(0);
    expect(n.changedFiles).toBe(0);
    expect(n.commitsCount).toBe(0);
  });
});

describe('normalizePullRequest — v6 rework reviews', () => {
  const pr = { number: 77, user: { login: 'octodev' }, created_at: '2026-07-01T09:00:00Z' };
  const commitsAfter = [{ sha: 'a1', commit: { committer: { date: '2026-07-01T11:00:00Z' } } }];

  function reworkReviews(reviews: unknown[], commits: unknown[] = commitsAfter) {
    return normalizePullRequest(pr, reviews, [], commits)!.reworkReviews;
  }

  it('emits both kinds when another human reviewed and the author pushed afterwards', () => {
    expect(
      reworkReviews(
        [
          {
            id: 1,
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-07-01T10:00:00Z',
            user: { login: 'reviewer', type: 'User' },
            html_url: 'https://github.com/acme/widgets/pull/77#pullrequestreview-1',
          },
          {
            id: 2,
            state: 'COMMENTED',
            submitted_at: '2026-07-01T10:30:00Z',
            user: { login: 'reviewer', type: 'User' },
          },
        ],
        // One commit inside each review's own window: 10:15 answers review 1
        // ((10:00, 10:30]), 11:00 answers review 2 ((10:30, +inf)).
        [{ sha: 'a0', commit: { committer: { date: '2026-07-01T10:15:00Z' } } }, ...commitsAfter],
      ),
    ).toEqual([
      // Newest first: the cap keeps the most recent qualifying reviews.
      // No usable html_url -> the synthetic, stable reference.
      {
        reviewId: '2',
        kind: 'review_commented',
        occurredAt: '2026-07-01T10:30:00Z',
        sourceRef: 'pr#77:review:2',
      },
      {
        reviewId: '1',
        kind: 'review_changes_requested',
        occurredAt: '2026-07-01T10:00:00Z',
        sourceRef: 'https://github.com/acme/widgets/pull/77#pullrequestreview-1',
      },
    ]);
  });

  it('ignores bot reviews, self-reviews, approvals, and reviews with no submitted_at', () => {
    expect(
      reworkReviews([
        { id: 1, state: 'CHANGES_REQUESTED', submitted_at: '2026-07-01T10:00:00Z', user: { login: 'ci', type: 'Bot' } },
        {
          id: 2,
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-07-01T10:00:00Z',
          user: { login: 'octodev', type: 'User' },
        },
        { id: 3, state: 'APPROVED', submitted_at: '2026-07-01T10:00:00Z', user: { login: 'reviewer', type: 'User' } },
        { id: 4, state: 'COMMENTED', user: { login: 'reviewer', type: 'User' } },
      ]),
    ).toEqual([]);
  });

  it('emits nothing when no commit followed the review — a nitpick nobody acted on is not rework', () => {
    const review = [
      {
        id: 1,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-07-01T12:00:00Z',
        user: { login: 'reviewer', type: 'User' },
      },
    ];
    // Last commit is BEFORE the review…
    expect(reworkReviews(review)).toEqual([]);
    // …and a PR whose commits were never fetched states nothing rather than guessing.
    expect(reworkReviews(review, [])).toEqual([]);
  });

  it('caps the emitted signals at 50 per pull request', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      id: i + 1,
      state: 'COMMENTED',
      submitted_at: '2026-07-01T10:00:00Z',
      user: { login: 'reviewer', type: 'User' },
    }));
    expect(reworkReviews(many)).toHaveLength(50);
  });

  it('emits nothing when the commit list is known to be truncated', () => {
    const reviews = [
      {
        id: 1,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-07-01T10:00:00Z',
        user: { login: 'reviewer', type: 'User' },
      },
    ];
    expect(normalizePullRequest(pr, reviews, [], commitsAfter, undefined, false)!.reworkReviews).toHaveLength(1);
    expect(normalizePullRequest(pr, reviews, [], commitsAfter, undefined, true)!.reworkReviews).toEqual([]);
  });

  it('does not convert an earlier review into rework from a commit that landed after a later review', () => {
    // COMMENTED at 10:00, approval at 11:00, merge commit at 12:00 — the commit belongs to the
    // approval's window, not the comment's.
    expect(
      reworkReviews(
        [
          {
            id: 1,
            state: 'COMMENTED',
            submitted_at: '2026-07-01T10:00:00Z',
            user: { login: 'reviewer', type: 'User' },
          },
          {
            id: 2,
            state: 'APPROVED',
            submitted_at: '2026-07-01T11:00:00Z',
            user: { login: 'other', type: 'User' },
          },
        ],
        [{ sha: 'm1', commit: { committer: { date: '2026-07-01T12:00:00Z' } } }],
      ),
    ).toEqual([]);
  });

  it('keeps the NEWEST reviews when the cap bites', () => {
    // 51 reviews an hour apart, each followed by its own commit, so all 51 qualify.
    const at = (i: number) => `2026-07-0${1 + Math.floor(i / 12)}T${String(i % 12).padStart(2, '0')}:00:00Z`;
    const reviews = Array.from({ length: 51 }, (_, i) => ({
      id: i + 1,
      state: 'COMMENTED',
      submitted_at: at(i),
      user: { login: 'reviewer', type: 'User' },
    }));
    const commits = Array.from({ length: 51 }, (_, i) => ({
      sha: `c${i}`,
      commit: { committer: { date: at(i).replace(':00:00Z', ':30:00Z') } },
    }));
    const emitted = reworkReviews(reviews, commits);
    expect(emitted).toHaveLength(50);
    expect(emitted[0].reviewId).toBe('51');
    expect(emitted.map((r) => r.reviewId)).not.toContain('1');
  });

  it('compares offset-format commit dates as instants, not lexically', () => {
    // 11:00+02:00 is 09:00Z — BEFORE the 10:00Z review, though it sorts after it as a string.
    expect(
      reworkReviews(
        [
          {
            id: 1,
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-07-01T10:00:00Z',
            user: { login: 'reviewer', type: 'User' },
          },
        ],
        [{ sha: 'a1', commit: { committer: { date: '2026-07-01T11:00:00+02:00' } } }],
      ),
    ).toEqual([]);
    // 13:00+02:00 is 11:00Z — after it.
    expect(
      reworkReviews(
        [
          {
            id: 1,
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-07-01T10:00:00Z',
            user: { login: 'reviewer', type: 'User' },
          },
        ],
        [{ sha: 'a1', commit: { committer: { date: '2026-07-01T13:00:00+02:00' } } }],
      ),
    ).toHaveLength(1);
  });

  it('drops a qualifying review whose id is not a safe integer', () => {
    expect(
      reworkReviews([
        {
          id: 'not-a-number',
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-07-01T10:00:00Z',
          user: { login: 'reviewer', type: 'User' },
        },
        {
          id: Number.MAX_SAFE_INTEGER + 2,
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-07-01T10:00:00Z',
          user: { login: 'reviewer', type: 'User' },
        },
      ]),
    ).toEqual([]);
  });

  it('ignores a commit date that does not parse', () => {
    expect(
      reworkReviews(
        [
          {
            id: 1,
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-07-01T10:00:00Z',
            user: { login: 'reviewer', type: 'User' },
          },
        ],
        [{ sha: 'a1', commit: { committer: { date: 'yesterday-ish' } } }],
      ),
    ).toEqual([]);
  });
});

describe('intent handoff cutover', () => {
  it('does not interpret PR prose as mapping or delivery declarations', () => {
    const pr = { number: 1, state: 'open', body: 'Coredoc-Intent-Delivers: cap-a@1\nCoredoc-Intent-Retires: lim-b@2' };
    const norm = normalizePullRequest(pr, [], [], [], {}, false)!;
    expect(norm.attrs).not.toHaveProperty('intentDelivers');
    expect(norm.attrs).not.toHaveProperty('intentRetires');
    expect(norm.attrs).not.toHaveProperty('intentTrailerError');
  });
  it('does not parse adversarial Markdown', () => {
    expect(() =>
      normalizePullRequest(
        { number: 1, body: `${'*a'.repeat(32768)}\nCoredoc-Intent-Delivers: x@1` },
        [],
        [],
        [],
        {},
        false,
      ),
    ).not.toThrow();
  });
});
