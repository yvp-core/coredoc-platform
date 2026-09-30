# Context-first retrieval screen

This is step 1 of the accepted [MVP spec](../../../.scratch/intent-loop-v3/mvp-context-first.md).
It compares the existing cloud task selector with and without stored anchors. It does **not**
run an agent or pass the hosted/edit/approval/release acceptance criteria.

## Inputs

- `fixture.json`: frozen dev export, captured through the supported cloud REST export/context
  APIs on 2026-09-13. 58 items (48 accepted), 23 anchors, exact payloads, versions, sources and
  feature/domain attachments. Anchor `source` is restored from exact context reads because export
  format v1 does not carry it. User identities, transition history and release ledger are excluded;
  both arms omit effectivity requests. This fixture is test setup, never agent context.
- `cases.json`: task text, file references and gold frozen before the first valid A/B request.
  Two discovery cases come from the existing (c)/scale scenarios; exact IDs are a positive control.
  Gold IDs are consumed only by the assessor. No discovery request receives a gold ID or domain.
- `heldout.json`: the independently authored 2026-09-12 Cypher-scoping task and gold from
  `.scratch/intent-loop-v3/run-heldout.md`, copied verbatim. It is a different subsystem/author in
  the same repository, not an other-repository sample. It was not used to choose the lexical fix.
  A read-validation failure on its original multiline text was repaired without changing the task.
- `remaining-corpus.json`: the original unlinked-connector task/gold (a), a new-file reporting
  extension with the two IDs routed by the accepted connector-report spec (b), unchanged (c),
  and verbatim independent held-out. The reporting extension is a context-only evaluation task,
  not proof of candidate acceptance or a shipped product feature.
- A separate immutable graph file is required. Expected graph SHA-256:
  `78e5bebb7a189e8ed874bef38add49423b3035c63ce61570a56f2636bc8621e7`.
  Graph version: `d3d25c70f60385e6af2f5a1446db872e940b83d1924a7f5eea40fef2aa58e826`;
  parsed checkout: `fea39b1ed3130f62354fd6d0b60b0ec1a5a4bf69`.
  The 69 MB snapshot is not checked into Git. Use the retained local copy from this run or obtain
  that exact published snapshot from the workspace's artifact/cache path. A newer snapshot requires
  a separate baseline; the harness refuses a hash mismatch.

## Run

The context-first A/B experiment (owner decision, spec v1.2) is cancelled; its manual runner
script under `apps/server/scripts` (which needed a gitignored 69 MB frozen graph and a
disposable Postgres) has been removed. The only reproducible part left is the frozen fixture
(`fixture.json`), exercised by the ordinary evals suite:
`pnpm --filter @coredoc/evals test -- harness/intent-context-ab.test.ts`.

## Current gate and artifact policy

The remaining corpus screen on 2026-09-13 found a repeatable counterexample: the no-ID
unlinked-connector task retrieved 3/4 critical rules without anchors on 48 accepted items and
1/4 on 3348, versus 4/4 with anchors at both sizes. The other cases passed retrieval only.
Do not interpret the earlier c-scale agent pair as a corpus-wide pass or enable cutover.
Raw evidence and the detailed verdict are retained locally in the gitignored
`.scratch/intent-loop-v3/context-first/remaining-*` outputs.

Generated JSON responses, agent evidence and run reports are ignored. The fixtures, frozen
case packs, harness/verifier scripts and accepted specs remain reviewable. Existing committed
historical run notes are source evidence for these case definitions and have not been deleted.
