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
