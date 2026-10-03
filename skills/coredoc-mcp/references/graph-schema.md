# Graph Schema Reference (for `run_cypher_query`)

This is the full vocabulary for writing read-only Cypher against the coredoc graph. The
`run_cypher_query` tool description stays compact and points here, and its `query` parameter
lists the kind names — this file is where the complete `NodeType`/`EdgeType` list, the
per-kind property shapes and the full list of rejected clauses live.

Every `run_cypher_query` response names the **serving backend/dialect** in its metadata —
check that field before assuming which dialect syntax applies.

## Two dialects, two query shapes

coredoc's graph is served by one of two Cypher-speaking backends. They persist the same
`NodeType`/`EdgeType` vocabulary but expose it differently.

### Ladybug / Kùzu (local, and hosted `file_snapshot`)

One node table, `GraphNode`, with `type` as a plain string discriminator column. All node
kinds live in the same table — filter on `type`:

```cypher
MATCH (n:GraphNode) WHERE n.type = 'function' AND n.name = 'createBooking' RETURN n.name AS name, n.filePath AS file
```

One relationship table **per** `EdgeType` member (the rel table name **is** the edge type,
uppercase-snake-case), each `FROM GraphNode TO GraphNode`:

```cypher
MATCH (a:GraphNode)-[r:CALLS]->(b:GraphNode) WHERE a.name = 'createBooking' RETURN b.name, b.type
```

### Neo4j (on-prem, local-only — never hosted)

Per-type **labels** — the node type is the label, not a property:

```cypher
MATCH (n:function {name: 'createBooking'}) RETURN n.name AS name, n.filePath AS file
```

Every node also carries the shared `CodeNode` label, useful for label-agnostic queries:

```cypher
MATCH (n:CodeNode) WHERE n.name CONTAINS 'Booking' RETURN n.type, n.name
```

Edge types are Neo4j relationship types, same names as `EdgeType` members:

```cypher
MATCH (a)-[r:CALLS]->(b) RETURN b.name, labels(b)
```

**Hosted MCP only ever serves Ladybug/Kùzu dialect** (the hosted graph backend is
`file_snapshot`→Ladybug; `turso` is deprecated legacy for not-yet-migrated workspaces;
Neo4j is local-only). If you're on hosted, use the Ladybug shape above regardless of
what this doc says about Neo4j.

## `GraphNode` / rel-table columns (Ladybug/Kùzu)

```
GraphNode(id, type, name, properties, summary, embedding, repoId, filePath, startLine, endLine)
<EDGE_TYPE>(FROM GraphNode TO GraphNode, id, confidence, createdBy, properties)
```

## NodeType — every member (verbatim from `packages/core/src/types/graph.ts`)

| Enum member | Persisted string value |
|---|---|
| `Repository` | `repository` |
| `Package` | `package` |
| `File` | `file` |
| `Function` | `function` |
| `Class` | `class` |
| `Interface` | `interface` |
| `Entrypoint` | `entrypoint` |
| `Entity` | `entity` |
| `Component` | `component` |
| `Route` | `route` |
| `StateStore` | `state_store` |
| `TypeAlias` | `type_alias` |
| `Enum` | `enum` |
| `Variable` | `variable` |
| `ExternalCall` | `external_call` |

## EdgeType — every member (verbatim from `packages/core/src/types/graph.ts`)

| Enum member | Persisted string value |
|---|---|
| `ContainsPackage` | `CONTAINS_PACKAGE` |
| `ContainsFile` | `CONTAINS_FILE` |
| `ContainsFunction` | `CONTAINS_FUNCTION` |
| `ContainsClass` | `CONTAINS_CLASS` |
| `ContainsInterface` | `CONTAINS_INTERFACE` |
| `ContainsTypeAlias` | `CONTAINS_TYPE_ALIAS` |
| `ContainsEnum` | `CONTAINS_ENUM` |
| `ContainsVariable` | `CONTAINS_VARIABLE` |
| `ContainsEntity` | `CONTAINS_ENTITY` |
| `ContainsComponent` | `CONTAINS_COMPONENT` |
| `HasMethod` | `HAS_METHOD` |
| `Calls` | `CALLS` |
| `Imports` | `IMPORTS` |
| `Extends` | `EXTENDS` |
| `ImplementsInterface` | `IMPLEMENTS_INTERFACE` |
| `UsesType` | `USES_TYPE` |
| `Handles` | `HANDLES` |
| `OperatesOn` | `OPERATES_ON` |
| `ContainsRoute` | `CONTAINS_ROUTE` |
| `RendersComponent` | `RENDERS_COMPONENT` |
| `UsesComponent` | `USES_COMPONENT` |
| `MakesExternalCall` | `MAKES_EXTERNAL_CALL` |
| `ReferencesVariable` | `REFERENCES_VARIABLE` |
| `ResolvesTo` | `RESOLVES_TO` |

## `properties` is a JSON *string*, not queryable columns

Loud gotcha: on both dialects, `properties` is a **JSON string column** on `GraphNode` and
on every rel table — it is NOT expanded into native, queryable graph properties. You
**cannot** do `WHERE n.properties.isAsync = true` in Cypher.

Second gotcha, and the one that actually rejects queries: unless the deployment opted into
storing source in the graph, **any mention of a NODE's `properties` or `sourceCode` is
rejected before execution** — in `RETURN` *and* in `WHERE` — because the node blob can carry
source (`n.*` star projections are rejected for the same reason). A **relationship**
variable is exempt: `r.properties` and `r.*` on a variable bound by a pattern
(`-[r:USES_TYPE]->`) are edge metadata, not source, and are allowed.

The correct pattern:

1. Filter/traverse using the node columns that ARE native: `n.type`, `n.name`, `n.repoId`,
   `n.filePath`, `n.startLine`, `n.endLine`, `n.summary`, `n.id`.
2. For per-edge detail, bind the relationship and project `r.properties` (plus native
   `r.confidence` / `r.createdBy`), then parse the JSON **client-side** (in the agent, not
   in Cypher).
3. For node-level type-specific fields (`isAsync`, `tableName`, `ormType`, …), do not try
   Cypher at all — `explain` / `describe_db_schema` return them already parsed.

Type-specific node fields live inside that JSON string on the parse side (`packages/core/src/types/output.ts`),
not as Cypher-queryable columns. There is no server-side JSON-path filtering available
through this tool.

### Per-kind `properties` highlights (what's typically inside the JSON, not exhaustive)

| Node kind (`n.type`) | Commonly present in `properties` |
|---|---|
| `function` | `isAsync`, `isGenerator`, `parameters`, `returnType`, `decorators`, `complexity`, `isExported` (functions) / `classId`, `visibility`, `isStatic`, `isAbstract`, `accessor` (methods) |
| `class` | `isExported`, `isAbstract`, `extends`, `implements`, `methods` (IDs), `properties` (fields), `constructor` |
| `interface` | `isExported`, `extends`, `members` |
| `entity` | `ormType`, `tableName`, `schema`, `fields` (columns w/ `dbType`, `isPrimaryKey`, `isNullable`, `isUnique`), `relations`, `indexes` |
| `entrypoint` | `type` (http/graphql/grpc/websocket/cron/queue/event/cli/mobile), `handlerId`, `details` (method/path/etc, shape varies by entrypoint type), `requestSchema`/`responseSchema` |
| `type_alias` | `isExported`, `typeParameters`, `aliasedType` |
| `enum` | `isExported`, `isConst`, `members` (name/value pairs) |
| `variable` | `isExported`, `declarationKind` (const/let/var), `type`, `initialValue` |
| `component` | component-framework-specific (React/Vue) props/state shape |
| `external_call` | target service/SDK method, protocol details |

For an authoritative full shape, read `packages/core/src/types/output.ts` (`FunctionNode`,
`ClassNode`, `EntityNode`, `Entrypoint`, etc.) — this table is a summary, not a dump.

### Edge `properties` highlights (the half you CAN read from Cypher)

| Edge type | Inside the edge JSON |
|---|---|
| `USES_TYPE` | `usage` (`parameter`/`return`/`property`/`aliased`/`extends`/`member-access`), `via` (parameter or property name), `targetKind`, `ambiguous` (name-only match — the identity check could not pin the declaring module), plus `useKind: "value"` + `member: "<MemberName>"` on a **value-position enum-member reference** (`if (s === Status.Locked)`); type-position uses carry neither |
| `EXTENDS` / `IMPLEMENTS_INTERFACE` | no payload — the edge itself is the fact. Direction is **subtype → supertype**: the class/interface is the source, the base class/implemented interface is the target |
| `OPERATES_ON` | `operation` (`create`/`read`/`update`/`delete`) |
| `CALLS` | call-site metadata; `confidence` is a native column, not JSON |
| `RESOLVES_TO` | cross-boundary resolution; `relation: "package-import"` marks an import of a package-exported symbol |
| `MAKES_EXTERNAL_CALL` | egress metadata (target service, protocol details) |

`confidence` on any edge is a **native column**: `USES_TYPE` edges resolved to exactly one
declaration score `1.0`, ambiguous name-only matches `0.5` — filter with
`WHERE r.confidence >= 1.0` when you need the pinned ones only.

## Worked query recipes

**Per-kind counts** (aggregate — the canonical reason to reach for Cypher):

```cypher
MATCH (n:GraphNode) RETURN n.type AS kind, count(*) AS c ORDER BY c DESC
```

**Find by name:**

```cypher
MATCH (n:GraphNode) WHERE n.type = 'function' AND n.name = 'createBooking' RETURN n.id, n.filePath, n.startLine
```

**1-hop neighbors (outgoing):**

```cypher
MATCH (n:GraphNode)-[r:CALLS]->(m:GraphNode) WHERE n.name = 'createBooking' RETURN m.name, m.type, r.confidence
```

**1-hop neighbors (incoming, any edge type):**

```cypher
MATCH (m:GraphNode)-[r]->(n:GraphNode) WHERE n.name = 'BookingService' RETURN m.name, m.type, type(r)
```

**Pagination via `ORDER BY … SKIP … LIMIT`** (no cursor pagination — this is the only
mechanism):

```cypher
MATCH (n:GraphNode) WHERE n.type = 'entity' RETURN n.name ORDER BY n.name SKIP 20 LIMIT 20
```

### Worked examples for real tasks (Ladybug shape)

All three project scalars only (the `rows` shape rejects whole nodes/lists/maps), touch node
`properties` nowhere, and carry a stable `ORDER BY` so `SKIP`/`LIMIT` paging is meaningful.

**1. Who branches on one enum MEMBER** — "if I delete `Status.Locked`, what breaks?"
`find_dependents(name: "Status")` answers the enum as a whole; only the edge payload
distinguishes the member, so this is a genuine Cypher question:

```cypher
MATCH (src:GraphNode)-[r:USES_TYPE]->(e:GraphNode)
WHERE e.type = 'enum' AND e.name = 'Status'
RETURN src.name AS caller, src.filePath AS file, src.startLine AS line, r.properties AS usage
ORDER BY file, line
```

Every consumer of the enum comes back with its edge payload; split value-position
(`"useKind":"value"` with `"member":"Locked"`) from type-position **agent-side** by parsing
the `usage` JSON. To narrow in-query instead, add
`AND r.properties CONTAINS '"member":"Locked"'` (match the JSON exactly as stored — no
spaces). Do **not** write it as `contains(r.properties, …)`: the read-only guard treats
`(r` as a node position, loses the relationship exemption, and rejects the query.

**2. Every implementor of an interface** — what a `find_dependents` call gives you per name,
as a whole-graph table:

```cypher
MATCH (impl:GraphNode)-[:IMPLEMENTS_INTERFACE]->(i:GraphNode)
WHERE i.name = 'PaymentProvider'
RETURN impl.name AS implementor, impl.repoId AS repo, impl.filePath AS file
ORDER BY repo, implementor
```

Subclasses of a base class are the same query with `-[:EXTENDS]->` (interfaces extending
interfaces use `EXTENDS` too). Both edges point subtype → supertype, so reverse the arrow
(`(c)-[:EXTENDS]->(base)` with `c.name = 'X'`) to walk *up* from a class instead.

**3. Cross-repo egress aggregate** — which repos talk to which external targets, and how
much. This is the canonical Cypher case: an aggregate over the whole graph that no fixed
tool expresses (`list_service_dependencies` answers one repo at a time):

```cypher
MATCH (caller:GraphNode)-[:MAKES_EXTERNAL_CALL]->(target:GraphNode)
RETURN caller.repoId AS repo, target.name AS target, count(*) AS calls
ORDER BY calls DESC, repo SKIP 0 LIMIT 100
```

Remember Cypher is **not** repo-filtered: that is the point here, but add
`WHERE caller.repoId = '<repoId>'` the moment you mean one repo.

## Constraints an agent must know

- **Read-only only.** The tool enforces an allowlist (deny-by-default), not a deny-list:
  `CREATE`, `MERGE`, `DELETE`, `DETACH`, `SET`, `REMOVE`, `DROP`, `FOREACH`, `CALL`, `LOAD`,
  `INSERT`, `USE`, `ATTACH`, `COPY`, `EXPORT`, `IMPORT`, `INSTALL`, `SHOW`, and other
  mutation/cross-db/admin keywords are all rejected before execution. Only
  `MATCH`/`OPTIONAL MATCH`/`WITH`/`UNWIND`/`RETURN`/`WHERE`/`ORDER BY`/`SKIP`/`LIMIT` and
  read-only pattern syntax pass.
- **Results are capped.** Default `limit` 200, max 500 (clamped). A `truncated: true` flag
  on the response means more rows existed than were returned — page with `SKIP`/`LIMIT`
  rather than assuming completeness.
- **`resultShape`: `rows` (default) vs `graph`.**
  - `rows` — scalar cells only. `RETURN` clauses must project scalar fields (strings,
    numbers, booleans) or aggregates (`count(*)`, etc). Cypher composite types — lists,
    maps, whole nodes, whole relationships — are **rejected** with a projection-guidance
    error; project the scalar fields you need instead (`n.name`, `n.type`, not `n`).
  - `graph` — returns nodes/edges shaped for visualization (`CypherGraphResult`); use this
    when you actually want node/edge objects back, not scalar aggregates.
- **Not repo-filtered.** Unlike every fixed tool, raw Cypher runs against the **whole
  selected graph** — it does not apply the `scope`/`repoHashes` narrowing that
  `search_symbols`/`explain`/etc. apply automatically. If you need one repo, filter
  explicitly with `WHERE n.repoId = '<repoId>'` (or scope the graph selection itself, where
  the surface supports it) — don't assume the graph is already narrowed to "the current
  repo" the way other tools are.
- **No full-text search via Cypher.** `CALL` is blocked by the allowlist (it's how FTS
  indexes are invoked in Kùzu), so there is no `CALL CREATE_FTS_INDEX`/`CALL QUERY_FTS_INDEX`
  escape hatch here. Use `search_symbols` for name/substring search instead.

## When to reach for a fixed tool instead

Try `search_symbols` / `explain` / `find_callers` / `find_dependents` / `find_entity_usage`
/ `analyze_change_impact` / `list_entrypoints` / `describe_db_schema` first — they already
express the common questions, handle scope narrowing, and format results for reading.
Reach for `run_cypher_query` when the question is an **aggregate** (counts, group-bys) or an
**ad-hoc shape** the fixed tools genuinely don't express (a custom multi-hop pattern, a
property-column filter across kinds). If a fixed tool answers the question, prefer it — it's
scoped, formatted, and cheaper to reason about than raw Cypher.
