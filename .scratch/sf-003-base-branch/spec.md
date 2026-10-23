# SF-003 — Base branch per repository

Status: accepted. Size: l.

Last reviewed: 2026-10-23

Source: the PROD-29787 pilot. The story depended on an epic whose work was
merged only into `feat/PROD-29013-absence-policies`. The agent built on
`master`/`main` and opened its pull requests there, because no part of a run
knows any branch but the default. Decisions taken by the workspace owner on
2026-10-23:

- **D1.** The agent chooses each repository's base from candidates the platform finds, and the reviewer sees it at scope acceptance.
- **D2.** The scope agent can read code on a candidate base through read-only clones.
- **D3.** A wrong base is corrected through "request changes"; there is no base picker in the UI.

## Verified current state

**Where the default branch is fixed today:**

| Step | Code | Behaviour |
| --- | --- | --- |
| Scope assignment | `apps/server/src/modules/cloud-agent-runs/cloud-agent-run-implement.service.ts:90` | Seeds only, for the bot check |
| Clone and run branch | `apps/agent-runner/src/git/turn-git.ts:101–127` | `checkout -b <run>` from `origin/HEAD`, or the existing run branch |
| Secret scan before push | `turn-git.ts:183` | Compared against `clone.defaultBranch` |
| Draft pull request | `apps/agent-runner/src/delivery/deliver.ts:53` | `base = github.defaultBranch(...)` |
| Server check of a reported PR | `cloud-agent-run-delivery.service.ts:197` | Rejects a PR whose base is not the default branch |
| "Repository unchanged" check | `cloud-agent-run-delivery.service.ts:227–233` | Compares the run branch against the default branch |

**Related facts:**
- `ProposeScopeRequestSchema.repositories` (`packages/core/src/agent-runner/protocol.ts`) has no base. Nor do `SpecRepository`, `RunRepository` (`cloud-agent-run-scope.service.ts:24, 47`) or `AssignedRepository`.
- `CloudAgentRunScopeService.validate` (`:79`) is synchronous and makes no GitHub call.
- `CloudAgentRunIssueReader.readPrd` already resolves a story's parent epic.
- The scope turn has no clones and never publishes (`claude-executor.ts`, `scopeTurn`). The agent may not run network git (`claude/prompts.ts`, preamble).
- The scope review renders `spec.repositories` in merge order (`apps/web/src/features/agent-runs/ScopeReview.tsx:42`).

## Scope

**In:**
- Base-branch candidates in the scope prompt.
- `read_repo` in the scope phase.
- `baseBranch` on proposals, persisted per run repository and shown at review.
- Run branches created from the base, the secret scan compared against it, PRs opened into it, and the server's PR and "unchanged" checks against it.
- The day.io scope skill update.

**Non-goals:**
- Merging later base commits into an existing run branch.
- A base picker in the UI.
- Graph indexing of non-default branches.
- Candidates for issues without a parent epic (they keep the default branch unless the agent names one).
- Changing the base of a repository added later through `request_repo` (it uses its default branch).

## Contracts

### Scope assignment (server → runner)

`TurnAssignment` gains `branchScan: { epicKey: string | null; repositories: Array<{ key, cloneUrl }> } | null`.
- It is sent on scope turns only.
- It holds every eligible workspace repository (the same eligibility `validate` uses) and the parent epic's key from `readPrd`.
- It defaults to `null`, so an older server's assignment still parses.

### Candidates (runner)

- Before a scope session, when `epicKey` is set, the runner runs `git ls-remote --symref <cloneUrl> HEAD 'refs/heads/*'` with the bot credential for each repository. One call gives the default branch and all heads. These run at most 8 at a time, with 20 s per repository.
- It keeps the head names that contain `epicKey` (case-insensitive) and the default branch.
- The scope prompt gets a **Base-branch candidates** section: one line per repository that has at least one matching branch, plus one sentence saying every other repository has only its default branch.
- A repository whose listing fails is named as unchecked. It never fails the turn.

### `read_repo` (scope run-control tool)

- `read_repo({ key, branch? })` makes a shallow, single-branch clone (`--depth 1 --branch <branch>`, default branch when omitted) into `work/read/<key>` and answers with the path.
- **Refusals:**
  - a key outside `branchScan.repositories`;
  - more than the run's `maxRepositories` distinct clones in one turn;
  - a branch the clone cannot find.
- Nothing from the scope phase is ever pushed. The scratch directory is wiped at turn end, as today.
- The bot-permission check is not needed for reading. The implement phase keeps its check.

### Branch names reaching git

- Every branch name from the agent (`read_repo.branch`, `baseBranch`) must pass `git check-ref-format --branch` and must not start with `-`. The check runs in the server for proposals and in the runner before any git call.
- Git always receives the name as the argument of `--branch`, or inside `origin/<name>`, after `--`, never as a bare argument.

### Proposal and persistence

- `ProposeScopeRequestSchema.repositories[].baseBranch?: string`, at most 255 characters.
  - Absent means the default branch.
  - The value is never the run's own branch.
- Before saving a proposal, the server checks each named base with the GitHub connector (`GET /repos/{o}/{r}/branches/{b}`). A missing branch is returned to the agent as a rule error.
- `SpecRepository.baseBranch` and `RunRepository.baseBranch` are `string | null`, carried when the spec is accepted.
- `AssignedRepository.baseBranch: string | null` defaults to `null`.

### Implement and delivery

- **Runner `TurnGit.prepare`.** When the run branch does not exist on the remote, it checks out `-b <run>` from `origin/<baseBranch ?? default>`. An existing run branch continues as today.
- **Secret scan.** The outbound range starts from `origin/<baseBranch ?? default>`.
- **Delivery.** `deliver` opens the draft pull request into `baseBranch ?? default`.
- **Server delivery check.** A reported pull request must have `base.ref === baseBranch ?? default_branch`. The "unchanged" comparison uses the same base.

### Prompt and review

- The scope prompt asks for a base per repository, with the reason (the unmerged dependency), whenever it is not the default.
- The run's notes (SF-004) come first as a source.
- The scope review shows each repository's base, or "default branch".

### day-ai-plugin

The `day-agent-run:scope` skill §3 changes:
- take the base from the notes, else from the candidates;
- read the code on it with `read_repo` before stating anything about it;
- put `baseBranch` and the reason in `propose_scope`.

## Acceptance

| ID | Pass/fail outcome | Observer / validation |
| --- | --- | --- |
| AC-1 | A scope assignment for a story under an epic carries `branchScan` with the epic key and the eligible repositories. A story without an epic carries `epicKey: null`. Implement and delivery assignments carry `null`. | Scope integration suite (claim) |
| AC-2 | Given remotes with `feat/PROJ-1-exports` and unrelated branches, the scope prompt lists that branch for its repository, plus the default branch. A repository whose listing fails is named as unchecked, and the turn proceeds. | Runner test with bare remotes (`implement.test-support` style) |
| AC-3 | `read_repo` clones the named branch shallowly and returns its path. An unknown key, a missing branch, a clone over the cap, and a branch such as `--upload-pack=x` or `a..b` are refused as tool errors. | Runner scope test with bare remotes |
| AC-4 | A proposal naming a base that GitHub does not have, or an invalid branch name, is refused with a rule error naming the repository and branch. An existing base is stored, shown in the spec, and carried into the run's repositories on acceptance. | Scope integration suite with the fake GitHub |
| AC-5 | An implement turn on a repository with `baseBranch` creates the run branch from that base: its parent is the base's head, not the default branch's. The secret scan's range starts at the base. An existing run branch is reused. | `implement-turn.test.ts` with a bare remote holding both branches |
| AC-6 | Delivery opens the draft pull request into the base. The server accepts a pull request whose base is the recorded base and rejects one into the default branch. A repository without a base behaves as today. | `delivery-turn.test.ts`; delivery integration suite |
| AC-7 | The scope review shows `feat/PROJ-1-exports` for a repository with a base, and "default branch" for one without. | Web test beside `ScopeReview` |
| AC-8 | Rerunning PROD-29787 with notes naming the base, and once without notes, gives a spec, a run branch and pull requests on `feat/PROD-29013-absence-policies` in `oitchau-requests`. | Pilot rerun |

How a check could pass while behaviour is broken:
- AC-5 passes if the test only checks the branch name. Assert the parent commit equals the base's head.
- AC-6 passes if the fake GitHub accepts any base. Assert the base sent to the PR call, and test the server's rejection of the default branch when a base was recorded.

## Implementation plan

| Step | Change boundary | Traces to | Depends on |
| --- | --- | --- | --- |
| 1 | Core protocol: `branchScan`, `repositories[].baseBranch` on proposals, `AssignedRepository.baseBranch` | all | — |
| 2 | Server: `branchScan` on scope claims (eligibility plus the epic key from `readPrd`) | AC-1 | 1 |
| 3 | Server: base check on proposals through the GitHub connector (`GithubClient.getBranch`); `baseBranch` through `SpecRepository` → `RunRepository` → `AssignedRepository` | AC-4 | 1 |
| 4 | Server: the delivery check and the "unchanged" compare use the recorded base | AC-6 | 3 |
| 5 | Runner: `ls-remote` candidates and the scope prompt section | AC-2 | 1 |
| 6 | Runner: `read_repo` scope tool | AC-3 | 1 |
| 7 | Runner: `TurnGit.prepare`, the scan base, and the `deliver` base | AC-5, AC-6 | 1 |
| 8 | Web: base in the scope review | AC-7 | 3 |
| 9 | Docs `AGENT-RUNS.md`; day-ai-plugin scope skill | AC-8 | 2–7 |

**Validation:**
- The suites named above.
- `pnpm typecheck`, `pnpm test`, the agent-runs Postgres suites, and Biome on the changed files.
- The pilot rerun (AC-8) after the release.

**Reachable failure modes:**

| Failure | Handling | What people see |
| --- | --- | --- |
| `ls-remote` fails | That repository is unchecked | The prompt says so |
| The base is deleted after acceptance, before the run branch exists | Clone/checkout fails | `github_error` with the branch named |
| The base is deleted after PRs exist | GitHub may retarget the PR to the default branch; the server check requires the recorded base | `delivery_failed` with the reason |
| `read_repo` is over the cap | Tool error | The agent continues |

**Rollout/rollback:**
- Server, runner and core release together, and the runner must be upgraded with the server.
  - **A new server with an older runner:** a recorded `baseBranch` is dropped by the older runner. It builds on the default branch and opens the PR there, and the new server's check then fails delivery (`delivery_failed`) after the implement phase.
  - **An older server with a new runner:** behaves as today. The older server drops `baseBranch` from proposals, so it never reaches the run.
  - Every new field defaults to `null`.
- Ship the day.io scope skill update with the image built on that release.
- Rollback = the previous images. Stored `baseBranch` values are ignored by old code.

## Unresolved decisions

NO UNRESOLVED DECISIONS.
