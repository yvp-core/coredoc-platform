# Profile-Driven Extraction Engine — prototype results

> **Historical log (2026-06-17).** Records the prototype go/no-go gate as it stood, when the engine
> was the ts-morph `ProfileDrivenParser`. That oracle engine has since been removed; the substrate
> (tree-sitter+SCIP) engine is now the single extraction path. Kept for the record; not current state.

Go/no-go gate: a single GENERIC engine (`ProfileDrivenParser extends TsMorphBaseParser`)
applies an AI-authored declarative `ExtractionProfile` and reproduces the two golden
eval-parser outputs with **0 validation errors**.

**Result: PASS — both repos reproduced EXACTLY on every count.**

## Comparison tables (golden vs engine)

### acme-core (`/path/to/acme/acme-core`) — NestJS / MikroORM / Kafka

| Count          | Golden | Engine | Match |
|----------------|-------:|-------:|:-----:|
| http           | 132    | 132    | ✅    |
| queue          | 3      | 3      | ✅    |
| entities       | 104    | 104    | ✅    |
| dbOperations   | 224    | 224    | ✅    |
| functions      | 628    | 628    | ✅    |
| calls          | 1317   | 1317   | ✅    |
| externalCalls  | 12     | 12     | ✅    |
| **validate-output errors** | 0 | **0** | ✅ |

Reproduced entirely through the CLEAN declarative primitives — **no escape hatch used**.

### acme-schedules (`/path/to/acme/acme-schedules`) — pure-JS Koa / Sequelize / Pub-Sub

| Count          | Golden | Engine | Match |
|----------------|-------:|-------:|:-----:|
| http           | 82     | 82     | ✅    |
| queue          | 9      | 9      | ✅    |
| entities       | 16     | 16     | ✅    |
| dbOperations   | 135    | 135    | ✅    |
| functions      | 591    | 591    | ✅    |
| calls          | 873    | 873    | ✅    |
| externalCalls  | 6      | 6      | ✅    |
| **validate-output errors** | 0 | **0** | ✅ |

## Engine genericity

- `engine.ts`: **1241 lines** (one generic interpreter; written once, reused by every profile).
- Contains **no repo- or framework-specific runtime strings**. Verified by grep: the only
  string literals in code are generic schema discriminants (`'http'`, `'queue'`, `'entity'`,
  the `'kafka'`/`'http'` protocol tags written onto `targetDescriptor`), ts-morph AST-kind
  checks, and output-schema field names. Every decorator name, callee, op map, receiver
  pattern, service name, table-name option, source glob, and DataType map lives in the
  profile objects. No `"acme-core"`, `"acme"`, `"Controller"`, `"sequelize.define"`,
  `"httpService"`, `"handlers"`, file path, etc. appears in engine code (only in comments
  as illustrative examples).

### Profiles

- `profiles/acme-core.ts`: **121 lines** (pure declarative — no custom rules).
- `profiles/acme-schedules.ts`: **325 lines** — of which ~75 lines are the declarative
  profile object and ~250 lines are the three NAMED custom-rule handlers (the escape hatch).

## How `customRules` is wired

The profile lists named custom-rule specs (`{ name, phase, files | inPaths }`). The host
passes a `Map<string, CustomRuleHandler>` into the `ProfileDrivenParser` constructor. The
engine invokes a matching handler with a `CustomRuleContext` exposing the `SourceFile` plus
a thin set of engine capabilities (`getFunctionId`, `findSourceFile`, `emitHttpEntrypoint`,
`emitQueueEntrypoint`). Handlers never touch private base-parser state; they emit through the
same id-generated helpers the engine uses. Two phases are supported: `source-file`
(per matching file during the walk) and `complete` (once, after all files parsed — needed so
synthesized handler FunctionNodes already exist).

## Escape-hatch findings (the key result)

acme-core needed **zero** escape hatches — the entire decorator-TS backend compresses into
the clean declarative primitives (decorator-route, decorator-queue, decorator-entity,
db-operation, di-resolver, call-graph, external-client http/queue/sdk matchers).

acme-schedules used the escape hatch for **3 features**, all genuinely hard to express
declaratively because they involve *cross-construct symbol resolution*, not single-site
shape matching:

1. **`koa-router-handlers`** — Koa routes are `router.<verb>('/p', handlers.<alias chain>.<method>)`
   nested inside `router.extend(base, fn, router)` blocks. Resolving the handler requires
   (a) walking a deeply-nested `handlers = { a: { b: require('app/handlers/x') } }` object to
   build an *alias-chain → file* map, then (b) splitting `handlers.a.b.create` into
   `(alias='a.b', method='create')` and looking up the synthesized function id in that file.
   The `scopedBy` detector in the schema can express the `router.extend` nesting, but the
   alias-chain require-map + synthetic-id join has no declarative vocabulary — it's bespoke
   symbol resolution over two separate AST shapes.

2. **`pubsub-init-handlers`** — `initHandler(X_JOB_NAME, handlers.alias)` needs: resolve the
   `*_JOB_NAME` const to its string (expressible via `as: const-string`), AND map
   `handlers.alias` through a (flat this time) require-map to a handler file, then resolve
   `onMessage` in it. Same alias→file→synthetic-id join as (1); not declarative.

3. **`bg-initialize-queues`** — `initializeQueues({ name: [n, require('app/jobs/x')] })`:
   the handler is buried in an array-valued property and the job module exports a single
   top-level function (whose name varies), so resolution is "find the first function declared
   in that file." A fallback-by-file-scan, not a fixed arg shape.

**Common theme:** the clean primitives handle *recognize a construct and read its args*. They
do **not** handle *resolve a handler reference through an intermediate alias/require indirection
table to a symbol defined in another file*. That join is what all three escape-hatch rules do.
This is exactly the signal the spec wanted: it tells us the primitive library's next growth
area is a declarative "alias/require resolution table → symbol" primitive (a `handlerTable`
detector) that would absorb all three.

Everything else schedules needed — Sequelize `*.define` factory entities (incl. `const-string`
name resolution), DataType field mapping, `hasMany`/`belongsTo` associations, `models.X.op()`
db-ops, `acmeApiClient` external calls, DI-container call abstention, untyped-JS mode, and
`module.exports = { m: () => {} }` function synthesis — all expressed in the clean declarative
primitives / engine toggles, no bespoke code.

## Blockers to exact reproduction

None. Both repos matched every count exactly on the first full convergence. Notes on what it
took to get there (all generic engine fixes, not per-repo hacks):

- **DB-op entity-name race.** em-style ops (`this.orm.em.find(Entity, …)`) are only
  entity-specific if the first arg names a known entity, but entities can be defined in files
  parsed *after* the calling file. Fixed generically by buffering db-ops during the walk and
  resolving entity names in `onParsingComplete` (after all entities are known) — mirrors how
  the engine already buffers entities for relation-id resolution.
- **external-call receiver shapes.** `this.httpService.axiosRef.post()` and `this.axios.request()`
  needed receiver-pattern matching against the *full* receiver text (not just the stripped
  property name) and `request` as a verb — both handled by profile regex receiver patterns,
  no engine specifics.

## Reproduce

```bash
pnpm --filter @coredoc/profile-parser test          # asserts the exact golden counts
# or run a profile and see the count table + validate-output + pre-scan:
cd packages/profile-parser
node_modules/.bin/tsx src/run.ts acme-core          /path/to/acme/acme-core          /tmp/acme-core-engine.json
node_modules/.bin/tsx src/run.ts acme-schedules /path/to/acme/acme-schedules /tmp/sched-engine.json
```
