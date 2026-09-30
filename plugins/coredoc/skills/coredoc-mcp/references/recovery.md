# Empty / Not-Found Recovery

For indexed names and relations, use one diagnostic call per dead end. For raw
literals (query parameters, headers, env keys, log messages, topic names), go
directly to targeted source search: symbol lookup does not search source text.
A graph miss never establishes code absence.

Param names, so a lookup never fails spuriously: `find_callers` takes **`functionName`**
(bare name or `Class.method`), `explain` takes **`target`**, `search_symbols` takes
**`query`** — never `symbol`.

## `explain` says "not found" / returns "did you mean…?"

`explain` auto-detects the kind (function / class / interface / entity / component / type
alias / enum / variable / route) and routes appropriately, so a miss usually means the name
is wrong or out of scope — not the wrong tool. Common case: `RequestsPage` is a class
component (class + component), and an ORM model is both an entity and a class — `explain`
returns one **merged** result tagged with both kinds and a follow-up hint for each tool
(`find_dependents`, `find_entity_usage`), not a disambiguation prompt.

- For a specific method, qualify the target: `explain(target: "ClassName.methodName")` (e.g. `RequestsPage.render`).
- Have a **location** but not a name (stack frame, grep hit)? Switch to the `path:line` form: `explain(target: "src/foo.ts:42")`.
- For who consumes a class/interface: `find_dependents(name: "ClassName", type: "class")`.

## `search_symbols` returned 0

- Try a **shorter substring**. The search is `%query%` LIKE — partial names work (e.g. `CreateUser` matches `CreateUserDTO`).
- **Multi-word queries are AND-matched** — every word must appear in the same symbol name. An empty result stays empty; search one concept per call. For "anything related to modals," issue separate queries (`Modal`, then `Dialog`) and merge.
- Default `all` includes exported top-level variables/constants; pass `type: "variable"` to include non-exported ones too.
- `search_symbols` matches **declared symbol names only** — it does NOT resolve URL paths. For an HTTP path use `explain` (pass the path) or `list_entrypoints`; for a cross-repo call use `trace_cross_repo_call`. For concept questions, use `semantic_search` when present.
- **Verify before you plan**: any symbol name going into an implementation plan should be pinned with a `search_symbols(exact: true)` re-call (add `path` when you know the file) — it drops substring/fuzzy near-misses and confirms the canonical node and owning repo.

## `explain` on an HTTP path says "not found in scope"

- Pass the verb with the path: `explain(target: "POST /posts/foo")` — the method is parsed off automatically.
- The path might live in a **sibling repo** in the same project. Try `trace_cross_repo_call(callPattern: "POST /path")` — it crosses scopes. `callPattern` also accepts the **SDK method name** (e.g. `linkSubscription`), which is how SDK-mediated calls (no literal URL at the call site) are matched. For an async queue/event hop use destination mode instead: `trace_cross_repo_call(destination: "user-events", system: "kafka")` — `callPattern` does NOT understand a `kafka:` prefix.
- React routes appear under `list_entrypoints` as `GET /path` synthetics. If you're chasing a UI route, use `list_entrypoints` first to see how it was indexed.

## `find_entity_usage` returns 0 every time

The repo likely has no ORM entities (e.g. frontend repos). Check `describe_repository`'s
entity count — if 0, the right tools are `find_dependents` (for type usage) or
`find_callers` (for function call sites). Don't keep asking the same tool with different
names. If the repo does have entities, read `get_extraction_coverage`'s **DB operations**
line: unbound counted db-operation sites (or "resolution not measured by this graph's
parser") make a zero inconclusive — grep the table/model name before asserting nonexistence.

## `find_callers` says 0 callers, but you know X is used

Possible: callers go through a wrapper, an interface, or a proxy/dynamic dispatch. Try
`analyze_change_impact(target: "X")` — it traces transitively and surfaces wrapper layers.
A zero here is inconclusive whenever `get_extraction_coverage` reports unbound in-repo call
sites for the scope, or reports call resolution as not measured: verify in source before
asserting nothing calls it.

## `trace_cross_repo_call` says "downstream entrypoint unresolved"

The outbound call was indexed but its target entrypoint didn't resolve — either the target
repo isn't parsed yet, **or** the resolver couldn't bridge that SDK call (a fraction of
external calls stay unresolved on any graph). The response still names the **caller**
function/file and the **target repo**. Two ways forward: (a) start from the caller and
trace manually with `explain`; (b) if you can name the target repo,
`search_symbols(scope: "<target-repo>", query: "<sdkMethodName>")` to find candidate
handlers, then `explain` them.

## Unknown scope error

Scope failures are always **hard errors** — the server never silently falls back to another
repo, so an error here means your scope string is wrong, not that data is missing. The
error lists the valid options: pick a configured repo name, or the qualified `project/repo`
form (`coredoc/server-api`) when a bare name exists in more than one project — re-call with
a token from the error message. Common mistake: passing a service name (`sample-api`)
instead of a repo name (`demo-packages`). Service identifiers are virtual targets of
external calls, not repos.

## What this graph cannot see (empty because it is blind, not because the code is)

Two different kinds of hole produce the same empty result, and they need different moves:

- **Thin coverage** — the shape IS modelled, this repo's profile just captured little of it.
  `get_extraction_coverage` measures exactly this and reports it as counts: in-repo call
  sites the extractor could not bind (or "not measured" on a graph pushed before the signal
  existed), entities with a recorded operation, and a LOW flag for external-call resolution
  — the only category with a threshold. Unbound sites, unmeasured repos or few entities with
  operations = the empty result is inconclusive; there is no pass mark to read off.
- **Structural blindness** — no edge of that kind is emitted at all, so *no count can ever
  flag it*: the counters have nothing to count. A green coverage report says nothing about
  these. `get_extraction_coverage` therefore prints a separate **structurally blind
  categories** block naming them.

**That printed block is the live list — read it, don't memorise one.** Entries are declared
in the server and retired by the change that closes the gap, so a shape absent from the
block is modelled today (class/interface hierarchy edges, for instance, are emitted:
`find_dependents` sees subclasses and implementors). Categories that have appeared there
describe code shapes, never frameworks — e.g. calls made inside test callbacks (impact
roll-ups may not name the tests a change breaks) and producer-side queue publication whose
destination is not statically resolvable (egress can read near-empty while every count
looks healthy). Each entry ends in the move to make instead of trusting the empty result.

**The dispatch caveat applies at any resolution rate, blind list or not.** `CALLS` edges cover
statically resolvable dispatch only; calls made through proxies, DI containers, handler
registries or reflection are absent even in a repo whose in-repo calls nearly all bind. So a
0-caller / 0-usage result for a symbol that plausibly has framework wiring is unproven, not
a finding — one targeted grep before you call it unused.

**An affirmative negative claim needs the governing source, not graph absence.** Before a
security finding, review, diagnosis, explanation, or plan asserts "nothing uses X", "no migration is required", or "the version/contract constant
does not need to change", READ the file that owns that rule (the constant's declaration, the
migrations map, the contract type) — conventions like "changing this shape requires bumping
the version and adding a checked-in migration" live in those files as code and comments the
graph does not model as edges. A graph that shows no edge forcing the bump is not evidence
the bump is optional.

Recovery per shape, in one move each:

| Empty result | Likely hole | Move |
|---|---|---|
| `find_callers` → 0, symbol obviously used | dynamic dispatch, or a wrapper layer | `analyze_change_impact` (traces transitively), then one grep on the bare name |
| `find_entity_usage` → 0 on a repo that has entities | counted db-operation sites unbound, or resolution not measured | read the **DB operations** line of `get_extraction_coverage`; grep the table/model name; report the gap |
| `list_service_dependencies` → near-empty on a repo that clearly calls out | LOW external resolution, or an unmodelled publish shape — a resolved call is always named, by the repo it reaches, even when the client carries no service name | grep the client/publish call sites |
| impact roll-up names no tests | test-callback attribution | grep the test dir for the symbol |
| a symbol you can see in source is absent entirely | the file/repo was not parsed | `describe_repository` to confirm the repo is covered and when it was parsed |

Whenever source contradicts the graph: trust the source, answer from it, say which part came
from source, and file the gap (below).

## Reporting a gap

When the source contradicts the graph, trust the source, answer from it, and report the
discrepancy as a coverage gap via the coredoc-feedback skill (`submit_session_feedback`,
category `incomplete` or `wrong`, with a redacted `exampleQuery`).
