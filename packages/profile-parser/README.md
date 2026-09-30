# @coredoc/profile-parser

**Profile-driven code extraction.** Instead of hand-writing (or AI-writing) a bespoke ~600-line
parser per repository, you write a small **declarative `ExtractionProfile`** describing the repo's
conventions, and a single **generic engine** applies it to produce coredoc's `ParsedRepo` graph
(entrypoints, entities, DB operations, calls, external calls, components/routes/state stores).

The engine runs on a backend-neutral **tree-sitter + SCIP** substrate (`SubstrateProfileEngine`):
language-agnostic structure via web-tree-sitter plus a precise call graph from scip-typescript, both
supplied by `@coredoc/code-graph`'s `buildBaseline` (the substrate facts). This is **the** extraction
engine — it reproduces the bespoke parsers' output exactly (see [Status](#status)) and is the path the
`coredoc` CLI runs for a repo that has a `profile.ts`.

This package owns the Tree-sitter runtime, pinned WASM grammar dependencies, and
the loader and tree lifecycle helpers in `src/tree-sitter/`. CLI and Desktop
bundles copy those dependencies from this package. The shared `@coredoc/core`
package contains no parser runtime, so server and web installations do not pull
in grammars. The workspace skips the C# package's native install script because
analysis uses its prebuilt WASM.

---

## C# / .NET profiles

The C# WASM comes from the pinned
[0.23.5-coredoc.1 grammar release](https://github.com/yvp-core/tree-sitter-c-sharp/releases/tag/0.23.5-coredoc.1),
which fixes escaped braces immediately before interpolation in upstream 0.23.5.
The lockfile pins the release archive's SHA-512; the release includes SHA-256
checksums and build provenance. Desktop and CLI bundles consume its prebuilt
WASM, without building a grammar or requiring compiler tooling on the client.

`CSharpProfile` selects `substrate.language: 'csharp'` and source include/exclude
globs. The C# substrate interprets its rules and assembles the shared `ParsedRepo`
output contract, following the other language providers. C# framework facts and
rules live in `substrate/csharp/` and `types/csharp-profile.ts`; they do not extend
the TypeScript engine or its substrate interface.
Framework selectors belong in `libraries` and `nominal`; see the
[C# authoring reference](../../skills/author-profile/references/csharp.md) for the
supported controller, minimal-route, model, registration, DI and egress rules.

C# in CLI/CI defaults to enhanced analysis when the compiler tools can run, with a visible
warning and a syntax/lexical basic graph otherwise. Basic requires neither a
.NET SDK nor SCIP. The C# target can explicitly select either policy:

```ts
substrate: { language: 'csharp', include: ['**/*.cs'], analysis: { mode: 'basic' } }
// Require compiler analysis instead of accepting fallback (including in CI):
substrate: { language: 'csharp', include: ['**/*.cs'], analysis: { mode: 'enhanced', fallback: false } }
```

The parser never downloads, patches, compiles or installs an SDK/indexer.
It looks for an existing `COREDOC_SCIP_DOTNET` executable (or .NET DLL), then
the verified Coredoc tool cache, then `scip-dotnet` on PATH, and requires a compatible `dotnet` SDK on PATH.
The indexer is optional and is downloaded only by an explicit `coredoc tools install csharp`
command or desktop **Install C# indexer** choice. The pinned GitHub release is about 18 MB,
verified by SHA-256 before extraction and rechecked against pinned content hashes before reuse, and installed under `<COREDOC_HOME>/tools/scip-dotnet/<version>`.
.NET SDK 10 is installed separately. Parsing itself never downloads or installs a tool.
Installing a compiler tool does not change the TS/JS prerequisite policy.

Enhanced C# uses macOS sandbox-exec or Linux bubblewrap. Windows, the Alpine CLI
image, and environments lacking isolation fall back with a reason in the logs.
The Ubuntu bundle channel still needs an indexer and bubblewrap even when the
runner already has a .NET SDK. Explicit strict mode refuses the unavailable tier.
The desktop's generated-profile sandbox currently supports macOS only; this
parser fallback does not introduce Windows desktop sandbox support.
Desktop profile authoring uses an app-owned score tool. On the first C# score,
the protected scorer asks the trusted desktop host to prepare its index. Repositories
with C# sources show the native mode/consent dialog before the authoring agent starts.
Generation and its automatic parse reuse that decision and index for unchanged compiler requests.
Three consecutive scores with identical blocking diagnostics stop the stalled run;
there is no fixed time limit for a large repository making progress.
Failed or cancelled authoring preserves `profile.draft.ts` for a freshly verified retry.
Every new enhanced run first requires **Run enhanced** consent, including
when tools are already installed. The dialog explains that repository MSBuild targets
execute in an isolated copy with network access during restore; **Use basic**
starts the built-in parser instead. Missing prerequisites then open a dialog with **Install C# indexer** when available, SDK setup links, **Check again**, **Use basic**, and
**Cancel analysis**. Strict profiles omit the basic choice. The dialog survives
navigation and renderer reload. Installation shows download progress and an explicit cancel action. Escape and outside clicks do not cancel analysis. Repository cards display the resulting mode and
any fallback. Profiles explicitly selecting basic never probe compiler tools.
The host runs only built-in compiler preparation; profile code stays in the
network-denied sandbox and receives read-only, per-run index artifacts.
Conditional `defines` are passed to both restore (`DefineConstants`) and the Coredoc
indexer (`--define`). A stock indexer without this capability still uses the configured
fallback or fails in strict mode; it cannot report inconsistent compiler facts as enhanced. CLI enhanced is available
only when its host already supplies the tools and isolation. The shipped CI
does not install SDKs or bubblewrap. The bundle action can explicitly install the indexer
with `install-csharp-tools: true`; Alpine uses basic and prints that limitation.

Restore and indexing use an isolated physical copy and Coredoc-owned storage.
Restore may access configured NuGet sources; indexing has network access denied.
No `index.scip`, `obj`, `bin` or tool manifest is written to the source repository.
Compiler receiver facts, when supplied by a compatible indexer, enable binding
through awaited generic factories. An ordinary index without those facts can
improve call resolution but cannot establish every framework receiver type.
The pinned [Coredoc scip-dotnet release](https://github.com/yvp-core/scip-dotnet/releases/tag/0.2.15-coredoc.1) supplies these receiver facts. `stats.analysis` records actual
mode, fallback and `compilerReceiverTypes` for each reported language/target.
These records survive graph storage and appear in MCP extraction coverage;
missing records from older parsers mean unknown, never implicitly enhanced.
Ambiguous or external compiler references never regain an internal lexical edge.
Basic resolves only proven argument types. Unknown expressions and unsupported
conversions remain unresolved, even when one method has the matching arity;
compiler analysis may recover those calls. Raw type spelling is retained for
display but cannot authorize framework relationships without a resolved identity.
Basic infers SDK global usings only for simple projects with literal properties and
no custom imports, package build assets, or ancestor `Directory.Build.*` configuration.
Imported build settings require compiler facts; explicit `using` directives in C#
source remain available in basic mode. Git discovery failures are reported explicitly
instead of falling back to a filesystem walk that would ignore `.gitignore` rules.

## Optional Ruby, Python, Go and Rust analysis

Each language keeps its own runner and source-to-symbol adapter in its substrate.
SCIP joins compiler identities onto the existing graph IDs; it enriches **internal calls**.
It does not replace route/entity/database-operation extraction or create calls from ordinary
method references. The effective mode and fallback are recorded in `stats.analysis`.
Before joining compiler positions, each target verifies its parsed source against SHA-256 hashes
captured when the compiler's source copy was made. The index and hash manifest are bound by an
index digest and stay outside the checkout. Every selected source file must have a matching SCIP
document; missing documents or changed bytes produce a visible basic fallback (strict enhanced
fails). This includes Go cgo files emitted only as generated cache documents: narrow the profile
scope or use basic until original-source mapping is supported. Older Ruby caches without a
manifest rebuild automatically.

`substrate.analysis` accepts `{ mode: 'basic' }` or `{ mode: 'enhanced', fallback: false }`.
The default in CLI/CI is enhanced with a logged basic fallback. Desktop offers the mode before
profile authoring, asks separately before installation, and prepares indexes outside the profile
sandbox. Cancellation never becomes a successful fallback.

Run enhanced C#/Go/Rust analysis only on **trusted repositories**: it can execute project build
code and access the network for dependencies. Desktop asks before execution. CLI/CI retain the
enhanced default without an interactive consent step; choosing basic avoids compiler execution.
Filesystem isolation protects source and host data, but this release does not isolate all LAN,
cloud-metadata or host-service network destinations (Linux shares the runner network). Use a
dedicated runner with suitable network policy when those services must be inaccessible.

For a mixed repository, authoring offers one choice for the discovered optional-indexer
languages; TS/JS retains its existing policy. Missing tools have separate installation prompts.
Targets run concurrently, so approved downloads can overlap. Scoring shares one optional index
per language within each score, then prepares it again for a new score or the final parse to avoid stale coordinates.
A later independent parse still asks per target;
an aggregate prerequisite screen and persistent per-language choices are not implemented yet.

| Language | Enhanced tool and setup | Current boundary |
| --- | --- | --- |
| TS/JS | Pinned scip-typescript is bundled and takes priority over PATH. Install the repository's dependencies separately. | CI refuses semantic fallback only when the degraded target has no resolved call or external-call edges; edges in another target do not count. |
| Ruby | `coredoc tools install ruby` or Desktop **Install Ruby indexer** | Pinned standalone 0.4.8: 18.7 MB macOS ARM64 / 41.7 MB Linux x64 with glibc >= 2.38 (for example, Ubuntu 24.04). Older glibc uses basic fallback unless strict enhanced is requested. No Ruby SDK, Bundler or Gemfile changes. |
| Python | `coredoc tools install python` or Desktop **Install Python indexer** | Pinned 0.6.6, about 4.4 MB compressed. Project Python sources and bundled type stubs; no execution of Python, pip, venv or installed-package discovery. |
| Go | Install Go SDK, then `go install github.com/scip-code/scip-go/cmd/scip-go@v0.2.7`; put its bin directory on PATH. | Indexes each go.mod module read-only. Disables automatic Go SDK installation; dependency and build caches are reused outside the repository. |
| Rust | Install the repository's Rust toolchain and `rust-src`, plus the verified standalone `rust-analyzer` 0.3.3049 on PATH. | Uses `rust-analyzer scip` for a root Cargo workspace; Cargo/build scripts/proc macros require execution consent in Desktop. |

Basic needs none of these optional tools. Enhanced runs only with macOS Seatbelt or Linux
bubblewrap installed in `/usr/bin` or `/bin`; preflight and execution use the same OS tool.
Rust and Go on macOS also require an installed clang/macOS SDK selected by `xcode-select`.
Unsupported environments report why they fell back. Windows Desktop remains separate
sandbox work. No SDK or indexer is downloaded by a parse. The explicit Ruby/Python installers
verify pinned archive/binary hashes and verify installed contents before reuse.

Go/Rust read selected compiler sources and module/Cargo manifests at their original paths,
with writes to the checkout denied. No source tree is copied. Credentials and other omitted
inputs stay inaccessible; source symlinks are refused. Projects requiring other embedded/build
assets, lockfile updates or writes beside source files may need basic mode. Dependency and build
caches persist under `COREDOC_HOME/scip/<repo>/<language>/cache`, outside the checkout, without
reading the user's credential-bearing package-manager configuration.

Go/Rust retain one successful index per repository and language in `latest.scip-cache` (SCIP bytes
and source hashes together). Unchanged sources and tooling reuse it across parses and scores.
Successful updates atomically replace it; failed or cancelled builds leave it intact. A previous
index is never joined to changed source. Each caller receives its own output when requested.
Ruby also reuses verified indexes; Python still rebuilds its isolated source copy each run.
Unsupported builds fall back with a reason unless strict enhanced is selected.

Rust checks rust-analyzer's `load_cargo` trace because its SCIP command can exit successfully
after build-script or proc-macro loading fails. Reported loader failures and missing diagnostics
trigger basic fallback (or an error for strict enhanced). Before indexing, the selected
analyzer's `--version` runs inside the sandbox without network access. Only version 0.3.3049 is currently accepted, because this adapter consumes diagnostic
text rather than a stable structured API. Other versions report the detected version and
use basic fallback (or fail strict enhanced) before repository build code runs. Install the
[verified standalone release](https://github.com/rust-lang/rust-analyzer/releases/tag/2026-09-14)
on PATH ahead of rustup's proxy, or select basic. Updating rustup's component alone does not
guarantee a supported analyzer version. Rustup proxies installed as either symlinks or hard
links resolve to the selected installed toolchain; no toolchain is downloaded by analysis.

Re-parse to adopt the new compiler call edges (Ruby 1.4.0; Python/Go/Rust 1.2.0). Stable ID formulas
are unchanged. Ruby uses fixed compiler package metadata rather than a whole-repository hash;
rebuild any experimental snapshots from this branch to replace the earlier hash-versioned edges.

Compiler regression fixtures include Unicode before a call and an unused method reference.
With the tools explicitly installed, regenerate them with
`pnpm --filter @coredoc/profile-parser exec tsx scripts/regen-optional-scip-fixtures.ts`.
`COREDOC_SCIP_RUBY_E2E=1 pnpm --filter @coredoc/profile-parser test ruby-scip.e2e`
exercises a real standalone Ruby install and read-only source parse.
`COREDOC_RUST_E2E=1 pnpm --filter @coredoc/profile-parser test scip-run.test.ts`
also checks real Rust build-script failure and successful proc-macro loading with installed tools.

Kotlin stays on its existing basic substrate. Upstream scip-java supports Kotlin with Gradle,
but its documented Android Gradle integration remains unsupported; see
[upstream support](https://github.com/scip-code/scip-java/blob/main/docs/getting-started.md)
and [Android tracking issue](https://github.com/scip-code/scip-java/issues/177).


## Why

Coredoc's hard problem is **interpreting framework conventions into a domain schema** (a `@Controller`
+ `@Get('/x')` → an HTTP entrypoint with `fullPath = base + path`; a `@Entity` class → an entity with
typed fields and relations; `this.svc.method()` → a resolved call edge), plus **adapting per repo**.
That interpretation is the variable part; everything else (AST walking, path joining, URL
normalization, DI resolution, ID generation) is generic machinery.

Auditing a real bespoke parser (a NestJS service, ~615 lines) showed only **~50 lines** are repo-specific —
the decorator names, an ORM-op map, relation decorators, a DI style, external-client matchers. The
rest is reusable. So:

> **Move the variable part into a declarative profile; put the machinery in one engine.**

This gives exhaustive, deterministic recall (the engine applies rules to *every* site, not whatever
an LLM happened to enumerate), precision by construction (emit only where the substrate resolves the
target), per-rule verification instead of per-edge, and a ~50-line reviewable artifact per repo
instead of 600 lines of code.

---

## Architecture

```
┌─ Layer 1: SUBSTRATE FACTS (deterministic, @coredoc/code-graph) ────────────┐
│  tree-sitter (structure) + SCIP (calls), via buildBaseline                 │
│  → files, classes (decorators w/ args, methods, properties, ctorParams),   │
│    functions, raw call-shapes, symbol/const resolution, call graph         │
└────────────────────────────────────────────────────────────────────────────┘
                              ▲ reads facts
┌─ Layer 2: EXTRACTION PROFILE (declarative, per-repo) ──────────────────────┐
│  ~50-line ExtractionProfile: detectors + arg refs + maps                   │
└────────────────────────────────────────────────────────────────────────────┘
                              ▼ interpreted by
┌─ Layer 3: ENGINE (generic) ────────────────────────────────────────────────┐
│  SubstrateProfileEngine over the Substrate interface                       │
│  → ParsedRepo (@coredoc/core OutputFormat)                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

- **`src/types.ts`** — the `ExtractionProfile` schema. Pure vocabulary of detector *shapes* and
  argument-extraction *references*. Nothing repo-specific lives here.
- **`src/substrate/`** — the engine:
  - `interface.ts` — the `Substrate` interface (the exact facts the primitives need).
  - `tree-sitter-scip.ts` — implements `Substrate` over `@coredoc/code-graph`'s `buildBaseline`
    (web-tree-sitter structural output + the SCIP semantic graph), including the **raw call-shape
    query** that the structural abstraction otherwise lacks.
  - `engine.ts` — `SubstrateProfileEngine`: interprets the profile over the `Substrate`.
  - `run.ts` — `runProfile(profile, repoRoot, repoName, repoKey?)`: `buildBaseline` → substrate →
    engine → `ParsedRepo`. The engine entry point used by the CLI and the authoring scorer.
  - `glob.ts` — scopes files/nodes to the profile's `include`/`exclude`.
- **Per-repo profiles** are authored outside the package at `coredoc-parsers/<project>/<repo>/profile.ts`
  (see `skills/author-profile`). The package ships only the engine + schema — no bundled client profiles.

---

## The profile schema

An `ExtractionProfile` (see `src/types.ts`):

```ts
interface ExtractionProfile {
  parserId: string;
  substrate: { language: 'ts'|'js'; untypedJsMode?: boolean; include: string[]; exclude?: string[] };
  synthesize?: { objectLiteralExportMethods?: boolean; inPaths?: string[] };
  di?: { style: 'constructor-type'|'none'; stripGenerics?: boolean };
  callGraph?: { resolveThis?; resolveDI?; resolveBare?; abstainReceiverPatterns?: string[] };
  entrypoints?: EntrypointRule[];     // http | queue
  handlerTables?: HandlerTable[];     // cross-file require/alias handler registries
  entities?: EntityRule[];
  dbOperations?: DbOpRule;
  externalCalls?: ExternalClientMatcher[];
  components?: ComponentRule;         // frontend: React component + JSX render edges
  routes?: RouteRule;                 // frontend: route → component
  stateStores?: StateStoreRule[];     // frontend: zustand/redux/…
}
```

There is **no imperative escape hatch** — every repo's conventions are expressed declaratively. When a
convention genuinely can't be, the right move is to report a precise primitive gap so a new declarative
primitive can be added (see the authoring loop), not to bolt on bespoke code.

### The two building blocks

**Detectors** — how the engine recognizes a construct:

| `via` | matches | example |
|---|---|---|
| `class-decorator` | a class decorated with `name` | `@Controller`, `@Entity` |
| `method-decorator` | a method whose decorator is a key of `names` | `@Get`→GET, `@EventPattern`→event |
| `property-decorator` | a property decorated with any of `names` | `@Property`, `@PrimaryKey` |
| `call-shape` | a call expression matching `callee` (`recv.*`, `*.method`, exact); optional `scopedBy` requires it nested in a parent call | `sequelize.define`, `router.*` inside `router.extend(base,…)` |

**ArgRefs** — how the engine reads a value out of an argument:

| `as` | reads | example |
|---|---|---|
| `string-literal` | a quoted string | `@Get('/x')` → `/x` |
| `const-string` | an identifier resolved to its string-literal const | `define(ENTITY_NAME,…)` → `"BreakType"` |
| `arrow-target` | the identifier returned by an arrow | `() => Companies` → `Companies` |
| `identifier` | a bare identifier's text | `em.create(User,…)` → `User` |

Every rule (entrypoints, entities, db-ops, externals) is built from these two primitives plus small
maps (decorator→verb, op→CRUD, datatype→type, etc.).

### Example — a NestJS / MikroORM service, fully declarative

```ts
export const nestjsProfile: ExtractionProfile = {
  parserId: 'nestjs-mikroorm-parser-v1',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/*.spec.ts','**/dist/**','**/*.d.ts'] },
  di: { style: 'constructor-type', stripGenerics: true },
  entrypoints: [
    { kind: 'http', detect: { via: 'class-decorator', name: 'Controller' },
      basePath: { arg: 0, as: 'string-literal' },
      method: { Get:'GET', Post:'POST', Put:'PUT', Patch:'PATCH', Delete:'DELETE' },
      methodPath: { arg: 0, as: 'string-literal' }, paramSyntax: 'colon' },           // :id → {id}
    { kind: 'queue', detect: { via: 'method-decorator', names: { EventPattern:'event', MessagePattern:'request-response' } },
      system: 'kafka', topic: { arg: 0, as: 'string-literal' } },
  ],
  entities: [
    { orm: 'mikro-orm', detect: { via: 'class-decorator', name: 'Entity' },
      tableName: { option: 'tableName', fallback: 'snake_case' },
      fields: { decorators: ['Property','PrimaryKey','Enum'], pk: 'PrimaryKey', columnNameOption: 'fieldName',
                flags: { nullable: 'nullable:\\s*true', unique: 'unique:\\s*true', generated: 'autoincrement|onCreate' } },
      relations: { decorators: { OneToOne:'one-to-one', ManyToOne:'many-to-one', OneToMany:'one-to-many', ManyToMany:'many-to-many' },
                   target: { arg: 0, as: 'arrow-target' } } },
  ],
  dbOperations: { opMap: { find:'read', persist:'create', nativeUpdate:'update', remove:'delete' /* … */ },
                  emReceivers: ['em','*.em','*.orm.em'], repoReceiverPattern: '/repository$|repo$/i',
                  entityFrom: { arg: 0, as: 'identifier' } },
  externalCalls: [
    { kind: 'http', receiverPattern: '/httpService(\\.axiosRef)?$/i', verbs: ['get','post','put','patch','delete'], url: { arg:0, as:'string-literal' }, serviceName: 'http-service' },
    { kind: 'queue', receiverPattern: '/client$/i', methods: ['emit','send'], topic: { arg:0, as:'string-literal' }, system: 'kafka' },
    { kind: 'sdk', diTypeSuffix: ['ApiClient','Client'], serviceName: 'internal-api' },
  ],
};
```

### `handlerTable` — cross-file handler resolution (the schedules/JS case)

Some frameworks reference a handler through a require/alias registry instead of co-locating it
(`router.get('/p', handlers.api.schedules.create)` where `handlers` is an object of `require()`
leaves). `handlerTables` resolves that declaratively:

```ts
handlerTables: [
  { name: 'koa-handlers', registryVar: 'handlers', inFile: 'app/initializers/create-koa-router.js',
    leaf: 'require', reference: 'member-chain', nested: true },              // handlers.a.b.create → create() in the required file
  { name: 'pubsub-handlers', registryVar: 'handlers', inFile: 'app/initializers/create-pub-sub-jobs.js',
    leaf: 'require', reference: 'member-chain', defaultMethod: 'onMessage' },// handlers.alias → onMessage() in the required file
]
// …and the entrypoint rule points at it:
entrypoints: [
  { kind: 'http', detect: { via: 'call-shape', callee: 'router.*', scopedBy: { callee: 'router.extend', basePathArg: 0 } },
    method: 'from-callee', methodPath: { arg: 0, as: 'string-literal' }, paramSyntax: 'colon',
    handler: { via: 'handler-table', table: 'koa-handlers', arg: -1 } },     // -1 = last argument
]
```

This single primitive replaced ~480 lines of bespoke handler code; the Koa/JS profile uses no
escape hatches.

---

## Multi-target profiles (multi-language monorepos)

A repo that mixes languages (e.g. a TS backend + a Ruby service in one workspace) is
described by a `MultiTargetProfile` (`src/types/multi-profile.ts`) instead of a single
`ExtractionProfile`:

```ts
interface MultiTargetProfile {
  parserId: string;
  repoType?: RepoType;      // usually 'monorepo'; surfaces as the merged ParsedRepo.type
  targets: TargetProfile[]; // each: a full single-language profile minus parserId, plus a unique `name`
}
```

Detection is structural: a composite has `parserId` + `targets` and no top-level
`substrate`, so it can never be mistaken for a single-language profile.

**A target is a language scope, not a workspace package.** N same-language packages share
one target and one SCIP index — cross-package call resolution depends on indexing the whole
workspace together, so splitting one language across multiple targets would fragment that
index. Workspace-package topology stays engine-internal; it never drives target boundaries.

- `resolveTargets` / `resolveProfileExport` / `resolveProfileModule` (`src/providers/resolve.ts`)
  validate the composite (unique names, exactly one target per canonical language provider,
  a registered provider per target, provider-recognized shape) and fail fast, naming the
  offending targets. Aliases such as `ts` and `js` count as the same provider.
- `parseMultiTarget` (`src/multi/orchestrate.ts`) runs every target's `provider.parse` in
  parallel, sharing one `repoRoot`/`repoName`/`repoKey` so all targets' IDs land in the same
  `repoHash` space; each target gets its own incremental-cache subdirectory.
- `mergeParsedRepos` (`src/multi/merge.ts`) combines the per-target `ParsedRepo`s into one
  graph, guarding against scope overlap (two targets claiming the same file throws, naming
  both) and attributing `Package.language` from each package's dominant merged-file language.
- `src/score.ts` + `src/scoring/unclaimed-scope.ts` print one scorecard per target plus an
  unclaimed-scope report (known-language files no target's `include`/`exclude` claimed); the
  overall verdict is the AND of every target's verdict.

Any registered `LanguageProvider` is automatically usable as a `targets[]` entry — see
[`docs/ADDING-A-LANGUAGE.md`](../../docs/ADDING-A-LANGUAGE.md).

**Deferred:** cross-language protocol edges within one repo (e.g. a React target's `fetch`
call into a Ruby target's route) are not resolved yet; the planned approach reuses the
cross-repo linker's descriptor-protocol hop intra-repo.

---

## How the engine interprets a profile

`SubstrateProfileEngine.run(baseline, opts)` reads facts off the `Substrate` interface and emits a
`ParsedRepo`:

| Profile area | Substrate facts used |
|---|---|
| `substrate.include`/`exclude` | scopes the structural node set (`glob.ts`); `untypedJsMode` skips type-dependent resolution on untyped JS |
| entrypoints (decorator-route/queue) | `substrate.classes()` decorators (full text) + arg refs |
| entrypoints (call-route/queue), factory entities, object-literal synthesis | `substrate.callShapes()` |
| db-ops + external matchers | `substrate.classes()` for structure; `substrate.internalCalls()` (scoped + DI-corrected) / `substrate.externalCalls(matchers)` for edges |
| `handlerTable` entrypoints | resolved after functions exist, against the cross-file registry |
| components / routes / state stores | `substrate.componentSites()` + SCIP componentId resolution |

`repoKey` (when set) threads into id hashing so the substrate path produces the same repoHash as the
legacy parser path for a repo whose `key` differs from its `name` (the `@coredoc/core` two-ID system).

---

## Install & build

From the repo root (pnpm workspace):

```bash
pnpm install
pnpm --filter @coredoc/profile-parser typecheck
pnpm --filter @coredoc/profile-parser test       # vitest gates (exact-count regression on real repos)
```

Runtime deps: `@coredoc/core` (types, idGen, ts-morph-free SDK registry) and `@coredoc/code-graph`
(the tree-sitter+SCIP substrate facts). TypeScript SCIP ships as a Coredoc dependency; no global installation is required. It needs
the **target repo's `node_modules`** present (so SCIP can
resolve imports). Without those dependencies, parsing uses the structural tier and reports a warning:
symbols and supported framework facts remain available, while semantic call edges may be incomplete.
Coredoc does not install dependencies or write into the repository. Missing dependencies do not by
themselves fail profile scoring; actual extraction errors and coverage gaps still apply.

## Run

### Through the `coredoc` CLI (the product path)

Author a `profile.ts` at `coredoc-parsers/<projectId>/<repoName>/profile.ts` (see
`skills/author-profile`), then:

```bash
coredoc parse -r <repoName>
```

`parser-loader` loads `profile.ts` (it takes precedence over a legacy `parser.ts`), builds the
substrate facts, runs the engine, and writes the `ParsedRepo`.

### Directly (development / scoring)

```bash
# run a profile module over a repo:  tsx src/substrate/run.ts <path-to-profile> <repoPath> <outJson> [goldenJson]
npx tsx packages/profile-parser/src/substrate/run.ts \
  coredoc-parsers/<project>/<repo>/profile.ts /path/to/repo /tmp/out.json

# coverage scorecard (by path to a profile module):
npx tsx packages/profile-parser/src/score.ts <path-to-profile.ts> <repoPath>
```

(Indexes the repo with scip-typescript on first run — seconds to a couple of minutes for large repos.)

### Validate any output

```bash
node packages/profile-parser/scripts/validate-output.mjs /tmp/out.json
node packages/profile-parser/scripts/pre-scan.mjs <repoPath> /tmp/out.json
```

---

## Writing a new profile

See `skills/author-profile` for the full loop. In short:

1. **Scope.** Set `substrate.include` to the source globs and exclude `node_modules`/`dist`/tests.
2. **Identify conventions** by reading a few representative files: routes (decorators? a router call?),
   entities (decorators? a factory call?), DI (constructor types?), outbound calls (which clients?).
3. **Fill the rules** using detectors + arg refs (`class-decorator`/`method-decorator`/`property-decorator`
   for decorator frameworks; `call-shape` + `handlerTables` for functional/factory/registry frameworks).
4. **Add the maps**: decorator→verb, ORM op→CRUD, datatype→type, relation decorators/assoc methods.
5. **Score** with `src/score.ts` and iterate the profile — not code — until every required category
   matches its source signal with 0 validate-output errors.

---

## Status

Verified substrate-only, **0 validation errors**, exact match to the bespoke parsers (golden fixtures)
across all five proven repos. Representative counts:

| Repo | http | queue | entities | dbOps | externalCalls |
|---|--:|--:|--:|--:|--:|
| Service A (NestJS/MikroORM/Kafka, TS) | 132 | 3 | 104 | 232 | 39 |
| Service B (Koa/Sequelize/pub-sub, JS) | 82 | 9 | 16 | 135 | 6 |

The full decommission matrix (substrate ≥ ts-morph oracle ≥/= curated, call-tree recall, name-match)
across all five proven repos was the decommission gate: it passed, the ts-morph oracle engine was
removed, and the substrate engine is now the single extraction path, wired into the CLI.

## Files

```
src/
  types.ts                     ExtractionProfile schema (the vocabulary)
  types/multi-profile.ts       MultiTargetProfile / TargetProfile (multi-language monorepos)
  index.ts                     public exports (SubstrateProfileEngine, runProfile, …)
  run.ts                       CLI: run a profile module + validate/pre-scan
  score.ts                     coverage scorecard (the authoring-loop gate)
  providers/resolve.ts         resolveTargets / resolveProfileExport / resolveProfileModule
  multi/
    orchestrate.ts              parseMultiTarget (per-target parse, run in parallel)
    merge.ts                    mergeParsedRepos (per-target ParsedRepos -> one graph)
  scoring/unclaimed-scope.ts   unclaimed-scope report (multi-target coverage gaps)
  substrate/
    interface.ts               Substrate (backend-neutral fact interface)
    tree-sitter-scip.ts        Substrate impl over @coredoc/code-graph (tree-sitter + SCIP)
    engine.ts                  SubstrateProfileEngine (the engine)
    run.ts                     runProfile / runSubstrate entry points
    glob.ts                    include/exclude scoping
    engine.test.ts             exact-count regression on real repos
    run.test.ts                two-ID (repoKey) stability regression
```

## See also

- Profile authoring loop: [`skills/author-profile`](../../skills/author-profile) — the full authoring + scoring workflow.
- Schema vocabulary: [`src/types.ts`](./src/types.ts) — the `ExtractionProfile` shape.
