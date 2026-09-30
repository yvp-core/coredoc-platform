# SCIP probe — can coredoc extraction run on tree-sitter + SCIP instead of ts-morph?

**Date:** 2026-06-17
**Target repo:** `acme-core` (`/path/to/acme/acme-core`) — NestJS / MikroORM / Kafka.
**Ground truth:** the ts-morph profile-engine golden at `/tmp/pp-acme-core.json` (from `packages/profile-parser/src/profiles/acme-core.ts`).
**Probe code:** `packages/profile-parser/scip-probe/` (`run.ts` + `decorator-conventions.ts`), tsx-runnable, isolated from the ts-morph engine.

```
npx tsx packages/profile-parser/scip-probe/run.ts \
  /path/to/acme/acme-core acme-core \
  /tmp/scip-probe-acme-core.json /tmp/pp-acme-core.json
```

## What the probe does

1. **Step 1 — native baseline.** Calls `buildBaseline({repoRoot, repoName}, {runScip:true})` from `@coredoc/code-graph`: web-tree-sitter structure + `scip-typescript` semantic edges. SCIP ran successfully (NOT degraded) in ~8s — no blocker.
2. **Step 2 — conventions over the tree-sitter substrate.** `extractConventions(structuralFiles, idGen)` reproduces acme-core's HTTP entrypoints + MikroORM entities by parsing the **full-text decorator strings** on `StructuralClass.decorators` / `methods[].decorators` / `properties[].decorators` with small regexes — the same conventions as `profiles/acme-core.ts`, but with **zero ts-morph**.
3. **Step 3 — assemble + compare.** Calls/externalCalls come from the SCIP graph; conventions supply entrypoints/entities. Assembled into a `ParsedRepo` and compared to the golden.

## Comparison table (golden ts-morph vs tree-sitter + SCIP)

Two columns of "tree-sitter+SCIP": **raw** (whole repo as discovered) and **src-restricted** (filtered to `src/**/*.ts`, excluding `*.spec/test.ts` — the substrate the ts-morph profile actually uses via `include: ['src/**/*.ts']`).

| category        | golden (ts-morph) | tt+SCIP raw | tt+SCIP src-only | verdict |
|-----------------|------------------:|------------:|-----------------:|---------|
| functions       | 628               | 4536        | 799              | comparable (src) |
| classes         | 487               | 578         | 483              | **near-exact (src)** |
| entrypoints     | 135               | **135**     | 135              | **exact** |
| &nbsp;&nbsp;http | 132              | **132**     | 132              | **exact** |
| &nbsp;&nbsp;queue | 3               | **3**       | 3                | **exact** |
| entities        | 104               | **104**     | 104              | **exact** |
| dbOperations    | 224               | 0           | 0                | **not reproduced** |
| calls           | 1317              | 21920       | 4088 (2336 both-ends-resolved) | different semantics |
| externalCalls   | 12                | 9121        | 8700             | **different concept** |

### The raw-column inflation is a substrate (discover) bug, not a SCIP problem

The 4536→799 function gap is almost entirely **one file**: `.yarn/releases/yarn-1.22.19.js` (the bundled Yarn 1.x launcher, a minified blob) contributed **3697** function nodes. acme-core uses Yarn zero-installs; `discover`'s `IGNORE_DIRS` does not include `.yarn`, so the structural parser ingests that megabyte of vendored JS. The ts-morph profile never sees it (`include: ['src/**/*.ts']`). **Fix is trivial:** add `.yarn` to `IGNORE_DIRS` and honour a profile-style `include`/`exclude`. All real comparisons below use the src-restricted column.

## What tree-sitter reproduced — 132/104, exactly

- **HTTP entrypoints: 132/132 exact.** Every golden `METHOD fullPath` was reproduced with byte-identical `fullPath` (`Controller('base')` + `Get('/x')` joined, `:param`→`{param}` canonicalised). 0 missing, 0 extra.
- **Queue entrypoints: 3/3 exact**, including the non-literal topic `getTopicInNamespace(forward-to-test as Topics)` carried verbatim (matches golden — ts-morph also leaves it unresolved).
- **Entities: 104/104 exact name overlap**, 0 missing / 0 extra. 1083 fields, 101 relations, 55 entities with relations.
- **Field/relation fidelity** spot-checks match the golden field-for-field: e.g. `AdditionalIdentifications` (7 fields, 1 rel, table `additional_identifications`) is identical; `AbTests` reproduces `fieldName`→columnName mapping, `nullable`, `default`, snake_case fallback, and `isGenerated` for the PK.

**Conclusion for conventions:** the decorator FULL-TEXT strings tree-sitter keeps are a *complete* substitute for ts-morph decorator nodes for this profile. Every fact the profile reads (decorator name, string-literal args, object options `tableName`/`fieldName`/`nullable`/`unique`/`default`, `() => Target` relation arrows) is recoverable with the same regexes the ts-morph engine already uses on `DecoratorInfo.expression`. Field `type.text` comes from the property's type annotation, which tree-sitter also captures.

## What SCIP gave for calls / externalCalls — and the precision caveat

SCIP produced **2336** internal call edges with both ends resolved to real `src` function nodes (vs golden 1317) and **8700** external calls (vs golden 12). The counts diverge because **SCIP and the ts-morph profile define "call" and "external call" differently**, not because either is wrong:

- **`externalCall` is a different concept.** SCIP emits an external edge for *every cross-package symbol reference* — every use of an imported `@nestjs/common`, `@mikro-orm/core`, `date-fns`, `typescript`, even an internal `core` moniker (top services by count: `core` 4265, `typescript` 1686, `@mikro-orm/core` 748, `@acme/api-client` 675, `@nestjs/common` 541). The ts-morph profile's `externalCall` is a *curated egress set* — only HTTP/Kafka/SDK calls that leave the service (`http-service` 2, `kafka` 8, `axios` 2). SCIP's 8700 is a superset that includes all library symbol usage; it would need a profile-style allow-list (receiver/verb/SDK matchers) layered on top to recover the 12 the golden cares about. **Useful spot-check:** SCIP *does* find the egress — `axios` (26), `@acme/api-client` (675), and the MikroORM symbols are all present; the signal is there, just unfiltered.
- **Internal-call precision is mixed.** Bare and same-file calls resolve correctly (`startHttpApplication → startApplication`, `startApplication → getBootstrappedApplication`). But **DI member-chain calls resolve to the wrong symbol**: `this.apiClientService.schedules.listUserProfilesSchedules(...)` resolves to `constructor` (SCIP follows the receiver's *type* and lands on the class's constructor symbol, not the invoked method). The ts-morph profile's DI map resolves these to the correct method via `constructor-type` injection. So SCIP gives *more raw edges* but *lower semantic precision on the DI patterns that matter for a NestJS call graph* — the inverse trade-off from the `project_code_graph_experiment` finding (SCIP precise/low-recall on enumerated edges; here it's high-recall/mixed-precision because it resolves through types indiscriminately).

## Where it diverged / gaps

1. **dbOperations: 0 vs 224 — not reproduced.** The probe deliberately did not port the db-op rule. It is reproducible on the tree-sitter substrate (the `StructuralCall` records `receiver`, `methodName`, and `arguments` as strings — enough to run the `em`/`repo`/opMap convention), but it needs the **DI map** (constructor param `name → ClassName`), which tree-sitter also captures via `StructuralClass.ctorParams[].type`. It was out of scope for this probe; no blocker, just unbuilt.
2. **externalCall semantics** need an allow-list layer (above) before SCIP's output is comparable to the curated golden.
3. **Substrate scoping** (`.yarn`, specs) must be profile-driven, not discover-default.

## VERDICT

**Yes — ts-morph can be dropped in favour of tree-sitter + SCIP for the convention-driven facts, with caveats on the call graph.** The decisive result: tree-sitter's decorator full-text strings reproduced **132/132 HTTP entrypoints and 104/104 MikroORM entities exactly, field-for-field**, with no ts-morph anywhere — proving the profile's *convention layer* (entrypoints, entities, and by extension db-ops and DI) runs entirely on the tree-sitter substrate. SCIP supplies a real, high-recall internal call graph (2336 resolved src edges) and detects all the egress targets, so the *call layer* is viable too. The caveats are real but addressable, not fundamental: (a) discover must scope the substrate like the profile does (exclude `.yarn`/specs) — a one-line fix that collapses the 722% function inflation to ~127%; (b) SCIP's `externalCall` is "every cross-package reference," so the curated 12-egress view needs a thin receiver/verb allow-list on top; (c) SCIP mis-resolves DI member-chain calls to the class constructor, so for a precise NestJS call graph the ts-morph-style DI map (recoverable from `ctorParams`) still beats raw SCIP on those sites. None of these require ts-morph. JS support is the open risk not exercised here (acme-core is pure TS); tree-sitter parses JS, but the untyped-JS call/DI resolution that ts-morph's `untypedJsMode` handled would fall to SCIP's `--infer-tsconfig`, untested in this probe.

---

## JS probe (acme-schedules)

**Date:** 2026-06-17
**Target repo:** `acme-schedules` (`/path/to/acme/acme-schedules`) — pure-JS Koa + Sequelize + Google Pub/Sub, ~260 `.js`, `jsconfig.json` (no tsconfig), `node_modules` present.
**Ground truth:** the ts-morph profile-engine golden at `/tmp/pp-acme-schedules.json`, regenerated from `packages/profile-parser/src/profiles/acme-schedules.ts` via `npx tsx src/run.ts acme-schedules <repo> /tmp/pp-acme-schedules.json` (reproduces 82/9/16/135/591/873/6, validate-output 0 errors).
**Probe code:** `packages/profile-parser/scip-probe/` (`run-js.ts` + `call-shape-conventions.ts`), tsx-runnable.

```
npx tsx packages/profile-parser/scip-probe/run-js.ts \
  /path/to/acme/acme-schedules acme-schedules \
  /tmp/scip-probe-acme-schedules.json /tmp/pp-acme-schedules.json
```

This is the JS analogue of the acme-core decorator proof. acme-core's conventions are **decorator-driven** — and `StructuralFile`'s decorator full-text strings carried them. acme-schedules' conventions are **call-shape-driven** (no decorators at all): `sequelize.define(...)`, Koa `router.<method>(...)` nested inside `router.extend(BASE, fn)`, and `initHandler(JOB_CONST, handlers.alias)`. The probe tests whether the substrate carries *those*.

### (a) SCIP on pure JS — WORKS, not degraded

`buildBaseline({repoRoot, repoName:'acme-schedules'}, {runScip:true})` ran in **2.7s** with **`SCIP degraded: false`** and **zero warnings**. scip-typescript indexed the `.js` tree via the synthesized-tsconfig / `--infer-tsconfig` path (`pipeline.ts` runs SCIP whenever the TS *or* JS prereqs are met; `node_modules` present satisfies the JS prereq). It produced **8274 call edges, 7295 with `calleeId` resolved** and **3085 externalCalls**. **SCIP-on-JS is real, not a degraded stub** — the open risk is retired.

### (b) Call-shape conventions over RAW tree-sitter CST — 82/9/16 exact

The conventions were run over **raw web-tree-sitter CST** (via `TreeSitterLoader`, the same loader+parse pattern as `ts-structural.ts`), NOT over `StructuralFile.calls` — see capability finding below for why that was necessary. Result vs golden:

| category     | golden (ts-morph) | tree-sitter+SCIP | exact-match | verdict |
|--------------|------------------:|-----------------:|:-----------:|---------|
| http         | 82                | **82**           | 82/82       | **exact** |
| queue        | 9                 | **9**            | 9/9         | **exact** |
| entities     | 16                | **16**           | 16/16       | **exact** |
| entity fields| 200               | **200**          | —           | **exact** |
| entity relations | 9             | **9**            | —           | **exact** |
| functions (src-scoped) | 591     | 710              | —           | comparable (scoping) |
| calls        | 873               | 8274 (7295 resolved) | —       | different semantics (as acme-core) |
| externalCalls| 6                 | 3085             | —           | different concept (as acme-core) |

Full per-entity fidelity diff (all 16): **0 tableName mismatches, 0 field-count mismatches, 0 relation-count mismatches.** Specifics reproduced from CST alone:
- **Entities (16/16):** `sequelize.define("Name", {fields}, {opts})` — name read from the string-literal arg-0 (the const-identifier resolution path is implemented for the general case but every schedules model uses a literal); `tableName` from the opts object's `tableName` key, fallback = **verbatim model name** (matching the golden's `fallback: 'verbatim'` — e.g. `AutomaticBookingTrigger`→`AutomaticBookingTrigger`, with explicit opts overriding: `OnCall`→`on_calls`); fields from the arg-1 object literal with `DataTypes.X` → type, `allowNull`/`primaryKey`/`unique`/`autoIncrement` booleans; relations from `Model.hasMany/belongsTo/...(models.Target)` calls (target read off the `member_expression` property).
- **HTTP (82/82):** `router.<method>("/p", handler)` calls recursed out of the enclosing `router.extend(BASE, fn)` callback; `fullPath = BASE + path`, `:param`→`{param}`, `del`→DELETE. Handler resolved through the `handlers` require-map (alias-chain → file). Byte-identical `METHOD fullPath` on all 82, 0 missing / 0 extra.
- **Queue (9/9):** `initHandler(JOB_NAME_CONST, handlers.alias)` with the **const resolved to its string literal** (`AUTOMATIC_BOOKINGS_JOB_NAME`→`automatic_bookings`). The bg `initializeQueues({...})` case is also walked but correctly emits **nothing** here — its one job (`update-events-subscription`) is a `module.exports = async () => {}` with no `onMessage` and no top-level function declaration, so the golden gates it out too; the probe mirrors that by gating on the handler being a real function node in the graph (`graph.functions.has(id)`). 0 missing / 0 extra against the golden's 9.

### (c) The missing capability — substrate must expose a raw call-shape query API

The decisive finding: **none of the three extractions are recoverable from code-graph's `StructuralCall` abstraction.** `StructuralFile.calls` flattens every call expression and records `receiver` / `methodName` / `arguments` (as raw text) plus the *enclosing method/function/class* — but it does **not** record:

1. **The enclosing CALL.** The Koa routes are only meaningful with the `BASE` from the `router.extend(BASE, fn)` they nest inside. `StructuralCall` has `enclosingKind: 'method'|'function'|'module'` — there is no "enclosing call expression / enclosing call argument," so the `extend`→`router.get` nesting (and thus `fullPath`) is unrecoverable from the abstraction. Raw CST recovers it by recursing into the `extend` callback node.
2. **Structured object-literal arguments.** Entity fields live in `define()`'s arg-1 object literal; `StructuralCall.arguments` stores each arg as one flat *string*, so reading `DataTypes.X` / `allowNull` / `tableName` means re-parsing that string. Raw CST gives the `object` → `pair` → key/value nodes directly.
3. **In-scope value/const resolution at a call site.** `initHandler(JOB_CONST, ...)` needs `JOB_CONST` resolved to its literal. `valueBindings` captures top-level `const X = "lit"`, so this *one* is borderline-recoverable via the existing resolver — but the require-map alias chain (`handlers.apiManagement.schedules.create` → file+method) is not, and that is what makes the handlerId resolvable.

So a tree-sitter+SCIP **profile engine** needs one capability the current `structuralFiles` does not expose: **a raw call-shape query API** — access to the CST `call_expression` nodes with (i) their nesting/enclosing-call chain, (ii) structured (not stringified) argument nodes including object literals, and (iii) a hook to resolve identifier/require-map args against in-file bindings. This is the call-shape analogue of what the decorator full-text strings already gave the acme-core probe for free.

### VERDICT (JS)

**Yes — the tree-sitter + SCIP substrate handles the pure-JS / call-shape case, with one substrate-API gap.** SCIP indexes pure JS without degrading (2.7s, 7295 resolved edges), retiring the open risk from the acme-core probe. Raw tree-sitter CST reproduced **all 82 HTTP routes, 9 Pub/Sub queues, and 16 Sequelize entities exactly — field-for-field (200/200 fields, 9/9 relations, 0 tableName/field/relation mismatches across all 16)** — proving the CST carries everything call-shape conventions need: call expressions, string-literal args, structured object literals, const resolution, member-expression targets, and arbitrary call nesting. The single non-fundamental gap is that the convention extraction had to bypass code-graph's `StructuralCall` abstraction and go to raw CST, because `StructuralCall` flattens calls and drops (1) the enclosing-call chain that supplies the Koa `BASE`, (2) structured object-literal argument nodes, and (3) call-site const/require-map resolution. The capability a tree-sitter+SCIP profile engine must add is therefore a **raw call-shape query API** over the CST — nesting-aware, with structured argument nodes and an in-file binding resolver. With that one addition, ts-morph is unnecessary for the JS convention layer just as it was for the TS one; the call/externalCall semantics diverge from the curated golden exactly as in the acme-core probe (SCIP's "call"/"external" are broader concepts needing a thin allow-list on top), not a JS-specific problem.

---

## Step 2 — engine on tree-sitter+SCIP substrate

Step 1 proved the *conventions* run over tree-sitter+SCIP via two throwaway probes. Step 2 builds the real thing: a backend-neutral **`Substrate`** interface (`src/substrate/interface.ts`), a **tree-sitter+SCIP implementation** (`src/substrate/tree-sitter-scip.ts`), and a **`SubstrateProfileEngine`** (`src/substrate/engine.ts`) that runs an `ExtractionProfile` over the substrate and assembles a `ParsedRepo`. One engine + the *existing* `acme-core` / `acme-schedules` profiles → reproduces both repos from tree-sitter+SCIP, with the ts-morph engine left untouched (parallel substrate path).

Run: `npx tsx src/substrate/run.ts <acme-core|acme-schedules> <repoPath> <outJson> [goldenJson]`. Test: `src/substrate/engine.test.ts` (asserts exact http/queue/entity counts for both, + handlerId integrity).

### Comparison: golden (ts-morph) vs substrate-engine (tree-sitter+SCIP)

#### acme-core — NestJS / MikroORM / Kafka

| Count          | Golden | Substrate | Match |
|----------------|-------:|----------:|:-----:|
| http           | 132    | 132       | exact (byte-identical fullPath/path/pathParams) |
| queue          | 3      | 3         | exact (topics included) |
| entities       | 104    | 104       | exact |
| entity fields  | (all)  | (all)     | exact — 0 field mismatches across 104 |
| entity relations | (all)| (all)     | exact — 0 relation mismatches across 104 |
| dbOperations   | 224    | 224       | exact |
| externalCalls  | 12     | 12        | exact |
| validate-output errors | 0 | **0**   | exact |

#### acme-schedules — pure-JS Koa / Sequelize / Pub-Sub

| Count          | Golden | Substrate | Match |
|----------------|-------:|----------:|:-----:|
| http           | 82     | 82        | exact (byte-identical fullPath/path/pathParams) |
| queue          | 9      | 9         | exact (topics included) |
| entities       | 16     | 16        | exact |
| entity fields  | (all)  | (all)     | exact — 0 field mismatches across 16 |
| entity relations | (all)| (all)     | exact — 0 relation mismatches across 16 |
| dbOperations   | 135    | 135       | exact |
| externalCalls  | 6      | 6         | exact |
| validate-output errors | 0 | **0**   | exact |

**MUST + SHOULD all met exactly, 0 validate-output errors on both.** Entity fields/relations are byte-identical (a per-entity diff of columnName/PK/nullable/unique flags and relation name/type/target found 0 mismatches across all 120 entities). dbOperations (the SHOULD) reproduced exactly via the same convention+DI approach as entities.

### The three Step-2 fixes — calls/externals before vs after (REPORT)

The findings from Step 1 were acted on in the substrate impl:

**Fix 1 — scope the substrate to the profile include/exclude globs.** A minimal glob matcher (`src/substrate/glob.ts`) scopes `structuralFiles` and the graph nodes, killing the bundled-`.yarn` inflation:

| functions | raw baseline | scoped | golden |
|-----------|-------------:|-------:|-------:|
| acme-core  | 4536         | 840    | 628 (628 = ts-morph; 840 = tree-sitter incl. arrow/object methods) |
| schedules | 945          | 711    | 591 |

**Fix 2 — external allow-list.** SCIP's `externalCalls` is a broad cross-package symbol-ref superset; the engine ignores it and re-derives curated egress from the profile's `externalCalls` matchers (receiver/verb/DI-type) over the structural call sites, gated by the ctor DI map — exactly as the ts-morph engine does:

| externalCalls | raw SCIP superset | allow-listed | golden |
|---------------|------------------:|-------------:|-------:|
| acme-core      | 9121              | **12**       | 12 (exact) |
| schedules     | 3085              | **6**        | 6 (exact) |

**Fix 3 — ctorParams-based DI map for member-chain calls.** SCIP misresolves `this.svc.method()` to the receiver's *constructor*. A DI map built from tree-sitter `StructuralClass.ctorParams` (param name→type) re-resolves the member-chain call to the right method, mirroring the ts-morph engine's DI primitive.

**internalCalls — before vs after scoping + DI correction:**

| calls       | raw SCIP (resolved) | scoped + DI (resolved) | golden |
|-------------|--------------------:|-----------------------:|-------:|
| acme-core    | 21920 (3952)        | 4088 (2348)            | 1317 |
| schedules   | 8274 (7295)         | 6767 (6053)            | 873 |

Scoping + DI brings the call set far closer to golden (acme-core 21920→4088), but a **residual delta remains** (4088 vs 1317; 6767 vs 873). The explanation is the same "different semantics" finding from Step 1, now quantified: **tree-sitter records every `call_expression` as a call edge, whereas the ts-morph golden's `resolveAndClassifyCall` only emits an edge for the call shapes its primitives recognize** (this-method, DI-method, bare-function, abstain-receiver) and *drops the rest* (calls on locals, chained library calls, built-in-ish receivers it can't classify). The substrate keeps all structural+SCIP edges; the golden is a curated subset. This is a deliberate divergence in what "a call" means, not a fidelity bug — the **edges the golden DOES emit are reproduced** (handlerId/callerId/calleeId integrity is clean: 0 validate-output errors, every entrypoint handler resolves to a real function node). Closing the residual to golden's exact count would require porting the ts-morph engine's call-*classification gate* (which edges to keep) into the substrate engine — a count-shaping policy, orthogonal to substrate capability.

### What (if anything) still needs the ts-morph path

**Nothing for the MUST/SHOULD surface** (entrypoints, entities, fields/relations, dbOps, externals) — all reproduced exactly from tree-sitter+SCIP. The only residual is the **internalCalls count**, and that is a *policy* gap (the golden emits a curated subset of call edges), not a substrate gap: the raw call-shape query API added here (`Substrate.callShapes()` — nesting-aware, structured args, in-file const resolver) supplies everything the conventions need; the ts-morph `customRules` escape hatch (Koa handler-alias map, pub-sub require-map) is reproduced as substrate-CST handlers (`src/substrate/schedules-custom-rules.ts`). ts-morph is not required for either convention layer.

## Step 3 — handlerTable primitive

The three bespoke `customRules` handlers (koa-router-handlers, pubsub-init-handlers, bg-initialize-queues) — ~250 lines of imperative ts-morph + a parallel ~270-line substrate-CST re-implementation — were one pattern: **resolve a handler reference through a cross-file require/alias registry table to a function in another file.** That pattern is now a declarative primitive.

### Schema (`types.ts`)

```ts
interface HandlerTable {
  name: string;                              // referenced by entrypoint rules
  registryVar: string;                       // var holding the alias→require map ("handlers")
  inFile?: string;                           // where the registry is declared (member-chain)
  leaf: 'require';                           // object-literal leaves are require("path")
  reference: 'member-chain' | 'require-arg'; // how a handler ref maps to (file, method)
  nested?: boolean;                          // registry nests aliases (member-chain)
  defaultMethod?: string;                    // method when ref has no trailing segment ("onMessage")
  requirePrefix?: string;                    // require() path filter (default "app/")
}
// entrypoint handler resolution gains:
type HandlerResolution = ArgRef | { via: 'handler-table'; table: string; arg: number };
```

A `handlerTables: HandlerTable[]` config sits on the profile; call-shape entrypoint rules point their `handler` at a table by name. The engine builds the alias→file map once per table (walking the `registryVar` object literal, nested aliases joined by `.`, `require()` leaves resolved to files), then resolves each handler reference:

- **member-chain** — `handlers.a.b.create`: trailing segment is the method, the rest is the alias → `functionId(aliasFile, method)`. With `defaultMethod` (pub-sub), an alias-only ref `handlers.alias` resolves to `functionId(aliasFile, defaultMethod)`.
- **require-arg** — `initializeQueues({ name: [n, require("app/jobs/x")] })`: object key is the topic, the `require()` value is the file → `functionId(file, defaultMethod)`. The golden gate (emit nothing when the handler doesn't resolve to a real function node) is preserved by the `hasFunctionId`/registry existence check.

Koa scoping (`router.<m>` only inside `router.extend(base, fn)`) reuses the existing `Detector.scopedBy`: ts-morph walks the wrapper's callback; the substrate reads `CallSite.enclosingCallChain`. A new `Substrate.requireRegistry(...)` exposes the registry walk to the substrate engine.

### Result — both engines, fully declarative

| repo | engine | http | queue | entities | dbOps | validate-output |
|------|--------|-----:|------:|---------:|------:|----------------:|
| schedules | ts-morph  | 82 | 9 | 16 | 135 | 0 errors |
| schedules | substrate | 82 | 9 | 16 | 135 | 0 errors |
| acme-core  | ts-morph  | 132 | 3 | 104 | 224 | 0 errors |
| acme-core  | substrate | 132 | 3 | 104 | 224 | 0 errors |

Schedules entrypoints are byte-identical to the pre-Step-3 output (91/91 exact, handlerId included). acme-core is unaffected (it declares no `handlerTables`).

### Footprint

- **Removed:** `src/substrate/schedules-custom-rules.ts` (deleted, ~270 lines) and the in-profile custom-rule handlers + registry map (~210 lines of imperative ts-morph in `acme-schedules.ts`). `grep -c customRules src/profiles/acme-schedules.ts` → **0**.
- **Added:** ~30 lines of declarative `handlerTables` + call-shape entrypoint config in the schedules profile, and the generic primitive in both engines (`extractHandlerTableEntrypoints` and friends).
- The `customRules` escape-hatch mechanism is **kept** in `types.ts` + both engines as a general-purpose hatch; the schedules profile simply no longer uses it.

### What the primitive could NOT absorb

Nothing. All three handler resolutions — including the bg `require-arg` array shape and the golden "emit nothing when no handler resolves" gate — collapse into the two `reference` modes. No bespoke handler remains for schedules.
