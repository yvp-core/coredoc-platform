/**
 * Pure derivations for the intent browse surface, kept out of the components so
 * every one of them is assertable without a DOM (mirrors
 * `../observability/observability-panel-state.ts`).
 *
 * Two rules run through this module:
 *
 * - **`Empty` is a real state, not an error.** A knowledge base nobody has started
 *   yet has neither domains NOR product-root items, and the panel then offers the
 *   first write instead of an apology. Both counts are load-bearing: a product-root
 *   item needs no domain, so a workspace whose last domain was archived still has a
 *   knowledge base and must not be shown the onboarding invitation over it.
 * - **Counts come from the server, not from item pages.** The tree read carries
 *   every node's counts, so the structure column never tallies a list it may
 *   only have part of.
 */

import { stagedCard, type IntentStagedCard } from './intent-review-request.js';
import {
  IntentAuthority,
  IntentReviewAction,
  type IntentFeatureView,
  type IntentCountedFeature,
  type IntentItemSummary,
  type IntentNodeCounts,
  type IntentNodeDocument,
  type IntentTreeDomain,
  type IntentTreeResponse,
} from './types.js';

/** The tree node the browse surface is reading: a domain, one of its features, or the product root. */
export interface IntentTreeSelection {
  domainId: string | null;
  featureId: string | null;
}

/** Nothing selected — the product root, whose items are the whole workspace's. */
export const INTENT_ROOT_SELECTION: IntentTreeSelection = { domainId: null, featureId: null };

/** What the browse surface is showing right now. */
export enum IntentBrowseState {
  Loading = 'loading',
  Error = 'error',
  /** No domains AND no product-root items — the knowledge base is not set up. */
  Empty = 'empty',
  Ready = 'ready',
}

interface IntentBrowseStateInput {
  treeLoading: boolean;
  treeError: boolean;
  /** `null` while nothing has resolved yet; a number once the tree page is in hand. */
  domainCount: number | null;
  /** Live items attached to the product root, from the tree read; `null` while unresolved. */
  rootItemCount: number | null;
}

export function intentBrowseState(input: IntentBrowseStateInput): IntentBrowseState {
  if (input.treeError) return IntentBrowseState.Error;
  if (input.treeLoading || input.domainCount === null) return IntentBrowseState.Loading;
  if (input.domainCount > 0) return IntentBrowseState.Ready;
  // No domains: the product root is the only place left that can hold anything,
  // so its count — and only then — decides between the invitation and the items.
  if (input.rootItemCount === null) return IntentBrowseState.Loading;
  return input.rootItemCount === 0 ? IntentBrowseState.Empty : IntentBrowseState.Ready;
}

/** Display names for the tree nodes the review surface labels rows with. */
interface IntentTreeNames {
  domains: Record<string, string>;
  features: Record<string, string>;
}

/**
 * Domain and feature titles out of the tree pages in hand, plus whatever a
 * "show all features" read added. A node these reads never covered is absent,
 * and its id is shown instead — an id is a true label, an empty string is not.
 */
export function intentTreeNames(
  domains: readonly IntentTreeDomain[] | null,
  extraFeatures: readonly IntentFeatureView[] | null,
): IntentTreeNames {
  const names: IntentTreeNames = { domains: {}, features: {} };
  for (const domain of domains ?? []) {
    names.domains[domain.id] = domain.title;
    for (const feature of domain.features) names.features[feature.id] = feature.title;
  }
  for (const feature of extraFeatures ?? []) names.features[feature.id] = feature.title;
  return names;
}

/* ------------------------------------------------------------ item scope --- */

/**
 * Where an item sits relative to the selected tree node.
 *
 * DERIVED HERE, not read from the server. The scoped context read reports the
 * server's own applicability reason (`attached` / `inherited`), but the browse
 * list reads the item index, not the context read. The index carries
 * `domainId`/`featureId` on every row, which is exactly what these four cases
 * need.
 */
export enum IntentItemScope {
  /** Attached directly to the selected node. */
  Attached = 'attached',
  /** Attached to a feature below the selection (a domain view shows these). */
  InFeature = 'in_feature',
  /** Attached to the domain above the selected feature. */
  InheritedDomain = 'inherited_domain',
  /** Attached to the product root, above everything. */
  InheritedRoot = 'inherited_root',
}

type IntentItemPlacement = Pick<IntentItemSummary, 'domainId' | 'featureId'>;

export function intentItemScope(item: IntentItemPlacement, selection: IntentTreeSelection): IntentItemScope {
  if (item.domainId === null && item.featureId === null) {
    return selection.domainId === null ? IntentItemScope.Attached : IntentItemScope.InheritedRoot;
  }
  if (selection.featureId !== null) {
    if (item.featureId === selection.featureId) return IntentItemScope.Attached;
    if (item.featureId === null) return IntentItemScope.InheritedDomain;
    return IntentItemScope.InFeature;
  }
  if (item.featureId !== null) return IntentItemScope.InFeature;
  return IntentItemScope.Attached;
}

/**
 * The items that APPLY to the selection, out of a domain-scoped read.
 *
 * A feature view is read at its domain's scope on purpose: inheritance is part
 * of what applies to a feature, and the items route filters by exactly one node
 * — so reading the domain is the only way one call can carry both the feature's
 * own items and the domain's. A sibling feature's items come back in that read
 * and are dropped here; they apply to a branch the reader is not on.
 */
export function intentItemsInScope(
  items: readonly IntentItemSummary[] | null,
  selection: IntentTreeSelection,
): IntentItemSummary[] {
  if (items === null) return [];
  if (selection.featureId === null) return [...items];
  return items.filter((item) => intentItemScope(item, selection) !== IntentItemScope.InFeature);
}

/* ---------------------------------------------------------------- counts --- */

/** One tree node's live items (candidate or accepted), the candidates and the open questions among them. */
export interface IntentCountCell {
  items: number;
  pending: number;
  open: number;
  comments: number;
}

/**
 * The structure column's counts, straight from the tree read (see
 * `IntentTreeService.itemCounts`): a domain counts its whole subtree, a feature
 * only what is attached to it directly, the root what is attached to no node.
 * A node absent from these maps was never listed by a read in hand, and is
 * drawn without a number.
 */
export interface IntentTreeCounts {
  root: IntentCountCell;
  domains: Readonly<Record<string, IntentCountCell>>;
  features: Readonly<Record<string, IntentCountCell>>;
}

const NO_NODE_COUNTS: IntentNodeCounts = { itemCount: 0, pendingCount: 0, openQuestionCount: 0, openCommentCount: 0 };

/** From the tree pages, plus the features a "show all features" read listed past the tree's cap. */
export function intentTreeCounts(
  pages: readonly IntentTreeResponse[],
  moreFeatures: readonly IntentCountedFeature[] = [],
): IntentTreeCounts {
  const domains: Record<string, IntentCountCell> = {};
  const features: Record<string, IntentCountCell> = {};
  const cell = (node: IntentNodeCounts): IntentCountCell => ({
    items: node.itemCount,
    pending: node.pendingCount,
    open: node.openQuestionCount,
    comments: node.openCommentCount,
  });
  for (const page of pages) {
    for (const domain of page.domains) {
      domains[domain.id] = {
        items: domain.subtreeItemCount,
        pending: domain.subtreePendingCount,
        open: domain.subtreeOpenQuestionCount,
        comments: domain.subtreeOpenCommentCount,
      };
      for (const feature of domain.features) features[feature.id] = cell(feature);
    }
  }
  for (const feature of moreFeatures) features[feature.id] = cell(feature);
  return {
    root: cell(pages[0]?.root ?? NO_NODE_COUNTS),
    domains,
    features,
  };
}

/* --------------------------------------------------------------- filters --- */

export interface IntentItemFilter {
  /** Sent to the items route, which matches it against title, id and statement. */
  search: string;
  /** Empty means every kind; otherwise only these. */
  kinds: readonly string[];
  /** Candidates alongside accepted items; off leaves only accepted. */
  includeCandidates: boolean;
  /** Rejected and superseded items, which are hidden by default. */
  includeResolved: boolean;
  /**
   * Only decisions whose choice is still open. Shared with the structure
   * column's "Only with open questions" toggle, so the tree and the list narrow
   * together and clearing either clears both.
   */
  openQuestions: boolean;
  /** Shared with the structure column's toggle, like `openQuestions`. */
  openComments: boolean;
}

export const DEFAULT_INTENT_ITEM_FILTER: IntentItemFilter = {
  search: '',
  kinds: [],
  includeCandidates: true,
  includeResolved: false,
  openQuestions: false,
  openComments: false,
};

/** Items grouped by kind, in the browse filter's kind order. */
export function groupIntentItemsByKind(
  items: readonly IntentItemSummary[],
  order: readonly string[],
): { kind: string; items: IntentItemSummary[] }[] {
  const groups = new Map<string, IntentItemSummary[]>();
  for (const item of items) {
    const bucket = groups.get(item.kind);
    if (bucket) bucket.push(item);
    else groups.set(item.kind, [item]);
  }
  const ordered = [
    ...order.filter((kind) => groups.has(kind)),
    ...[...groups.keys()].filter((k) => !order.includes(k)),
  ];
  return ordered.map((kind) => ({ kind, items: groups.get(kind) as IntentItemSummary[] }));
}

/** One anchor's identity inside the detail pane — anchors have no surrogate id. */
export function intentAnchorKey(anchor: { repoKey: string; nodeId: string }): string {
  return `${anchor.repoKey}\n${anchor.nodeId}`;
}

/**
 * Every waiting proposal a node document shows, as review cards: standalone
 * candidates and the candidates riding on the item they would replace, with
 * the versions a supersede must check on both sides.
 */
export function intentDocumentProposals(document: IntentNodeDocument): {
  cards: IntentStagedCard[];
  predecessorVersions: Record<string, number>;
} {
  const cards: IntentStagedCard[] = [];
  const predecessorVersions: Record<string, number> = {};
  const card = (id: string, version: number, title: string, proposedSuccessorOfId: string | null) =>
    cards.push(stagedCard({ id, version, title, proposedSuccessorOfId }, IntentReviewAction.Accept));
  for (const section of document.sections) {
    for (const block of section.blocks) {
      if (block.type !== 'item') continue;
      const { item } = block;
      if (item.authority === IntentAuthority.Candidate)
        card(item.id, item.version, item.title, item.proposedSuccessorOfId);
      if (item.pendingSuccessor) {
        predecessorVersions[item.id] = item.version;
        card(item.pendingSuccessor.id, item.pendingSuccessor.version, item.pendingSuccessor.title, item.id);
      }
    }
  }
  return { cards, predecessorVersions };
}
