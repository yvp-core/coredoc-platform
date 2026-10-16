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
  IntentContextMatchState,
  IntentItemKind,
  IntentReviewOutcome,
  IntentSnapshotFreshness,
  type ContextCondition,
  type DimensionValueSelection,
  type IntentDimension,
  type IntentListConditions,
  type IntentListContextMatch,
  type TreeCondition,
} from './types.js';
import { IntentItemScope } from './intent-panel-state.js';

/** The badge variants this feature uses, from `components/ui/badge.tsx`. */
export type IntentBadgeVariant =
  | 'accepted'
  | 'candidate'
  | 'rejected'
  | 'superseded'
  | 'reason'
  | 'replace'
  | 'ok'
  | 'warn'
  | 'err'
  | 'info'
  | 'neutral';

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
  [IntentAuthority.Candidate]: 'candidate',
  [IntentAuthority.Accepted]: 'accepted',
  [IntentAuthority.Rejected]: 'rejected',
  [IntentAuthority.Superseded]: 'superseded',
};

export function authorityLabel(authority: IntentAuthority): string {
  return AUTHORITY_LABELS[authority] ?? authority;
}

export function authorityVariant(authority: IntentAuthority): IntentBadgeVariant {
  return AUTHORITY_VARIANTS[authority] ?? 'neutral';
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
  [IntentAnchorStatus.Matched]: 'ok',
  [IntentAnchorStatus.Changed]: 'warn',
  [IntentAnchorStatus.Missing]: 'err',
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
  return status === undefined ? 'neutral' : (ANCHOR_STATUS_VARIANTS[status] ?? 'neutral');
}

const FRESHNESS_VARIANTS: Record<IntentSnapshotFreshness, IntentBadgeVariant> = {
  [IntentSnapshotFreshness.Current]: 'info',
  [IntentSnapshotFreshness.Stale]: 'warn',
  [IntentSnapshotFreshness.Unknown]: 'neutral',
  [IntentSnapshotFreshness.Unverified]: 'neutral',
};

export function snapshotFreshnessVariant(freshness: IntentSnapshotFreshness | undefined): IntentBadgeVariant {
  return freshness === undefined ? 'neutral' : (FRESHNESS_VARIANTS[freshness] ?? 'neutral');
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

export function effectivityVariant(state: import('./release-types.js').IntentEffectivity) {
  return (
    { effective: 'ok', planned: 'info', withdrawn: 'warn', not_effective: 'neutral', unknown: 'neutral' } as const
  )[state];
}

/* --------------------------------------------------- context conditions --- */

type Registry = readonly IntentDimension[] | null | undefined;

const dimensionOf = (dimensions: Registry, id: string) => dimensions?.find((dimension) => dimension.id === id);

/** A dimension value's title from the registry, falling back to its id. */
export function dimensionValueTitle(dimensions: Registry, dimensionId: string, valueId: string): string {
  return dimensionOf(dimensions, dimensionId)?.values.find((value) => value.id === valueId)?.title ?? valueId;
}

/** One own clause as chip text, with value titles: "BR, US", "not BR", "where <item>". */
function clauseChipText(clause: ContextCondition, dimensions: Registry): string {
  if ('text' in clause) return 'text condition';
  if ('item' in clause) return `where ${clause.item}`;
  const titles = (ids: string[]) => ids.map((id) => dimensionValueTitle(dimensions, clause.dimension, id)).join(', ');
  return 'in' in clause ? titles(clause.in) : `not ${titles(clause.notIn)}`;
}

/**
 * A browse row's condition chips: the item's own clauses as one chip, then
 * "inherited" when a domain/feature adds conditions, then "N variants".
 */
export function conditionChips(conditions: IntentListConditions | undefined, dimensions: Registry): string[] {
  if (!conditions) return [];
  const chips: string[] = [];
  if (conditions.own && conditions.own.length > 0)
    chips.push(conditions.own.map((clause) => clauseChipText(clause, dimensions)).join(' · '));
  if (conditions.inherited) chips.push('inherited');
  if (conditions.variants) chips.push(conditions.variants === 1 ? '1 variant' : `${conditions.variants} variants`);
  return chips;
}

/** A preview row the context could not settle: "depends on Country", or "not machine-evaluated". */
export function contextMatchChip(match: IntentListContextMatch | undefined, dimensions: Registry): string | null {
  if (!match) return null;
  if (match.state === IntentContextMatchState.Unevaluated) return 'not machine-evaluated';
  if (match.state !== IntentContextMatchState.Open) return null;
  if (match.open.length === 0) return 'depends on context';
  return `depends on ${match.open.map((id) => dimensionOf(dimensions, id)?.title ?? id).join(', ')}`;
}

/**
 * The "preview as" choice as canonical context JSON — sorted keys and values;
 * an empty list stays (it means "none of these") — or `null` when nothing is
 * chosen. Canonical so the same choice is always the same query key.
 */
export function canonicalPreviewContext(selection: DimensionValueSelection): string | null {
  const entries = Object.entries(selection)
    .map(([dimension, value]) => [dimension, Array.isArray(value) ? [...value].sort() : value] as const)
    .filter(([, value]) => value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? null : JSON.stringify(Object.fromEntries(entries));
}

/** A dimension a node's conditions use, with the titles of the values its clauses name. */
export interface ConditionDimension {
  id: string;
  title: string;
  values: string[];
}

/** The dimensions a set of tree clauses use, in first-use order, value titles de-duplicated. */
export function conditionDimensions(clauses: readonly TreeCondition[], dimensions: Registry): ConditionDimension[] {
  const used = new Map<string, ConditionDimension>();
  for (const clause of clauses) {
    const entry = used.get(clause.dimension) ?? {
      id: clause.dimension,
      title: dimensionOf(dimensions, clause.dimension)?.title ?? clause.dimension,
      values: [],
    };
    for (const value of 'in' in clause ? clause.in : clause.notIn) {
      const title = dimensionValueTitle(dimensions, clause.dimension, value);
      if (!entry.values.includes(title)) entry.values.push(title);
    }
    used.set(clause.dimension, entry);
  }
  return [...used.values()];
}

const SOURCE_REF = /^[a-z][a-z0-9-]*:\S/;
const URL_SCHEME = /^(?:https?|ftp|mailto|file|data|javascript):/i;

/**
 * Remove parenthesised groups made only of source refs (and the dates imports
 * write beside them), with their italic stars: `*(jira:PROD-1, 2022-01-27)*`.
 * A group with any other text in it stays. Mirrors `stripRefs` in the server's
 * `intent-read.service.ts`, which strips the same groups for agents.
 */
export function stripSourceRefs(text: string): string {
  // Code and diagram fences pass through untouched.
  return text
    .split(/(```[\s\S]*?```)/)
    .map((part) => (part.startsWith('```') ? part : stripRefsOutsideCode(part)))
    .join('');
}

function stripRefsOutsideCode(text: string): string {
  return text
    .replace(/\s*\*?\(([^()]*)\)\*?/g, (match: string, inner: string, offset: number, whole: string) => {
      // `[label](target)` is a link, never a citation.
      if (whole[offset - 1] === ']') return match;
      // Each `;` part is one citation: a ref, then optional locators or a date after it.
      const parts = inner.split(/;\s*/).map((part) => part.trim());
      if (!parts.every((part) => SOURCE_REF.test(part) && !URL_SCHEME.test(part))) return match;
      // `*(refs)*` goes whole; a trailing star that closes an outer italic stays.
      const opensItalic = match.trimStart().startsWith('*');
      return !opensItalic && match.endsWith('*') ? '*' : '';
    })
    .replace(/[ \t]+([.,;:])/g, '$1')
    .replace(/[ \t]+$/gm, '');
}

export function openCommentsLabel(count: number | undefined): string | null {
  if (!count) return null;
  return `${count} open ${count === 1 ? 'comment' : 'comments'}`;
}

/** An error's message for display; `undefined` for no error. */
export function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : error ? String(error) : undefined;
}
