import type { TypeUsage } from './types.js';

/** Immutable identity shared by graph-file publishers and readers. */
export const GRAPH_FILE_FORMAT_COMPATIBILITY = Object.freeze({
  engine: 'ladybug',
  engineVersion: '0.19.1',
  graphSchemaVersion: 1,
  /**
   * Identity of the code that BUILT the payload. `graphSchemaVersion` describes the storage
   * schema (node/edge tables), which did not change; this describes the meaning of what is
   * written into it, which did.
   *
   * phase3-v1 → phase4-v1 because the persisted edge payload changed five ways:
   *  1. CALLS gained `provenance` (how the callee was resolved) on every edge.
   *  2. CALLS gained `provenanceInferred: true` plus reduced confidence on inferred lineages
   *     (`iface-impl`), which previously did not exist and would have been stored at 1.0.
   *  3. USES_TYPE gained `useKind` / `member` for value-position (enum member) references.
   *  4. USES_TYPE gained the `member-access` and `construction` usage values.
   *  5. Messaging entrypoints gained a derived `name` instead of the raw node id.
   *
   * And — the reason a reader must be able to tell the vintages apart rather than just diff
   * the property set — `ambiguous` on a heritage USES_TYPE row was REINTERPRETED. See
   * {@link heritageIdentityIsVerifiable}.
   */
  builderVersion: 'phase4-v1',
  storageFormatVersion: 1,
} as const);

// Why the added `UnresolvedCall` table bumped none of the versions above: it is
// purely additive and no existing payload changed meaning. A reader that
// predates the table never names it (`validateLadybugGraphSchema` requires a
// SUBSET of tables, so an extra one is ignored), and a reader that knows it
// answers unresolved-call queries as empty on a file that lacks it. Both
// versions are compared for EXACT equality by the R2 object-metadata and
// snapshot-manifest gates, so bumping either would fail-close every
// already-published snapshot over a difference no reader can be wrong about.

/**
 * Builders whose heritage USES_TYPE rows carry the phase4 meaning of `ambiguous`.
 *
 * Deliberately an allow-list of known-good builders rather than a deny-list of known-bad ones:
 * an unrecognised (older, or newer-than-this-reader) builder answers `false`, so the worst
 * outcome is a verified edge rendered as unverified. The reverse default would assert identity
 * for a payload this reader has never seen.
 *
 * A future builder that preserves the phase4 heritage semantics must be appended here.
 */
const HERITAGE_IDENTITY_VERIFIED_BUILDER_VERSIONS: ReadonlySet<string> = new Set<string>([
  GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion,
]);

/**
 * Whether `ambiguous: false` on an `extends` / `implements` USES_TYPE row from this builder may
 * be read as "the parser VERIFIED the base's identity".
 *
 * The flag was reinterpreted in phase4-v1. An unresolved heritage clause with exactly one
 * same-named in-repo declaration used to be written `confidence: 1.0, ambiguous: false`, meaning
 * only "unique NAME match" — the identity was never checked. Phase4 writes the same edge
 * `confidence: 0.5, ambiguous: true`, meaning "identity never verified".
 *
 * Published snapshots are immutable, so both vintages coexist in one workspace whenever a repo
 * was pushed before the bump and another after. On a PRE-phase4 snapshot `ambiguous: false` on
 * such a row is NOT proof of identity, and a consumer that renders it as verified (as
 * `packages/mcp/src/type-usage.ts` does) is asserting something the writer never claimed.
 *
 * Returns false for an absent/unknown builder version — a reader that cannot establish the
 * vintage must not claim verification.
 *
 * Rollout: publishing a phase4 graph requires a re-parse + re-push; the read paths that gate on
 * `GRAPH_FILE_FORMAT_COMPATIBILITY` (R2 object metadata and the snapshot manifest) already
 * compare `builderVersion` for exact equality, so pre-bump artifacts fail closed there rather
 * than being silently mixed.
 */
export function heritageIdentityIsVerifiable(builderVersion: string | null | undefined): boolean {
  if (builderVersion === null || builderVersion === undefined) return false;
  return HERITAGE_IDENTITY_VERIFIED_BUILDER_VERSIONS.has(builderVersion);
}

/**
 * USES_TYPE `usage` values whose `ambiguous` flag changed meaning at phase4.
 *
 * A heritage clause (`extends` / `implements`) is the only place the transformer
 * reinterpreted the flag: pre-phase4 it meant "one same-named declaration existed"
 * (written `ambiguous: false`), post-phase4 it means "identity was actually proved".
 * Every other usage kind kept its meaning, so downgrading them would invent a
 * caveat the writer never implied.
 */
const HERITAGE_USAGE_KINDS: ReadonlySet<string> = new Set(['extends', 'implements']);

/**
 * Wrap a repository so heritage rows from a pre-phase4 snapshot report as
 * unverified.
 *
 * The alternative — threading the snapshot vintage through the MCP scope and into
 * every formatter — puts the burden on each consumer to remember, and a new tool
 * that reads `getTypeUsages` would silently reintroduce the false claim. Doing it
 * at the READ boundary means the rows a consumer can observe are already honest,
 * so `type-usage.ts` needs no vintage awareness at all.
 *
 * Returns the repository untouched when the vintage IS verifiable, so a current
 * snapshot pays nothing.
 */
export function withHeritageIdentityDowngrade<T extends { getTypeUsages: IGraphTypeUsageReader['getTypeUsages'] }>(
  repository: T,
  builderVersion: string | null | undefined,
): T {
  if (heritageIdentityIsVerifiable(builderVersion)) return repository;
  const downgraded: ProxyHandler<T> = {
    get(target, property, receiver) {
      if (property !== 'getTypeUsages') return Reflect.get(target, property, receiver);
      return async (...args: Parameters<IGraphTypeUsageReader['getTypeUsages']>) => {
        const rows = await target.getTypeUsages(...args);
        return rows.map((row) =>
          HERITAGE_USAGE_KINDS.has(row.usage) && !row.ambiguous ? { ...row, ambiguous: true } : row,
        );
      };
    },
  };
  return new Proxy(repository, downgraded);
}

/** The single method {@link withHeritageIdentityDowngrade} rewrites. */
interface IGraphTypeUsageReader {
  getTypeUsages(typeId: string, repoHashes: string[]): Promise<TypeUsage[]>;
}
