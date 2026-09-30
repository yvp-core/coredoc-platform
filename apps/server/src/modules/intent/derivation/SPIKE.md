# Derivation transport spike (issue 06 / spec §6.1)

**Decision: batched repository methods.** `runReadOnlyCypher*` is kept for nothing here; the two
new set-shaped reads on `@coredoc/db` (`expandOutboundNodeIds`, `selectReachedNodeIds`) are the
transport, and a backend that does not implement them degrades to attachment-only applicability
exactly as a backend without Cypher would.

## What was measured

Fixture: `buildIntentGraphFixture` at `{ files: 60, functionsPerFile: 20, calleesPerFunction: 3 }`
— 4948 nodes, 12151 edges over two repos; the seeded containment closure of one repo is 1268
nodes. Seeds: one Package + one Route. Median of 5 runs, warm handle, read-only Ladybug file,
one process. The one-off harness (`transport-spike.test-support.ts`) has since been removed — the
decision is made and the recorded results below stand as the record.

Three transports:

- **A — batched repository methods** (this issue's addition).
- **B — `runReadOnlyCypherRows`** templates; W1 in both a single recursive form and a per-level form.
- **C — today's single-node reads**, i.e. what the derivation would cost if built on the existing
  contract: `getSubgraph` per seed, `getNeighbors`/`getDirectCallees`/`getDirectCallers` per node.

| Workload | Transport | Queries | Median ms | Result |
|---|---|---:|---:|---:|
| W1 multi-seed containment closure | A batched methods | 3 | 28.8 | 1268 |
| W1 | B cypher (single recursive `*1..6`) | 1 | 15.5 | 1268 |
| W1 | B cypher (per level) | 3 | 24.3 | 1268 |
| W1 | C `getSubgraph` per seed | 2 | 33.0 | **202 — `nodeCap` 200 tripped** |
| W2 HANDLES resolution over the closure | A batched methods | 1 | 15.1 | 1 |
| W2 | B cypher | 1 | 6.6 | 1 |
| W2 | C `getNeighbors` per node | 1268 | 1519.7 | 1 |
| W3 one-hop CALLS callees of the closure | A batched methods | 1 | 24.9 | 1202 |
| W3 | B cypher | 1 | 24.9 | 1202 |
| W3 | C `getDirectCallees` per node | 1268 | 1143.9 | 1202 |
| W4 which of 203 anchors are called by the area | A batched methods | 1 | 16.6 | 201 |
| W4 | B cypher | 1 | 16.2 | 201 |
| W4 | C `getDirectCallers` per anchor | 203 | 827.9 | 201 |

## Reading the numbers

1. **The baseline is disqualified, which is the finding that matters.** C is 40–100× slower on
   the set-shaped workloads (one round trip per closure node) and, worse, W1 shows `getSubgraph`
   cannot express the job at all: its `nodeCap` is hard-capped at 200, so it returned a silently
   partial closure. The audit's "existing reads are single-node" is confirmed as a blocker, not a
   performance preference.
2. **A and B are the same query.** On W2/W3/W4 both issue exactly one Kùzu query and land inside
   noise of each other (24.88 vs 24.88 ms on W3). There is no engine-level advantage to writing
   the traversal as caller-supplied Cypher; the batched method IS the same `MATCH … WHERE
   list_contains(…)` the template would send.
3. **B's only real win is W1**, where a recursive `*1..6` pattern does the whole closure in one
   query (15.5 ms) instead of A's one query per level (28.8 ms) — ~13 ms on a 1268-node closure.
   That win is bought by giving up the per-level bound: the recursive form can only limit the
   final row count, so the engine walks the entire reachable set before the limit applies and the
   caller cannot stop at a node budget or report which level tripped it. A's loop checks the
   budget between levels, which is what makes §6.1's "results never silently shrink" enforceable
   rather than aspirational.

## Why the 13 ms does not buy the decision

- **Bounds.** §6.1 requires a node budget AND a per-request query budget with a `truncated`
  marker. A enforces both in the loop it already runs; the recursive Cypher form enforces neither
  before execution.
- **Guard surface.** Every `runReadOnlyCypher*` call re-enters `assertReadOnlyCypherAllowlisted`
  plus the source-projection scanners — a security boundary tuned for *untrusted* caller input.
  Routing first-party derivation through it adds risk in one direction only: a future tightening
  of that guard (or `COREDOC_ALLOW_SOURCES` policy) can break derivation, and derivation queries
  would compete for the attention that boundary owes to user queries.
- **Availability is a wash, not an argument for B.** Cypher is `undefined` on the legacy
  Turso/SQLite path, and so are the batched methods (both are optional capabilities). Either way
  the service feature-detects and degrades to attachment-only. B additionally requires a
  *read-only handle* (`assertReadOnlyCypherHandle`), which the batched reads do not.
- **Types.** A returns `string[]`; B returns `CypherScalar[][]` that the caller re-asserts, and the
  query text is a string no compiler checks against the schema.

## Cost of the decision (paid, not hidden)

`WorkspaceMcpContextService` hands out a *scoped facade*, not the repository: only methods named in
`GRAPH_READ_METHODS` / `OPTIONAL_CYPHER_METHODS` are forwarded. Cypher is already on that list;
the batched methods had to be added to it (`OPTIONAL_BATCH_TRAVERSAL_METHODS`, feature-detected the
same way). That is the one edit outside this module the decision required. Choosing B would have
avoided it — and that convenience is the entire case for B, which the bounds argument outweighs.

## Residual

- The recursive form stays available as a later optimisation for W1 specifically, if closure depth
  ever dominates a measured profile (§16's caching lane). It is not needed at this scale: the
  whole area computation for a 1268-node closure is ~5 queries and well under 100 ms.
- These are single-process, warm-cache numbers on a local file. They bound the *shape* of the cost
  (query counts), not production latency; §15's large-workspace performance smoke is the gate for
  that.
