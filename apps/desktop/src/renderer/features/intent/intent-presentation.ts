/**
 * Pure presentation vocabulary for the intent knowledge base.
 *
 * Kept out of the components so the mapping from a wire value to a badge or a
 * label is testable on its own, matching `observability-format.ts` /
 * `capture-health-state.ts` in the neighbouring feature.
 *
 * The two trust markers stay SEPARATE here as well: {@link anchorStatusLabel}
 * describes the anchor, {@link snapshotFreshnessVariant} describes the snapshot
 * the anchor was judged against, and no function in this module combines them.
 * Spec §6.4 — a matched anchor on an old snapshot is not proof of anything, so
 * the UI must never collapse the pair into one verdict.
 */

import {
  IntentAnchorStatus,
  IntentAuthority,
  AuthoringHintKind,
  IntentItemKind,
  IntentReviewOutcome,
  IntentSnapshotFreshness,
  type AuthoringHint,
  type ContextCondition,
  type DimensionValueSelection,
  type TreeCondition,
} from '../../../shared/intent-types.js';
import { IntentItemScope } from './intent-panel-state';

/** The badge variants this feature uses, from `components/ui/badge.tsx`. */
export type IntentBadgeVariant = 'initial' | 'success' | 'warning' | 'error' | 'info' | 'outlineInitial';

const AUTHORITY_LABELS: Record<IntentAuthority, string> = {
  [IntentAuthority.Candidate]: 'Candidate',
  [IntentAuthority.Accepted]: 'Accepted',
  [IntentAuthority.Rejected]: 'Rejected',
  [IntentAuthority.Superseded]: 'Superseded',
};

/**
 * Authority → badge. `accepted` is the only positive state; `candidate` reads as
 * in-progress (info/dodger-blue, the design's `progress` tag), and both terminal
 * states are neutral or negative rather than dressed up.
 */
const AUTHORITY_VARIANTS: Record<IntentAuthority, IntentBadgeVariant> = {
  [IntentAuthority.Candidate]: 'info',
  [IntentAuthority.Accepted]: 'success',
  [IntentAuthority.Rejected]: 'error',
  [IntentAuthority.Superseded]: 'initial',
};

export function authorityLabel(authority: IntentAuthority): string {
  return AUTHORITY_LABELS[authority] ?? authority;
}

export function authorityVariant(authority: IntentAuthority): IntentBadgeVariant {
  return AUTHORITY_VARIANTS[authority] ?? 'initial';
}

const KIND_LABELS: Record<IntentItemKind, string> = {
  [IntentItemKind.Capability]: 'Capability',
  [IntentItemKind.UseCase]: 'Use case',
  [IntentItemKind.Flow]: 'Flow',
  [IntentItemKind.BusinessRule]: 'Business rule',
  [IntentItemKind.Limitation]: 'Limitation',
  [IntentItemKind.Decision]: 'Decision',
};

export function kindLabel(kind: IntentItemKind): string {
  return KIND_LABELS[kind] ?? kind;
}

/** Every kind, in the order the browse filter offers them. */
export const INTENT_KIND_ORDER: readonly IntentItemKind[] = [
  IntentItemKind.Capability,
  IntentItemKind.UseCase,
  IntentItemKind.Flow,
  IntentItemKind.BusinessRule,
  IntentItemKind.Limitation,
  IntentItemKind.Decision,
];

const ANCHOR_STATUS_LABELS: Record<IntentAnchorStatus, string> = {
  [IntentAnchorStatus.Matched]: 'Anchor matched',
  [IntentAnchorStatus.Changed]: 'Anchor changed',
  [IntentAnchorStatus.Missing]: 'Anchor missing',
};

const ANCHOR_STATUS_VARIANTS: Record<IntentAnchorStatus, IntentBadgeVariant> = {
  [IntentAnchorStatus.Matched]: 'success',
  [IntentAnchorStatus.Changed]: 'warning',
  [IntentAnchorStatus.Missing]: 'error',
};

/**
 * `undefined` is NOT `missing`: the server omits the field when the graph could
 * not be read at all (§6.3 degradation), which is a different statement and must
 * be labelled as one rather than being rendered as a drift verdict.
 */
export function anchorStatusLabel(status: IntentAnchorStatus | undefined): string {
  return status === undefined ? 'Anchor unevaluated' : (ANCHOR_STATUS_LABELS[status] ?? status);
}

export function anchorStatusVariant(status: IntentAnchorStatus | undefined): IntentBadgeVariant {
  return status === undefined ? 'outlineInitial' : (ANCHOR_STATUS_VARIANTS[status] ?? 'initial');
}

const FRESHNESS_VARIANTS: Record<IntentSnapshotFreshness, IntentBadgeVariant> = {
  [IntentSnapshotFreshness.Current]: 'info',
  [IntentSnapshotFreshness.Stale]: 'warning',
  [IntentSnapshotFreshness.Unknown]: 'outlineInitial',
  [IntentSnapshotFreshness.Unverified]: 'outlineInitial',
};

export function snapshotFreshnessVariant(freshness: IntentSnapshotFreshness | undefined): IntentBadgeVariant {
  return freshness === undefined ? 'outlineInitial' : (FRESHNESS_VARIANTS[freshness] ?? 'initial');
}

const OUTCOME_LABELS: Record<IntentReviewOutcome, string> = {
  [IntentReviewOutcome.Accepted]: 'Accepted',
  [IntentReviewOutcome.Rejected]: 'Rejected',
  [IntentReviewOutcome.Superseded]: 'Superseded',
  [IntentReviewOutcome.Deferred]: 'Deferred',
  [IntentReviewOutcome.NeedsEdit]: 'Needs edit',
  [IntentReviewOutcome.Refused]: 'Refused',
};

export function outcomeLabel(outcome: IntentReviewOutcome): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

export function outcomeVariant(outcome: IntentReviewOutcome): IntentBadgeVariant {
  if (outcome === IntentReviewOutcome.Refused) return 'error';
  if (outcome === IntentReviewOutcome.Accepted || outcome === IntentReviewOutcome.Superseded) return 'success';
  return 'initial';
}

/**
 * Pretty-print an item payload for the detail pane. A payload is optional and
 * free-form (D9), so this only formats — it never asserts a kind-specific shape.
 */
export function formatPayload(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/** ISO timestamp → the compact form used across the desktop's dense rows. */
export function formatIntentTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').slice(0, 16);
}

/* --------------------------------------------------------- browse labels --- */

/**
 * Where an item sits relative to the selection, as the reason badge says it.
 *
 * `null` for a directly attached item: a badge that says "this is attached
 * here" on every row of a list that is already scoped to here is noise, and the
 * badge is only interesting when the item comes from somewhere else.
 */
export function itemScopeLabel(scope: IntentItemScope, featureTitle?: string | null): string | null {
  switch (scope) {
    case IntentItemScope.Attached:
      return null;
    case IntentItemScope.InFeature:
      return featureTitle ? `in ${featureTitle}` : 'in a feature';
    case IntentItemScope.InheritedDomain:
      return 'inherited · domain';
    case IntentItemScope.InheritedRoot:
      return 'inherited · product root';
    default:
      return null;
  }
}

/** The three-word marks the anchor rows carry, short enough to sit side by side. */
export function anchorStatusMark(status: IntentAnchorStatus | undefined): string {
  return status === undefined ? 'anchor unevaluated' : `anchor ${status}`;
}

export function snapshotFreshnessMark(freshness: IntentSnapshotFreshness | undefined): string {
  return freshness === undefined ? 'snapshot not reported' : `snapshot ${freshness}`;
}

/* -------------------------------------------------------- payload details --- */

/** `primaryActor` → `Primary actor`; an already-spaced key is left alone. */
export function humanizeIntentKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One row of the per-kind details grid. `values` carries a list-valued field. */
export interface IntentDetailField {
  key: string;
  label: string;
  value: string | null;
  values: string[] | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const scalarText = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
};

/**
 * The payload as a key/value grid, WITHOUT asserting a kind-specific shape: a
 * payload is optional and free-form on the wire (D9). An array or object that
 * is not all-scalar still gets a row — formatted as JSON — rather than
 * vanishing: a payload field is never silently dropped.
 *
 * `steps` is deliberately excluded — a flow's steps render as steps
 * ({@link intentFlowSteps}). `variants` is excluded too when every entry
 * parses ({@link intentPayloadVariants}) — it renders as a table instead of a
 * stringified cell — but a `variants` array that {@link intentPayloadVariants}
 * could not fully read still gets a raw-JSON row here, so a malformed variant
 * is never silently dropped even though the table only shows the valid ones
 * (AC-8).
 */
export function intentDetailFields(payload: unknown): IntentDetailField[] {
  if (!isPlainObject(payload)) return [];
  const fields: IntentDetailField[] = [];
  for (const [key, raw] of Object.entries(payload)) {
    if (key === 'steps') continue;
    if (key === 'variants') {
      if (Array.isArray(raw) && raw.length > 0) {
        const parsed = intentPayloadVariants(payload);
        if (parsed === null || parsed.length < raw.length) {
          fields.push({ key, label: humanizeIntentKey(key), value: formatPayload(raw), values: null });
        }
      }
      continue;
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) continue;
      const values = raw.map(scalarText).filter((entry): entry is string => entry !== null);
      if (values.length === raw.length) {
        fields.push({ key, label: humanizeIntentKey(key), value: null, values });
      } else {
        fields.push({ key, label: humanizeIntentKey(key), value: formatPayload(raw), values: null });
      }
      continue;
    }
    const value = scalarText(raw);
    if (value !== null && value !== '') {
      fields.push({ key, label: humanizeIntentKey(key), value, values: null });
      continue;
    }
    if (isPlainObject(raw) && Object.keys(raw).length > 0) {
      fields.push({ key, label: humanizeIntentKey(key), value: formatPayload(raw), values: null });
    }
  }
  return fields;
}

/**
 * A clause as a readable sentence (intent-dimensions spec, worked examples):
 * "country in de, pl", "country not in ua", "applies where <item id> applies".
 * A `text` clause is returned as-is — call {@link isUnevaluatedCondition} to
 * mark it as not machine-evaluated, matching BR-3.
 */
export function contextConditionText(clause: ContextCondition): string {
  if ('text' in clause) return clause.text;
  if ('item' in clause) return `applies where ${clause.item} applies`;
  if ('in' in clause) return `${clause.dimension} in ${clause.in.join(', ')}`;
  return `${clause.dimension} not in ${clause.notIn.join(', ')}`;
}

/** A `text` clause is never machine-evaluated (BR-3); every other clause is. */
export function isUnevaluatedCondition(clause: ContextCondition): boolean {
  return 'text' in clause;
}

/**
 * A variant's `when` as a readable clause: "country = de; product ∈ ta,
 * shifts", or "default" for the variant with no `when` (intent-dimensions
 * spec, worked examples).
 */
export function variantWhenText(when: DimensionValueSelection | undefined): string {
  if (!when || Object.keys(when).length === 0) return 'default';
  return Object.entries(when)
    .map(([dimension, value]) =>
      Array.isArray(value) ? `${dimension} ∈ ${value.join(', ')}` : `${dimension} = ${value}`,
    )
    .join('; ');
}

/** One numbered step of a flow payload, with its branch conditions. */
export interface IntentFlowStep {
  id: string;
  actor: string | null;
  action: string | null;
  outcome: string | null;
  branches: { condition: string; toStepId: string }[];
}

/**
 * A flow payload's steps, or `null` when the payload does not carry a step list
 * — which is the answer for every other kind, and for a flow whose payload does
 * not match the shape the CLI schema writes.
 */
export function intentFlowSteps(payload: unknown): IntentFlowStep[] | null {
  if (!isPlainObject(payload) || !Array.isArray(payload.steps)) return null;
  const steps: IntentFlowStep[] = [];
  for (const [index, raw] of payload.steps.entries()) {
    if (!isPlainObject(raw)) continue;
    const branches = Array.isArray(raw.branches)
      ? raw.branches.flatMap((branch) => {
          if (!isPlainObject(branch)) return [];
          const condition = scalarText(branch.condition);
          const toStepId = scalarText(branch.toStepId);
          return condition === null || toStepId === null ? [] : [{ condition, toStepId }];
        })
      : [];
    steps.push({
      id: scalarText(raw.id) ?? `step-${index + 1}`,
      actor: scalarText(raw.actor),
      action: scalarText(raw.action),
      outcome: scalarText(raw.outcome),
      branches,
    });
  }
  return steps.length === 0 ? null : steps;
}

/** One row of a `business_rule` payload's `variants` table. */
export interface IntentPayloadVariant {
  when: DimensionValueSelection | undefined;
  /**
   * The raw `when` value, kept ONLY when sanitizing it lost entries — a
   * present-but-malformed `when` must never collapse to the same "default"
   * reading as a genuinely absent one (AC-8); see {@link variantWhenCell}.
   */
  whenRaw: unknown;
  outcome: string;
  inputs: string[] | null;
}

const sanitizeWhen = (raw: Record<string, unknown>): DimensionValueSelection | undefined => {
  const when: DimensionValueSelection = {};
  for (const [dimension, value] of Object.entries(raw)) {
    if (typeof value === 'string') when[dimension] = value;
    else if (Array.isArray(value)) {
      const values = value.filter((entry): entry is string => typeof entry === 'string');
      if (values.length > 0) when[dimension] = values;
    }
  }
  return Object.keys(when).length === 0 ? undefined : when;
};

/** Whether sanitizing dropped a key, or filtered entries out of an array value. */
const isWhenLossy = (raw: Record<string, unknown>, sanitized: DimensionValueSelection | undefined): boolean => {
  const sanitizedKeys = sanitized ? Object.keys(sanitized) : [];
  if (sanitizedKeys.length !== Object.keys(raw).length) return true;
  return Object.entries(raw).some(([dimension, value]) => {
    if (!Array.isArray(value)) return false;
    const kept = sanitized?.[dimension];
    return !Array.isArray(kept) || kept.length !== value.length;
  });
};

/**
 * A `business_rule` payload's `variants`, or `null` when the payload does not
 * carry any — the answer for every other kind, and for a rule whose payload
 * predates this schema addition.
 */
export function intentPayloadVariants(payload: unknown): IntentPayloadVariant[] | null {
  if (!isPlainObject(payload) || !Array.isArray(payload.variants)) return null;
  const variants: IntentPayloadVariant[] = [];
  for (const raw of payload.variants) {
    if (!isPlainObject(raw)) continue;
    const outcome = scalarText(raw.outcome);
    if (outcome === null) continue;
    const inputs = Array.isArray(raw.inputs)
      ? raw.inputs.filter((entry): entry is string => typeof entry === 'string')
      : null;
    const rawWhen = isPlainObject(raw.when) ? raw.when : undefined;
    const when = rawWhen ? sanitizeWhen(rawWhen) : undefined;
    const whenLossy =
      raw.when !== undefined && (rawWhen === undefined || when === undefined || isWhenLossy(rawWhen, when));
    variants.push({
      when,
      whenRaw: whenLossy ? raw.when : undefined,
      outcome,
      inputs: inputs && inputs.length > 0 ? inputs : null,
    });
  }
  return variants.length === 0 ? null : variants;
}

/**
 * The variant table's "When" cell text: {@link variantWhenText} for a `when`
 * that sanitized cleanly (including a genuinely absent one, which reads
 * "default"), or the raw JSON of `when` when sanitizing lost part or all of
 * it — a rule slice must never masquerade as the default outcome (AC-8).
 */
export function variantWhenCell(variant: IntentPayloadVariant): string {
  // JSON.stringify, not formatPayload: formatPayload(null) is null, which would
  // fall back to "default" and hide the very loss this raw rendering exists to surface.
  if (variant.whenRaw !== undefined) return JSON.stringify(variant.whenRaw, null, 2);
  return variantWhenText(variant.when);
}

/** One group of an item's inherited tree conditions, labelled by the level it came from. */
export interface InheritedConditionGroup {
  source: 'domain' | 'feature';
  clauses: TreeCondition[];
}

/**
 * An item's inherited conditions as ordered, non-empty groups (domain first,
 * then feature) — never merged into the item's own `appliesWhen` list, so the
 * source stays visible (intent-dimensions-inheritance spec, UC-3).
 */
export function inheritedConditionGroups(inherited?: {
  domain?: TreeCondition[];
  feature?: TreeCondition[];
}): InheritedConditionGroup[] {
  if (!inherited) return [];
  const groups: InheritedConditionGroup[] = [];
  if (inherited.domain && inherited.domain.length > 0) groups.push({ source: 'domain', clauses: inherited.domain });
  if (inherited.feature && inherited.feature.length > 0) groups.push({ source: 'feature', clauses: inherited.feature });
  return groups;
}

/** "from domain shifts" / "from feature overtime-brazil" — the group's source label. */
export function inheritedConditionSourceLabel(
  group: InheritedConditionGroup,
  domainId?: string | null,
  featureId?: string | null,
): string {
  const id = group.source === 'domain' ? domainId : featureId;
  return id ? `from ${group.source} ${id}` : `from ${group.source}`;
}

const scalarOrListText = (value: string | string[]): string => (Array.isArray(value) ? value.join(', ') : value);

/**
 * A non-blocking authoring hint as a readable sentence (BR-3, BR-5, worked
 * examples). Variant numbers are shown 1-based; the wire's `variants`/`variant`
 * indices are 0-based.
 */
export function authoringHintText(hint: AuthoringHint): string {
  switch (hint.kind) {
    case AuthoringHintKind.MissingCondition:
      return `Mentions “${hint.matched}” (${hint.dimension} = ${hint.value}) but has no ${hint.dimension} condition`;
    case AuthoringHintKind.AmbiguousVariants: {
      const [first, second] = hint.variants;
      const context = Object.entries(hint.context)
        .map(([dimension, value]) => `${dimension} = ${scalarOrListText(value)}`)
        .join('; ');
      return `Variants ${first + 1} and ${second + 1} both match ${context} — add a more specific variant`;
    }
    case AuthoringHintKind.DeadVariant:
      return `Variant ${hint.variant + 1} can never apply under the item's conditions`;
    case AuthoringHintKind.UnacceptedConditionItem:
      return `Applies where ${hint.item} applies, but ${hint.item} is not accepted yet — until it is, this condition filters nothing`;
  }
}

export function effectivityVariant(state: import('../../../shared/intent-release-types.js').IntentEffectivity) {
  return (
    {
      effective: 'success',
      planned: 'info',
      withdrawn: 'warning',
      not_effective: 'outlineInitial',
      unknown: 'initial',
    } as const
  )[state];
}
