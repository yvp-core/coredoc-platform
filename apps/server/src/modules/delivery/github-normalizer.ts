// Pure normalizer: GitHub REST v3 pull-request payloads -> NormalizedCodeChange.
// No I/O; the single import is the equally pure PR-body trailer parser, which is
// reused rather than restated so the connector and the API read one grammar.
// GitHub payloads are UNTRUSTED, so every field is coerced
// through tolerant helpers (str/num/arr/obj); non-conforming shapes degrade to
// undefined / [] rather than throwing. Dates are passed through verbatim as ISO
// strings — the service layer converts to `Date`. The one place that compares
// dates as instants (rework windows) parses with `Date.parse` and ignores what
// does not parse.

/**
 * Normalization schema version stamped on every persisted raw row + the single
 * source of truth for both writers (github-importer and renormalize.service).
 * Bump when the normalizer's output shape changes so the renormalize job can find
 * and upgrade stale rows.
 */
export const CODE_CHANGE_NORM_VERSION = 10; // v10: PR prose no longer supplies intent declarations

/**
 * The retired flow's run-id grammar, preserved BY EXACT VALUE for compatibility
 * with existing trailers and stored records. The active workflow emitter uses
 * the same grammar.
 *
 * It is anchored and fixed-length, which is what makes an over-long value DROPPED
 * rather than truncated: no prefix of a longer token can satisfy it, so there is no
 * truncation that could fabricate a different, valid-looking id (the same deliberate
 * asymmetry the existing `specIds` length filter makes explicit). Matching on the
 * VALUE and not merely on the trailer key is what keeps anything a commit author typed
 * after the colon out of a column the archive later fetches network resources against.
 */
const RUN_ID_RE = /^cdr-\d{8}-[0-9a-f]{6}$/;

/**
 * Cheap presence test for the two intent trailer keys (amendment §1).
 *
 * A body WITHOUT either key is not a parse failure — it is every pull request in
 * every repository that has not adopted the loop — so the strict parser (which
 * refuses "names no items") is only invoked once this matches.
 */

/**
 * Cap on captured run ids, deliberately above the 10-spec-id cap: a run is per
 * CHANGE while a spec id is per PULL REQUEST, so one pull request legitimately carries
 * many. When the cap bites the first ids are kept and the set is MARKED partial
 * (`attrs.runIdsPartial`), so a truncated run set is never read as a complete one.
 */
const MAX_RUN_IDS = 50;

/**
 * A review that demonstrably caused rework: a human other than the PR author asked for changes
 * (or commented) and the author pushed at least one commit afterwards. The "and then a commit"
 * half is what separates rework from an approving nitpick nobody acted on.
 */
export interface NormalizedReworkReview {
  reviewId: string;
  kind: 'review_changes_requested' | 'review_commented';
  /** Review `submitted_at`, verbatim ISO-8601 — the service layer converts to `Date`. */
  occurredAt: string;
  sourceRef: string;
}

/** Where an issue key was found; highest priority first (branch > title > body). */
export type IssueKeySource = 'branch' | 'title' | 'body';

export interface NormalizedCodeChange {
  externalId: string;
  number?: number;
  title?: string;
  sourceBranch?: string;
  targetBranch?: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  createdAtSource?: string;
  readyForReviewAt?: string;
  firstReviewAt?: string;
  approvedAt?: string;
  mergedAt?: string;
  closedAt?: string;
  lastCommitAt?: string;
  commitsCount?: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  changedPaths: string[];
  reviewRounds: number;
  reviewComments: number;
  /** Empty when the PR carries no rework-causing review, or when commits were not fetched / truncated. */
  reworkReviews: NormalizedReworkReview[];
  aiAssisted?: boolean;
  // externalUrl/commentCount/reviewCount are only present on the single-PR GET (`prDetail`),
  // same as the diff-stat counts above. LIST-shaped calls (no prDetail, or a prDetail that
  // degraded to {}) leave all three undefined (-> null downstream) — never a fabricated 0/"" —
  // so a genuinely-zero comment count stays distinguishable from "not fetched yet".
  externalUrl?: string;
  commentCount?: number;
  reviewCount?: number;
  /**
   * True when the single-PR GET body was present on this normalization pass — i.e. the
   * three detail-only fields above carry an OBSERVATION (value or genuine absence), and
   * not merely "this pass could not see them". Persistence reads this to decide whether
   * an update may overwrite established detail values; it is a property of the pass, not
   * a provider fact, so it is never stored.
   */
  detailShaped: boolean;
  attrs: {
    authorLogin?: string;
    specIds?: string[];
    issueKeys?: string[];
    // Per-key provenance (v2): each surviving issueKey mapped to its highest-priority
    // source. Absent entirely when there are no issue keys.
    issueKeySources?: Record<string, IssueKeySource>;
    // Legacy workflow run ids (v4): `Coredoc-Run-Id` trailers matching the frozen
    // compatibility grammar. ABSENT ENTIRELY when the change carries none — no
    // compatible run must remain distinguishable from an empty compatible run.
    runIds?: string[];
    // Present as `true` only when MAX_RUN_IDS bit; absent otherwise. Typed as the literal
    // so there is no `false` stub to mistake for a measured "not partial".
    runIdsPartial?: true;
    /**
     * `merge_commit_sha` — the delivered ref of a `merge`-mode release. Absent until the
     * PR merges (and on the list payload of an unmerged PR).
     */
    mergeCommitSha?: string;
    /**
     * `base.repo.default_branch`: what a repository with no explicit `productionBranch`
     * compares its merges against (amendment §2). Captured here because the connector
     * already sees it — no second ingestion, no `main`/`master` guessing.
     */
    baseDefaultBranch?: string;
  };
}

// --- tolerant coercion helpers -------------------------------------------------

/** Non-string -> undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Finite number, or a numeric string, else undefined. GitHub sends these fields as
 * JSON integers; the numeric-string branch is a deliberate tolerance for untrusted
 * input (payloads are not schema-validated upstream), not an observed GitHub shape.
 */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Non-array -> []. */
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Non-object (or array/null) -> {}. */
function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** str() then truncate to `max` chars; undefined passes through. */
function capped(v: unknown, max: number): string | undefined {
  const s = str(v);
  return s === undefined ? undefined : s.slice(0, max);
}

/** Cap on a stored provider URL — matches the delivery_code_changes.external_url column width. */
const MAX_EXTERNAL_URL_CHARS = 2048;

/** Matches the delivery_rework_signals.source_ref column width. */
const MAX_SOURCE_REF_CHARS = 512;

/**
 * Cap on rework signals emitted per pull request: each one becomes a row per linked task, and
 * a review thread of a thousand comments is not a thousand distinct rework facts worth storing.
 */
const MAX_REWORK_REVIEWS = 50;

/**
 * A well-formed http(s) URL of at most `max` chars, else undefined.
 *
 * URLs are the deliberate exception to `capped()`: every other string here is a display
 * value where a lossy prefix is still usable, but a truncated URL is garbage that reads
 * as a valid link (the same reject-don't-truncate asymmetry `specIds`/`runIds` make).
 * Rejecting at the WRITE boundary also keeps an over-long value from reaching a narrower
 * column mid-transaction, where the resulting error would abort the projection and be
 * replayed forever from the stored raw payload. The scheme check keeps javascript:/data:
 * out of a field the desktop renders as a link.
 */
function httpUrl(v: unknown, max: number): string | undefined {
  const s = str(v);
  if (s === undefined || s.length > max) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    // intentional: malformed URL in an untrusted payload → the field is dropped
    // rather than stored. Throwing here would abort a whole projection replay.
    return undefined;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? s : undefined;
}

/** commit.commit.message for a GitHub commit list item. */
function commitMessage(c: unknown): string | undefined {
  return str(obj(obj(c).commit).message);
}

/** Ordered, de-duplicated capture-group-1 matches of `re` over `text`. */
function uniqueMatches(re: RegExp, text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    const v = m[1];
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Uppercase issue keys found in `text`, minus any that a captured spec id equals or
 * prefixes (guard (b) — a spec id must never masquerade as a tracker key). A fresh
 * regex literal per call keeps `lastIndex` at 0 so the three per-source scans are
 * independent.
 */
function issueKeysIn(text: string, specIds: string[]): string[] {
  return uniqueMatches(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g, text).filter(
    (k) => !specIds.some((s) => s === k || s.startsWith(`${k}-`)),
  );
}

// --- normalizer ----------------------------------------------------------------

export function normalizePullRequest(
  pr: Record<string, unknown>,
  reviews: unknown[],
  files: unknown[],
  commits: unknown[],
  prDetail?: Record<string, unknown>,
  /**
   * True when `commits` is known to be a TRUNCATED view of the PR's commits (the client's page
   * cap bit, or the raw envelope was stored minimal). Rework signals are then suppressed
   * entirely: "a commit followed this review" cannot be decided from a partial commit list, and
   * a fabricated signal is worse than a missing one. Defaults to false — the complete-list
   * assumption every pre-v6 caller already made; the three production callers thread the stored
   * `commitsIncomplete` flag explicitly.
   */
  commitsIncomplete = false,
): NormalizedCodeChange | null {
  const number = num(pr.number);
  if (number === undefined) return null; // no usable PR number -> unindexable

  const reviewList = arr(reviews);
  const fileList = arr(files);
  const commitList = arr(commits);

  // state: merged_at wins, then an explicit closed state, else open.
  const mergedAt = str(pr.merged_at);
  const closedAt = str(pr.closed_at);
  let state: 'open' | 'merged' | 'closed';
  if (mergedAt) state = 'merged';
  else if (str(pr.state) === 'closed') state = 'closed';
  else state = 'open';

  const isDraft = pr.draft === true;

  // readyForReviewAt (v1 approximation): the draft->ready transition timestamp is
  // NOT present in the REST PR payload, so a currently-ready PR is approximated as
  // ready-at-creation, and a still-draft PR reports no ready time yet.
  const readyForReviewAt = isDraft ? undefined : str(pr.created_at);

  // Review timeline. ISO-8601 UTC strings sort lexicographically == chronologically,
  // so min/max are taken as string comparisons — no Date parsing.
  const submittedTimes: string[] = [];
  const approvedTimes: string[] = [];
  let changesRequestedCount = 0;
  let hasNonChangesRequested = false;
  for (const r of reviewList) {
    const review = obj(r);
    const submittedAt = str(review.submitted_at);
    const reviewState = str(review.state);
    if (submittedAt) submittedTimes.push(submittedAt);
    if (reviewState === 'CHANGES_REQUESTED') {
      changesRequestedCount++;
    } else {
      hasNonChangesRequested = true;
    }
    if (reviewState === 'APPROVED' && submittedAt) approvedTimes.push(submittedAt);
  }
  const firstReviewAt = submittedTimes.length > 0 ? submittedTimes.reduce((a, b) => (a < b ? a : b)) : undefined;
  const approvedAt = approvedTimes.length > 0 ? approvedTimes.reduce((a, b) => (a > b ? a : b)) : undefined;

  // reviewRounds (v1 heuristic): one round per CHANGES_REQUESTED, plus a single
  // round if any non-CHANGES_REQUESTED review exists (approval/comment presence).
  const reviewRounds = changesRequestedCount + (hasNonChangesRequested ? 1 : 0);

  // changedPaths: dedup is not applied (GitHub files are already unique paths);
  // caps are applied AFTER extraction — each path <=512 chars, at most 300 entries.
  const changedPaths = fileList
    .map((f) => str(obj(f).filename))
    .filter((s): s is string => s !== undefined)
    .map((s) => s.slice(0, 512))
    .slice(0, 300);

  // Diff-stat counts — additions/deletions/changed_files/commits/review_comments — are
  // ABSENT from the PR *list* endpoint that feeds the live importer (github-client's
  // listPullsUpdatedSince); they exist only on the single-PR GET. `prDetail` carries that
  // GET's body when available: prefer its authoritative, GitHub-computed totals. When it is
  // absent (legacy raw payloads re-normalized offline, or a detail fetch that yielded no
  // body), fall back to deriving the counts from the already-fetched files/commits sub-
  // resources — exact for PRs within the client's page caps (300 files / 100 commits), an
  // accepted undercount above them. With neither a detail nor the relevant sub-resource,
  // the count stays undefined (→ null): null is "unknown", not a fabricated 0. Only
  // review_comments has no sub-resource to derive from (reviews carry submissions, not
  // inline comments), so it degrades to 0 — matching its non-optional NormalizedCodeChange
  // type and pre-existing default.
  const detail = obj(prDetail);
  let derivedAdditions = 0;
  let derivedDeletions = 0;
  for (const f of fileList) {
    const file = obj(f);
    derivedAdditions += num(file.additions) ?? 0;
    derivedDeletions += num(file.deletions) ?? 0;
  }
  const additions = num(detail.additions) ?? (fileList.length > 0 ? derivedAdditions : undefined);
  const deletions = num(detail.deletions) ?? (fileList.length > 0 ? derivedDeletions : undefined);
  const changedFiles = num(detail.changed_files) ?? (fileList.length > 0 ? fileList.length : undefined);
  const commitsCount = num(detail.commits) ?? (commitList.length > 0 ? commitList.length : undefined);
  const reviewComments = num(detail.review_comments) ?? 0;

  // externalUrl/commentCount/reviewCount: detail-only fields. Left undefined when
  // `prDetail` is absent or degraded to {}, so a genuine zero from the detail read
  // stays distinguishable from "not fetched".
  //
  // reviewCount counts actual review SUBMISSIONS (`reviewList.length`), not GitHub's
  // `review_comments` inline-comment tally — the UI renders it as "N reviews", and a
  // PR reviewed once with three inline comments must read "1 review", not "3". The
  // reviews endpoint is fetched on both list and detail flows, so the count is gated
  // on detail presence to preserve the LIST-shaped absence contract.
  const detailShaped = Object.keys(detail).length > 0;
  const externalUrl = httpUrl(detail.html_url, MAX_EXTERNAL_URL_CHARS);
  const commentCount = num(detail.comments);
  const reviewCount = detailShaped ? reviewList.length : undefined;

  // aiAssisted tri-state: true if any commit message carries a known AI co-author
  // trailer; false if commits exist and none match; undefined if commits unknown.
  let aiAssisted: boolean | undefined;
  if (commitList.length > 0) {
    const aiTrailer = /co-authored-by:.*(claude|copilot|cursor|codex)/i;
    aiAssisted = commitList.some((c) => {
      const msg = commitMessage(c);
      return msg !== undefined && aiTrailer.test(msg);
    });
  }

  // lastCommitAt: newest commit timestamp. Per commit prefer commit.committer.date,
  // fall back to commit.author.date. ISO-8601 UTC (GitHub commit dates are Z-suffixed),
  // so lexical max == chronological max — no Date parsing (same idiom as firstReviewAt/
  // approvedAt above). Undefined when commits are empty/non-array or carry no dates.
  const commitTimes: string[] = [];
  for (const c of commitList) {
    const inner = obj(obj(c).commit);
    const date = str(obj(inner.committer).date) ?? str(obj(inner.author).date);
    if (date) commitTimes.push(date);
  }
  const lastCommitAt = commitTimes.length > 0 ? commitTimes.reduce((a, b) => (a > b ? a : b)) : undefined;

  // reworkReviews (v6): the review-driven half of the rework rule. A review counts only when
  // someone OTHER than the PR author (and not a Bot) asked for changes or commented, AND a
  // commit landed in that review's OWN window — (submitted_at, next review's submitted_at], the
  // next review being the next by ANYONE in submitted_at order, or +infinity for the last one.
  // Attributing every later commit to every earlier review (what comparing against the newest
  // commit did) converts a merge commit pushed after an approval into rework for every comment
  // that preceded it.
  //
  // Comparison is by `Date.parse` epoch ms, NOT lexical: GitHub review/commit timestamps are
  // normally Z-suffixed, but a commit date carries the author's local offset in the wild, and
  // "2026-07-01T11:00:00+02:00" sorts lexically after a 10:00Z review it actually precedes. A
  // date that does not parse is ignored rather than guessed at.
  const prAuthorLogin = str(obj(pr.user).login);
  const epochs = (times: string[]) => times.map((t) => Date.parse(t)).filter((ms) => Number.isFinite(ms));
  // A truncated commit list yields NO commit evidence, so no review can qualify — the one
  // mechanism that suppresses fabricated signals for both "commits not fetched" and "commits
  // fetched but incomplete".
  const commitEpochs = commitsIncomplete ? [] : epochs(commitTimes);
  // Every review's boundary, regardless of state or author: an approval by a third party still
  // ends the previous reviewer's window.
  const reviewEpochs = epochs(submittedTimes).sort((a, b) => a - b);
  const qualifying: { at: number; signal: NormalizedReworkReview }[] = [];
  for (const r of reviewList) {
    const review = obj(r);
    const reviewState = str(review.state);
    const kind =
      reviewState === 'CHANGES_REQUESTED'
        ? ('review_changes_requested' as const)
        : reviewState === 'COMMENTED'
          ? ('review_commented' as const)
          : undefined;
    if (kind === undefined) continue;
    const submittedAt = str(review.submitted_at);
    if (submittedAt === undefined) continue;
    const reviewer = obj(review.user);
    const reviewerLogin = str(reviewer.login);
    if (str(reviewer.type) === 'Bot' || reviewerLogin === undefined || reviewerLogin === prAuthorLogin) continue;
    const submittedMs = Date.parse(submittedAt);
    if (!Number.isFinite(submittedMs)) continue;
    const nextReviewMs = reviewEpochs.find((ms) => ms > submittedMs) ?? Number.POSITIVE_INFINITY;
    if (!commitEpochs.some((ms) => ms > submittedMs && ms <= nextReviewMs)) continue;
    // The id is the signal's identity, so a payload without a usable one is dropped rather
    // than keyed on something that could collide across reviews.
    const reviewId = num(review.id);
    if (reviewId === undefined || !Number.isSafeInteger(reviewId)) continue;
    qualifying.push({
      at: submittedMs,
      signal: {
        reviewId: String(reviewId),
        kind,
        occurredAt: submittedAt,
        // Same reject-don't-truncate rule as externalUrl, at the `source_ref` column width.
        sourceRef: httpUrl(review.html_url, MAX_SOURCE_REF_CHARS) ?? `pr#${number}:review:${reviewId}`,
      },
    });
  }
  // The cap keeps the NEWEST reviews: when a thread overruns it, the recent rework is the part
  // worth storing, and stopping at the first 50 would freeze the signal at the PR's opening
  // round forever.
  const reworkReviews: NormalizedReworkReview[] = qualifying
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_REWORK_REVIEWS)
    .map((entry) => entry.signal);

  const body = str(pr.body) ?? '';
  const title = str(pr.title) ?? '';
  const headRef = str(obj(pr.head).ref) ?? '';
  const commitMessages = commitList.map(commitMessage).filter((m): m is string => m !== undefined);

  // The trailer corpus: the PR body plus every commit message. Both trailer captures
  // below read this one string, so "the same corpus" is a fact of the code rather than
  // a claim about two expressions that could drift.
  const trailerCorpus = [body, ...commitMessages].join('\n');

  // specIds: unique Spec-Id trailers over body + all commit messages; cap 10, <=128 each.
  // Over-long ids are DROPPED, not truncated: an over-long id is garbage, and slicing
  // it would fabricate a different, valid-looking id (deliberate asymmetry vs capped(),
  // which truncates display strings where a lossy value is still acceptable).
  const specIds = uniqueMatches(/\bSpec-Id:\s*(\S+)/gi, trailerCorpus)
    .filter((s) => s.length <= 128)
    .slice(0, 10);

  // runIds (v4): unique Coredoc-Run-Id trailers over the SAME corpus, with the same
  // discipline — matched against the compatibility grammar (which is also what drops
  // over-long values), deduplicated by uniqueMatches, capped, and marked partial when
  // the cap bites. The run trailer is namespaced so its population stays separable
  // from spec ids at the code change; nothing below changes spec-id capture.
  const matchedRunIds = uniqueMatches(/\bCoredoc-Run-Id:\s*(\S+)/gi, trailerCorpus).filter((v) => RUN_ID_RE.test(v));
  const runIds = matchedRunIds.slice(0, MAX_RUN_IDS);
  const runIdsPartial = matchedRunIds.length > MAX_RUN_IDS;

  // issueKeys: unique uppercase issue keys over head.ref + title + body; cap 10.
  // The uppercase-only anchor is deliberate — a case-insensitive variant invents
  // phantom tickets from lowercase branch tokens (2026-07-02 review finding).
  //
  // Phantom-ticket class from the same review: spec ids must never masquerade as
  // tracker keys. A Spec-Id like `SF-20260701-x` repeated into the PR body as a
  // trailer line otherwise leaks `SF-20260701` into issueKeys. Two guards:
  //   (a) strip Spec-Id trailer lines from the BODY before scanning (head.ref/title
  //       keep the full scan — real tickets there are not spec-id trailers);
  //   (b) drop any key that a captured spec id equals or prefixes (covers spec ids
  //       mentioned in titles outside trailer syntax).
  //
  // v2 adds per-source provenance: scan head.ref / title / body independently, then
  // union preserving branch→title→body first-occurrence order (cap 10) and record each
  // surviving key's HIGHEST-priority source. A Map preserves insertion order, so the
  // union order matches the pre-v2 concatenated scan exactly (existing fixtures unchanged).
  //
  // v4: ONE expression strips BOTH trailer keys. Two identifier vocabularies now share
  // this free-text corpus, and the run-id trailer arrives with the same defect the
  // spec-id filter already exists for — a `Coredoc-Run-Id:` line whose value is not a
  // run id (so guard (b) has nothing to filter by, the grammar having refused it) still
  // offers the scan an uppercase token to mint a phantom ticket from. Stripping the line
  // is what stops it, and stripping both keys in one expression is what keeps the two
  // from drifting apart later.
  const bodyForIssueKeys = body.replace(/^.*\b(?:Spec-Id|Coredoc-Run-Id):.*$/gim, '');
  const sourceByKey = new Map<string, IssueKeySource>();
  for (const k of issueKeysIn(headRef, specIds)) if (!sourceByKey.has(k)) sourceByKey.set(k, 'branch');
  for (const k of issueKeysIn(title, specIds)) if (!sourceByKey.has(k)) sourceByKey.set(k, 'title');
  for (const k of issueKeysIn(bodyForIssueKeys, specIds)) if (!sourceByKey.has(k)) sourceByKey.set(k, 'body');
  const issueKeys = [...sourceByKey.keys()].slice(0, 10);

  const issueKeySources: Record<string, IssueKeySource> = {};
  for (const k of issueKeys) {
    const source = sourceByKey.get(k);
    if (source) issueKeySources[k] = source;
  }

  return {
    externalId: String(number),
    number,
    title: capped(pr.title, 512),
    sourceBranch: capped(obj(pr.head).ref, 256),
    targetBranch: capped(obj(pr.base).ref, 256),
    state,
    isDraft,
    createdAtSource: str(pr.created_at),
    readyForReviewAt,
    firstReviewAt,
    approvedAt,
    mergedAt,
    closedAt,
    lastCommitAt,
    commitsCount,
    additions,
    deletions,
    changedFiles,
    changedPaths,
    reviewRounds,
    reviewComments,
    reworkReviews,
    aiAssisted,
    externalUrl,
    commentCount,
    reviewCount,
    detailShaped,
    attrs: {
      authorLogin: str(obj(pr.user).login),
      specIds,
      issueKeys,
      // Absent entirely when no keys survived (no phantom empty map).
      ...(issueKeys.length > 0 ? { issueKeySources } : {}),
      // Absent entirely when the change carries no run-id trailer, and the partial
      // marker absent unless the cap actually bit — an empty stub here would read as a
      // repository that emitted a compatible run and produced nothing.
      ...(runIds.length > 0 ? { runIds } : {}),
      ...(runIdsPartial ? { runIdsPartial: true as const } : {}),
      // Absent when the body names no intent trailer; mutually exclusive with the error.

      ...(str(pr.merge_commit_sha) ? { mergeCommitSha: str(pr.merge_commit_sha) } : {}),
      ...(str(obj(obj(pr.base).repo).default_branch)
        ? { baseDefaultBranch: str(obj(obj(pr.base).repo).default_branch) }
        : {}),
    },
  };
}
