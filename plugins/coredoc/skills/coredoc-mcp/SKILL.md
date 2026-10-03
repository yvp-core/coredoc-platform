---
name: coredoc-mcp
description: Use Coredoc MCP tools to navigate code structure, trace calls, assess change impact, and follow cross-repository dependencies. Use for codebase questions when Coredoc is available; verify behavior claims in source. Grep, Glob and Read do not satisfy a code question this workspace's MCP can answer; the implement and review stage closes count Coredoc reads, not writes.
---

# coredoc MCP Tools

A pre-parsed code graph — calls, entrypoints, entities, cross-service links; the staleness
banner marks the last parse.

## MCP-first navigation

**MCP replaces discovery** of indexed structure: repo inventory, symbol lookup,
entrypoints, callers, impact, and cross-repo links. Use targeted source reads for
line-level behavior and incomplete, stale, or unresolved results. For a missing
indexed name or relation, try one diagnostic call before source fallback.

Raw literals (query parameters, headers, env keys, log messages, topic names,
prose/config) go straight to targeted source search. A wrapping identifier such
as `otToken` for `ot_token` locates candidates; it does not prove literal handling.
Never run a repo-wide Grep/Glob inventory as a substitute for indexed discovery.
Targeted source checks remain necessary even after a successful graph lookup.

## Structure vs. line-level semantics

The graph carries **structure** — what exists, who calls what, what breaks if X
changes — not **line-level semantics**: validation rules, allow/deny-lists,
guards, defaults, ORM/serialization config.

- **Changing code** (plan, spec, refactor): locate with coredoc, then **read those files** — every file you name you have read or quoted from an `explain` body, never inferred from a summary.
- **Behavior claims** (security findings, reviews, diagnoses, explanations): the graph is the skeleton; substance is line-level (guards, predicates, branches). Pull bodies **before** answering — `explain(includeSource: true)` when offered, else Read the files.
- **Read-only discovery** (inventory, dependency map, impact): the graph answer stands alone; read source only to confirm a cited line, close a flagged gap, or check a negative claim.

For claims about a value's handling, follow the producer through the relevant
transport/navigation boundary to its consumers and inspect the validation,
propagation, persistence, or cleanup being assessed. A backend URL writer does
not establish frontend URL handling. Use `find_callers` for function relations
and cross-repo tools where available; bridge unresolved boundaries with targeted
source search. A call graph alone is not a value-flow proof. Cite inspected paths
and bound conclusions to the evidence available.

## Call budget

Typical task: **3–8 discovery calls**; source-body verification is not budgeted.
Do not re-issue overlapping discovery or repeated explanations. One clarifying call per
unresolved item, then name what remains unknown.

## Start here

`describe_repository` once per task.

**Repo-membership gate.** Check the current repo is among the listed repos.
A workspace-scoped connection can stay available in an unindexed repo.
If absent, the graph does not cover this repo: say so; results describe other projects.
Use source for this repo, or `coredoc parse` + `push` / correct scope.
Indexed siblings remain usable for cross-repo questions.

| Question | Tool |
|---|---|
| Which repos exist | `describe_repository` |
| What is X — any kind, `path:line`, `METHOD /path` | `explain` |
| Name search | `search_symbols` (`exact: true` pins one) |
| Concept, no name | `semantic_search` if present |
| Entrypoints / routes | `list_entrypoints` (HTTP, queue, event, cron, CLI, UI) |
| File outline | `list_file_symbols` |
| Who calls X | `find_callers` (functions) / `find_dependents` (types) |
| What breaks if X changes | `analyze_change_impact` |
| Reads/writes entity Y | `find_entity_usage` (ORM) |
| DB schema | `describe_db_schema` (`scope` = one repo, `entityName` = full table) |
| Cross-service calls, publishers of Y | `trace_cross_repo_call`, `list_service_dependencies` |
| Product rules, non-goals | `intent_read` (workspace MCP only) |
| Ad-hoc graph query | `run_cypher_query` if present |

`intent_read`: `tree`, then `node`, then `search`. Rules for code you
change: `get_intent_context` with `files`/`intentIds`.

Intent read semantics: see `workflows.md`.

`explain` is the default when the kind is uncertain: kinds merge into one result; a
disambiguation list = a cross-file collision (re-call with `className`/`fileHint`); **`+N more`
= truncated** (re-call at `detailLevel: "full"`); the `Deeper:` footer names the next hop.

## Detail levels

Lists return **`basic` by default** (name, repo, location, relationship). Use `full` for
rows needing detail; `explain` and whole-schema dumps are also compact by default.

## Answer-quality habits

- **Disambiguate in multi-repo scope.** Common names resolve to the first match with a `⚠ N more matches` banner — re-call with `Class.method` or `fileHint`, or you answer from the wrong repo. Cite files as `repo-name/repo-relative/path`.
- **Paginate.** `search_symbols` / `list_entrypoints` return 20 by default — raise `limit` or page with `skip`.
- **Scope failures are hard errors, never silent fallbacks.** Use a configured repo name, `project/repo` when ambiguous, `project:<project-id>` for package-export blast radius; the error lists valid tokens.
- **A graph miss is not code absence.** Never invent a missing symbol, and never turn a failed lookup into “nothing handles this” or “this does not exist.” A negative behavior claim requires inspection of the relevant source and revision. If that evidence is unavailable, state what remains unverified.
- **Graph gaps vs code gaps.** Empty ≠ absent for DB ops, egress calls and caller closures: under-extraction looks identical. `get_extraction_coverage` calibrates trust with counts, not verdicts: unbound in-repo call sites, entities with a recorded operation, a LOW flag for external resolution only, and "not measured" when the graph predates it (re-parse, re-push). Its **structurally blind categories** block names shapes no count can flag (no edge emitted → nothing to count). `CALLS` covers statically resolvable dispatch only: 0 callers on a plausibly framework-wired symbol is unproven. One targeted grep before asserting nonexistence; source beats graph — trust it, report the gap (coredoc-feedback).

## References

Load only if needed; this file stands alone. `recovery.md` — empty/not-found recovery, blind-category moves, param names. `workflows.md` — SQL/schema + pub-sub recipes, stack traces, `depth`/`fileHint` pitfalls, `COREDOC_SCOPE`/vantage, `format: "raw"`, staleness. `cross-repo.md` — cross-service tracing, destinations. `graph-schema.md` — node/edge/edge-property vocabulary, Cypher dialects, worked queries.
