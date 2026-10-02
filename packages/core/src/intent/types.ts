/**
 * Product-intent overlay contract (`IntentFileV2`).
 *
 * This is a DURABLE, human-reviewed artifact stored beside the code at
 * `<repoRoot>/.coredoc/intent.json`. It is deliberately NOT part of `ParsedRepo`
 * / `OutputFormat`: the code graph is rebuildable parser output, the intent
 * overlay is not, and a reparse must never rewrite it.
 *
 * The intent item `id` is a durable product identity chosen by the maintainer or
 * derived by capture from the item's title. It is unrelated to
 * `StableIdGenerator` — code IDs change with the code, product identities must
 * not. Since v2 it is a kind-prefixed slug (BR-16): the id is free searchable
 * text for the deterministic lexical matcher and self-describing in a routed
 * hand-off, which a numeric `BR-7` never was.
 */
import { NodeType } from '../types/graph.js';

/**
 * Version 2 is the ONLY supported shape. A lower value (the pre-slug, pre-domain
 * v1 overlay) is refused with migration remediation and a higher value is
 * refused as a newer schema — neither is dual-read or silently upgraded
 * (BR-22).
 */
export const INTENT_SCHEMA_VERSION = 2;

/** The v1 shape this build refuses; named so the refusal can be traced to BR-22. */
export const INTENT_LEGACY_SCHEMA_VERSION = 1;

/** The six supported semantic kinds. There is no generic `note`/`knowledge` escape hatch. */
export enum IntentKind {
  Capability = 'capability',
  UseCase = 'use_case',
  Flow = 'flow',
  BusinessRule = 'business_rule',
  Limitation = 'limitation',
  Decision = 'decision',
}

/**
 * The fixed id prefix per kind (BR-16). Authored as a total `Record` over the
 * enum so adding a kind fails the build here rather than silently producing an
 * id no validator can classify.
 */
// Null prototype, because `kind` reaches this table straight from an
// agent-authored proposals document BEFORE the discriminated union has rejected
// an unknown value (`provisionalProposalId` in capture-file.ts, `deriveIntentId`
// in capture.ts). On a plain object literal `kind: "constructor"` resolves up
// the prototype chain to a truthy inherited member, so the `prefix === undefined`
// fail-safe guarding those lookups never fires. Defend the MAP, not each read.
export const INTENT_ID_PREFIX_BY_KIND: Record<IntentKind, string> = Object.assign(Object.create(null), {
  [IntentKind.Capability]: 'cap',
  [IntentKind.UseCase]: 'uc',
  [IntentKind.Flow]: 'flow',
  [IntentKind.BusinessRule]: 'br',
  [IntentKind.Limitation]: 'lim',
  [IntentKind.Decision]: 'dec',
});

/**
 * Slug form shared by intent item ids and domain ids: lowercase `a-z0-9` words
 * joined by single hyphens, first word starting with a letter.
 */
export const INTENT_SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Cap on a written item id. An id is quoted in hand-offs, error messages, and
 * eval transcripts, so it must stay a label rather than becoming a sentence;
 * capture truncates a derived id at a word boundary to fit.
 */
export const INTENT_ID_MAX_LENGTH = 64;

/** Who has accepted the product assertion. Only an explicit maintainer edit leaves `candidate`. */
export enum IntentAuthority {
  Candidate = 'candidate',
  Accepted = 'accepted',
  Rejected = 'rejected',
  Superseded = 'superseded',
}

/** Provenance kind of the reviewed artifact a statement was captured from. */
export enum IntentSourceKind {
  Spec = 'spec',
  Issue = 'issue',
  Adr = 'adr',
  Manual = 'manual',
}

/** The controlled relation registry; endpoint kinds are constrained per relation. */
export enum IntentRelationType {
  Contains = 'contains',
  Governs = 'governs',
  Constrains = 'constrains',
  Decides = 'decides',
  DependsOn = 'depends_on',
  Supersedes = 'supersedes',
}

/**
 * ADR-style status of the CHOICE recorded by a `decision` item.
 *
 * Deliberately distinct from `IntentAuthority`: authority says whether the
 * maintainer accepted the intent record, `choiceStatus` says whether the product
 * choice it describes is proposed or accepted.
 */
export enum DecisionStatus {
  /** The question is recorded and nobody has chosen yet; `choice` is absent. */
  Open = 'open',
  Proposed = 'proposed',
  Accepted = 'accepted',
}

/**
 * Anchorable node kinds — a SUBSET of the persisted `NodeType` taxonomy, limited
 * to the kinds the graph transformer actually stores `properties.versionedId`
 * for. Repository, package, and route nodes lack that contract and cannot be
 * anchored (LIM-5).
 */
export const VERSIONED_ANCHOR_NODE_TYPES = [
  NodeType.File,
  NodeType.Function,
  NodeType.Class,
  NodeType.Interface,
  NodeType.Entrypoint,
  NodeType.Entity,
  NodeType.Component,
  NodeType.StateStore,
  NodeType.TypeAlias,
  NodeType.Enum,
  NodeType.Variable,
  NodeType.ExternalCall,
] as const;

export type VersionedAnchorNodeType = (typeof VERSIONED_ANCHOR_NODE_TYPES)[number];

/** Artifact identity a statement came from — never the artifact's body (BR-14). */
export interface IntentSourceRef {
  kind: IntentSourceKind;
  /** Artifact/provider identity, e.g. `spec/widget-ordering` or `tracker/WID-14`. */
  ref: string;
  /** Identity of the statement inside that artifact, e.g. `BR-3`. */
  localId: string;
  revision?: string;
  locator?: string;
}

/** A touchpoint in the code graph. Evidence of where intent is implemented, not conformance proof. */
export interface CodeAnchor {
  repo: string;
  /** Stable node ID (`{repoHash}:{type}:{path}:{name}`). */
  nodeId: string;
  nodeType: VersionedAnchorNodeType;
  /** Versioned ID observed when the anchor was captured; drift makes the anchor `changed`. */
  capturedVersionedId: string;
  rationale: string;
}

export interface CapabilityPayload {
  outcome: string;
  beneficiary: string;
  boundary: string;
}

export interface UseCasePayload {
  primaryActor: string;
  trigger: string;
  preconditions: string[];
  successOutcome: string;
  failureOutcomes: string[];
}

/** A branch out of a flow step. `toStepId` must name a step inside the same flow. */
export interface FlowBranch {
  condition: string;
  toStepId: string;
}

/** Flow steps are nested values, not graph nodes (ADR-5). Array order IS the step order. */
export interface FlowStep {
  /** Local to the containing flow; unique inside it. */
  id: string;
  actor: string;
  action: string;
  outcome: string;
  branches?: FlowBranch[];
}

export interface FlowPayload {
  trigger: string;
  terminationCondition: string;
  steps: FlowStep[];
}

export interface BusinessRulePayload {
  condition: string;
  requiredOutcome: string;
  observer: string;
  exceptions?: string[];
  /** Per-context outcomes; at most one default (a variant without `when`). */
  variants?: RuleVariant[];
}

/** A value of a workspace-declared context dimension. */
export interface IntentDimensionValue {
  /** Slug identity, referenced by clauses, variants, and read contexts. */
  id: string;
  title: string;
  /** Alternative names, used only to recognise mentions in text (missing-condition hints). */
  aliases?: string[];
}

/**
 * A workspace-declared, enumerable context attribute (country, plan, role, …).
 * Values are flat: there is no hierarchy between them (LIM-2).
 */
export interface IntentDimension {
  /** Slug identity. */
  id: string;
  title: string;
  values: IntentDimensionValue[];
  /** A `multi` dimension holds several values at once in a context (subscribed products, permissions). */
  multi: boolean;
  archived?: boolean;
}

/** One clause of an item's `appliesWhen`; clauses are joined with AND. */
export type ContextCondition =
  | { dimension: string; in: string[] }
  | { dimension: string; notIn: string[] }
  /** Applies only where the referenced item applies (one level deep). */
  | { item: string }
  /** Human-readable, never machine-evaluated. */
  | { text: string };

/**
 * Item-level conditions, joined with AND; absent means unconditional. A cloud
 * item field only: the local overlay file format does not carry it (LIM-1).
 */
export interface IntentItemContextConditions {
  appliesWhen?: ContextCondition[];
}

/** Dimension id → one value id, or a list of value ids. */
export type DimensionValueSelection = Record<string, string | string[]>;

/** A reader-supplied context; a list is valid only for a `multi` dimension. */
export type IntentContext = DimensionValueSelection;

export interface RuleVariant {
  /** Absent means the default variant. A list names alternatives, not a conjunction. */
  when?: DimensionValueSelection;
  /** Text; may be a formula over `inputs` (LIM-3). */
  outcome: string;
  /** Runtime values a formula reads. Not dimensions, never enumerated. */
  inputs?: string[];
}

export interface LimitationPayload {
  constraint: string;
  reason: string;
  /**
   * Human-readable name of the affected flow or capability. The machine-checkable
   * link is a `constrains` relation; this field keeps the statement readable on
   * its own when the related item is not fetched.
   */
  affects: string;
}

export interface DecisionPayload {
  /** Question and context the decision answers. */
  question: string;
  /** Absent exactly when `choiceStatus` is `open`. */
  choice?: string;
  choiceStatus: DecisionStatus;
  rationale: string;
  alternatives: string[];
  consequences: string[];
}

/**
 * A declared product area (ADR-8). The registry is in-file and controlled: an
 * item may only reference a domain declared here, which is what keeps `domain`
 * a reviewable facet instead of a free-text tag zoo.
 */
export interface IntentDomain {
  /** Slug identity, referenced by `IntentItemBase.domain`. */
  id: string;
  title: string;
  /** Optional one-line scope of the area, for a reader deciding where an item belongs. */
  statement?: string;
}

interface IntentItemBase {
  /** Durable product identity; independent from `StableIdGenerator`. */
  id: string;
  /** Exactly one declared domain id (BR-18); membership is a field, not a relation. */
  domain: string;
  title: string;
  statement: string;
  authority: IntentAuthority;
  /** At least one reference is required (BR-5). */
  sources: IntentSourceRef[];
  codeAnchors?: CodeAnchor[];
}

export interface CapabilityItem extends IntentItemBase {
  kind: IntentKind.Capability;
  payload: CapabilityPayload;
}

export interface UseCaseItem extends IntentItemBase {
  kind: IntentKind.UseCase;
  payload: UseCasePayload;
}

export interface FlowItem extends IntentItemBase {
  kind: IntentKind.Flow;
  payload: FlowPayload;
}

export interface BusinessRuleItem extends IntentItemBase {
  kind: IntentKind.BusinessRule;
  payload: BusinessRulePayload;
}

export interface LimitationItem extends IntentItemBase {
  kind: IntentKind.Limitation;
  payload: LimitationPayload;
}

export interface DecisionItem extends IntentItemBase {
  kind: IntentKind.Decision;
  payload: DecisionPayload;
}

/** Discriminated by `kind`; the payload shape follows the kind. */
export type IntentItem = CapabilityItem | UseCaseItem | FlowItem | BusinessRuleItem | LimitationItem | DecisionItem;

export interface IntentRelation {
  from: string;
  type: IntentRelationType;
  to: string;
}

export interface IntentFileV2 {
  schemaVersion: typeof INTENT_SCHEMA_VERSION;
  projectId: string;
  /** The controlled domain registry; a declared-but-unused entry is valid (BR-19). */
  domains: IntentDomain[];
  items: IntentItem[];
  relations: IntentRelation[];
}

/**
 * What a capture operation proposes.
 *
 * `authority` is absent by construction: a captured item is always a
 * `candidate` (BR-1), so a proposal cannot express one. `id` is OPTIONAL:
 * omitted, capture derives the kind-prefixed slug from the title (BR-17);
 * supplied, it is validated against BR-16 for the proposal's kind and is
 * ignored when the proposal matches an existing item by source identity — ids
 * are never renamed.
 */
type ProposalOf<T extends IntentItem> = Omit<T, 'authority' | 'id'> & { id?: string };

export type IntentItemProposal =
  | ProposalOf<CapabilityItem>
  | ProposalOf<UseCaseItem>
  | ProposalOf<FlowItem>
  | ProposalOf<BusinessRuleItem>
  | ProposalOf<LimitationItem>
  | ProposalOf<DecisionItem>;
