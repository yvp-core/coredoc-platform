---
name: author-profile
description: Author and iteratively refine a declarative coredoc ExtractionProfile for a code repository, driving the profile-parser engine's coverage loop. Use this whenever the user wants to "author a profile", "write an extraction profile", "create a profile for my repo", "set up profile-driven parsing", "add a repo to profile-parser", "onboard a repo to coredoc", or asks coredoc to extract a repo via a profile. This is the standard way to onboard a repo for `coredoc parse` (it replaces the old imperative ts-morph parser approach): it grounds in the repo's shape + installed libraries first, dispatches scouts to gather convention evidence, then produces a ~50-line reviewable profile that the tree-sitter+SCIP substrate engine applies to every matching site — exhaustive recall, precision by construction. The engine supplies the AST machinery; you supply the conventions.
---

# Author a coredoc ExtractionProfile

An `ExtractionProfile` is a small **declarative** config (~50 lines) describing one repo's
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
languages** (today: **TS/JS** and **Ruby**, the two with a wired substrate). For that, author a
composite **`MultiTargetProfile`** (`packages/profile-parser/src/types/multi-profile.ts`) —
`{ parserId, repoType: 'monorepo', targets: [...] }` — where each target is a full single-language
profile **minus `parserId`** plus a unique `name`.

**Detect the shape in Orient (fact 2).** Having enumerated packages, count the language populations —
extensions × directories × workspace packages. One registered language with source → single profile.
**≥2 registered languages, each with substantial source → composite.** (A stray `.rb` script in a TS
repo is not a second population; a Rails `api/` beside a React `ui/` is.)

**One target per language *scope*, never per package.** The unit of composition is the language slice,
not the workspace package: N same-language packages share **one** target and **one** SCIP index —
cross-package call resolution depends on indexing the whole language workspace together, so a
target-per-package split would fragment that index and drop cross-package edges. Each target needs a
unique `name` and a **disjoint** `include`/`exclude` scope; the engine **throws at merge if two targets
claim the same file**, so keep the globs non-overlapping. (Two *same-language* targets are allowed when
you genuinely need disjoint slices scored apart — just keep their scopes disjoint.)

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
Orient → (Ask the user, if it saves work) → Scout → Draft → Score → (Refine → Score)* → Verify → Done
```

Track these as todos.

### 0. Orient — establish the facts (deterministic, no guessing)

Read the manifests and repo layout FIRST. Produce four facts that drive everything below:

1. **Repo shape.** Monorepo or single? Check `pnpm-workspace.yaml`, root `package.json` `workspaces`,
   `lerna.json`, `nx.json`, `turbo.json`, `go.work`. If a monorepo, **enumerate ALL packages/apps** and
   cover **every one that holds source** in `substrate.include` — coredoc parses the *whole* repository,
   not just the primary framework app. Use broad globs (e.g. `['apps/**/*.ts', 'packages/**/*.ts']`), not
   a single app like `apps/server/**`. Framework rules (routes/entities/db-ops) apply where they match;
   plain library packages with no framework still contribute functions, classes, and their call graph via
   the base substrate, so they must be included too. The coverage scorecard only measures the *included*
   scope — a PASS on a narrow `include` is **not** done; widen until it spans the repo, then re-score.
   Never assume a single root `src/`.
2. **Language.** From manifests + file extensions. The engine extracts via tree-sitter + a SCIP indexer.
   Wired today:
   - **TS/JS** (`scip-typescript`) — the full `ExtractionProfile` vocabulary in this cheat-sheet.
   - **Ruby/Rails** — a tree-sitter substrate for routes/entities/db-ops/egress + a Tier-B call
     heuristic, with optional `scip-ruby` for compiler-grade calls (see 0.6). Uses `RubyProfile`.
   - **Swift** — `SwiftProfile`.
   - **Python** — a tree-sitter substrate for Django/DRF routes, Celery tasks, ORM entities/db-ops,
     and HTTP egress, with an import-aware Tier-B call resolver. Uses **`PythonProfile`**, which is a
     much smaller vocabulary than `ExtractionProfile`: the framework conventions live in engine code
     and the profile only TUNES them (`entities.baseClasses`, `entrypoints.djangoRoutes.routeFileGlobs`,
     `entrypoints.queue.taskDecorators`, `egress.clientModules`, `dbOperations.methods`). Every knob is
     optional, so a bare `{ parserId, substrate: { language: 'python', include } }` already parses a
     Django/DRF/Celery repo — start there and tune only what the scorecard says is missing.
     `scip-python` Tier-A is not wired; the parse never fails on a missing venv, it degrades to Tier-B.
   Multi-language is the goal, but each language's substrate lands separately. If the target is
   primarily **Go/Rust/etc.** (no substrate yet), **say so plainly and stop**: you can scout conventions
   and sketch a profile, but the engine can't index/extract it yet — note it for the multi-language
   engine track. Proceed with extraction only on a wired language (TS/JS, Ruby, Swift or Python; or
   that portion of a polyglot repo — a polyglot monorepo is a `MultiTargetProfile`, one target per
   language).
3. **Libraries → candidate conventions.** Read the manifest(s) (per-package in a monorepo) and map the
   installed deps to the frameworks/ORMs/queues/clients they imply — see
   `references/framework-signals.md`. This *hypothesis* is what the scout confirms: `@nestjs/common` ⇒
   `@Controller`/`@Get` + `@Entity`; `express`/`koa` ⇒ `app.get`/`router.get` call-shapes; `sequelize`
   ⇒ `sequelize.define` factory entities; `@mikro-orm/*`/`typeorm` ⇒ decorator entities; `kafkajs`/
   `bullmq` ⇒ queues; `axios`/an injected `*ApiClient` ⇒ external calls.
4. **Scope.** The source root(s) and obvious excludes (`node_modules`, `dist`, tests, `.d.ts`, `.yarn`),
   per target package.

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

### 0.6 Ruby only — offer scip-ruby (Tier-A calls), consented

For a Ruby/Rails target the call graph has two tiers. **Tier-B** (tree-sitter heuristic: constant + self
sends) always works, no toolchain. **Tier-A** (`scip-ruby`, a Sorbet-based SCIP indexer) is compiler-grade
— it resolves bare self-sends, inheritance/MRO, and constant calls Tier-B can't — and on a real untyped
Rails repo lands **~3× more internal call edges at high precision**. Tier-A activates automatically **iff**
`scip-ruby` is in the repo's bundle, so check:

```
grep scip-ruby <repoRoot>/Gemfile.lock     # present → Tier-A is already on; skip this step
```

If **absent**, offer to install it — **consent required, never silent** (this edits the user's Gemfile and
runs `bundle install`). Ask one structured yes/no:

> "Add `scip-ruby` (a dev gem) to this repo's Gemfile and run `bundle install`? It gives compiler-grade
> Ruby call edges (~3× the tree-sitter heuristic). Declining is fine — calls fall back to Tier-B."

- **Consent → install.** Add to the Gemfile **idempotently** (skip if a `scip-ruby` line already exists),
  in the development group:
  ```ruby
  gem 'scip-ruby', '~> 0.4.7', require: false, group: :development
  ```
  (Pin a known-good version — `~> 0.4.7` is the validated baseline; scip-ruby is a low-cadence
  external gem, so an unpinned line risks pulling an untested release.)
  Then run `bundle install` in `<repoRoot>` and re-check the lockfile to confirm. Platform note: the binary
  ships for **arm64-macOS + x86_64-Linux only** — elsewhere `bundle install` may fail or the indexer won't
  run; that's fine, it degrades to Tier-B.
- **Decline → proceed.** No edit. Calls use Tier-B. No failure, no re-ask.

One-time setup: once `scip-ruby` is in the lockfile, every `coredoc parse` / Score run picks up Tier-A
automatically (provenance `scip`).

### 1. Scout — dispatch evidence-gatherers (haiku), one per target package

For each target package, dispatch a **scout subagent on the `haiku` model** (`Task` with the haiku
model). The scout's job is **mechanical and cheap — gather evidence, do NOT write the profile.** Hand it
the candidate frameworks from Orient and have it sample 2–3 representative files per category and report
the raw facts:

- **entrypoints** — HTTP: exact decorator names + arg positions (`@Get(':id')`) OR the router call-shape
  (`router.get('/x', h)`) + how the base path is set. Also capture non-HTTP kinds where present: CLI
  commands (`program.command('name')…action(h)`), gRPC methods (`@GrpcMethod('Svc','Method')`), and
  GraphQL resolvers (`@Resolver()` class + `@Query`/`@Mutation`/`@Subscription` fields);
- **entities** — decorator (`@Entity`) + field/PK/relation decorator names, OR a factory call
  (`sequelize.define(name, {...})`);
- **queues** — method decorators (`@EventPattern`) OR a registration call (`initHandler(...)`);
- **DI** — constructor-type injection? the receiver patterns for `this.svc.method()`;
- **external clients** — which receivers / injected SDK types make outbound calls; any internal SDK
  package names;
- **handler indirection** — are handlers referenced through a require/alias registry (`handlers.api.x`)?

The scout returns **structured findings** (decorator/callee/receiver names, arg positions, file paths,
short snippets) — NOT a profile. Run scouts in **parallel** for a monorepo. Scout prompt template:
`references/framework-signals.md`.

### 2. Draft — interpret the evidence into the profile (judgment lives here)

*You* turn the scouts' raw facts into rules — "files use `@Get(':id')`" becomes a `method-decorator`
detector + a `string-literal` arg ref + `paramSyntax: 'colon'`. Write the profile where `coredoc parse`
loads it: **`coredoc-parsers/<projectId>/<repoName>/profile.ts`**, exporting one `ExtractionProfile` (it
takes precedence over any legacy `parser.ts`). Set `substrate.include`/`exclude` from Orient's scope.
Build every rule from the two primitives — **detectors** + **arg refs** — plus small maps.

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
- **queue** — the profile's own queue-decorator names when declared (precise). Without a queue rule,
  `repoType: 'frontend'` → `not_applicable` (frontends have no queue surface); a backend falls back
  to a call/decorator-shaped grep scoped to the profile's `include` roots.

> Scoring runs the SCIP pass. **TS/JS** needs the target repo's `node_modules` + `scip-typescript`;
> **Ruby** uses `scip-ruby` when it's in the bundle (offered in 0.6) and otherwise the Tier-B heuristic.
> Install the repo's deps first; without them call-graph coverage degrades.

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

Re-score until overall PASS.

### 5. Verify — spot-check, then done

Confirm it's faithful, not just numerically green:

- Spot-check 2–3 emitted HTTP `fullPath`s against source (base + method path joined, params normalized).
- Spot-check 2–3 entities' fields/relations against their class.
- **Recall spot-check** — the two above sample *emitted* nodes (precision); also hunt for misses. Read
  the scorer's cluster report FIRST: its top clusters are the misses, already grouped. When the report
  is empty but a category still feels thin, sample 3–5 source sites per category from a broad grep
  (`.find(|.save(|await this.` for dbOps; `new *Api(|new *Client(|axios|fetch(` for egress) that are
  NOT in the emitted set, and classify each as genuine-miss vs noise. **>1 genuine miss reopens Refine.**
- Confirm 0 validate-output errors, no red flags.

The profile is now ready: `coredoc parse -r <repoName>` loads it, builds the substrate facts, runs the
engine, and writes the `ParsedRepo`. When done, summarize: final scorecard, profile line count, refine
iterations, any primitive gap reported, any category deliberately `not_applicable` with the why (queue
n/a on a `repoType: 'frontend'` repo is expected), and whether `schemaMirror` is set (state the
operated-entity basis the scorecard disclosed).

## When to ask the user

Two moments only:

1. **Up front (0.5)** — the familiarity gate, to harvest shortcuts. One prompt.
2. **A genuine dead-end (Score loop)** — a homegrown route/DI convention you can't classify, coverage
   that stays low and you can't tell genuine-sparse from a profile bug, or "we found 0 entrypoints — is
   that right, and where are they?". One crisp question with a best-guess default.

Never interrogate for what you can read from the code.

## References

| File | Read when |
|------|-----------|
| `references/framework-signals.md` | In Orient — the dep→convention signal table + the scout prompt template. |
| `packages/profile-parser/src/types.ts` | Before drafting — the profile schema / vocabulary. |
| `references/profile-cheatsheet.md` | Before drafting — detectors, arg refs, rules, exemplars annotated. |
| `references/archetypes/` | In Draft, when the stack matches — copy-ready base profiles (nestjs-mikroorm, react-admin, koa-sequelize) with the fleet's trap-avoiding WHY comments. |
| `packages/profile-parser/README.md` | The whole design + schema tables (incl. worked example shapes). |
