/**
 * Non-blocking authoring hints for a stored item (BR-3, BR-5), shared by the
 * propose response and the review queue so both show the same notes.
 */
import {
  ConditionLevel,
  IntentKind,
  composeEffectiveConditions,
  detectMissingConditionHints,
  detectVariantHints,
  HintKind,
  type AuthoringHint,
  type ContextCondition,
  type IntentDimension,
  type IntentDimensionValue,
  type RuleVariant,
} from '@coredoc/core';
import type { Prisma } from '../../generated/prisma/client.js';

/** The item fields hints read, with its attachment's tree conditions (relation selects). */
export const HINT_ITEM_SELECT = {
  kind: true,
  title: true,
  statement: true,
  payload: true,
  appliesWhen: true,
  domain: { select: { appliesWhen: true } },
  feature: { select: { appliesWhen: true } },
} as const;

export interface HintItemRow {
  kind: string;
  title: string;
  statement: string;
  payload: unknown;
  appliesWhen: unknown;
  domain: { appliesWhen: unknown } | null;
  feature: { appliesWhen: unknown } | null;
}

const conditionsOf = (value: unknown): ContextCondition[] | undefined =>
  Array.isArray(value) ? (value as ContextCondition[]) : undefined;

/**
 * Payload keys that name WHO acts or notices ("Absence Policies admin", "HR
 * admin"), not when a rule applies: a role word there is a description of a
 * person, never a missing condition, so these fields are not scanned.
 */
const PERSON_KEYS = new Set(['observer', 'primaryActor', 'beneficiary', 'actor']);

const stringsOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsOf)
      : value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, inner]) => (PERSON_KEYS.has(key) ? [] : stringsOf(inner)))
        : [];

const effectiveOf = (item: Pick<HintItemRow, 'appliesWhen' | 'domain' | 'feature'>) =>
  composeEffectiveConditions({
    [ConditionLevel.Domain]: conditionsOf(item.domain?.appliesWhen),
    [ConditionLevel.Feature]: conditionsOf(item.feature?.appliesWhen),
    [ConditionLevel.Item]: conditionsOf(item.appliesWhen),
  });

const itemRefsOf = (item: Pick<HintItemRow, 'appliesWhen'>) =>
  (conditionsOf(item.appliesWhen) ?? []).flatMap((clause) => ('item' in clause ? [clause.item] : []));

/** An item an `item` clause names: its effective dimension clauses and whether it is accepted yet. */
export interface ReferencedItem {
  clauses: ContextCondition[];
  accepted: boolean;
}

/**
 * The items `rows` name in `item` clauses, by id: one level deep, accepted or
 * candidate targets only (propose refuses rejected and superseded ones).
 */
export async function readReferencedClauses(
  reader: { intentItem: Prisma.TransactionClient['intentItem'] },
  workspaceId: string,
  rows: Pick<HintItemRow, 'appliesWhen'>[],
): Promise<Map<string, ReferencedItem>> {
  const ids = [...new Set(rows.flatMap(itemRefsOf))];
  if (ids.length === 0) return new Map();
  const refs = await reader.intentItem.findMany({
    where: { workspaceId, id: { in: ids }, authority: { in: ['accepted', 'candidate'] } },
    select: {
      id: true,
      authority: true,
      appliesWhen: true,
      domain: HINT_ITEM_SELECT.domain,
      feature: HINT_ITEM_SELECT.feature,
    },
  });
  return new Map(
    refs.map((ref) => [
      ref.id,
      { clauses: effectiveOf(ref).filter((clause) => 'dimension' in clause), accepted: ref.authority === 'accepted' },
    ]),
  );
}

export async function readHintDimensions(
  reader: { intentDimension: Prisma.TransactionClient['intentDimension'] },
  workspaceId: string,
): Promise<IntentDimension[]> {
  const rows = await reader.intentDimension.findMany({
    where: { workspaceId, archived: false },
    select: { id: true, title: true, values: true, multi: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => ({ ...row, values: row.values as unknown as IntentDimensionValue[] }));
}

export function authoringHintsOf(
  item: HintItemRow,
  dimensions: IntentDimension[],
  referenced: ReadonlyMap<string, ReferencedItem>,
): AuthoringHint[] {
  // A candidate target reads `unevaluated` (it filters nothing yet), so the reviewer is told before accepting.
  const unaccepted: AuthoringHint[] = [...new Set(itemRefsOf(item))]
    .filter((id) => referenced.get(id)?.accepted === false)
    .map((id) => ({ kind: HintKind.UnacceptedConditionItem, item: id }));
  if (dimensions.length === 0) return unaccepted;
  const effective = [...effectiveOf(item), ...itemRefsOf(item).flatMap((id) => referenced.get(id)?.clauses ?? [])];
  const variants =
    item.kind === IntentKind.BusinessRule ? (item.payload as { variants?: RuleVariant[] } | null)?.variants : undefined;
  // A variant's `when` holds value ids, not prose, and its dimensions are already handled by the rule.
  const varied = new Set((variants ?? []).flatMap((variant) => Object.keys(variant.when ?? {})));
  const payloadText = stringsOf(
    variants
      ? { ...(item.payload as object), variants: variants.map(({ when: _when, ...rest }) => rest) }
      : item.payload,
  );
  const text = [item.title, item.statement, ...payloadText].join('\n');
  return [
    ...unaccepted,
    ...detectMissingConditionHints(text, dimensions, effective).filter((hint) => !varied.has(hint.dimension)),
    ...(variants ? detectVariantHints(variants, effective, dimensions) : []),
  ];
}
