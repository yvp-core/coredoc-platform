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

## Scout prompt template (haiku)

Dispatch one scout per target package with the haiku model. Fill the brackets from Orient. The scout
gathers **evidence only** — the main agent writes the profile.

> You are scouting `<package path>` (language `<ts|js>`, candidate stack: `<frameworks from the table>`).
> Do NOT write a profile or any code. Gather EVIDENCE and return structured findings.
> For each category below, grep the source (exclude `node_modules`/`dist`/tests) and report the RAW
> facts plus 1–2 example `file:line` snippets. If a category has no signal, say "none found" — never
> invent one.
>
> 1. **entrypoints** — HTTP route decorators (`@Controller`/`@Get`…) with arg positions, OR the router
>    call-shape (`router.get('/x', h)`) + how the base path is set. ALSO capture non-HTTP entrypoints:
>    CLI command declarations (`program.command('name')…action(h)`), gRPC method decorators
>    (`@GrpcMethod('Svc','Method')`), GraphQL resolvers (`@Resolver()` + `@Query`/`@Mutation`/`@Subscription`).
>    Report the shape + arg positions + approx count for each kind present.
> 2. **entities** — the decorator (`@Entity`) + field/PK/relation decorator names, OR the factory call
>    (`sequelize.define`) + how fields/associations are declared. Approx count.
> 3. **queues** — method decorators (`@EventPattern`…) OR a registration call. Approx count.
> 4. **DI** — is it constructor-type injection (`constructor(private svc: Svc)`)? The receiver patterns
>    used for `this.x.method()`.
> 5. **external clients** — which receivers / injected types make outbound HTTP/queue/SDK calls; list
>    any internal SDK package names you see imported.
> 6. **handler indirection** — are route/queue handlers referenced through a require/alias registry
>    object (e.g. `handlers.api.schedules.create`)? If so, name the registry variable + the file it is
>    built in.
>
> Return one short section per category: concrete names/arg-positions, the count, and the snippets.

The main agent (not the scout) maps these findings to detectors + arg refs + maps in the
`ExtractionProfile` — see `profile-cheatsheet.md`.
