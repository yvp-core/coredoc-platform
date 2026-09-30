# Workflows, Surfaces, and Scope Detail

Recipes for recurring task shapes, plus the deployment facts that decide which tools exist
and which repo a call lands on.

## Writing SQL / schema questions

1. `describe_db_schema(scope: "<repo>")` → compact table inventory (column names + relation counts); `detailLevel: "full"` expands every column with types/flags
2. `describe_db_schema(entityName: "User")` → the one table you're writing SQL against — columns, db types, PK/unique/nullable flags, relations, enum values
3. `find_entity_usage(entityName: "User")` → who reads/writes it — then **read the entity file** for ORM config the graph won't carry (serialization, hooks, allow-lists)

`explain` on an entity name inlines the same schema block — one call when the entity is your
starting point.

## Event / pub-sub flows

1. `list_entrypoints(type: "queue", system: "kafka")` and `list_entrypoints(type: "event", system: "celery")` → consumer inventory with destination token/value
2. `trace_cross_repo_call(destination: "user-events", system: "kafka")` → publish sites + consume handlers with repo attribution

Omit `system` when it is unknown: the trace either selects the sole system or returns an
explicit ambiguity with the available systems. Legacy systemless data appears as the
reserved filter value `unknown`. If one side remains absent, grep the destination constant
in source and report the extraction gap.

## Stack trace / grep hit — a location but no name

1. `explain(target: "src/services/booking.service.ts:142")` → the symbol spanning that line, structure inline
2. Follow the `Deeper:` footer (e.g. `find_callers` on the resolved name for blast radius)
3. Open the file at that line before proposing an edit

## Data flow

`explain` on the entrypoint or function shows the call tree of functions involved;
`find_entity_usage` lists an entity's read/write sites. Together they answer "where does
this data end up in the DB".

## Pitfalls

- **`find_callers` depth semantics.** `depth: 1` (the default) returns direct callers: the **edit sites** for a rename or signature change. `depth: 2+` (or `analyze_change_impact`) adds transitive callers: the **behavioural blast radius**. Transitive callers compile against the changed symbol through the chain — never list them as edit sites in a plan.
- **`fileHint` is informational, not a hard filter.** A `fileHint` that doesn't exist in the current scope makes the tool **fall back to name-only lookup** and still find the function. Use it freely, but don't depend on it as a strict gate.
- **Entrypoints vs. functions in `explain`.** An HTTP method/path, Kafka topic, cron schedule or route returns the entrypoint deep-dive (call tree, entities touched, upstream callers); a bare or qualified function name returns the function view (purpose, callees). `explain` picks from the shape of the target — there is no separate tool.
- **`find_callers` vs `find_dependents`.** `find_callers` traces call chains on functions/methods; `find_dependents` finds subclasses, implementations and type users of classes/interfaces. The wrong one returns nothing useful.
- **Counts differ per tool.** `explain`'s `Usages`, `find_dependents`' row count and a grep file count answer different questions (type references vs. dependents vs. files). Say which one you are quoting.

## Local vs. cloud surfaces

- `list_file_symbols` and `semantic_search` exist only on the **local stdio server**. `semantic_search` is additionally env-gated (`ENABLE_SEMANTIC_SEARCH=1`) — when it's not in the tool list, that's a deployment setting, not an error; don't report it as broken.
- Cloud fallback for a file outline: `search_symbols` with `path` (add `exact: true` when pinning one symbol).
- `semantic_search` also needs embeddings in the graph — with none stored it returns guidance to run `coredoc embed`, not results. It searches AI summaries only and never returns source code.
- `includeSource` (on `explain` / `search_symbols`) appears in the schema only when the deployment allows source-in-graph; when it's absent, read the file instead.
- `run_cypher_query` is backend/opt-in gated; when present, see `graph-schema.md`.

## Scope resolution and environment

- Scope accepts a bare repo name, the qualified `project/repo` form (`coredoc/server-api`), or a filesystem path. Failures are **hard errors, never silent fallbacks**; a bare name that exists in multiple projects is rejected as ambiguous — re-call with a `project/repo` token from the error message.
- Scope is auto-detected from the working directory; pass `scope` explicitly only when querying a sibling repo in the same project. Precedence: an explicit `scope` arg wins under a `COREDOC_SCOPE=project:<id>` binding (you narrow *within* the project) or no binding / `auto` — but a **hard** `COREDOC_SCOPE=<repo>` binding (not `project:`, not `auto`) pins every query to that repo and **overrides your `scope` arg**. If your scope looks ignored, that's why.
- `COREDOC_CURRENT_REPO` sets a **vantage** repo (where the server sits), distinct from the scope boundary: when set it makes `list_service_dependencies` report *that repo's* dependencies and ranks `search_symbols` matches from it first. It applies only when you pass no explicit `scope`.
- For a package/npm exported symbol blast radius, call `find_dependents` or `analyze_change_impact` with the project-wide scope token `project:<project-id>`. Scoping to the declaring repo intentionally returns only that repo and excludes external importers.
- Only destination-mode `trace_cross_repo_call` may span the whole graph when local scope is genuinely unbound. Explicit, host-bound, and cloud workspace scopes never widen.
- Cross-scope lookups in `trace_cross_repo_call` follow `resolvedTargetId` automatically when the resolver linked the call at push time. The response surfaces the real target repo name.

## Staleness

Check the staleness banner against recent git activity before leaning on an answer.
Structure queries (what exists, who calls what at module level) tolerate a stale graph;
fine-grained edges on files being actively edited don't — verify those with a file read. If
the graph predates the work under discussion, say so explicitly and suggest re-running
`coredoc parse`.

## Output format

`format: "raw"` returns structured JSON with node ids for chaining. It is usually **larger**
than the default `"summary"` — ask for it when you need ids or exact fields, never to save
context.


## Intent release effectivity

On cloud servers exposing release effectivity, opt in with `effectivity: true` to distinguish
recorded production rules from planned changes. `currentRelease` identifies the latest recorded
evidence; it is not live deployment monitoring. Implement `planned` only when the current task
explicitly includes that approved change through its sources or a maintainer instruction.
Otherwise follow `effective` and report the relevant plan in review. Never implement `withdrawn`;
`unknown` is not proof of production availability. `intent_release` preview/list are reads;
record/rollback/plan/withdraw/reinstate require a person's own session (any workspace member). Merge, ticket closure,
and graph publication do not prove availability. An uncertain write is retried with the same
key, body and expected head; do not automatically update a stale head to force a delivery through.

The local overlay MCP does not support release effectivity or the release ledger. Do not pass
`effectivity` to a local tool or interpret an ignored argument as a production-aware result.
A cloud production-aware response includes the `currentRelease` field (which can be null before
any delivery); without that field, no production effectivity was established by the response.

Default context/list reads carry authority only and provide no production or plan-withdrawal
information. Opt in before reasoning about delivery or planned implementation. `not_effective`
means the rule is excluded from recorded production state, including ancestors replaced before delivery; it does not authorize
implementing it again. Inspect its history and the task's approved change rather than treating
it as `planned`.
