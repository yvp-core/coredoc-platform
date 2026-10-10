/** Per-language SCIP indexer invocation. command is argv[0]; args are templated in run-indexer. */
export const SCIP_INDEXERS = {
  typescript: { command: 'scip-typescript', baseArgs: ['index'] },
} as const;

export const PARSER_ID = 'coredoc-code-graph-tsjs-v1';

/**
 * Extraction-behaviour version. It is a cache key, not a release number.
 *
 * `manifestsMatch` compares it, and a match makes `runProfile` return the PRIOR `parsed.json`
 * with no baseline, no SCIP and no engine pass. So any change to what the engine or a substrate
 * EXTRACTS — new node/edge kinds, changed ids, changed resolution — must bump this, or callers
 * with a warm cache and unchanged source keep the old graph and the change ships invisibly.
 *
 * 1.2.6: distinguish incomplete semantic indexing from structural extraction errors in cache reuse.
 * Re-parse warm caches once; graph IDs are unchanged.
 *
 * 1.2.5: optional compiler call resolution for Ruby/Python/Go/Rust and actual TS analysis mode.
 * Stable node/edge ID formulas are unchanged; compiler evidence can add or retarget calls.
 * Ruby SCIP package identity is fixed at coredoc-local@0: source hashes are cache keys only.
 * Rebuild experimental snapshots from this unreleased branch to replace hash-versioned Ruby edges.
 * MIGRATION: re-parse and push --rebuild to replace the prior snapshot. Warm incremental caches
 * are invalidated by this version. Rollback also requires re-parsing with the prior parser.
 *
 * 1.2.4: Ruby synthesizes association-reader FunctionNodes (new method ids), binds `Klass.new` to
 * `initialize`, and retargets edges through multi-argument `include` and Grape `helpers` mixins;
 * every substrate now records `stats.callResolution` / `stats.dbOpResolution`; the Kotlin substrate
 * is registered; `ComponentNode.templateFile` is emitted. See MIGRATION below.
 * 1.2.3: Zig substrate emits imports/calls/entrypoints/egress/SQL entities+ops/variables/aliases;
 * shared `CREATE TABLE` column parser (sql-ddl.ts) no longer swallows the constraint keyword into
 * `dbType` (Rust output changes).
 * 1.2.2: Ruby class and method STABLE IDS are now nesting-qualified
 * (`Billing::Client.fetch`, not `Client.fetch`). Two same-named classes in different namespaces
 * declared in ONE file previously minted one id, so the second definition was dropped and its
 * calls bound to the first — a wrong edge at full confidence. This changes persisted ids for
 * every Ruby repo, so it needs a re-parse; the bump is what forces one on a warm cache.
 * See MIGRATION below.
 * 1.2.1: Swift now emits the package/file/class nodes referenced by its functions and entities;
 * TypeScript workspace indexing now isolates root-owned and config-less project source.
 * 1.2.0: extraction changed materially (Vue SFC, file-convention routes, pages-api `ALL`
 * entrypoints, await-import CALLS, USES_TYPE member types, lazy() route componentIds, python
 * file/class nodes + DRF/urlconf/model-base lanes, rust classes, package-import facts).
 */
export const PARSER_VERSION = '1.2.6';

/**
 * MIGRATION — 1.2.3 → 1.2.4 (Ruby association readers + resolution records)
 *
 * WHAT CHANGED:
 *   - Ruby synthesizes a `FunctionNode` per association reader (`has_many :orders` →
 *     `Company#orders`). Those are node ids that did not exist before, and calls that used to
 *     resolve to nothing now bind to them.
 *   - Ruby binds `Klass.new` to that class's `initialize` (a constructor CALL edge where there
 *     was none), and resolves methods reached through a multi-argument `include A, B` or a Grape
 *     `helpers` mixin — existing edges are RETARGETED, not just added.
 *   - Every substrate now records `stats.callResolution` and `stats.dbOpResolution`; a graph
 *     parsed before this has neither, and MCP reads an absent record as "not measured".
 *   - The Kotlin substrate is registered, so a repo with `.kt` sources extracts where it did not.
 *   - `ComponentNode.templateFile` is emitted and persisted.
 *
 * WHO IS AFFECTED: every repo — the resolution records are new for all of them. Ruby repos also
 * gain nodes and change edge targets; repos with Kotlin sources gain a whole language.
 *
 * PROCEDURE: `coredoc parse` + `coredoc push --rebuild` per project. The bump is contract
 * discipline (GUARDRAILS #3) plus the `parserVersion` value persisted on the repo node, which
 * consumers gate on (`packages/mcp/src/tools/cross-repo/messaging-data.ts`).
 *
 * ROLLBACK: revert and re-parse. Nothing here reads the old graph in place; every changed id and
 * edge is a pure function of the source.
 */

/**
 * MIGRATION — 1.2.2 → 1.2.3 (shared SQL entity names)
 *
 * WHAT CHANGED: the shared `singularize` now strips `-es` after `x`/`z`/`ch`/`sh`/`ss` (it used
 * to strip it after `us` too). And the shared `CREATE TABLE` column parser (`sql-ddl.ts`) no
 * longer swallows the constraint keyword into `dbType`. Both are correctness fixes.
 *
 * WHO IS AFFECTED: repos whose entities come from plain SQL DDL — Rust (and now Zig). For a
 * table like `idb_indexes` or `classes` the entity NAME changes, and `entityId(relPath,
 * entityName)` is minted from that name, so those ids change on re-parse. TypeScript
 * decorator-relation `targetEntityName` guesses (`engine.ts`'s `singularize(propName)`
 * fallback) change the same way. Repos with no such table re-parse to identical output.
 *
 * PROCEDURE: none beyond a re-parse — the `PARSER_VERSION` bump invalidates a warm incremental
 * cache, so `coredoc parse` + `coredoc push --rebuild` per project converges the graph.
 *
 * ROLLBACK: revert and re-parse; both formulas are pure functions of the source.
 */

/**
 * MIGRATION — 1.2.1 → 1.2.2 (Ruby stable ids)
 *
 * Required by GUARDRAILS #3: an edit to `StableIdGenerator`'s INPUTS ships with a documented
 * migration in the same change. The inputs changed for Ruby only — `rubyMethodId` and
 * `rubyClassNode` now hash the nesting-qualified container name.
 *
 * WHO IS AFFECTED: any repo with Ruby sources. TypeScript, Python, Go, Rust and Swift ids are
 * untouched, so a repo without Ruby re-parses to byte-identical output.
 *
 * WHAT BREAKS IF YOU SKIP IT: Ruby node ids are join keys. A graph built before the bump and one
 * built after cannot be cross-referenced — `find_callers`, `analyze_change_impact` and every
 * cross-repo link keyed on a Ruby function or class id will miss.
 *
 * PROCEDURE: `coredoc parse` (this bump invalidates the incremental cache, so it is a full
 * re-parse) then `coredoc push --rebuild` per project. For a cloud workspace the same push
 * re-materializes the snapshot; the `builderVersion` bump to `phase4-v1` in `@coredoc/db`
 * independently marks the published artifact, so a stale snapshot is detectable rather than
 * silently mixed.
 *
 * ROLLBACK: revert the commit and re-parse. The old ids are reproducible from the same source,
 * because both formulas are pure functions of (repoRoot, relPath, container, name) — nothing was
 * lost, only re-derived.
 */
