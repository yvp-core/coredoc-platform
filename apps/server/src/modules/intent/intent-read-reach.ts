/**
 * Which items a read reaches beyond accepted ones.
 *
 * An IMPORTED candidate arrived with a workspace import and waits for a product
 * manager: it describes the product as it already runs, so it is likely right
 * and reviewed by nobody. That is provenance, not authority, so it is derived
 * from the item's `import` arrival transition and adds no authority state; an
 * item leaves the set the moment a review moves it out of `candidate`.
 */
import { IntentAuthoritySourceKind, IntentItemAuthority, Prisma } from '../../generated/prisma/client.js';

export interface IntentReadReach {
  /** Every candidate, proposed or imported. */
  includeCandidates?: boolean;
  /** Imported candidates only; `includeCandidates` already covers them. */
  includeImported?: boolean;
}

/** An item (aliased `i`) that arrived with a workspace import. */
export const importedSql = Prisma.sql`EXISTS (
  SELECT 1 FROM intent_authority_transitions t
  WHERE t.workspace_id = i.workspace_id AND t.item_id = i.id AND t.source_kind::text = 'import')`;

/** The authority predicate of a read, over `intent_items` aliased `i`. */
export function reachSql(reach: IntentReadReach): Prisma.Sql {
  if (reach.includeCandidates) return Prisma.sql`i.authority::text IN ('accepted', 'candidate')`;
  if (reach.includeImported)
    return Prisma.sql`(i.authority::text = 'accepted' OR (i.authority::text = 'candidate' AND ${importedSql}))`;
  return Prisma.sql`i.authority::text = 'accepted'`;
}

/** {@link reachSql} as a Prisma filter. */
export function reachWhere(reach: IntentReadReach): Prisma.IntentItemWhereInput {
  if (reach.includeCandidates)
    return { authority: { in: [IntentItemAuthority.accepted, IntentItemAuthority.candidate] } };
  if (reach.includeImported)
    return {
      OR: [
        { authority: IntentItemAuthority.accepted },
        {
          authority: IntentItemAuthority.candidate,
          transitions: { some: { sourceKind: IntentAuthoritySourceKind.import } },
        },
      ],
    };
  return { authority: IntentItemAuthority.accepted };
}

/** Select fragment that lets {@link isImportedCandidate} answer for a loaded item. */
export const IMPORT_ARRIVAL_SELECT = {
  transitions: { where: { sourceKind: IntentAuthoritySourceKind.import }, select: { id: true }, take: 1 },
} as const;

export function isImportedCandidate(item: { authority: IntentItemAuthority; transitions: unknown[] }): boolean {
  return item.authority === IntentItemAuthority.candidate && item.transitions.length > 0;
}

/*
 * Page order of a read: accepted first, then by id, so an unreviewed item never
 * takes a reviewed one's place on a page. `after` is the last id of the previous
 * page.
 *
 * The position of `after` is rebuilt from the item as it is NOW, and a review can
 * land between two pages. So only `candidate` counts as the second group: an item
 * accepted, superseded or rejected since stays in the first, and the continuation
 * may repeat rows but never skips an accepted one. A read that reaches no
 * candidate has one group and pages by id alone, whatever `after` names.
 */

export function reachesCandidates(reach: IntentReadReach): boolean {
  return Boolean(reach.includeCandidates || reach.includeImported);
}

/** `ORDER BY` terms over `intent_items` aliased `i`. */
export const reachOrderSql = Prisma.sql`(CASE WHEN i.authority::text = 'candidate' THEN 1 ELSE 0 END), i.id`;

/** The rows that follow `after` in {@link reachOrderSql}; an id naming no item continues the first group. */
export function afterInReachOrderSql(reach: IntentReadReach, workspaceId: string, after: string): Prisma.Sql {
  if (!reachesCandidates(reach)) return Prisma.sql`i.id > ${after}`;
  return Prisma.sql`((CASE WHEN i.authority::text = 'candidate' THEN 1 ELSE 0 END), i.id) > (COALESCE((
    SELECT CASE WHEN a.authority::text = 'candidate' THEN 1 ELSE 0 END FROM intent_items a
    WHERE a.workspace_id = ${workspaceId}::uuid AND a.id = ${after}), 0), ${after})`;
}

/**
 * {@link reachOrderSql} for Prisma. The enum declares `candidate` before
 * `accepted`, so descending puts accepted first among the two a read reaches.
 */
export const REACH_ORDER_BY = [{ authority: 'desc' }, { id: 'asc' }] as const;

/** {@link afterInReachOrderSql} for Prisma, given the current authority of the `after` item. */
export function afterInReachOrderWhere(
  reach: IntentReadReach,
  after: string,
  afterAuthority: IntentItemAuthority | undefined,
): Prisma.IntentItemWhereInput {
  const candidate = IntentItemAuthority.candidate;
  if (!reachesCandidates(reach)) return { id: { gt: after } };
  if (afterAuthority === candidate) return { authority: candidate, id: { gt: after } };
  return { OR: [{ authority: IntentItemAuthority.accepted, id: { gt: after } }, { authority: candidate }] };
}
