# Intent performance baseline

`intent-baseline.json` is the committed measurement of what a cloud-intent read costs on a
large workspace. It exists because spec §16 names one residual risk — *"derivation cost on
large graphs is unproven"* — and §15 answers it with a gate rather than a budget: the numbers
are recorded, and the next run is compared against them.

## Running it

```bash
apps/server/scripts/perf-intent-smoke.sh                          # compare against the baseline
INTENT_PERF_UPDATE_BASELINE=1 apps/server/scripts/perf-intent-smoke.sh   # replace the baseline
```

The script starts its own throwaway Postgres (`docker-compose.test.yml`, project
`coredoc-server-intent-perf`, port `55433` — it does not collide with `test:postgres`), applies
the migrations, and runs one vitest file:
`apps/server/src/modules/intent/perf/intent-perf.smoke.test.ts`.

It is **not** in `pnpm test` and **not** in `scripts/test-postgres-integration.sh`. The suite is
gated on `INTENT_PERF_TEST_DATABASE_URL`, which only this script sets, so everywhere else it
skips. A full run is ~2 minutes, most of it building the graph fixture.

Rebuild the workspace packages first (`pnpm build`) if `@coredoc/db` changed: the suite imports
`@coredoc/db/ladybug` and `@coredoc/db/testing` from `dist`.

## What it measures

A generated workspace (`intent-perf-fixture.test-support.ts`, parameters recorded in the
baseline's `shape`): 12 repositories, 240 features each with its own seeded package, 280 feature
seeds, 3400 items, 1500 anchors, over a 16.6k-node / 30k-edge Ladybug snapshot. Every feature's
handler calls a guard function outside its own package, and an item is anchored there — so the
node workloads exercise the §6.2 "admin guard" derivation path rather than a row lookup.

Six workloads, all through the real controllers with the real guards:

| workload | what it stresses |
|---|---|
| `context: feature scope` | tree scope + attachment, evidence over the returned items |
| `context: nodeIds (guard case, unscoped)` | full derivation: every candidate feature's area |
| `context: nodeIds (guard case, feature-scoped)` | the same, narrowed to one feature |
| `context: lexical search` | the pg_trgm selector |
| `context: exact ids` | the handoff re-fetch path |
| `review: batch of 10` | the write path (locks, transitions, idempotency ledger) |

Per workload: p50/p95/min/max over 25 measured iterations (3 warm-ups discarded), the number of
SQL statements counted at the pg transport, the number of graph reads counted at the repository,
the result size, and whether a §6.1 derivation bound tripped.

## How a comparison fails

**Query counts are the gate.** They are deterministic and they are shape, not speed: an extra
round trip is the regression that compounds with workspace size. Any workload whose `sqlQueries`
or `graphQueries` exceeds the baseline fails the run.

**Latency is reported, never enforced.** The compose Postgres keeps its data on tmpfs and the
graph is a warm local file in the same process, so these are floor values for one laptop. The
run prints `p95 <now> vs <baseline> (<ratio>×)` for every workload; a ratio that jumped on the
same machine is worth investigating, but this lane will not stop you on it.

**A partial baseline is never written.** A workload whose test failed is absent from the report,
not marked failed — so an `INTENT_PERF_UPDATE_BASELINE=1` run that is missing any workload of the
baseline set (`PerfWorkloadName` in `intent-perf-baseline.ts`) throws, names the missing workloads
and leaves the committed baseline untouched. Fix the failing workload and re-run the whole suite.
The comparison path is unaffected: it writes `intent-report.json` whatever it managed to measure.

Re-measure the baseline only deliberately, and say in the commit message which machine it came
from — the latencies are comparable to themselves and to nothing else.

## What the committed baseline says

The fact worth carrying around: an **unscoped** node-selector read (`nodeIds` with no
`domain`/`feature`) now DERIVES COMPLETELY — `derivationTruncated: false`, no limits — on this
fixture, and it is the most expensive workload here by a wide margin. It used to truncate on the
query budget and derive only the alphabetically-first features, which was honest and useless;
v1.1-05 fixed the SELECTION rather than the number:

- `IntentContextService.derivableFeatures` drops every feature with no seed in a queried
  repository before the `features` bound applies. Exact, not a heuristic: §6.1 computes areas per
  repository and no cross-repo edge extends one, so such a feature could not have matched.
- `resolveNodeApplicability` then walks what is left in relevance order (seed-is-the-queried-node,
  then a feature an anchored item already ties to this code, then repository overlap ordered by
  shared path depth), so a budget that DOES run out has bought the areas most likely to matter —
  and whatever it did not reach comes back as a `graph.scopeSuggestion` naming `feature=`/`domain=`
  and the features never checked.

Narrowing with `feature=` is still roughly three times cheaper, which is why the tool description
says so. The §4.9 caching lane was measured and **not** taken: with the selection fixed, the
unscoped read costs fewer graph queries than it did while truncating, so a per-(feature,
graphVersionId) area cache would have bought latency this gate does not enforce, at the price of
state the spec says must not exist. Re-open it only if a measured workload needs it.

The 2026-09-02 baseline was re-measured on a laptop noticeably slower than the one that produced
the first one, so its latencies are lower-bound noise; the query counts are the comparable part.
