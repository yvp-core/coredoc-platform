# ExtractionProfile cheat-sheet — detectors, arg refs, rules, when to use each

The full typed vocabulary is `packages/profile-parser/src/types.ts`. This file is the quick reference
for *choosing* primitives while drafting. Two building blocks compose every rule: **detectors**
(recognize a construct) and **arg refs** (read a value out of an argument).

**Import the schema by its package name, and annotate the profile const:**

```ts
import type { ExtractionProfile } from '@coredoc/profile-parser';
const profile: ExtractionProfile = { … };
export default profile;
```

Both halves matter. A profile lives in the user's parser storage, not inside a checkout of the
engine, so a relative specifier resolves nowhere — the bare package name is what the typecheck
gate maps. And the gate compares your object against the schema only where an annotation asks it
to: `export default { … }` with no `: ExtractionProfile` typechecks clean no matter what fields it
invents, which is the exact silent hole the gate exists to close.

## Detectors — `detect: { via: … }`

| `via` | matches | use when |
|---|---|---|
| `class-decorator` `{ name }` | a class decorated with `name` | controllers (`@Controller`), decorator ORMs (`@Entity`) |
| `method-decorator` `{ names: {Dec: tag} }` | a method whose decorator is a key of `names` | decorator routes/queues (`@Get`→GET, `@EventPattern`→event) |
| `property-decorator` `{ names: [...] }` | a property decorated with any name | (entity fields use `fields.decorators`, not a top-level detector) |
| `call-shape` `{ callee, scopedBy? }` | a call matching `callee` (`recv.*`, `*.method`, exact); optional `scopedBy` requires nesting in a parent call | factory ORMs (`*.define`), router-call routes (`router.*`), registration calls (`initHandler`) |

`callee` globs: `router.*` (any method on `router`), `*.define` (`.define` on any receiver), `initHandler`
(bare call), exact `sequelize.define`. `scopedBy: { callee, basePathArg }` matches only inside that
parent call's callback and reads the base path from `basePathArg` (the Koa `router.extend(base, fn)`
case).

## Arg refs — `{ arg: N, as: … }`  (N is 0-based; -1 = last arg)

| `as` | reads | example |
|---|---|---|
| `string-literal` | a quoted string | `@Get('/x')` → `/x` |
| `const-string` | an identifier resolved to its string-literal const | `define(ENTITY_NAME,…)` → `"BreakType"` |
| `arrow-target` | the identifier returned by an arrow | `() => Companies` → `Companies` |
| `identifier` | a bare identifier's text | `em.create(User,…)` → `User` |
| `object-property` `{ key }` | a property read out of an object-literal arg | `@Tool({ name:'search_symbols' })` key `name` → `search_symbols`; `@Cron(EXPR, { name:'…' })` arg 1 key `name` |

`object-property` works for both decorator args and call-shape args — point `arg` at the object literal and
`key` at the property.

**Limitation worth knowing:** arg refs read a *direct* literal/identifier/const/arrow. They do **not**
reach through a wrapper call. `@EventPattern(getTopicInNamespace(Topics.X))` cannot be resolved to the
inner topic by `string-literal` (the arg is a call expression, not a literal) — the engine stores the
raw expression text. The entrypoint still emits with its handler; only the topic *string* is unresolved.
This is a known primitive gap (a `call-unwrap` arg ref would close it) — report it, don't hack the engine.

## Top-level metadata

### repoType — declarative classification (optional)

```ts
repoType: 'frontend',  // 'backend' | 'frontend' | 'mobile' | 'library' | 'monorepo'
```

You know what the repo is — set it. It surfaces as `ParsedRepo.type`. It is **not** inferred from
fact counts (a count-based guess can't tell `mobile` from `frontend`, or `library` from `monorepo`).
Omit it only when genuinely unsure; the parser then leaves `type` unset rather than guessing.

## The rules

### entrypoints[] — `kind: 'http' | 'queue' | 'cli' | 'grpc' | 'graphql'`

HTTP:
```ts
{ kind: 'http', detect: <Detector>,
  basePath?: <ArgRef>,                         // class-decorator base path (@Controller('x'))
  method: { Get:'GET', … } | 'from-callee',    // decorator→verb map, or 'from-callee' for router.get
  methodPath: <ArgRef>,                        // the per-route path
  paramSyntax: 'colon'|'brace'|'template',     // :id | {id} | ${id} → normalized {id}
  handler?: <ArgRef | { via:'handler-table', table, arg }>,   // call-shape routes only
  globalPrefix?: { path: '/api/v1',            // app.setGlobalPrefix — read it from the bootstrap!
    exclude?: ['mcp', '.well-known/*'] } }     // routes matching an exclude stay unprefixed
```
Queue:
```ts
{ kind: 'queue', detect: <Detector>, system: 'kafka'|'google-pubsub'|…,
  topic: <ArgRef>, pattern?: { Dec: 'event'|'request-response' },
  handler?: <ArgRef | { via:'handler-table', … }> }
```
> **`system` is load-bearing for cross-repo resolution.** The linker keys queue/event
> entrypoints on `(system, destination)`, and matching normalizes case and whitespace
> ONLY — `'gcp-pubsub'` and `'google-pubsub'` are different transports. Every `queue`
> entrypoint rule must use the SAME spelling as the `externalCalls` queue matcher that
> publishes to it (and as sibling repos on the same bus), or those edges silently
> resolve to nothing. Pick one spelling per transport and reuse it verbatim.
CLI (commander/yargs/oclif — `program.command('name')…action(handler)`):
```ts
{ kind: 'cli', detect: { via:'call-shape', callee:'*.command' },  // the command-declaring call
  command: { arg: 0, as: 'string-literal' },                       // command name (`<id>` placeholders stripped)
  action: { call: 'action', arg: 0 } }                             // sibling call in the chain carrying the handler
```
gRPC (`@GrpcMethod('Svc','Method')`, streaming variants):
```ts
{ kind: 'grpc', detect: { via:'method-decorator', names:{ GrpcMethod:'unary', GrpcStreamMethod:'server' } },
  service?: { arg: 0, as: 'string-literal' },   // omit → class name
  method?:  { arg: 1, as: 'string-literal' } }  // omit → method name
```
GraphQL (`@Resolver(() => T)` class + `@Query`/`@Mutation`/`@Subscription` fields):
```ts
{ kind: 'graphql', detect: { via:'class-decorator', name:'Resolver' },
  operation: { Query:'query', Mutation:'mutation', Subscription:'subscription' },
  fieldName?: { arg: 0, as:'object-property', key:'name' },  // else the method name
  parentType?: { arg: 0, as:'arrow-target' } }               // @Resolver(() => T); else the root op type
```
Decorator routes/queues/grpc/graphql use the decorated method as the handler (no `handler` field). CLI
and call-shape HTTP routes must resolve the handler — directly via an ArgRef (`action`), or a `handlerTable`.

### handlerTables[] — cross-file require/alias registries

Use when a handler is referenced through a registry object instead of co-located:
`router.get('/p', handlers.api.schedules.create)` where `handlers` is an object of `require()` leaves.
- `reference: 'member-chain'` — handler arg is `<registryVar>.<alias…>.<method>`; trailing segment is
  the method (use `defaultMethod` when there's no trailing method, e.g. pub-sub). Needs `inFile` +
  `nested`.
- `reference: 'require-arg'` — handler arg is `require("app/…")` (or `[name, require(...)]`); resolves
  to `defaultMethod` in that file. Use `requirePrefix` to filter leaves.

This one primitive replaced ~480 lines of bespoke handler code.

### entities[]

Decorator ORM (MikroORM/TypeORM):
```ts
{ orm:'mikro-orm', detect:{ via:'class-decorator', name:'Entity' },
  tableName:{ option:'tableName', fallback:'snake_case'|'verbatim' },
  fields:{ decorators:['Property','PrimaryKey','Enum'], pk:'PrimaryKey',
           columnNameOption:'fieldName',
           flags:{ nullable:'nullable:\\s*true', unique:'…', generated:'…' } },  // regex sources
  relations:{ decorators:{ OneToOne:'one-to-one', … }, target:{ arg:0, as:'arrow-target' } } }
```
Factory ORM (Sequelize): `detect:{ via:'call-shape', callee:'*.define' }`, `name:{arg:0,as:'const-string'}`,
`fields:{ factoryFieldsArg:1, dataTypeMap:{STRING:'STRING',…} }`,
`relations:{ assocMethods:{ hasMany:'one-to-many', … }, target:{arg:0,as:'identifier'} }`.

Prisma (schema-driven — NO `detect`/`fields`/`relations`): `{ orm:'prisma', schemaPath:'apps/server/prisma/schema.prisma' }`.
The engine parses the `schema.prisma` DSL file directly into entities with fields, relations, and `@@map`
table names — there is no in-code detector. The matching dbOps use `dbOperations.modelReceiverPattern`
(e.g. `'(^|\\.)prisma\\.[a-z][A-Za-z0-9]*$'`): the engine auto-aliases the camelCase client accessor
(`prisma.workspaceMember`) to its PascalCase model, so each `this.prisma.<model>.<op>()` dbOp links to its
entity node.

### dbOperations

```ts
{ opMap:{ find:'read', persist:'create', nativeUpdate:'update', remove:'delete', … },
  emReceivers:['em','*.em','*.orm.em'],          // entity-manager receivers; entity from entityFrom
  repoReceiverPattern:'/repository$|repo$/i',    // repo.<op>() — entity inferred from repo type
  modelReceiverPattern:'(^|\\.)models\\.[A-Z]…', // models.User.<op>() — entity named inline
  transactionReceiverPattern:'…',                // entity-agnostic tx ops
  entityFrom:{ arg:0, as:'identifier' } }
```
Map *every* op the ORM exposes that you see in source — missing ops drop db-op coverage.

**Raw SQL / Cypher (no ORM).** For `client.execute('SELECT … FROM nodes')` / `tx.run('MATCH (n:Function)…')`,
parse the query *string* arg instead of the receiver:
```ts
rawQueries:[
  { dialect:'sql',    methods:['execute','run'], queryArg:0, receivers:['client$'], inPaths:['packages/db/src/sqlite'] },
  { dialect:'cypher', methods:['run'],           queryArg:0, receivers:['(^|\\.)tx$'], inPaths:['packages/db/src/neo4j'] } ]
```
`dialect:'sql'` → SQL verb→CRUD + table; `dialect:'cypher'` → Cypher clause→op + node label (handles
multi-line template literals). The entity name *is* the table (SQL) / label (Cypher); **no entity node is
synthesized**. `inPaths` scopes a matcher to a directory — needed when two stores share a method (SQLite and
Neo4j both `.run(query,…)`).

### externalCalls[] — outbound clients

```ts
{ kind:'http', receiverPattern:'/httpService(\\.axiosRef)?$/i', verbs:['get','post',…],
  url:{arg:0,as:'string-literal'}, serviceName:'http-service' }
{ kind:'queue', receiverPattern:'/client$/i', methods:['emit','send'],
  topic:{arg:0,as:'string-literal'}, system:'kafka' }   // MUST match the queue entrypoint rule's `system` verbatim
{ kind:'sdk', diTypeSuffix:['ApiClient','Client'], serviceName:'demo-api' }   // matches injected DI type
```
`receiverPattern`/flag regexes are **regex source strings** (the engine compiles them), e.g.
`'/repository$/i'` or `'(^|\\.)models\\.'`.

### di / callGraph / synthesize

- `di: { style:'constructor-type', stripGenerics?:true }` — resolves `this.svc.method()` via the
  constructor param types. `none` to disable.
- `callGraph.abstainReceiverPatterns: [...]` — receiver patterns for name-only DI-container calls
  (`ctx.services.X.m()`): emit an edge with no calleeId, keep the expression (don't drop it).
- `synthesize: { objectLiteralExportMethods:true, inPaths:['app/handlers/'] }` — turn
  `module.exports = { m: () => {} }` into FunctionNodes (functional JS handlers).

### frontend routes / stateStores — exact closed vocabulary

File-convention routes accept only the two implemented frameworks, with one concrete repo-relative
root per app:

```ts
routes: {
  fileConvention: [
    { framework: 'next-pages', routeDir: 'apps/legacy/pages' },
    { framework: 'next-app', routeDir: 'apps/docs/app' },
  ],
}
```

`framework` is exactly `'next-pages' | 'next-app'`; `routeDir` is a real string path. Mixed or
unsupported routing is represented by omitting that rule (or just the unsupported app's entry) and
explaining the gap in the profile comment — never by `{ framework: 'unknown', routeDir: 'unknown' }`.

State-store rules name an exact factory callee bound to an exported const:

```ts
stateStores: [
  { library: 'zustand', factory: 'create', fromModule: 'zustand' },
  { library: 'jotai', factory: 'atom', fromModule: 'jotai' },
  { library: 'other', factory: 'proxy', fromModule: 'valtio' },
  { library: 'other', factory: 'kea', fromModule: 'kea' },
]
```

`library` is exactly `'redux' | 'zustand' | 'mobx' | 'pinia' | 'vuex' | 'recoil' | 'jotai' | 'other'`.
Use `'other'` for supported factory shapes from libraries outside that union, including Valtio and
Kea. `factory` is always a string callee name, never `{}`. Use `inPaths` to scope package-local
factories; if no rule can match faithfully, omit it and document why.

### customRules[] — the gated escape hatch (last resort)

There **is** a gated escape hatch — `customRules?: [{ name, run: (facts, emit) => void }]` — for genuinely
bespoke conventions no primitive covers (e.g. Electron `ipcMain.handle('channel', handler)` ingress). It is
the **last resort**, not the default. Unlike every other rule, `run` is real code — so **write it against
the types below, not from memory**. A rule that reads a field the substrate does not expose typechecks
against `any`-shaped guesses in your head, then evaluates falsy at every branch and emits nothing.

These are the exact shapes (`substrate/interface.ts`, `types/profile.ts`) — no other fields exist:

```ts
interface CallSite {
  calleeText: string;            // 'ipcMain.handle'
  receiver?: string;             // 'ipcMain' (member calls only)
  method?: string;               // 'handle', or the bare callee name
  args: ArgNode[];
  enclosingCallChain: CallSite[]; // innermost-last
  file: string;
  loc: { filePath: string; startLine: number; endLine: number };  // NOT call.startLine
}

interface ArgNode {                // a discriminant-free bag: test the field you want
  stringLiteral?: string;          // 'foo'  → "foo"   (NOT arg.type === 'string-literal')
  identifier?: string;             // a bare identifier argument → its text
  arrowTargetIdent?: string;       // () => Companies → "Companies"
  objectEntries?: { key: string; valueText: string; valueObject?: ArgNode['objectEntries'] }[];
  memberProperty?: string;         // models.Target → "Target"
  callExpr?: { callee: string; firstArgText: string };
  text: string;                    // raw expression text (always present)
}

interface CustomRuleFacts {        // read-only; this is the whole read surface
  repoRoot: string;
  callShapes(calleePattern?: string): readonly CallSite[];  // 'a.b' | 'recv.*' | '*.method'
  functionId(file: string, name: string): string | undefined;
  resolveConstMember(qualifiedRef: string): string | undefined;  // 'IpcChannels.SEND' → value
}

interface CustomRuleEmit {         // the whole write surface
  entrypoint(n: { type: 'http'; method: HttpMethod; path: string; handlerId?: string } & Site): void;
  entrypoint(n: { type: 'queue'; system?: string; channel: string; handlerId?: string } & Site): void;
  externalCall(n: { callerId: string; serviceName: string; method: string; sdkName?: string;
                    targetPattern?: string; httpMethod?: HttpMethod } & Site): void;
  dbOperation(n: { performerId: string; entityName: string; operation: DbOperationType;
                   details?: string } & Site): void;
  handlerFunction(n: { name: string } & Site): string;   // → id for an inline/anonymous handler
}
type Site = { file: string; startLine: number; endLine: number };
```

An `id` you pass in (`handlerId`, `callerId`, `performerId`) must name a function the substrate already
emitted, or one you just minted with `handlerFunction` — the engine **throws** on a dangling id rather
than letting an unresolvable edge into the graph. A rule never builds nodes or ids itself.

Worked example — Electron IPC ingress, channel from either a literal or a const-object member:

```ts
customRules: [
  {
    name: 'electron-ipc-handlers',
    run: (facts, emit) => {
      for (const call of facts.callShapes('ipcMain.handle')) {
        const raw = call.args[0];
        const channel = raw?.stringLiteral ?? (raw?.text.includes('.') ? facts.resolveConstMember(raw.text) : undefined);
        if (!channel) continue;
        const named = call.args[1]?.identifier;
        const handlerId = named
          ? facts.functionId(call.file, named)
          : emit.handlerFunction({ name: `ipc:${channel}`, file: call.file, ...lines(call) });
        emit.entrypoint({ type: 'queue', system: 'electron-ipc', channel, handlerId, file: call.file, ...lines(call) });
      }
    },
  },
]
// where lines(c) = ({ startLine: c.loc.startLine, endLine: c.loc.endLine })
```
> **`system: 'electron-ipc'` is a reserved literal, not a label.** An `ipc` egress descriptor has no
> profile-authored system — the matcher looks the handler up under `electron-ipc` verbatim
> (`descriptor-matcher.ts`, `matchProtocolHop`). Any other spelling produces zero IPC edges with no
> error, and the messaging-system lint cannot catch it (it only compares two spellings against
> each other, and there is only one here).

Gating — apply in order:
- **(a)** Try a declarative primitive first. Custom code is the exception.
- **(b)** A rule can only emit nodes for call sites the substrate actually found — it **cannot fabricate**.
- **(c)** If the rule needs a read-fact the substrate doesn't expose, that fact extension needs a unit test
  (a half-right fact fails silently).
- **(d)** Report the gap (in the profile doc comment) so a recurring rule/fact graduates into a
  primitive — the promotion loop.
- **(e)** Confirm it actually fired. A custom rule that matches nothing looks identical to a repo with no
  such convention — check the emitted count, don't assume.

## Two exemplars, annotated

- **`demo-core.ts`** (NestJS / MikroORM / Kafka, TS) — the decorator-framework template. class-decorator
  HTTP + method-decorator queue, class-decorator entities with decorator fields/relations, em/repo
  db-ops, httpService/Kafka-client/SDK externals, constructor-type DI. Fully declarative. **Copy this
  for any NestJS/decorator-ORM repo** (demo-shifts was authored this way in one pass).
- **`sample-schedules.ts`** (Koa / Sequelize / pub-sub, plain JS) — the functional/registry template.
  `untypedJsMode`, object-literal export synthesis, call-shape routes with `scopedBy`, factory
  Sequelize entities, three `handlerTables` (member-chain ×2 + require-arg) for the koa/pub-sub/bg
  indirection. Fully declarative, no escape hatch. **Copy this for functional-JS / registry-handler
  repos.**

## Scorecard verdicts (what you're driving toward)

Per category: PASS (≥80% or not_applicable), PARTIAL (50–79%), FAIL (<50% or structural errors) —
except **externalCalls**, which scores against a real-but-coarse denominator (call sites of the
manifest's HTTP-client deps + constructed `new *Api(`/`new *Client(` sites): PASS ≥50%, FAIL below,
no PARTIAL band; self-relative when there's no client signal. **dbOperations** scores against the
emitted entity count — or the distinct *operated* entities when the profile sets `schemaMirror: true`
(entity-generator / schema-mirror repos; the honest alternative to dropping entities or accepting a
permanent FAIL — the scorecard's `basis` column discloses the switch). `schemaMirror` is honored only
when an entity-generator dependency (`@mikro-orm/entity-generator`, `typeorm-model-generator`,
`sequelize-auto`) is present in the manifest; otherwise it is ignored with a `basis` note. **queue**
with no queue rule is `not_applicable` on `repoType: 'frontend'` profiles.
Overall PASS = every `required` category PASS + 0 validate-output errors + no consistency red flags —
a red flag (e.g. ≥5 HTTP-client call sites but 0 externalCalls emitted, or a schemaMirror basis with
<5% of entities operated and <10 dbOperations) is an auto-fail, not a suggestion. The scorecard exits
non-zero unless overall PASS — gate the loop on its exit code.
