/**
 * Removes everything belonging to withheld repos from a graph read result.
 *
 * Every repo of a workspace lives in one graph, and the repositories treat
 * `repoHashes` as "the query touches these repos", not "stay inside them": a
 * cross-repo bridge, a caller list or a neighbor expansion legitimately reaches
 * into other repos. An access area needs a hard boundary instead, so it is
 * enforced here, on the one facade every hosted read goes through, rather than
 * in each method of each backend.
 *
 * The rule relies on node ids being prefixed with their repo hash: a record
 * that names a withheld repo in any of its own string fields (id, repoId,
 * sourceId, targetId, callerId, …) is withheld. Withheld records are dropped
 * from lists and maps; a withheld result is `null`.
 *
 * ponytail: counts computed inside the database (neighbor tallies, coverage
 * totals) still include withheld nodes — they reveal that something exists, not
 * what.
 */

const WITHHELD = Symbol('withheld');

export function withholdRepos<T>(value: T, withheldRepoHashes: readonly string[]): T | null {
  if (withheldRepoHashes.length === 0) return value;
  const names = (text: string): boolean =>
    withheldRepoHashes.some((hash) => text === hash || text.startsWith(`${hash}:`));

  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return names(node) ? WITHHELD : node;
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(visit).filter((item) => item !== WITHHELD);
    if (node instanceof Set) return new Set([...node].map(visit).filter((item) => item !== WITHHELD));
    if (node instanceof Map) {
      const kept = [...node].map(([key, item]) => [visit(key), visit(item)] as const);
      return new Map(kept.filter(([key, item]) => key !== WITHHELD && item !== WITHHELD));
    }
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) return node;

    const record = node as Record<string, unknown>;
    if (Object.values(record).some((field) => typeof field === 'string' && names(field))) return WITHHELD;
    const copy: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(record)) {
      if (names(key)) continue;
      const kept = visit(field);
      // A withheld record held as a field (`{ node, properties }`) withholds its holder too.
      if (kept === WITHHELD) return WITHHELD;
      copy[key] = kept;
    }
    return copy;
  };

  const result = visit(value);
  return result === WITHHELD ? null : (result as T);
}
