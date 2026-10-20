# Call-graph eval: tree-sitter + SCIP engine vs TypeScript checker

Status: ready-for-human

Question: does the current profile engine (tree-sitter + scip-typescript) produce a TS/JS call
graph comparable to what the TypeScript compiler (ts-morph, the v1 approach) can resolve?

## Method

- Parsed outputs: `coredoc-output/{cd/coredoc-platform,dayio/day-core,dayio/oitchau-schedules}.json`
  (parsed 2026-10-06, `coredoc-code-graph-tsjs-v1` 1.2.6). `packages/profile-parser` has no commits
  since that parse (`git log ef57728..HEAD -- packages/profile-parser` is empty), so they reflect the
  current engine.
- Source: `git archive` of the exact parse commit (coredoc-platform `ef57728`, day-core `510a6302`,
  oitchau-schedules `c348e21`), dependencies symlinked from the live checkouts.
- Ground truth (`eval.cjs`): every `CallExpression` in the parsed files whose callee symbol resolves
  (through imports, re-exports, `require`, destructured `await import()`) to an in-repo function-like
  declaration with a graph node. Calls through an in-repo interface/abstract member accept any
  implementation (or the abstract node). Workspace packages resolve to `src`, not `dist/*.d.ts`.
- Key: `file:line:calleeId`. Getter reads and functions passed as values are parser edges by design;
  they are counted separately, not as false positives.

```bash
# Parse the three repos with this checkout's CLI (a config whose repos point at the snapshots).
./parse-all.sh <coredoc.config.json>
# Ground truth + comparison for every repo of one parse output dir (coredoc-platform is read from
# a `cdp-tree` snapshot); ts-morph@27 is installed outside the repo and passed by path.
SNAP=<snapshots> OUT=<out> TSMORPH=<path to ts-morph> ./eval-run.sh <parse out dir> <tag>
node show.cjs <out>/<repo>.<tag>.json [buckets|callees|samples]
```

## Results

| repo | kind | checker sites | recall | precision | getter / value-ref edges |
| --- | --- | ---: | ---: | ---: | ---: |
| day-core | NestJS, TS | 909 | **94.9%** | 100% | 0 / 2 |
| oitchau-schedules | Koa, CommonJS JS | 455 | **82.2%** | 98.4% | 66 / 4 |
| coredoc-platform | pnpm monorepo, TS | 19 242 | **72.7%** | 99.9% | 18 / 2 430 |

Precision is not the problem: almost every parser edge the checker lacks is a getter read or a
function reference. Recall is.

For oitchau-schedules the checker itself resolves only ~50% of call expressions (untyped CommonJS),
so its recall is measured against a weaker ground truth; the true gap is larger.

Misses are tied to the **callee**, not the call site: in coredoc-platform 3 927 of 5 260 misses
belong to 1 406 functions none of whose calls resolve (day-core 39/46, oitchau 73/81). A definition
never joins to its node, so every caller misses it.

### Where the misses go (mutually exclusive, first match wins; pp = recall gained if fixed)

| bucket | coredoc-platform | day-core | oitchau |
| --- | ---: | ---: | ---: |
| callee is a nested function / arrow const (SCIP `local N`) | 1 183 (+6.1pp) | 13 (+1.4pp) | 35 (+7.7pp) |
| module-scope call, no caller node | 861 (+4.5pp) | 20 (+2.2pp) | 5 (+1.1pp) |
| dispatch via in-repo interface / abstract | 664 (+3.5pp) | – | – |
| file with no SCIP-resolved calls | 560 (+2.9pp) | 5 (+0.6pp) | – |
| callee id collides (same name twice in a file) | 402 (+2.1pp) | 3 (+0.3pp) | – |
| callee is an object-literal function (`module.exports = {…}`) | 54 | – | 27 (+5.9pp) |
| callee is a top-level arrow const | 64 | – | – |
| other (see call-form tables) | 1 472 (+7.6pp) | 5 | 14 |

Call-site form, coredoc-platform recall: single call on its line 78.7% vs line with several calls
54.7% (day-core 96.3% vs 70.8%); explicit type args `f<T>()` 44.1%; aliased import
`import { a as b }` 13.2%; cross-package 67.4%.

## Root causes found in code

1. **SCIP local symbols never resolve.** `symbolToNodeId` (`facts/scip/to-edges.ts`) verifies the
   node name against `methodNameFromMoniker(symbol)`. For `local N` that returns `"local N"`, which
   never equals a node name. scip-typescript emits `local N` for function-scoped declarations, so
   calls to nested `function f` / `const f = () =>` are always dropped although the nodes exist.
   `defLoc` is also keyed by the raw symbol, and `local N` repeats across files. A fix needs a
   `(file, symbol)` key and the name from the definition token.
2. **Line-granular call-site key.** `siteKey` (`facts/graph/graph-builder.ts:124`) is
   `callerId|file|line`. With several calls on a line, `unresolvedCallSites` keeps only the last
   one. SCIP results then upgrade one structural edge and append the rest. That causes the recall
   drop on multi-call lines and 1 158 duplicate (resolved + unresolved) records in coredoc-platform.
3. **Stable id `file:name` collides.** Two declarations with one name in a file (a top-level
   `function emit` and an `emit:` arrow in an object literal, `agent-run-service.ts`) share one id.
   One node survives, so all calls to the other miss and its own calls get the wrong caller.
   There are 155 such ids in coredoc-platform.
4. **No caller node for module scope.** `export const X = normalize(...)`, `@Module({ imports:
   [createPinoModule()] })` and config factories produce no edge. The file or module could be the
   caller.
5. **Interface dispatch is near 0%** outside Nest DI (`di` provenance). `iface-impl` fired 3 times
   in coredoc-platform. Example misses: `repository.getRepoOverview()` (Ladybug/Sqlite/Neo4j
   repositories) and `adapter.run()` (Claude/Codex).
6. **Files outside every SCIP project** (e.g. `apps/desktop/e2e/**`) fall back to no resolution,
   even for calls within the same file.

## Fixes 1–3: before / after

Implemented in `facts/scip/to-edges.ts` (local symbols keyed by file, resolved through the call
site's name), `facts/graph/graph-builder.ts` + `facts/structural/ts-structural.ts` (unresolved sites
keyed by the callee name token's line and column) and `facts/structural/to-nodes.ts` (a later
same-named function gets `name#2`, and callers are picked by span).

Both columns come from the same CLI, profile and source, with only the fix toggled. The "before"
parse of the dayio snapshots reproduces the 2026-10-06 outputs exactly (453 and 867 bound sites).
coredoc-platform was re-measured on a CoW clone of this worktree, which has real `node_modules`.
Symlinked deps made scip-typescript time out.

| repo | recall before → after | precision before → after | bound sites (CLI) |
| --- | ---: | ---: | ---: |
| day-core | 94.9% → **97.5%** | 100% → 100% | 867 → 890 |
| oitchau-schedules | 82.2% → **91.2%** | 98.4% → 100% | 453 → 510 |
| coredoc-platform | 72.6% → **86.2%** | 99.9% → 99.9% | 17 789 / 27 509 → 20 672 / 24 834 |

On coredoc-platform, recall on lines with several calls went from 54.8% to 88.5%, and same-file recall
from 72.6% to 91.1%. Duplicate resolved + unresolved records are gone: counted sites fall from
27 509 to 24 834.
Remaining misses: module-scope calls 908, interface dispatch 747, files outside every SCIP project
559, other 314, residual id collisions 202.

`engine.call-resolution.test.ts` asserted the old behaviour. Its "two `local(n)` facts on line 9"
were a mis-upgrade (`helper`'s SCIP result landed on `local`'s structural edge and was then gated
away). Its `setTimeout` site survived only because the stdlib-noise removal deleted the wrong edge
on the line. Both tests now assert the correct output.

## Folding isolated nested functions

A nested `function b` / `const b = () =>` that is only ever called directly inside its enclosing
function (or handed to an array method such as `.map(b)`) is no longer a node. Its body is attributed
to the enclosing function, whose source (and summary) already contains it, and `b(...)` is not an
edge. A nested function that escapes stays a node: returned, passed as a callback or handler, or put
in an object. Object-literal members always stay nodes, because they are called through the object
(factories, stores, option objects). Folded spans remain lexical scopes for accessor-hook and
dynamic-import binding resolution (`StructuralFile.foldedScopes`).

| repo | function nodes | nested nodes | recall | precision |
| --- | ---: | ---: | ---: | ---: |
| oitchau-schedules | 843 → 827 | 23 → 7 | 90.5% | 100% |
| day-core | 815 → 811 | 21 → 17 | 97.4% | 100% |
| coredoc-platform | 9 595 → 9 077 | 1 260 → 746 | 85.8% | 99.9% |

Recall is unchanged against the fixes-only parse. Calls to folded functions leave the ground truth
because they are not edges by design. In coredoc-platform, 397 of the remaining nested nodes are
object-literal members. 193 are declarations used as a value, e.g. `collectConfigObjectRoutes(root,
add)`, or kept conservatively when a same-named parameter shadows them. 155 are entrypoint handlers.

## Regression gate before release

`evals/scripts/graph-regression.ts` and `evals/scripts/mcp-regression.ts` (see evals/README) compare
the old-parser and new-parser parses of the same source, with no model calls. Final run (`out-before`
vs `out-after5`):

| repo | graph gate | resolved call sites | MCP questions | lost answers |
| --- | --- | ---: | ---: | ---: |
| oitchau-schedules | PASS | 450 → 475 | 572 | 0 |
| day-core | PASS | 865 → 877 | 688 | 0 |
| coredoc-platform | PASS | 17 775 → 19 534 | 794 | 0 (2 answers at the 20-item cap) |

The gate caught four problems in intermediate versions, all fixed before the final run:

- **Folding into a non-node.** A function folded into a class constructor or an anonymous callback
  loses its calls. Now a function only folds into a host that is itself a node.
- **Name-based owner for namesakes.** DB-op performers and call owners resolved through
  `functionId(file, name)` landed on the first namesake. The substrate now resolves the namesake
  that spans the line: `functionId(file, name, line)`.
- **Aliased imports.** `import { a as b }` lost the edge: the in-place upgrade kept the expression
  `b`, and the callee-name gate then refused it. Aliased sites keep the separate edge.
- **False alarms the gate itself had to learn.** Old-parser duplicate records; chained calls
  located at their first line; identical calls on one line; calls that became self-recursion after
  folding; callers refined between nested scopes.

All 166 refined callers in coredoc-platform moved to the narrower (or wider) scope that actually
contains the call, e.g. a namesake split back out of a merged node. `analyze_change_impact`
silently truncates reaching entrypoints at 20 (`ladybug/repository.ts` `getReachingEntrypoints`),
so new findings can push old ones off the list.

## Release checks

- `PARSER_VERSION` 1.2.6 → 1.3.0, with a MIGRATION note (`facts/config.ts`).
- `coredoc push` (Ladybug, through `file-builder`) published all three graphs, with no
  duplicate-edge-id or mass-delete refusal.
- The parsed-output validator (`packages/cli/src/validate`) reports identical results before and
  after. The 507 / 652 / 1 871 `FunctionNode.isAbstract` errors (methods without `isAbstract`) were
  there before this change.
- `getReachingEntrypoints` is now ordered by nearest handler, which needs `min(length(path))` instead
  of `DISTINCT handler`. On the coredoc-platform graph (18k nodes) both shapes took 4–9 ms on Neo4j 5
  and 2–8 ms on Ladybug, at walk depth 6 and 10. `apiRequest` returned 72 entrypoints instead of 20.

## Takeaways

- The engine is not far from the compiler on a conventional TS service (day-core 95%). The monorepo
  gap (73%) comes from a handful of mechanical join bugs, not from the tree-sitter + SCIP approach:
  scip-typescript *is* the TS compiler, and the information is lost in our join.
- Fixes 1–3 are local to `to-edges.ts` / `graph-builder.ts` / the id generator. Fixes 1 and 3 alone
  account for ~8pp on coredoc-platform; fix 2 recovers part of the multi-call-line gap (54.7% vs
  78.7%), which overlaps the other buckets. Rewriting the engine (in Rust or anything else)
  would not address any of them.
- This harness can be a regression gate: the same script against any TS/JS repo yields
  recall/precision plus bucketed samples.

Limits: TS/JS only; in-repo callees with graph nodes only; external/SDK calls are not scored; the
v1 per-repo ts-morph parsers' actual output was not measured. The checker is their ceiling, not
their result.
