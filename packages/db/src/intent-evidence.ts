/**
 * Code-anchor evidence for product-intent items.
 *
 * Resolves each stored {@link CodeAnchor} against the ACTIVE project graph and
 * reports two INDEPENDENT dimensions (spec BR-4, ADR-2):
 *
 * - `anchorStatus` — does the anchored node still exist with the captured
 *   versioned ID?
 * - `snapshotFreshness` — does that graph represent the checkout the caller is
 *   looking at?
 *
 * Neither dimension may be collapsed into the other: a `matched` anchor against
 * a `stale` graph is a normal, representable result and must never be rendered
 * as "unaffected". This module also never proves conformance — an anchor is an
 * implementation touchpoint, not evidence that the intent is satisfied (LIM-2).
 */

import type { CodeAnchor, NodeType } from '@coredoc/core';
import type { IGraphReadRepository } from './types.js';

/**
 * Result of resolving one anchor, plus the item-level `unmapped` value.
 *
 * `Unmapped` is deliberately part of the same enum as the spec's other three
 * values, but it is an ITEM-level result (the item declares no anchors), never
 * an anchor-level one.
 */
export enum AnchorStatus {
  Matched = 'matched',
  Changed = 'changed',
  Missing = 'missing',
  Unmapped = 'unmapped',
}

/**
 * Whether the active graph is known to represent the caller's checkout.
 *
 * `Unverified` and `Unknown` are NOT synonyms, and collapsing them is the
 * failure this enum exists to prevent:
 *
 * - `Unverified` — the caller supplied NO observed state for this repo, so
 *   nothing was compared. The snapshot's provenance is still reported; the
 *   answer to "is this current?" is simply not knowable from what was given.
 * - `Unknown` — a comparison WAS attempted and could not conclude: git could
 *   not be read, the checkout has no commit, the snapshot recorded none, or the
 *   working tree is dirty at the snapshot's commit.
 *
 * Neither may ever be rendered as `Current`.
 */
export enum SnapshotFreshness {
  Current = 'current',
  Stale = 'stale',
  Unknown = 'unknown',
  Unverified = 'unverified',
}

/**
 * Why an anchor did not resolve as a plain content comparison.
 *
 * A reason NEVER introduces a fifth status; it explains a `changed`/`missing`
 * one so a caller can distinguish "the code moved on" from "this anchor never
 * addressed what it claims to address".
 */
export enum AnchorMismatchReason {
  /**
   * The stable ID resolves to a node of a different kind than the anchor
   * declares. The declared target does not exist, so this can never be
   * `matched` (AC-5).
   */
  NodeTypeMismatch = 'node_type_mismatch',
  /**
   * The node exists but carries no `properties.versionedId`. BR-11 only allows
   * anchoring kinds that DO carry one, so this is an integrity surprise: the
   * captured ID cannot be confirmed, therefore the anchor is not `matched`.
   */
  VersionedIdAbsent = 'versioned_id_absent',
  /**
   * The anchor names a repository that is not part of the resolving project, so
   * it cannot be resolved at all (BR-12). No graph lookup is attempted.
   */
  RepoNotInProject = 'repo_not_in_project',
}

/** Observed state of the caller's working checkout for one repository. */
export interface ObservedCheckout {
  /** Full commit SHA of HEAD; absent when it could not be determined. */
  commit?: string;
  /** True when the working tree differs from HEAD, or dirtiness is unverifiable. */
  dirty: boolean;
}

export interface AnchorEvidence {
  /** The stored anchor, echoed so callers can render it without a second join. */
  anchor: CodeAnchor;
  status: AnchorStatus.Matched | AnchorStatus.Changed | AnchorStatus.Missing;
  mismatchReason?: AnchorMismatchReason;
  /** Versioned ID currently stored on the resolved node, when it carries one. */
  currentVersionedId?: string;
  /** Actual node kind, present only on a {@link AnchorMismatchReason.NodeTypeMismatch}. */
  actualNodeType?: NodeType;
  /**
   * Freshness of the declared repo's graph snapshot, repeated here so a
   * formatter cannot show an anchor status without its freshness (BR-4).
   */
  snapshotFreshness: SnapshotFreshness;
}

export interface IntentItemEvidence {
  intentId: string;
  anchors: AnchorEvidence[];
  /** Present only when the item declares no code anchors (spec's item-level `unmapped`). */
  itemStatus?: AnchorStatus.Unmapped;
}

export interface RepoSnapshotEvidence {
  /** Repository name as declared by the anchors. */
  repo: string;
  /** Repo hash it maps to inside the project; absent when the repo is unknown to the project. */
  repoHash?: string;
  snapshotFreshness: SnapshotFreshness;
  /** Commit the active graph was parsed at, when the snapshot recorded one. */
  graphCommit?: string;
  /** Commit the caller's checkout is on, when supplied. */
  observedCommit?: string;
}

/**
 * The only two fields of an item this module reads.
 *
 * Deliberately structural: the hosted intent service stores items relationally
 * and resolves anchors through this one algorithm.
 */
export interface AnchoredIntentSubject {
  id: string;
  codeAnchors?: readonly CodeAnchor[];
}

export interface IntentEvidenceInput {
  /** Project-scoped read repository (one project's active graph). */
  repository: IGraphReadRepository;
  items: readonly AnchoredIntentSubject[];
  /**
   * Declared anchor repo identity → graph repo hash, for the repos in scope
   * only. Locally the key is the repo NAME from the overlay; in the hosted
   * service it is the durable `intent_repo_key`. Either way it is the string an
   * anchor addresses its repository by, and an identity absent from this map is
   * "not in scope" (never resolved, never queried).
   */
  repoHashesByName: Record<string, string>;
  /** Observed checkout state per declared repo name; a missing entry means unknown. */
  observedCheckouts: Record<string, ObservedCheckout>;
}

export interface IntentEvidenceResult {
  items: IntentItemEvidence[];
  /** One entry per repository referenced by the resolved anchors. */
  repos: RepoSnapshotEvidence[];
}

/**
 * Read the caller's checkout state for one repo root.
 *
 * Reuses `captureGitInfo` — the SAME capture the parse path records
 * `gitCommitHash` from — so the two commits being compared are produced by one
 * implementation. Kept out of {@link resolveIntentEvidence} so resolution stays
 * injectable and free of process/filesystem access.
 *
 * Any failure (not a git repo, git unavailable, unreadable status) degrades to
 * `{ dirty: true }` with no commit: an unverifiable checkout must read as
 * `unknown` freshness, never as a clean match.
 */
export async function readObservedCheckout(repoRoot: string): Promise<ObservedCheckout> {
  // Lazy import: `@coredoc/core/utils` pulls in the git/child-process helpers,
  // which nothing else in this package needs at module load.
  const { captureGitInfo } = await import('@coredoc/core/utils');
  const info = await captureGitInfo(repoRoot);
  if (!info) return { dirty: true };
  return { commit: info.commitHash, dirty: info.isDirty };
}

/** Shortest observed commit that can name a snapshot commit by prefix (BR-1). */
const MIN_ABBREVIATED_COMMIT = 7;

/**
 * Freshness of one repo's snapshot, computed from the parsed commit and the
 * caller's observed checkout ONLY — never from anchor results (AC-7).
 *
 * No observed checkout at all is `unverified`, not `unknown`: nothing was
 * compared, so there is no inconclusive comparison to report. A supplied
 * observation that cannot conclude (git unreadable, no commit on either side)
 * is `unknown`. A dirty checkout degrades `current` to `unknown` (the working
 * tree is not the commit the graph saw), but it does not soften a KNOWN commit
 * difference: the graph still demonstrably represents another commit, which is
 * `stale`.
 *
 * An observed commit of at least 7 hex characters counts as the snapshot's
 * commit when it is a case-insensitive PREFIX of it (BR-1) — an abbreviated SHA
 * such as `git rev-parse --short HEAD` names the same commit — so a full-length
 * hash still only matches by equality, and anything shorter or non-prefixing is
 * `stale`.
 */
function computeFreshness(graphCommit: string | undefined, observed: ObservedCheckout | undefined): SnapshotFreshness {
  if (!observed) return SnapshotFreshness.Unverified;
  if (!graphCommit || !observed.commit) return SnapshotFreshness.Unknown;
  // Normalised here, not at the call sites: `readObservedCheckout` takes its
  // commit from git and the server parser lowercases its own, so one comparison
  // owns the casing for both. The echoed `observedCommit` stays as supplied.
  const observedCommit = observed.commit.toLowerCase();
  // Below MIN_ABBREVIATED_COMMIT an "abbreviation" names too many commits to be
  // one, so it is not a match — the db package does not lean on the server's
  // own `OBSERVED_COMMIT` bound.
  if (observedCommit.length < MIN_ABBREVIATED_COMMIT) return SnapshotFreshness.Stale;
  if (!graphCommit.toLowerCase().startsWith(observedCommit)) return SnapshotFreshness.Stale;
  return observed.dirty ? SnapshotFreshness.Unknown : SnapshotFreshness.Current;
}

/**
 * Look up a repo hash for an anchor-declared repo name.
 *
 * Anchor repo names come from a user-editable file, so they are untrusted map
 * keys: `'constructor'` or `'toString'` would otherwise resolve to an inherited
 * `Object.prototype` member and pass the "is this repo in the project?" guard
 * with a function value, which would then be handed to a graph query. Only an
 * own, string-valued entry counts as a repo of this project (BR-12).
 */
function lookupRepoHash(repoHashesByName: Record<string, string>, repo: string): string | undefined {
  if (!Object.hasOwn(repoHashesByName, repo)) return undefined;
  const repoHash = repoHashesByName[repo];
  return typeof repoHash === 'string' ? repoHash : undefined;
}

/** Same untrusted-key guard as {@link lookupRepoHash}, for the observed-checkout map. */
function lookupObservedCheckout(
  observedCheckouts: Record<string, ObservedCheckout>,
  repo: string,
): ObservedCheckout | undefined {
  if (!Object.hasOwn(observedCheckouts, repo)) return undefined;
  const observed = observedCheckouts[repo];
  return typeof observed === 'object' && observed !== null ? observed : undefined;
}

async function collectRepoEvidence(input: IntentEvidenceInput, repoNames: string[]): Promise<RepoSnapshotEvidence[]> {
  const evidence: RepoSnapshotEvidence[] = [];

  for (const repo of repoNames) {
    const repoHash = lookupRepoHash(input.repoHashesByName, repo);
    const observed = lookupObservedCheckout(input.observedCheckouts, repo);
    // A repo outside the project has no graph to be fresh about; asking for its
    // overview would silently widen the scope this resolution is confined to.
    const overviews = repoHash ? await input.repository.getRepoOverview([repoHash]) : [];
    const graphCommit = overviews[0]?.gitCommitHash;

    evidence.push({
      repo,
      ...(repoHash ? { repoHash } : {}),
      snapshotFreshness: computeFreshness(graphCommit, observed),
      ...(graphCommit ? { graphCommit } : {}),
      ...(observed?.commit ? { observedCommit: observed.commit } : {}),
    });
  }

  return evidence;
}

async function resolveAnchor(
  anchor: CodeAnchor,
  repoHash: string | undefined,
  repository: IGraphReadRepository,
  snapshotFreshness: SnapshotFreshness,
): Promise<AnchorEvidence> {
  if (!repoHash) {
    return {
      anchor,
      status: AnchorStatus.Missing,
      mismatchReason: AnchorMismatchReason.RepoNotInProject,
      snapshotFreshness,
    };
  }

  // Scoping the read to the declared repo's hash is what makes an identical
  // node in another repo (or another project's database) unable to satisfy the
  // anchor (BR-12).
  const found = await repository.getNodeWithProperties(anchor.nodeId, [repoHash]);
  if (!found) {
    return { anchor, status: AnchorStatus.Missing, snapshotFreshness };
  }

  if (found.node.type !== anchor.nodeType) {
    return {
      anchor,
      status: AnchorStatus.Missing,
      mismatchReason: AnchorMismatchReason.NodeTypeMismatch,
      actualNodeType: found.node.type,
      snapshotFreshness,
    };
  }

  const currentVersionedId =
    typeof found.properties.versionedId === 'string' ? found.properties.versionedId : undefined;

  if (currentVersionedId === undefined) {
    return {
      anchor,
      status: AnchorStatus.Changed,
      mismatchReason: AnchorMismatchReason.VersionedIdAbsent,
      snapshotFreshness,
    };
  }

  return {
    anchor,
    status: currentVersionedId === anchor.capturedVersionedId ? AnchorStatus.Matched : AnchorStatus.Changed,
    currentVersionedId,
    snapshotFreshness,
  };
}

/**
 * Resolve the code anchors of one project's intent items against its active
 * graph. `observedCheckouts` is supplied by the caller (see
 * {@link readObservedCheckout}) so this function stays pure with respect to the
 * filesystem and git.
 */
export async function resolveIntentEvidence(input: IntentEvidenceInput): Promise<IntentEvidenceResult> {
  const repoNames = [...new Set(input.items.flatMap((item) => item.codeAnchors ?? []).map((anchor) => anchor.repo))];
  const repos = await collectRepoEvidence(input, repoNames);
  const freshnessByRepo = new Map(repos.map((repo) => [repo.repo, repo.snapshotFreshness]));

  // One lookup per distinct (repo, nodeId): a small overlay routinely anchors
  // several items to the same touchpoint.
  const lookups = new Map<string, Promise<AnchorEvidence>>();

  const items: IntentItemEvidence[] = [];
  for (const item of input.items) {
    const anchors = item.codeAnchors ?? [];
    if (anchors.length === 0) {
      items.push({ intentId: item.id, anchors: [], itemStatus: AnchorStatus.Unmapped });
      continue;
    }

    const resolved: AnchorEvidence[] = [];
    for (const anchor of anchors) {
      const key = `${anchor.repo}\x00${anchor.nodeId}\x00${anchor.nodeType}\x00${anchor.capturedVersionedId}`;
      let pending = lookups.get(key);
      if (!pending) {
        pending = resolveAnchor(
          anchor,
          lookupRepoHash(input.repoHashesByName, anchor.repo),
          input.repository,
          freshnessByRepo.get(anchor.repo) ?? SnapshotFreshness.Unknown,
        );
        lookups.set(key, pending);
      }
      resolved.push({ ...(await pending), anchor });
    }

    items.push({ intentId: item.id, anchors: resolved });
  }

  return { items, repos };
}
