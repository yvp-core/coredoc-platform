/**
 * Shared product-intent contract types: kinds, authority, sources, anchors,
 * per-kind payloads, and context dimensions.
 *
 * Product intent is durable, human-reviewed knowledge owned by a cloud
 * workspace. It is deliberately NOT part of `ParsedRepo` / `OutputFormat`: the
 * code graph is rebuildable parser output, intent is not.
 *
 * An intent item `id` is a durable product identity, unrelated to
 * `StableIdGenerator` — code IDs change with the code, product identities must
 * not. It is a kind-prefixed slug (BR-16): free searchable text and
 * self-describing in a routed hand-off, which a numeric `BR-7` never was.
 */
import { NodeType } from '../types/graph.js';

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
// Null prototype, because `kind` can reach this table from agent-authored input
// BEFORE a schema has rejected an unknown value (`deriveIntentId` in
// derive-id.ts). On a plain object literal `kind: "constructor"` resolves up
// the prototype chain to a truthy inherited member, so the `prefix === undefined`
// fail-safe guarding such lookups never fires. Defend the MAP, not each read.
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
 * a derived id is truncated at a word boundary to fit.
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
 * Item-level conditions, joined with AND; absent means unconditional.
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
  /** Human-readable name of the affected flow or capability. */
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
