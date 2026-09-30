# Graph-audit protocol

Dispatch material for the Audit step: five independent angle agents, then one synthesis
agent. Parameters: `{REPO}` (repo root), `{JSON}` (the parse output), `{PROFILE}`
(the profile path). Prepend the shared preamble to every angle prompt and send as-is.

Audit findings are hypotheses, not facts: auditors misattribute causes, miscount, and
claim rules fit file sets they don't. The triage step verifies premises before any edit;
the preamble's evidence requirement is what makes that verification possible — keep it.

## Shared preamble (prepend to every angle prompt)

Read-only coverage audit; change nothing, fix nothing. Ground truth comes from the
SOURCE at {REPO} — enumerate it independently of the profile; open {PROFILE} only to
attribute findings, never to derive what "should" exist. {JSON} may be hundreds of MB —
never read it directly; slice it with `node -e` one-liners and print only aggregates and
samples. Prefer `git ls-files` over `find` (worktrees and untracked build dirs pollute
counts in both directions); state every counting heuristic next to its number. Verify in
BOTH directions: known source symbols present in the graph, and graph claims spot-checked
against source — a MIS-resolution (edge pointing at the wrong target) is a finding, and
worse than a missing edge. Attribute every finding PROFILE (authorable today — name the
rule shape) vs ENGINE (needs a primitive/fix). Every PROFILE finding must include its
reproduction evidence — the exact command(s) run and the counts printed — so the author
can re-run them; a finding whose premise cannot be reproduced will be discarded. Include
a "healthy lanes" section: what you verified as fine, with evidence. Return a compact
report: numbers tables, verdicts, findings ranked by impact with file:line examples.

## Angle 1 — entrypoints

Question: how complete are ENTRYPOINTS (HTTP/API handlers, queue/cron/cli/edge-function
handlers) versus source?
1. From {JSON}: entrypoint counts by kind and by app root; sample paths of each kind.
2. From SOURCE: enumerate ground truth per surface — file-convention handler files
   (pages/api, app/**/route.*, urls.py-style registries), call-shape routers, decorator
   routes, serverless/edge handlers, CLI/queue/cron registrations. Hunt for whole
   surfaces the profile never mentions: list every directory matching common route
   conventions and diff against the profile's declared roots/rules.
3. Sample-verify concrete endpoints from each surface (mix of kinds and roots): present
   with correct normalized paths? A present-but-WRONG path (missing mount prefix,
   unexpanded parameter) is its own finding class.
4. Verdict per surface: covered / partial (share) / missing entirely, with
   source-vs-graph counts; name the single biggest hole.

## Angle 2 — entities + dbOperations

Question: how complete are ENTITIES and DB-OPERATIONS versus the repo's actual data
layer?
1. From {JSON}: entity and dbOperation counts; entity names; ops-per-entity shape; share
   of ops with no resolved entity.
2. From {PROFILE}: which entity/dbOp rules are declared, if any.
3. From SOURCE: what SHOULD a truthful extraction find — ORM models (including models
   inheriting the repo's OWN abstract bases, not just the framework's), raw SQL
   builders/executors, query-client chains, schema files, generated type tables.
   Distinguish real domain tables from demo/snippet tables in docs and examples.
   Distinguish a true DB layer from an internal REST client that merely looks like one
   (that belongs to entrypoints/externalCalls, not entities — say so if seen).
4. Verdict: is low/zero extraction (a) a PROFILE gap — the convention is matchable today
   (name the rule shape AND run a bounded probe proving the rule fires on the claimed
   file set — file-set claims are this angle's most common false premise), (b) an ENGINE
   gap (describe the missing primitive), or (c) honest — the repo genuinely lacks a
   statically-extractable data layer? Quantify the miss.

## Angle 3 — frontend surface

Question: how complete are COMPONENTS, child-render edges, route→component links, and
state stores versus source?
1. From {JSON}: component count by root; route count and the share with a resolved
   component link; state-store count and member counts (a store with zero
   actions/selectors whose source clearly declares them is a finding); share of child
   references resolving to a component id versus name-only stubs.
2. From SOURCE: approximate ground truth per root (state the heuristic; watch for idioms
   a naive grep misses — forwardRef, HOC wrappers, builder-pattern stores, descriptor
   exports instead of default exports); count SFC/other-framework files if applicable.
3. Sample-verify prominent components: present as nodes? child edges pointing at the
   RIGHT definition (check for name-collision mis-links through barrel/re-export
   packages)? Sample stores and route links the same way.
4. Check systematic droppage: whole directories with zero component nodes; components
   with empty children versus their source JSX richness.
5. Verdict per surface with resolution shares; top holes ranked.

## Angle 4 — call graph + egress

Question: how complete are the CALL GRAPH and EXTERNAL CALLS versus source?
1. From {JSON}: function/method counts per root; calls total and resolved share OVERALL
   AND PER ROOT — flag bimodality explicitly: a root at zero resolution with normal node
   density is a distinct finding (silent per-unit indexer death), not gradual decay.
   Check errors[]/stats.integrity first — the parse may already name the failure.
2. Density check: functions-per-file per root against source file counts — separate
   "nodes missing" from "edges missing".
3. Sample-verify: random exported functions from different roots exist as nodes;
   hand-picked unambiguous same-repo call sites (read the real files) have edges to the
   RIGHT callee — watch for resolution into a same-named local shadow.
4. Egress: distinct service names in the graph versus a source inventory of SDK imports
   and raw HTTP call sites; name concretely exercised SDK paths producing zero external
   calls — and before attributing to a missing registry row, check the registry
   (packages/core/src/base-parser/sdk-registry.ts): the row may exist and the miss may
   be an indirection/call-shape gap.
5. Verdict: quantified holeyness, the single worst systematic edge-loss pattern, egress
   coverage; separate provenance classes if the output records them.

## Angle 5 — packages/files integrity

Question: is the output referentially sound and is every claimed file real?
1. From {JSON}: files/packages counts versus stats self-reports (parsedFiles vs files[]
   length, skippedFiles, errors, stats.integrity); dangling references — functions with
   fileId absent from files[], methods with classId absent from classes[], entrypoints
   whose handlerId resolves to nothing (synthetic handler ids are a documented
   exception); phantom classes.
2. From SOURCE: per-language file counts (`git ls-files`) versus claimed files per
   target; whole languages/targets present in source but absent from the output.
3. Verdict: violations by class with samples; state plainly whether the output
   self-reports green while structurally broken.

## Synthesis (one agent, after all angles return)

Consolidate the angle reports into a new dated section of `graph-audit.md` next to the
profile (create if absent; never overwrite earlier sections; stamp the parsed commit).
Per finding: Tier 0 data integrity / Tier 1 recall killers / Tier 2 smaller, each
attributed PROFILE vs ENGINE with its reproduction evidence (commands + counts +
file:line samples), plus the verified "healthy lanes" section. Where two angles disagree
on a fact, re-check the fact yourself before writing it — never average contradictions.
Do not soften findings; do not fix anything.
