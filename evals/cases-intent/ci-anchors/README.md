# CI anchor evaluation inputs

This directory contains frozen source projections, not generated run outputs. The runtime
prototype is isolated under `evals/harness/intent-ci-anchors`; production does not import it.

`pr112.json` records the real GitHub PR's base/head/merge identity, capture time, body hash
and exact Delivers/Retires lines. The full body is kept only in local evidence. T1a is explicitly
a counterfactual singleton of this multi-item PR. No historical body or synthetic PR is implied.
The authoritative graph/items/tasks remain in `../context-first`; no gold target list is given
to the touchpoint selector. [IA-01 result](../../../.scratch/intent-ci-anchors/ia-01-result.md).

The context-first A/B experiment this baseline was screened through (owner decision, spec v1.2)
is cancelled; its manual runner script under `apps/server/scripts` (which needed a gitignored
69 MB frozen graph and a disposable Postgres) has been removed. The only reproducible part left
is the frozen fixture (`../context-first/fixture.json`), exercised by the ordinary evals suite:
`pnpm --filter @coredoc/evals test -- harness/intent-context-ab.test.ts`.

Preparation checks graph and fixture hashes, computes a Git diff whose new side matches the
snapshot commit, uses real graph node/range/versioned IDs, and emits exclusions. Final-head
PR metadata and historical graph prefix are both retained. File/symbol variants do not share
ranking changes. The raw output includes per-case query counts, bytes, elapsed time, returned
IDs, graph/source hashes and full responses; neither bytes nor cumulative provider usage should
be called unique tokens.

The optional `INTENT_CONTEXT_AB_ANCHOR_VARIANT` changes only B's anchor rows. Without it the
original A/B remains curated versus no anchors. New CI rows must refer to accepted fixture
items; preserved manual rows must exactly match the frozen fixture (including historic
superseded/rejected anchors). This guard is not a replacement for production authorization.

Generated variants, hunks, logs and reports go to already ignored
`.scratch/intent-loop-v3/context-first/remaining-ci-anchors-*` paths. Keep compact findings in
`.scratch/intent-ci-anchors`, and freeze any future input before running/tuning T2.
