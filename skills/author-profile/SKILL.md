---
name: author-profile
description: Author and iteratively refine a declarative coredoc ExtractionProfile for a code repository, driving the profile-parser engine's coverage loop. Use this whenever the user wants to "author a profile", "write an extraction profile", "create a profile for my repo", "set up profile-driven parsing", "add a repo to profile-parser", "onboard a repo to coredoc", or asks coredoc to extract a repo via a profile. This is the standard way to onboard a repo for `coredoc parse` (it replaces the old imperative ts-morph parser approach): it grounds in the repo's shape + installed libraries first, dispatches scouts to gather convention evidence, then produces a ~50-line reviewable profile that the tree-sitter+SCIP substrate engine applies to every matching site — exhaustive recall, precision by construction. The engine supplies the AST machinery; you supply the conventions.
---

# Author a coredoc ExtractionProfile

An `ExtractionProfile` is a small **declarative** config describing one repo's
conventions: which decorators/call-shapes mark HTTP routes, CLI commands, gRPC/GraphQL resolvers, entities, queues; the DI style; the ORM op map;
the outbound clients. The generic **substrate profile engine** (tree-sitter + SCIP) interprets it and
emits coredoc's `ParsedRepo` graph. You don't write a parser — you write the profile and the engine
applies your rules to *every* matching site (exhaustive recall, precision by construction).

Your job: drive the scorecard to **overall PASS** — 0 validate-output errors, every required category
at its PASS bar (≥80% of its source signal; externalCalls ≥50% of its coarse call-site denominator),
no consistency red flags. You iterate the **profile**, never the engine.

**Ground before you guess.** A repo's conventions are *implied by its stack* — the framework, ORM, and
queue libraries it installs. So establish the facts first (repo shape, language, libraries), let those
drive what to look for, dispatch cheap scouts to gather the evidence, then *you* interpret it into the
profile. Do **not** start blind-sampling for `@Controller`/`@Entity` before you know the stack.

## Multi-language monorepos (multi-target profiles)

Decide the profile **shape** before the loop. A single profile carries one `parserId`, so one
provider — it can't span a repo that holds substantial source in **two or more registered
languages** (including **TS/JS**, **C#**, **Ruby**, **Swift**, **Python**, **Rust**, **Go**, **Zig**, and **Kotlin** — those with a wired
substrate). For that, author a
composite **`MultiTargetProfile`** (`packages/profile-parser/src/types/multi-profile.ts`) —
`{ parserId, repoType: 'monorepo', targets: [...] }` — where each target is a full single-language
profile **minus `parserId`** plus a unique `name`.

**Detect the shape in Orient (fact 2).** Having enumerated packages, count the language populations —
extensions × directories × workspace packages. One registered language with source → single profile.
**≥2 registered languages, each with substantial source → composite.** (A stray `.rb` script in a TS
repo is not a second population; a Rails `api/` beside a React `ui/` is.) Inventory a stray registered-
language file explicitly and add its exact repo-relative path to `substrate.exclude`; do not silently ignore it.
The whole-repo scope gate treats an explicit exclusion as intentional, while an unaccounted stray file
stays `BLOCKED` so missing source cannot disappear by accident. A wildcard cannot waive a non-target
language population: if there is more than a named stray file, give the substantial population a target.

**Exactly one target per canonical language provider, never per package.** The unit of composition is
the language slice, not the workspace package: N same-language packages share **one** target and
**one** SCIP index — cross-package call resolution depends on indexing the whole language workspace
together, so a target-per-package split would fragment that index and drop cross-package edges.
Provider aliases are the same language slice: `ts` and `js` both resolve to the TypeScript provider and
must share one target. The resolver rejects multiple targets for the same provider even when their
scopes are disjoint; use package/root-scoped scouts for distinct conventions, then synthesize their
rules and include globs into the one language target. Each target needs a
unique `name` and a **disjoint** `include`/`exclude` scope; the engine **throws at merge if two targets
claim the same file**, so keep the globs non-overlapping across different providers.

**`parserId` lives only at the composite top level.** Targets omit it (it is stamped on before provider
dispatch). `repoType` is usually `'monorepo'` and surfaces as the merged `ParsedRepo.type`.

**Run the coverage loop below per target.** On a composite, `score.ts` prints one scorecard section per
target —

```
===== Target: <name> (<language>) =====
```

— then an unclaimed-scope report and an AND-of-targets verdict:

```
=== Unclaimed scope ===
<n>/<total> known-language files claimed by no target
  <dir>: <count>
  …
=== Overall (all targets): PASS|FAIL ===
```

Drive **each** target's section to its own PASS — the overall verdict is the AND, so one failing target
fails the whole. Read **Unclaimed scope** as missing coverage: a known-language file claimed by no
target means either a target's `include` is too narrow (widen it) or a whole language population has no
target (add one). Done = every target PASS *and* the scope fully claimed.

**Example** — a React `ui/` + Rails `api/` monorepo:

```ts
const profile: MultiTargetProfile = {
  parserId: 'acme/webapp',
  repoType: 'monorepo',
  targets: [
    {
      name: 'ui',
      substrate: { language: 'ts', include: ['ui/**/*.ts', 'ui/**/*.tsx'], exclude: ['**/*.d.ts'] },
      // …React entrypoint/state rules…
    },
    {
      name: 'api',
      substrate: { language: 'ruby', include: ['api/**/*.rb'], exclude: ['api/spec/**'] },
      // …Rails route/entity/db-op rules…
    },
  ],
};
export default profile;
```

## The loop

```
Orient → (Ask the user, if it saves work) → Scout → Draft → Score → (Refine → Score)* → Audit → Verify → Done
```

Track these as todos.

### 0. Orient — establish the facts (deterministic, no guessing)

Read the manifests and repo layout FIRST. Before dispatching any scout, build a deterministic inventory
sorted by repo-relative path: one row per source-bearing root/package with its manifest, language/file
counts (after the obvious excludes), and assigned profile target. Annotate each row with the dependency
signals from fact 3. This inventory is the scope contract for scouting and synthesis. Then produce four
facts that drive everything below:

1. **Repo shape.** Monorepo or single? Check `pnpm-workspace.yaml`, root `package.json` `workspaces`,
   `lerna.json`, `nx.json`, `turbo.json`, `go.work`. If a monorepo, **enumerate ALL packages/apps** and
   cover **every one that holds production source** in `substrate.include` — coredoc parses the *whole* repository,
   not just the primary framework app. Use broad globs (e.g. `['apps/**/*.ts', 'packages/**/*.ts']`), not
   a single app like `apps/server/**`. Framework rules (routes/entities/db-ops) apply where they match;
   plain library packages with no framework still contribute functions, classes, and their call graph via
   the base substrate, so they must be included too. The coverage scorecard only measures the *included*
   scope — a PASS on a narrow `include` is **not** done; widen until it spans the repo's production
   source, then re-score. Keep the test/fixture exclusions from fact 4 when widening.
   Never assume a single root `src/`.
2. **Language.** From manifests + file extensions. Wired substrates — details and tuning
   knobs per language in `references/language-substrates.md` (read the entry for the
   language you are onboarding):

   | Language | Profile type | Calls |
   |---|---|---|
   | TS/JS | `ExtractionProfile` (full vocabulary, this cheat-sheet) | scip-typescript |
   | CSharp/.NET | `CSharpProfile` — one C# target spans its `.csproj` files; `libraries` establishes referenced type identities and `nominal` holds framework selectors | Basic tree-sitter/lexical analysis; optional existing `scip-dotnet` and .NET SDK improve compiler calls. No tool installation by the parser. Compiler receiver facts additionally require a compatible indexer; inspect `stats.analysis`. Restore/index use an isolated copy with no source-repository writes. |
   | Ruby/Rails | `RubyProfile` | Tier-B; optional explicitly installed scip-ruby |
   | Swift | `SwiftProfile` | Tier-B |
   | Python | `PythonProfile` (tuning knobs over built-in Django/DRF/Celery conventions) | Basic lexical calls; optional installed scip-python |
   | Rust | `RustProfile` (tuning knobs over built-in conventions) | Basic lexical calls; optional rust-analyzer SCIP with rust-src |
   | Go | `GoProfile` (tuning knobs over built-in conventions) | Basic lexical calls; optional installed scip-go and Go SDK |
   | Zig | `ZigProfile` (include/exclude — `build.zig`, `zig-out/`, `.zig-cache/`, `zig-cache/` are excluded by default and `exclude` EXTENDS that, `excludeDefaults: false` opts out; plus `dbOperations.methods` for a repo-owned SQL wrapper's execute verb — unioned with the generic `exec`/`query`/`prepare` set, never a replacement, and note `run` is NOT in the defaults) | Tier-B (five `zig-*` tiers over `@import` bindings; local-variable, shadowed-name and `anytype` receivers are dropped) |
   | Kotlin/Android | `KotlinProfile` — `include`/`exclude` decide which SOURCE SETS are parsed (the substrate has no `main`-vs-flavor default, so state them; generated code under `build/` or written into `src` is excluded only if you exclude it); `entities.orm` `'room'`\|`'realm'` plus `baseClasses`/`annotations`; `dbOperations.opMap` EXTENDS the Realm verb map and is how a third-party persistence wrapper's extension functions are recognised; `egress.verbAnnotations` for the HTTP-client annotation set; `di.koin.accessors` for the accessors that type a receiver (`get`, `inject`, `viewModel`, …); `android.*Bases` EXTEND the framework base-class lists (activity, fragment, receiver, worker, service, push service, provider) | Tier-B (four `kt-*` tiers plus `iface-impl` for a sole in-scope implementation; inferred, view-binding, `it`, generic, Java-typed and duplicate-FQCN receivers are dropped) |

   A target that is primarily **Java** (no registered substrate) → **say so plainly and
   stop**; note it for the multi-language track. A polyglot monorepo is a
   `MultiTargetProfile`, one target per language. A Kotlin repo holding a handful of `.java`
   files parses fine — the Kotlin target claims only `.kt` and the rest is reported as
   unclaimed scope.
3. **Libraries → candidate conventions.** Read the manifest(s) (per-package in a monorepo) and map the
   installed deps to the frameworks/ORMs/queues/clients they imply — see
   `references/framework-signals.md`. This *hypothesis* is what the scout confirms: `@nestjs/common` ⇒
   `@Controller`/`@Get` + `@Entity`; `express`/`koa` ⇒ `app.get`/`router.get` call-shapes; `sequelize`
   ⇒ `sequelize.define` factory entities; `@mikro-orm/*`/`typeorm` ⇒ decorator entities; `kafkajs`/
   `bullmq` ⇒ queues; `axios`/an injected `*ApiClient` ⇒ external calls.
   **The frontend surface is part of this map, not an afterthought**: `react`/`vue` ⇒ a `components` rule
   (`.vue` files additionally need `**/*.vue` in `include` + `vueSfc: true`); a state library —
   `zustand`/`valtio`/`redux`/`kea`/`pinia`/`jotai`/`recoil`/`mobx` ⇒ a `stateStores` rule (factory
   call bound to an exported const: `create(...)`, `proxy(...)`, `kea([...])`); a router ⇒ a `routes`
   rule — JSX `<Route>`/config-array/react-admin are declaration-site; Next.js `pages/`–`app/`
   roots are `routes.fileConvention` (`routeDir` = repo-relative app root, one entry per app); and
   scene-table routers (kea-router style: a path-keyed Record joined to a lazy-import scene table,
   optionally with computed `urls.*()` keys) are `routes.recordTable`. A
   frontend dep with NO corresponding rule in the final profile must be an explicit decision recorded
   in a profile comment, never silence. **Omit an unsupported rule; never fill required fields with
   placeholders such as `'unknown'`, `{}`, or an empty string.** A placeholder is executable profile
   data, not documentation, and the schema gate will reject it. Use only the exact closed literals and
   string factory names in `references/profile-cheatsheet.md`.
4. **Scope.** The source root(s) and obvious excludes (`node_modules`, `dist`, tests, `.d.ts`, `.yarn`),
   per inventory row. Every registered-language file must be assigned to a target, covered by that
   provider's documented built-in exclusions, or matched by a deliberate `substrate.exclude`. A minor
   non-target-language script has no owning provider target, so inventory it and exclude its exact path.

   **Exclude tests and test fixtures from the graph by default.** Record explicit repo-relative globs
   in each target's `substrate.exclude`; broad `include` globs must not pull these files back in.
   Apply this scope to the inventory, scouts, extraction rules, and final coverage audit. Common
   exclusions, including nested workspace packages, are:

   - Test filenames: `**/*.spec.*`, `**/*.test.*`.
   - Test roots: `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/spec/**`, `**/specs/**`.
   - Test data and doubles: `**/fixtures/**`, `**/__fixtures__/**`, `**/testdata/**`, `**/__mocks__/**`.
   - End-to-end tests: `**/e2e/**`.

   Add the repo's language-specific conventions after inspecting its test configuration and layout,
   for example `**/*_test.go`, `**/test_*.py`, `**/*_test.py`, and `**/*_spec.rb`, plus confirmed custom
   integration-test roots and test-only projects. Globs are separate array entries, not a pipe-joined
   path. Do not use a blanket `*test*` substring rule: a production name such as `contest` is not a test.
   If a conventional directory name actually holds production code, preserve that code and narrow the
   exclusion to the confirmed test paths. Include tests only when the user explicitly requests them.

   **Whole-repo coverage means all production applications and libraries.** Intentionally excluded
   tests, fixtures, mocks, and e2e helpers are not missing product coverage. Never add their fake routes,
   entities, or calls to satisfy a score threshold; investigate any scope/scorer disagreement instead.

Write these four down. If the manifests reveal *nothing* recognizable (a homegrown/unknown stack),
that's a signal to ask the user (next) rather than guess.

### 0.5 Ask the user — once, only if it saves real work

You're usually onboarding a repo the user knows. Ask up front, in one prompt:
**"Are you familiar with this repo's conventions?"**

- **Yes** → harvest the few facts that shortcut research: which package(s) matter, how routes/DI/
  entities are declared if non-obvious, the names of any **internal SDK packages** (so external calls
  get the right service provenance), and anything unusual. Then scout to *confirm*, not discover.
- **No** → don't interrogate. Go straight to scouting.

Don't ask what you can read from the code. Save later questions for genuine dead-ends (Score loop).

### 0.6 Optional compiler analysis — let the host handle tools

Ruby, Python, Go and Rust support `substrate.analysis` with `mode: 'basic' | 'enhanced'`
and `fallback: boolean`. The default is enhanced with basic fallback. Basic runs the
built-in tree-sitter parser without compiler tools. SCIP enriches internal calls; it
cannot repair unrelated missing framework matchers or route/entity coverage.

Desktop asks for the mode before authoring and owns execution consent, prerequisite
checks and installation prompts. Use the score tool and respect the selected mode.
Do not ask the user to enable an indexer again, edit a Gemfile, activate a venv, run
Cargo/Go dependency commands, or create `index.scip` in the source repository.

For CLI setup, the user can explicitly run `coredoc tools install ruby` or
`coredoc tools install python`. Go uses an installed SDK and `scip-go`; Rust uses
an installed Rust toolchain with `rust-analyzer` and `rust-src`. The parser never
installs these tools. Missing tools produce a visible basic fallback unless the
profile explicitly sets `fallback: false`. Keep authoring in basic when that was
chosen; do not treat unavailable enhanced analysis as a reason to repeat the same
score failure or to invent facts.

### 1. Scout — dispatch directional evidence-gatherers across the inventory

Dispatch four repo-wide directional scout subagents using the active harness's native collaboration
tool. Every scout receives the complete cross-language inventory and must inspect every listed source
root — do **not** multiply the initial scouts by language or package:

- **Claude Code:** call `Task` with the `haiku` model.
- **Codex:** call `spawn_agent` with model `gpt-6-luna`; do not call the Claude-only `Task` tool.

Launch these four directions concurrently up to the harness's capacity, and collect all four before
synthesis:

- **entrypoints + messaging** — HTTP (including bootstrap prefixes and router mounts), CLI, gRPC,
  GraphQL, queue consumers/producers, and file-convention endpoints;
- **data/db** — ORM/schema conventions, entities/fields/relations, db-operation receivers and raw queries;
- **frontend** — components, aliases, state stores, JSX/config/file-convention/record-table routes;
- **DI/indirection/egress** — injection style, handler registries/aliases, outbound HTTP/SDK clients and
  the receiver/type provenance needed to resolve their calls.

The scout's job is **mechanical and cheap — gather evidence, do NOT write the profile.** Its structured
report must list the roots it checked and, per root/category: concrete names and arg positions, a
reproducible site count (or a clearly labelled bounded approximation) with the search pattern, 1–2
`file:line` snippets, an explicit `none found`/`not applicable`, and an expressibility verdict using an
existing profile primitive, `customRules`, `substrate gap`, or `unknown`. Silence is never evidence of
absence; a scout must not invent fields or placeholder values.

Split a direction into an additional language/package/root-scoped scout **only** when the inventory or
first-pass evidence shows a genuinely distinct stack or convention that cannot be sampled faithfully together
(for example NestJS and Koa backends, or unrelated routing systems). Different package names alone are
not a reason. Record the evidence and scope that justified each split; a research split never implies a
same-language profile target split.

**Synthesize before Draft.** Merge all reports into a root × direction coverage matrix. Every inventory
row must have counts/evidence or an explicit absence for all four directions. Reconcile contradictions,
group conventions that can share a rule, validate each expressibility verdict against the schema, and
dispatch only the justified narrow follow-up scouts. Do not draft while a root/category cell is silent or
an `unknown` could be resolved mechanically. Prompt templates and the synthesis contract:
`references/framework-signals.md`.

### 2. Draft — interpret the evidence into the profile (judgment lives here)

*You* turn the scouts' raw facts into rules — "files use `@Get(':id')`" becomes a `method-decorator`
detector + a `string-literal` arg ref + `paramSyntax: 'colon'`. Write the profile where `coredoc parse`
loads it: **`coredoc-parsers/<projectId>/<repoName>/profile.ts`**, as one module exporting the shape
selected in Orient: an `ExtractionProfile` for one substantive language, or a `MultiTargetProfile` for
a substantive polyglot repo (it takes precedence over any legacy `parser.ts`). Set each target's
`substrate.include`/`exclude` from Orient's scope, preserving its test and fixture exclusions even
when starting from an archetype or refining an existing draft. Build every rule from the two primitives —
**detectors** + **arg refs** — plus small maps.

**Starter-pack archetypes — start from one when the stack matches.** Orient's dep map (fact 3,
libraries → candidate conventions) keys straight into a distilled, fleet-confirmed base profile:

| Detected deps (Orient) | Archetype |
|---|---|
| `@nestjs/*` + `@mikro-orm/*` | `references/archetypes/nestjs-mikroorm.ts` |
| `react-admin` | `references/archetypes/react-admin.ts` |
| `koa` (typically + `sequelize`) | `references/archetypes/koa-sequelize.ts` |

On a match, copy the archetype as the draft — its rules carry the fleet's confirmed conventions and
trap-avoiding WHY comments — and scope the scouts (step 1) to *confirming the deltas* (parserId,
include globs, base paths, topics, egress receivers) rather than discovering conventions from scratch.
No archetype match → draft from the primitives as below, unchanged.

- Schema vocabulary: `packages/profile-parser/src/types.ts` (read it).
- Cheat-sheet (detectors, arg refs, when to use each): `references/profile-cheatsheet.md`.
- Build each rule from the two primitives (detectors + arg refs) + small maps; the cheat-sheet annotates
  the decorator-framework (NestJS/MikroORM) and functional/registry (Koa/Sequelize JS, `handlerTable`)
  shapes. Your per-repo profile lives at `coredoc-parsers/<projectId>/<repoName>/profile.ts` and needs no
  registration — the package ships no bundled profiles.

For `js`, set `untypedJsMode: true` for plain CommonJS (the type checker crashes on untyped JS).

### 3. Score — run the scorecard

```
tsx packages/profile-parser/src/score.ts coredoc-parsers/<projectId>/<repoName>/profile.ts <repoPath>
```

**It typechecks the profile first and refuses to score one that does not match the schema.** A profile is
loaded by transpiling, which never checks types, so a rule naming a field the schema lacks used to load
fine and extract nothing — the category then reads FAIL and you burn the loop tuning a rule that was
never wired up. If you get `Profile does not match the ExtractionProfile schema`, fix the named lines
before reading any coverage number; they are not a coverage problem.

Then it resolves the profile by module path (above); runs the engine; prints per-category coverage (source
signal, emitted, ratio, required/n-a, PASS/PARTIAL/FAIL), an **unclaimed-site cluster report** for each
failing/under-emitting category (grep hits no emitted node claims, grouped by shape — your refine map),
the structural block (validate-output errors — must be 0 — + red flags), the overall verdict, and a
gaps list. Exits non-zero unless overall PASS.

The denominators are real, per category:

- **externalCalls** — call sites of the HTTP-client deps declared in the repo's `package.json`
  `dependencies` (`axios`, `got`, `node-fetch`, `undici`, `superagent`, `ky`, `@nestjs/axios`) plus
  constructed `new *Api(…)`/`new *Client(…)` sites. The grep is coarse, so the bar is **PASS ≥50%,
  FAIL below — no PARTIAL band**; with no client dep and no constructed clients the category stays
  self-relative (n/a at 0 emitted). **Red flag** at ≥5 such call sites with 0 externalCalls emitted —
  and a red flag is an **auto-fail** (overall FAIL until fixed), not a suggestion.
- **dbOperations** — the emitted entity count (≥0.8 ops/entity → PASS). On `schemaMirror: true`
  profiles the denominator becomes the **distinct operated entities** and the scorecard's `basis`
  column discloses it: `operated-entity basis (raw 39/92 = 42%)`. The flag is honored **only when an
  entity-generator dependency is present** in the repo manifest (`@mikro-orm/entity-generator`,
  `typeorm-model-generator`, `sequelize-auto`); without that evidence it is ignored and the row notes
  `schemaMirror ignored (no entity-generator dependency found)`.
- **queue** — the profile's own queue detector shapes when declared (precise). Without a queue rule,
  the fallback uses evidence-rich messaging decorators/constructors plus dependency-and-receiver-gated
  KafkaJS/NATS/Redis subscriptions. Generic `.subscribe(` is deliberately excluded because RxJS,
  state stores, and realtime clients use it without declaring queue entrypoints.

> Scoring runs the SCIP pass. **TS/JS** needs the target repo's `node_modules` + `scip-typescript`;
> **Ruby** uses the optional, explicitly installed `scip-ruby` and otherwise the Tier-B heuristic.
> Ruby's standalone indexer needs no Gemfile changes or Bundler setup. TS/JS needs the repo's
> dependencies installed first; without them call-graph coverage degrades.

### 4. Refine the profile (not code)

**Read the cluster report first.** Each `Unclaimed <category> sites` cluster is usually ONE missing
profile rule, and its shape names the primitive to add: a decorator shape (`@SqsMessageHandler(`) → an
entrypoint/entity decorator rule; a receiver chain (`em.getRepository(`) → a dbOp receiver pattern /
`opMap` entry; a constructor (`new UsersApi(`) → an external-call matcher (`sdk` `diTypeSuffix` /
`newInstanceOf`). Fix the biggest cluster, re-score, repeat.

Then read the remaining gaps and fix the **profile**:

- **required category below its PASS bar** → detector/argref too narrow: widen the decorator/callee
  map, fix a `paramSyntax`, add an op to `opMap`, broaden a `receiverPattern`.
- **handlers through a registry** → add a `handlerTable` and point the entrypoint's
  `handler: { via: 'handler-table', table }` at it (koa-router / pub-sub / bg-queue indirection).
- **validate-output errors** → a dangling handler/caller/callee reference: tighten the rule.
- **red flag** (entities but no dbOps, entrypoints without handlers, HTTP-client call sites but 0
  externalCalls, a schemaMirror basis with <5% of entities operated and <10 dbOperations — likely
  under-extraction, not a schema mirror) → fix the rule that should have populated the dropped
  category. Red flags fail the overall verdict — never "accept" one.
- **dbOperations permanently FAILs on a schema-mirror repo** (entity set generated from the whole DB
  schema — e.g. `@mikro-orm/entity-generator` output — while only a subset is operated on) → set
  `schemaMirror: true`. That is the honest fix: the denominator becomes the operated entities and the
  scorecard discloses the basis. It is honored only when an entity-generator dependency is present in
  the manifest; otherwise it is ignored with a scorecard note. Don't drop entities to game the ratio,
  don't accept a permanent FAIL.
- **convention you can't express** → first try harder to express it with a primitive. If it's genuinely
  bespoke (e.g. Electron `ipcMain.handle('ch', handler)`), there **is** a gated escape hatch — `customRules`
  (a facts-only `run(facts, emit)` fn in the profile, run after the built-ins) — but it's the **last resort**:
  the rule can only emit nodes for call sites the substrate found (it can't fabricate), and if it needs a
  read-fact the substrate doesn't expose, that fact extension needs a unit test (a half-right fact fails
  silently). Because `run` is real code, **copy the `CallSite`/`ArgNode`/`facts`/`emit` shapes from
  `references/profile-cheatsheet.md` → customRules rather than writing them from memory** — a guessed
  field name is the one mistake here that produces a rule which runs, matches nothing, and reports
  success. Then confirm it emitted a non-zero count. Always report the gap (in the profile doc comment)
  so a recurring custom rule/fact graduates into a primitive — the promotion loop.

Re-score until overall PASS — **but the loop is budgeted, not open-ended.** Track each category's
coverage across score runs. If a category has not improved after **3 consecutive refine→score
attempts**, or the whole refine stage has burned **8 score runs** without reaching overall PASS,
inspect the final `Profile completion` marker. Only `ACCEPTABLE_GAP` — one or more PARTIAL coverage
rows with no category FAIL, structural error, red flag, or unclaimed scope — may be offered to the
user (moment 3 below). `BLOCKED` must be refined or end unsuccessfully; it is never accept-as-is.
Grinding the same PARTIAL for another half hour
produces rule bloat and gamed denominators, not coverage — the remaining gap is usually either
genuinely-sparse signal (the denominator's grep over-counts) or a convention only the user can name.
Before offering acceptance, finish the audit, document the gap in the profile's doc comment
(category, ratio, what was tried), and score the final bytes. Then ask for the user's decision.
Accepting that documented PARTIAL is a legitimate outcome: finish with the accepted gap in the
final summary. Do not edit the profile or re-score after acceptance; either invalidates the
acceptance of the scored revision. `coredoc parse` does not require a PASS scorecard to run.

### 5. Audit — adversarial graph-vs-repo verification (after scorecard PASS)

A green scorecard is necessary, not sufficient: its denominators come from the rules you
declared, so it is blind to surfaces you never declared. Do not skip this step because
the scorecard looks clean — that is the blind spot it exists for.

**Protected Desktop variant.** When the host prompt explicitly says arbitrary Audit commands are
unavailable, do not probe for alternate interpreters or command workarounds. Use the synthesized
directional-scout matrix, scorer red flags, and targeted Read/Glob/Grep spot-checks as the audit
evidence. `score-*.json` is temporary staging scratch and `graph-audit.md` is not a completion artifact
in that variant; only the verified `profile.ts` is promoted. The command-driven artifact protocol and
exit criteria below apply to unrestricted CLI authoring.

Dispatch five audit subagents in parallel — entrypoints; entities+dbOperations; frontend
surface; call graph+egress; packages/files integrity — using the prompts in
`references/graph-audit.md` verbatim (prepend the shared preamble, fill the three paths).
Then dispatch the synthesis subagent (same file) to consolidate into a dated section of
`graph-audit.md` next to the profile — the audit log, versioned with it. Where angles
contradict, re-check the fact before acting.

**Triage — findings are hypotheses, not work orders.** Auditors misattribute causes,
miscount, and claim rules fit file sets they don't:
- Before ANY profile edit, reproduce the finding's premise by re-running its recorded
  evidence commands. Not reproducible → DISCARD (note it in graph-audit.md). Survives →
  normal Draft discipline, then re-score + re-run only the affected angle.
- A Tier-0/Tier-1 PROFILE finding you choose NOT to fix requires the user's explicit
  acceptance, recorded next to the finding — silence is not acceptance.
- ENGINE findings stay filed; report the count and the single worst one. Never work
  around an engine gap with a rule that fakes the data.
- "Honest zero" verdicts stay in healthy lanes — proof the absence was checked.

**Exit criteria (all three):** score-profile.json exists next to the profile;
graph-audit.md exists and every Tier-0/Tier-1 PROFILE finding in its latest section is
fixed, premise-discarded, or user-accepted; the affected-angle re-runs came back clean.

### 6. Verify — spot-check, then done

Confirm it's faithful, not just numerically green:

- Spot-check 2–3 emitted HTTP `fullPath`s against source (base + method path joined, params normalized).
- Spot-check 2–3 entities' fields/relations against their class.
- **Recall spot-check** — the two above sample *emitted* nodes (precision); also hunt for misses. Read
  the scorer's cluster report FIRST: its top clusters are the misses, already grouped. When the report
  is empty but a category still feels thin, sample 3–5 source sites per category from a broad grep
  (`.find(|.save(|await this.` for dbOps; `new *Api(|new *Client(|axios|fetch(` for egress) that are
  NOT in the emitted set, and classify each as genuine-miss vs noise. **>1 genuine miss reopens Refine.**
- Confirm 0 validate-output errors, no red flags.
- **Frontend absence check** — the scorecard does not measure components/routes/stateStores, so a
  frontend miss ships green. If the repo has `.tsx`/`.jsx`/`.vue` source, the profile must either
  declare the corresponding `components`/`routes`/`stateStores` rules or carry a comment justifying
  each absence (e.g. "routing is file-convention react-router fs-routes — unmodeled"). An output with
  frontend source but no `components` key is a REOPEN, not a pass.

The profile is now ready: `coredoc parse -r <repoName>` loads it, builds the substrate facts, runs the
engine, and writes the `ParsedRepo`. When done, summarize: final scorecard, profile line count, refine
iterations, any primitive gap reported, any category deliberately `not_applicable` with the why (queue
n/a on a `repoType: 'frontend'` repo is expected), and whether `schemaMirror` is set (state the
operated-entity basis the scorecard disclosed).

## When to ask the user

Three moments only:

1. **Up front (0.5)** — the familiarity gate, to harvest shortcuts. One prompt.
2. **A genuine dead-end (Score loop)** — a homegrown route/DI convention you can't classify, coverage
   that stays low and you can't tell genuine-sparse from a profile bug, or "we found 0 entrypoints — is
   that right, and where are they?". One crisp question with a best-guess default.
3. **An `ACCEPTABLE_GAP` category (Refine budget exhausted)** — 3 attempts without improvement, or 8
   score runs total. One question stating the category, its coverage (e.g. `cli 28/44 = 64%`), and what you already
   tried, with three options: **accept as-is** (finish with the gap documented — the default
   recommendation when everything else is PASS), **point me at the misses** (the user names the
   convention/files, you make targeted fixes), or **keep iterating** (they accept the time cost).
   Do not offer this question for `BLOCKED`, and do not silently keep grinding past the budget.

Never interrogate for what you can read from the code.

## References

| File | Read when |
|------|-----------|
| `references/framework-signals.md` | In Orient — the dep→convention signal table + the scout prompt template. |
| `references/language-substrates.md` | In Orient — per-language substrate details + tuning knobs. |
| `references/graph-audit.md` | In Audit (step 5) — the five angle prompts + synthesis prompt. |
| `packages/profile-parser/src/types.ts` | Before drafting — the profile schema / vocabulary. |
| `references/profile-cheatsheet.md` | Before drafting — detectors, arg refs, rules, exemplars annotated. |
| `references/archetypes/` | In Draft, when the stack matches — copy-ready base profiles (nestjs-mikroorm, react-admin, koa-sequelize) with the fleet's trap-avoiding WHY comments. |
| `packages/profile-parser/README.md` | The whole design + schema tables (incl. worked example shapes). |
