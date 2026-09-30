# Framework signals + scout prompt

Used in **Orient**: map a repo's installed dependencies to the conventions they imply, so the scout
knows what to look for. Read the manifest(s) — root and per-package in a monorepo (`package.json`
`dependencies`/`devDependencies`).

## Dep → candidate convention map

### Backend frameworks (entrypoints)

| dep signal | framework | route convention |
|---|---|---|
| `@nestjs/common`, `@nestjs/core` | NestJS | class `@Controller('base')` + method `@Get/@Post/...('path')`; queues via `@EventPattern`/`@MessagePattern` |
| `express` | Express | `app.get/post(...)` or `router.get/post('/x', handler)` call-shapes |
| `koa`, `@koa/router`, `koa-router` | Koa | `router.get/post('/x', handler)`; handlers often via a require/alias registry → `handlerTable` |
| `fastify` | Fastify | `fastify.get/post(...)` or `fastify.route({ method, url, handler })` |
| `@hapi/hapi` | hapi | `server.route({ method, path, handler })` |
| `next` | Next.js | file-convention routes (`app/**/route.ts`, `pages/api/**`) — frontend rules apply |
| `commander`, `yargs`, `oclif`/`@oclif/core` | CLI | command-declaring call-shape (`program.command('name')…action(handler)`) → `entrypoints[] kind:'cli'` |
| `@nestjs/microservices` + `@GrpcMethod`, `@grpc/grpc-js`, `nice-grpc` | gRPC | service method decorators (`@GrpcMethod('Svc','Method')`, streaming variants) → `entrypoints[] kind:'grpc'` |
| `@nestjs/graphql`, `type-graphql`, `@apollo/server`/`apollo-server*` | GraphQL | `@Resolver()` class + field decorators (`@Query`/`@Mutation`/`@Subscription`) → `entrypoints[] kind:'graphql'` |

These non-HTTP kinds are entrypoints too — emit them alongside `http`/`queue`; a repo often has several
(e.g. a NestJS HTTP API **and** a commander CLI). See the entrypoints shapes in `profile-cheatsheet.md`.

### ORMs (entities + dbOperations)

| dep signal | ORM | entity convention |
|---|---|---|
| `@mikro-orm/core` | MikroORM | `@Entity()` class; `@Property`/`@PrimaryKey`/`@Enum` fields; `@OneToMany`/… relations; ops via `em`/repository |
| `typeorm` | TypeORM | `@Entity()` class; `@Column`/`@PrimaryGeneratedColumn`; `@ManyToOne`/…; repository ops |
| `sequelize` | Sequelize | factory `sequelize.define('Name', {...})` or `Model.init`; assoc methods `hasMany`/`belongsTo` |
| `prisma`, `@prisma/client` | Prisma | **schema-driven** — entity `{ orm:'prisma', schemaPath:'…/schema.prisma' }` (engine parses the DSL; no in-code detector). dbOps via `modelReceiverPattern` `'(^\|\\.)prisma\\.[a-z]…'`; engine auto-aliases `prisma.workspaceMember`→`WorkspaceMember`. See cheat-sheet entities. |
| `mongoose` | Mongoose | `mongoose.model('Name', schema)`; ops `Model.find/create/...` |
| `drizzle-orm` | Drizzle | table builders (`pgTable('name', {...})`); ops via the query builder |
| raw SQL / Cypher (no ORM) — `better-sqlite3`, `pg`, `libsql`/`@libsql/client`, `neo4j-driver` | none | no entity classes — use `dbOperations.rawQueries:[{ dialect:'sql'\|'cypher', methods, queryArg?, receivers?, inPaths? }]`; entity = table (SQL) / node label (Cypher), no entity node synthesized. See cheat-sheet dbOperations. |

### Queues / messaging

| dep signal | system | convention |
|---|---|---|
| `kafkajs`, `@nestjs/microservices` | Kafka | producer `client.emit/send(topic, …)`; consumer `@EventPattern(topic)` |
| `bullmq`, `bull` | BullMQ | `new Queue('name')` + `queue.add(...)`; `new Worker('name', handler)` |
| `amqplib`, `@nestjs/microservices` | RabbitMQ | channel `assertQueue`/`consume`; `@MessagePattern` |
| `@google-cloud/pubsub` | Pub/Sub | `topic.publish(...)`; subscription handlers |

### External / outbound clients

| dep signal | kind | matcher |
|---|---|---|
| `axios`, `@nestjs/axios` | http | `receiverPattern` on `httpService`/`axios`/`*.axiosRef`; verbs get/post/… |
| `got`, `node-fetch`, bare `fetch` | http | receiver / bareCallee matcher |
| an internal `*ApiClient`/`*Client` injected type | sdk | `externalCalls: { kind: 'sdk', diTypeSuffix: ['ApiClient','Client'], serviceName }` — **ASK the user for internal SDK package names** |
| `@aws-sdk/*`, `stripe`, `@sentry/*`, `launchdarkly-*` | sdk | `imported-sdk` matcher keyed on the package the DI type is imported from |

If a dep isn't here, infer from its README/exports — but this table covers the common 90%. Absence of
any ORM/queue dep is itself a finding: those categories are likely `not_applicable`.

## Directional scout prompt templates

Use the harness/model selected in `SKILL.md`. Do not dispatch one scout per package by default. First
pass each directional scout the complete cross-language deterministic Orient inventory, including all
source-bearing roots and candidate dependency signals. Launch exactly four initial directions concurrently up to harness
capacity, and collect all four before synthesis.

### Common preamble

> You are the repo-wide `<entrypoints|data-db|frontend|di-egress>` scout. Scope: `<paste the sorted
> cross-language inventory rows, target assignments, file counts, and candidate stack signals>`.
> Inspect EVERY listed root; do not stop at the first matching app. Exclude generated/vendor/build/test
> paths from the inventory. Do NOT write a profile or code. Return evidence only.
>
> For each root, report: (1) concrete convention names/shapes and arg positions; (2) a reproducible site
> count, or a clearly labelled bounded approximation, plus the command/pattern used; (3) 1–2 example
> `file:line` snippets; (4) explicit `none found` or `not applicable` when absent; and (5) expressibility
> as `primitive:<existing primitive name>`, `customRules`, `substrate gap`, or `unknown`, with one-line
> evidence. Never invent a schema field or placeholder. End with the roots checked and any unresolved
> ambiguity.

Append exactly one direction assignment:

- **entrypoints + messaging:** Find HTTP decorators/router calls/file-convention endpoints, bootstrap
  prefixes and router mounts (including exclude lists), CLI commands, gRPC methods, GraphQL resolvers,
  and queue consumers/producers. Count each kind separately and record handler arg positions.
- **data/db:** Find ORM/schema sources, entities plus field/PK/relation conventions, db-operation receiver
  shapes/op names, raw SQL/Cypher calls, schema generators/mirrors, and their counts.
- **frontend:** For every root with `.tsx`/`.jsx`/`.vue`, find component conventions, tsconfig aliases,
  exact exported state-store factories/import modules, and routing style. Enumerate every concrete
  repo-relative Next.js `pages/`/`app/` root and label it `next-pages`/`next-app`. For roots without a
  frontend surface, say so explicitly.
- **DI/indirection/egress:** Find injection style and receiver types, handler registries/aliases, outbound
  HTTP/SDK/queue clients, internal SDK package provenance, and the call shapes needed to match them.

After the broad pass, add a package/root-scoped follow-up scout only when evidence proves a distinct
stack or convention that needs independent inspection. Record that evidence and the exact follow-up
scope; package boundaries alone do not justify the split.

## Synthesis contract

Before Draft, the main agent builds a root × direction matrix from the inventory and all reports. Every
cell contains counts/evidence or an explicit absence plus its expressibility verdict. Re-check conflicts,
group roots that share a convention, and resolve mechanical `unknown`s with narrow follow-ups. Only then
does the main agent map the synthesized facts to detectors, arg refs, and maps in the
`ExtractionProfile` (see `profile-cheatsheet.md`).
