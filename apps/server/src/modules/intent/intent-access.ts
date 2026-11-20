/**
 * Which intent domains the current reader may not see.
 *
 * The ids are decided once per request (`ControlPlaneService.withheldIntentDomains`,
 * rules in auth/iam.ts) and carried here rather than through every method
 * signature: intent is read from dozens of queries, many of them raw SQL, and a
 * forgotten parameter would be a silent leak. Code that runs outside a request
 * (release, handoff, CI bindings) has no store and sees every domain.
 *
 * A node of a withheld domain must look like it does not exist: excluded from
 * lists and counts, and "not found" when asked for by id.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '../../generated/prisma/client.js';

const storage = new AsyncLocalStorage<readonly string[]>();

export function withWithheldIntentDomains<T>(domainIds: readonly string[], run: () => T): T {
  return storage.run(domainIds, run);
}

export function withheldIntentDomains(): readonly string[] {
  return storage.getStore() ?? [];
}

/**
 * The `visible*` filters are wrapped in `AND` so that spreading one into a
 * `where` cannot be overwritten by a `domainId` or `id` condition next to it.
 * Do not spread one into a `where` that has its own `AND` key: nest it there.
 */

/** Product-root items carry no domain and are never withheld. */
export function visibleItems(): Prisma.IntentItemWhereInput {
  const withheld = withheldIntentDomains();
  return withheld.length ? { AND: [{ OR: [{ domainId: null }, { domainId: { notIn: [...withheld] } }] }] } : {};
}

export function visibleFeatures(): Prisma.IntentFeatureWhereInput {
  const withheld = withheldIntentDomains();
  return withheld.length ? { AND: [{ domainId: { notIn: [...withheld] } }] } : {};
}

export function visibleDomains(): Prisma.IntentDomainWhereInput {
  const withheld = withheldIntentDomains();
  return withheld.length ? { AND: [{ id: { notIn: [...withheld] } }] } : {};
}

/**
 * The same test as a raw SQL predicate: `column` is the domain id of the row,
 * e.g. `Prisma.sql\`i.domain_id\``. `TRUE` when nothing is withheld.
 */
export function visibleDomainSql(column: Prisma.Sql): Prisma.Sql {
  const withheld = withheldIntentDomains();
  return withheld.length
    ? Prisma.sql`(${column} IS NULL OR ${column} <> ALL(${[...withheld]}::text[]))`
    : Prisma.sql`TRUE`;
}
