# Agents — Coredoc

Last reviewed: 2026-09-22

Canonical contributor and agent instructions for **building Coredoc**. These rules
apply to every coding agent, including Claude Code and Codex.

## Working default

Coredoc is a startup. Deliver the smallest understandable change that solves the
requested problem on the supported path. Imperfect but clear code is acceptable;
unnecessary machinery and code whose purpose is unclear are not.

1. **Read an analogue first.** Before implementing, find and read the closest existing
   feature, provider, endpoint, component, or test. Follow its package boundaries,
   naming, error handling, and test style. For a new language, start with an existing
   language provider and substrate, not a new pipeline.
2. **Choose the direct solution.** Cover the requested behavior and realistic failures
   in that path. Do not implement every conceivable edge case, future consumer, or
   deployment model. Small local duplication is preferable to a premature abstraction.
3. **Keep the size proportional.** Before a substantial change, briefly name the
   intended outcome, likely files, and decisive validation. If a small task starts
   needing a new subsystem or changes across many layers, reconsider the simpler
   option before writing more. There is no line-count quota to game.
4. **Ask before departing from an established design.** If the existing pattern cannot
   meet the requirement, show the concrete limitation and propose the smallest
   alternative. Do not silently replace the architecture because another style seems
   better. An already approved departure needs no second approval.
5. **Stop when the task is solved.** Report the result, relevant checks, and material
   gaps. Do not keep adding hardening, abstractions, or cleanup after validation passes.

## Reference docs

Use these as references, not a ritual to repeat before every edit:

- [CLAUDE.md](CLAUDE.md) — development commands and repository orientation.
- [DoD.md](DoD.md) — completion and validation appropriate to the change.
- [GUARDRAILS.md](GUARDRAILS.md) — a short list of concrete boundaries.
- [ARCHITECTURE.md](ARCHITECTURE.md) — current ownership and data flow; read the relevant
  section before changing a package boundary or adding a new implementation.
- For desktop visual work, read [DESIGN.md](DESIGN.md) and
  [docs/agents/design-system.md](docs/agents/design-system.md). Reuse shipped components
  and tokens; check the relevant Figma frame for layout facts. The Figma library mirrors
  code and is not an independent source. Run `design:check` and inspect the real app.

For a trivial edit, the local code and relevant rule are enough. Re-read only what
is missing from context or has changed. No checklist recitation or separate plan
artifact is required for routine work.

## Comments

**Default to no new comments.** Use clear names and straightforward code.

- Add a short comment only when a reader would otherwise misunderstand a
  counterintuitive choice, an external constraint, or a necessary workaround.
- Do not narrate code, add section banners, generate JSDoc for self-explanatory
  functions, or leave implementation diaries, task IDs, and speculative TODOs.
- Product rationale belongs in accepted intent or an ADR. Reference it briefly only
  where the code needs that context; do not copy it into every implementation file.
- Remove comments made stale by your change. Do not sweep unrelated files for cleanup.

## Simplicity bar

- Every added mechanism needs a current requirement or observed failure and a named
  user, caller, or operator who benefits. A hypothetical future caller is not enough.
- No new permission frameworks, granular roles, sandbox layers, caches, queues,
  locks, retry systems, compatibility layers, or configuration flags unless the task
  or a demonstrated failure requires them. Preserve existing contracts without
  expanding them by default.
- Prefer an ordinary retry, rebuild, clear unsupported-case error, or documented
  limitation when it solves the actual problem. Acceptable parse latency alone is
  not a reason to introduce caching or coordination machinery.
- Parsing and enhanced indexing are for trusted repositories and trusted branches.
  Do not assume a requirement to safely execute arbitrary hostile repositories.
  Preserve existing cloud isolation, credential protection, and source-stripping.
- Keep functions and modules focused and readable. Split along an existing
  responsibility when needed; do not create giant catch-all files or fragment a
  short linear flow into a framework of one-use helpers.
- If removing apparently overbuilt code could change supported behavior, raise that
  specific tradeoff. Do not silently delete a contract or keep needless machinery
  merely because it already exists.

## Scope and execution

Read source, tests, docs, and public config needed for the task. Write only required
paths; preserve unrelated changes. Update the lockfile only when dependencies change.
Use repository commands and ordinary local tooling. Secrets, unrelated repositories,
production data, and destructive Git operations are outside routine task scope.

Before editing shared contracts (`@coredoc/core` types, `OutputFormat`/`ParsedRepo`,
`ExtractionProfile`, MCP signatures, REST routes), inspect callers and consumers.
Use Coredoc impact tools when this repo is indexed, then verify critical consumers
in source; otherwise inspect them manually. Update affected consumers together.
A graph risk label is a discovery hint, not an automatic approval gate.

Proceed with authorized, reversible implementation and validation. Ask only for a
missing decision that changes behavior or scope, an unapproved architecture departure,
or a destructive/external action beyond the request. Do not ask again for a decision
the maintainer already made. See [GUARDRAILS.md](GUARDRAILS.md).

## Review policy

- Judge against actual supported paths, deployment, users, and accepted limitations.
  Record release context only where it changes a finding, not as boilerplate.
- P0/P1 needs a reachable path, realistic trigger, named observer, observable wrong
  outcome, violated requirement, and no accepted mitigation. Missing tests or
  imagined failure modes alone are not blockers. P2 defects and P3 refactors are
  nonblocking and need maintainer opt-in before expanding implementation scope.
- One root cause is one finding. Severity and disposition are separate; use `fixed`,
  `accepted-risk`, `deferred`, or `rejected`. A blocker is not closed merely by
  labelling it deferred. Ask one concrete question for a proven issue whose impact
  depends on missing release context (`NEEDS_CONTEXT`).
- Routine changes need a focused self-check. Specialist or independent agent reviews
  are not automatic. When a full release review is requested, use at most one primary
  and one independent full pass per material tree; extra specialists need a concrete risk.
- For that cross-session release review, keep the visible handoff in the PR description
  or a maintainer-named review file: base/head,
  clean/dirty state (and patch/untracked-file fingerprint if dirty), checks, findings,
  dispositions, and passes used. It becomes accepted review state only after maintainer
  acceptance. Do not create a ledger or handoff file for every small change.
- Targeted factual verification is always allowed. New evidence that disproves a
  recorded premise reopens the affected finding; otherwise do not repeat completed
  full reviews. Finish once relevant checks pass and no unresolved blocker remains;
  a requested release review also needs maintainer acceptance of its handoff.

## Validation routine

Use [DoD § 4](DoD.md#4-validation-baseline). Code changes need relevant tests and
typecheck; shared core contract changes need `pnpm typecheck && pnpm test` across
consumers. Docs-only changes use content and link checks. Report what actually ran,
including relevant failures or checks that could not run. Do not add tests that
only mirror implementation details or enforce the shape of this diff.
