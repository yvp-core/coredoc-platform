# Definition of Done — Coredoc

Last reviewed: 2026-09-22

A change is done when the requested behavior works, the implementation is
understandable, and relevant validation supports it. Coredoc is a startup:
this file is not a requirement to make each change enterprise-ready.
Apply only the sections the change touches. Do not report a list of “N/A” items.

## 1. Scope and Intent

Solve the current task on its supported path. Preserve unrelated work and
existing contracts. A documented limitation, ordinary rebuild, or slower parse
can be the right tradeoff. Hypothetical scale, hostile-repository support, and
future integrations do not expand the task by themselves.

## 2. Core Definition of Done

- **Behavior:** the real caller reaches the implementation and gets the requested
  result. Handle realistic failures in that path; do not add unreachable guards.
- **Architecture:** read the nearest analogue first and follow its boundaries and
  conventions. Check consumers before changing a shared contract and update them
  together. Agree a necessary architecture departure before implementing it.
- **Readability:** prefer a direct flow, clear names, and focused modules. No
  speculative abstractions, giant catch-all files, or unrelated cleanup. Comments
  are exceptional explanations of non-obvious constraints, not narration.
- **Data and safety:** preserve the applicable boundaries in
  [GUARDRAILS.md](GUARDRAILS.md). For persisted-data changes, name the migration or
  approved cutover; disposable data can use an approved reseed instead of rolling
  compatibility. Do not build a new safety subsystem for an assumed requirement.
- **Performance:** avoid obvious regressions and resource leaks on realistic inputs.
  Add caches, parallelism, or coordination only for a demonstrated need; acceptable
  latency does not need an optimization project.
- **Evidence:** use a check that can reveal a failure of the changed behavior.
  Add a regression test when it gives useful coverage; do not add tests merely to
  restate code, count files, or prove deleted private helpers remain absent.
- **Communication:** update affected user help/docs and state material limitations.
  Existing actionable errors are usually enough; new telemetry is not a default
  requirement. A plain revert is enough rollback planning for a reversible edit.

## 3. Agent-Assisted Workflow

Follow [AGENTS.md](AGENTS.md): minimal scope, existing patterns, sparse comments,
and no speculative hardening. Use source to check facts that prose may have
outlived. Routine work needs a brief result and validation report, not a separate
specification, approval ceremony, or release-review artifact.

For a requested full review, use [the review policy](AGENTS.md#review-policy).
Missing coverage or an imaginable failure is not itself a release blocker.

## 4. Validation Baseline

Choose the smallest decisive check first, then the gates needed by the changed
contract. Do not install a runtime or run the whole monorepo just to validate prose.

| Changed area | Required evidence |
| --- | --- |
| Documentation/content only | Check facts, relative links, command examples against their definitions, and `git diff --check`. Run a relevant docs checker if one exists; no runtime tests/typecheck for prose alone. |
| One package's code | Relevant existing tests (plus a focused regression test where needed), package typecheck, and Biome on touched supported files. |
| Shared `@coredoc/core` types or cross-package contracts | Inspect and update consumers; run `pnpm typecheck`, `pnpm test`, and `pnpm check`. |
| Extraction/profile behavior | Relevant parser tests and a representative profile/fixture through the real extraction path; check emitted output with the existing output validator. `pnpm cli validate` validates configuration, not parsed output. |
| Server runtime | Relevant tests and `pnpm server:build`; exercise a real test database when DB queries/schema behavior changed. Include a migration if persisted schema requires one. |
| Desktop behavior/UI | Relevant tests/typecheck and exercise the real Electron path when IPC/preload/session behavior matters. For visual changes, run `pnpm --filter @coredoc/desktop design:check` and inspect the running app. |
| Config, dependencies, build, CI or release | Owning validator/build/dry run or triggered CI job; verify affected consumers. State any required remote check that remains unrun. |

Typical package commands are `pnpm --filter @coredoc/<pkg> test` and
`pnpm --filter @coredoc/<pkg> typecheck`. `pnpm build` builds in dependency order
when outputs are needed. `pnpm check` is non-mutating; apply fixes only to scoped
files. Once relevant checks pass, repeat or broaden them only for a new change,
failure, or unresolved concern. Report failures and unavailable checks honestly;
do not weaken assertions or claim unrelated green tests validate this change.

## 5. Review Gates

Before handing off, check: does it work on the real path, follow the existing
architecture, preserve affected contracts, remain understandable, and stay within
scope? Is there useful evidence for the changed behavior and no known material
regression? Remove unnecessary code and comments introduced by the change.

The report can be a few sentences: what changed, what verified it, and any gap
that matters. Do not append this checklist to every response or PR.
