# Wired language substrates — details

What each registered substrate extracts and which profile vocabulary tunes it. The
SKILL's Orient step carries only the summary table; read the entry here for the language
you are onboarding.

## TS/JS (`scip-typescript`)
The full `ExtractionProfile` vocabulary in `references/profile-cheatsheet.md`.

## C# / .NET (`CSharpProfile`)

Read [the C# profile vocabulary](csharp.md) before drafting. C# uses `libraries`
and `nominal` rules; TS decorators and `externalClients` do not apply. One C#
target includes its source-owning projects. Basic uses tree-sitter and lexical
resolution without .NET tools. Enhanced uses an already-installed .NET SDK and
scip-dotnet, with visible basic fallback by default; strict enhanced is opt-in.
The parser installs nothing. Restore/index run in an isolated copy and the source
checkout stays read-only. `stats.analysis` records the actual mode, fallback and
availability of compiler receiver facts. Desktop prepares enhanced indexes in a separate trusted host after explicit execution consent; the profile sandbox consumes only the index. Windows desktop sandbox support remains separate work. See the C# reference for the available compiler tier.

## Ruby/Rails (`RubyProfile`)
Tree-sitter substrate for routes/entities/db-ops/egress + a Tier-B call heuristic
(constant + self sends). Optional `scip-ruby` gives compiler-grade calls — consent flow
in SKILL step 0.6.

## Swift (`SwiftProfile`)
Tree-sitter substrate; small tuning vocabulary.

## Python (`PythonProfile`)
Tree-sitter substrate for Django/DRF routes (urls.py registries, DRF router tables,
nested routers, `@action` sub-routes, management commands), Celery tasks, ORM
entities/db-ops (transitive model-base resolution through the repo's own class graph),
raw-query db-ops, and HTTP egress; import-aware Tier-B call resolver. The framework
conventions live in the Python substrate — the profile only TUNES them, every knob optional:
`entities.baseClasses`, `entrypoints.djangoRoutes.routeFileGlobs`,
`entrypoints.queue.taskDecorators`, `egress.clientModules`, `dbOperations.methods`,
`dbOperations.rawQueries` (`functions` + `queryArg` + `emitUnresolved`). A bare
`{ parserId, substrate: { language: 'python', include } }` already parses a
Django/DRF/Celery repo — start there and tune what the scorecard says is missing.
`scip-python` optionally adds compiler-backed internal calls from project sources and bundled type stubs. It does not execute Python, install dependencies or use the client venv. External installed-package metadata is not indexed in this release.

## Rust (`RustProfile`)
Tree-sitter substrate for Cargo crates (real Package/File output), axum/actix/rocket
routes, tonic gRPC, smart-contract handlers, diesel/sea-orm/sqlx entities + db-ops, and
reqwest/hyper egress; `mod`/`use`-aware Tier-B call resolver. Tuning knobs (all
optional): `entities.deriveMacros`, `entities.schemaFileGlobs` (does NOT honor substrate
excludes — keep tests out via the globs themselves), `entrypoints.http.routeAttributes`,
`entrypoints.contracts.frameworks`, `egress.clientCrates`, `dbOperations.methods`.
Reading its output: smart-contract handlers (Anchor/ink!/CosmWasm) emit as `queue`
entrypoints with a namespaced topic, and that lane runs only when the framework's crate
is a declared Cargo.toml dependency. `rust-analyzer scip` optionally adds compiler-backed internal calls for a root Cargo workspace. It requires the installed toolchain and rust-src; Cargo/build scripts/proc macros run only in an isolated copy. `warp` filter combinators and macro-generated code without matching source declarations remain gaps.

## Go (`GoProfile`)
Tree-sitter substrate for Go modules/packages/files, chi/gin/echo/gorilla/net-http routes,
Cobra commands, gRPC registrations, SQL/GORM entities + db-ops, HTTP egress, and a
package/import-aware Tier-B call resolver. Tuning knobs include
`entities.structTags`/`schemaFileGlobs`, `dbOperations.methods`/`sqlcQueryGlobs`,
`entrypoints.http`/`grpc`/`cli`, and `egress.clientPackages`. Built-in discovery excludes
vendored dependencies, `testdata`, `*_test.go`, and protobuf-generated `*.pb.go`; use
`substrate.excludeDefaults: false` only when those files are intentionally part of extraction.

Go optionally uses `scip-go` for compiler-backed internal calls, indexing each go.mod module in a protected source copy. SDK/indexer installation is separate; the parser never runs `go install`.
