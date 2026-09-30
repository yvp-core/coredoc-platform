# Adding a Language to coredoc

> **Status: shipped.** `providers/`, the `LanguageProvider` interface and the single
> language registry (`providers/registry.ts`, wired once in `providers/index.ts`) are in
> the tree — the snippets here are importable code, not a proposed shape. Registered
> providers today: **TS/JS, Ruby, Swift, Python, Rust, Go, Zig, Kotlin**. Each of the seven
> non-TS ones was added with zero edits to the engine, the scorer or dispatch, which is the
> property this contract exists to hold.

You need this guide when your language is **not** already registered (see the list above)
*and* the existing detector/rule vocabulary can't express its constructs. If your language
is already registered and you're onboarding a new framework (NestJS, Rails, Grape, Prisma…),
you want [ADDING-A-FRAMEWORK.md](./ADDING-A-FRAMEWORK.md) instead — that's pure data, no code.

## The mental model — three layers

coredoc parses every language through **one** pipeline with a clean separation:

```
ExtractionProfile (declarative data)  ─┐
                                       ├─►  SubstrateProfileEngine  ─►  ParsedRepo
your Substrate (language facts)       ─┘   (language-neutral interpreter)
```

1. **Profile** — declarative rules describing a framework's conventions (decorators,
   call shapes, handler tables). Pure data. You author one *per framework*, not per language.
2. **Engine** (`substrate/engine.ts`) — a language-neutral interpreter. It contains no
   tree-sitter, no SCIP, no `.tsx` knowledge. **You do not touch it.**
3. **Substrate** — the only language-specific layer. It answers the engine's questions
   ("give me the classes", "give me call sites matching this pattern") from your
   language's AST/CST. **This is what you implement.**

Adding a language = implement one `Substrate` (+ a thin `LanguageProvider` wrapper) and
register it in one place. The engine and scorer are reused unchanged.

## Step 0 — Verify the grammar before you write anything

Node type names, which children are named **fields**, and whether a literal exposes its value as
a child all vary between grammars *and* between builds of the same grammar. Getting one wrong
does not fail loudly — it returns an empty string or the wrong node, forever:

```
npx tsx packages/profile-parser/scripts/dump-grammar.ts <language> <representative-file>
```

That prints the CST from the exact grammar build `TreeSitterLoader` loads, annotates every node
with its `childForFieldName` fields, and ends with a **literal probe** naming the trap surface.
Run it on a file that exercises your language's real constructs (a router, a model, a call chain)
and write the substrate from what it prints.

Two traps this repo has already paid for, both invisible to a unit test written against the same
wrong assumption:

- **A literal with no content child.** Python's `string` exposes `string_content`, so the natural
  idiom is `descendantsOfType('string_content')[0]?.text`. Rust's `string_literal` and Go's
  `interpreted_string_literal` have `namedChildCount === 0` — that idiom returns `''` for *every*
  string: empty routes, empty table names, empty SQL, no error. Hence `rustStringValue` /
  `goStringValue`. The probe tells you which world you are in.
- **A declaration whose name is not an `identifier`.** A Go `method_declaration`'s name is a
  `field_identifier`, so `descendantsOfType('identifier')[0]` returns the *receiver variable*.
  Always take names from `childForFieldName('name')` — which the dump shows you per node type.

## Step 1 — Implement the substrate

Most languages are **backend-only** (no JSX-style component tree). Implement
`BackendSubstrate` (already segregated at `substrate/interface.ts`); the engine runs in
backend-only mode via a capability probe (it checks `'componentSites' in substrate`,
**never** `language === '…'`). Implement the full `Substrate` only if your language has a
frontend story.

The method catalog (`BackendSubstrate`), each answered from your language's AST/CST:

| Method | Responsibility |
|---|---|
| `files()` | Source files in scope, honoring the profile's `include`/`exclude` globs. |
| `classes()` / `functions()` | Project declarations to `SubstrateClass` / `SubstrateFunction`. |
| `callShapes(pattern)` | Call sites matching a pattern → `CallSite` / `ArgNode` (receiver chains, args). |
| `externalCalls(matchers)` | Outbound HTTP/queue/RPC calls → `ExternalCallFact` (IDs via `idGen`). |
| `internalCalls()` | Resolved function→function calls. Return `[]` if you have no symbol index yet (the engine tolerates an empty set — document it as an intentional Tier-B gap). |
| `hasFunctionId(id)` | Membership test for emitted function IDs (handler gating). |
| `resolveConst*` / `resolveMethodOnClass` / `requireRegistry` / `functionId` | Best-effort symbol resolution over your AST. Return empty when N/A — never guess. |
| `idGen` | The repo's `StableIdGenerator`. **Every ID flows through this.** See the invariant below. |

### What a `Package` maps to

Nothing about the schema decides this for you, and the languages already here answer it
differently: TS uses the workspace package, Rust uses the crate. Both happen to be *both* the
manifest unit and the import unit, which hides the choice.

**Pick the unit your language IMPORTS, not the unit that carries the manifest**, whenever they
differ. Go is the worked example: its manifest is `go.mod` but its import *and* scoping unit is
the directory. Emitting one Package per module gave **1 Package for 483 files** on a real
service — every `FileNode.packageId` identical, so the layer carried no information and the
same-package call tier had nothing to key on. Per-directory gave 54.

Two consequences fall out of choosing the import unit:

- **Manifest facts stay module-scoped.** A dependency list belongs to the manifest unit; copying
  it onto each of 54 packages asserts that every one of them depends on all of it. Carry
  `manifestFile` on each package so the owner stays discoverable, and stamp `dependencies` only
  on the package at the manifest's own path.
- **The manifest root may hold no source of its own.** `server/go.mod` beside `server/cmd/…` is
  the normal Go layout, so a strict directories-with-files rule drops the require list entirely.
  Emit the manifest root as a package too; owning zero files is a fact about the repo.

Emit real `FileNode`s when the substrate supports structural file output — they are valuable graph
nodes and `multi/merge.ts` uses them for its overlap guard. Do not make whole-repo scoring depend on
them, though: Ruby and Swift intentionally have no FileNodes today. The provider-owned `sourceFiles`
contract below is the authoritative ownership set for every substrate.

## Step 2 — The two-ID invariant (load-bearing)

Every node ID is `{repoHash}:{type}:{path}:{name}` minted by `StableIdGenerator`, seeded
with the repo's `repoKey`; `{type}` must be a member of `NodeIdKind`/`EdgeIdKind` in
`@coredoc/core`; `versionedId` carries a real content checksum (not a constant).

**Never hand-build ID strings.** This is the exact contract the legacy Ruby path violated
(prefixing the raw repo name, inventing `ep:`/`dbop:`/`rbfn:` tokens, stamping `@1`),
which silently broke `belongsToRepo()`, `parseId()`, change-detection, and **cross-repo
linking** for Ruby output. If your language has a concept with no canonical `NodeIdKind`,
add a real member to `@coredoc/core` — do not invent a token.

## Step 3 — The `LanguageProvider`

A provider is the single per-language object the registry holds:

```ts
export interface LanguageProvider<P extends BaseProfile = BaseProfile> {
  /** The discriminant — also the value of `profile.substrate.language`. */
  readonly language: string;
  readonly aliases?: readonly string[];
  readonly discovery: LanguageDiscovery; // { extensions, scipPrereqs? }
  /** Does this exported value belong to THIS provider? */
  isProfile(v: unknown): v is P;
  /** Exact intended + intentionally excluded source sets, using the parser's effective defaults. */
  sourceFiles(profile: P, repoRoot: string): SourceFileScope;
  /** The one parse entry point. Returns a ParsedRepo whose IDs all flow through idGen. */
  parse(profile: P, opts: ParseOptions): Promise<ParsedRepo>;
  /** Source-signal denominators for the scorer (your grep dialect). */
  sourceSignals(ctx: ScoreContext): SourceSignals;
  /** Optional language-specific validation + consistency checks. */
  structuralChecks?(ctx: ScoreContext): StructuralResult;
}
```

The provider does **not** expose the substrate — that's the internal contract between
your `parse()` and the engine. `parse()` builds your substrate and runs the shared
`SubstrateProfileEngine`.

## Step 4 — File discovery

Declare every primary code `extension` that `sourceFiles` can include in `discovery` — metadata and actual discovery must agree
(`.vue`/`.mts`/`.cts` for TS, `.pyi` for Python, `.rake` for Ruby). Implement `sourceFiles` through
the same git-aware, `.gitignore`-honoring discovery function your parser uses, including its effective
default excludes and the profile's include/exclude policy. The whole-repo scorer uses its `included`
paths as target ownership and its `excluded` paths as intentional exclusions; it never guesses from
`ParsedRepo.files`. Declare `scipPrereqs` only if your language needs a semantic-index prerequisite
(TS uses it to require `node_modules` for scip-typescript; most languages omit it).

## Step 5 — Register (the one wiring point)

Add a single line to `providers/index.ts`:

```ts
registerLanguage(myLanguageProvider);
```

That one edit is the *entire* wiring. Dispatch, the name registry, discovery, and scoring
all read the registry — there is no second place to touch.

Once registered, your provider is automatically usable as a `targets[]` entry in a
`MultiTargetProfile` (multi-language monorepos) — the composite dispatcher
(`providers/resolve.ts`) resolves each target's `substrate.language` against the same
registry. The one static-typing wiring point to extend there is the `TargetProfile` union
in `types/multi-profile.ts` (mirroring `providers/index.ts`); nothing else about the
multi-target path is language-specific.

## Step 6 — Scoring

Implement `sourceSignals` (count what your language's source *should* yield — the
denominators) and `emittedCounts` (what the parse *did* yield — the numerators). The
shared `scoring/score-core.ts` computes the verdict (`≥0.8 PASS / ≥0.5 PARTIAL`) and the
coverage table. You write no scoring math.

## Step 7 — Measure resolution, and stamp `parserVersion`

Your parse **must** fill `stats.callResolution` and `stats.dbOpResolution` on the `ParsedRepo` it
returns. These are the repo-wide trust signal: MCP reads an absent record as *"this substrate never
measured"* and says so, and it reads zeros as *"measured, and nothing resolved"* — so never write
zeros to stand in for unknown.

Three rules make the numbers mean something:

- **Count SITES, before the shippable filter.** A site your resolver enumerated and then dropped —
  unresolved, ambiguous, self-edge, below your precision bar — still belongs in the denominator.
  Counting only what shipped makes every substrate report 100 %.
- **Say what is UNCOUNTED, and pin it with a test.** A site with no caller node (a module- or
  package-scope call) can never resolve, so it is excluded by construction, not missed. Every such
  exclusion needs a named must-NOT twin — a fixture with one excluded site and one ordinary site,
  asserting the denominator counts exactly one. See
  `substrate/go/go-callgraph.test.ts` → *"must NOT count a package-scope call site"* and its
  Python, Rust, Swift and Zig siblings.
- **Read `boundDbOps` back from the emitted operations**, never from a loop counter: two sites that
  collapse to one operation must count once (`substrate/go/go-dbops.ts` and the Python, Swift and
  Zig lanes all derive it from their output array).

Stamp `parserVersion` at **`>= 1.1.0-<lang>`** in your `toFullParsedRepo`. Anything with a `1.0.x`
semver core is read as predating the messaging-descriptor schema
(`MESSAGING_SCHEMA_VERSION` in `packages/mcp/src/tools/cross-repo/messaging-data.ts`), which
permanently excludes every repo you parse from `trace_cross_repo_call`'s messaging graph and prints
a "re-parse and push" warning that a re-parse can never clear. Bump the suffixed version whenever
your substrate's extraction changes, the same way `PARSER_VERSION` is bumped for the engine.

## Acceptance test (how you know you're done)

Your provider works end-to-end with **zero edits** to `substrate/engine.ts`,
`parser-loader.ts`, `scoring/score-core.ts`, or any profile/name registry. If you had to
edit any of those, the contract leaked — that's a bug in the seam, not in your provider;
file an issue. (The migration's own final step enforces exactly this with a throwaway stub
provider.)

## Worked skeleton

```
packages/profile-parser/src/providers/<lang>.ts   # your LanguageProvider
packages/profile-parser/src/substrate/<lang>/      # your Substrate + AST/CST projection
```

Reference implementations, in increasing order of how much you'd copy:

| Provider | Shape |
|---|---|
| `providers/typescript.ts` | wraps the SCIP engine (Tier-A semantic index) |
| `providers/ruby.ts` | tree-sitter-ruby → `BackendSubstrate` |
| `providers/python.ts` | tree-sitter + an OPTIONAL scip-python Tier-A that degrades to Tier-B |
| `providers/rust.ts` | tree-sitter only, no semantic indexer at all — the thinnest provider, and the one to copy if your language has no SCIP indexer (`substrate/rust/` shows the full CST substrate: crates, `mod`/`use` module graph, entrypoints, entities, db-ops, egress, Tier-B calls) |
| `providers/go.ts` | the same tree-sitter-only shape as Rust, for a language whose compilation unit is the DIRECTORY rather than the file (`substrate/go/`: go.mod modules, the package/import table, entrypoints, entities, db-ops, egress, Tier-B calls) |
| `providers/zig.ts` | tree-sitter only, no SCIP and no `structuralChecks` (there is no Zig semantic indexer), for a language whose import graph lives in `build.zig` rather than in the source (`substrate/zig/`: files, one root package, classes/enums/functions, a `build.zig` module/executable map, `@import` binding tables and `ImportEdge`s, five Tier-B call tiers, `cli` entrypoints from `pub fn main`, `std.http.Client` egress, raw-SQL entities and db-ops, constants split into variables and type aliases) |
| `providers/kotlin.ts` | the one to copy when your grammar exposes **no fields at all** and the repo's shape lives in build files and XML rather than in the source. `Language.fieldCount === 0` for the bundled Kotlin grammar, so every accessor in `substrate/kotlin/kotlin-cst.ts` is positional by node type and the catalogue was pinned with `dump-grammar.ts` before a single lane was written. It also shows the non-TS way to emit UI: `components`, `routes` and their layout links come from the provider's own parser, never from the engine's frontend lane, and screen-to-screen navigation is a `ComponentUsage` rather than a `RouteNode`. Two packages per repo shape (one per Kotlin package as the import unit, plus build-module roots owning zero files), `mobile` entrypoints read from `AndroidManifest.xml`, Retrofit egress whose path template folds in the client's configured base path, Room and Realm entities and operations, four `kt-*` call tiers plus `iface-impl` |
