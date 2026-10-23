---
size: m
status: accepted
---

# SF-005 — Agent-run fixes from the PROD-29787 rerun review

Last reviewed: 2026-10-23

Source: the owner's review of agent run `821e8dcf` (PROD-29787 rerun after SF-002/003/004, 2026-10-23) and GitHub issues #47–#53. Decisions taken by the owner on 2026-10-23:

- the runner takes the scope's spec file as the proposal's specification;
- the final implement turn's commit is named after the accepted scope;
- "complete with untested criteria" is fixed in the day.io implement skill, not in the platform.

## Verified current state

- **Spec handoff (#47).** The scope prompt has the agent write `<work>/spec.md`, then call `propose_scope` "with that specification" (`apps/agent-runner/src/claude/prompts.ts`, `scopePrompt`). The handler forwards `specMarkdown` unchanged (`run-control.ts`, `proposeScope`). The server checks only its size (`cloud-agent-run-scope.service.ts`, `validate`) and stores it as the version's markdown. The implement turn writes `SPEC.md` from `acceptedSpec.markdown` (`claude-executor.ts`, `implementTurn`). The scratch volume is wiped between turns (`turn-paths.ts`, `wipeScratch`), so the scope's `spec.md` never reaches implement. In the rerun the agent sent `"See /scratch/runs/<run>/work/spec.md … Key points"` (2.8 KB) for a 193-line spec. The reviewer approved that summary, and implement never saw the acceptance table or the endpoint contract.
- **Base-branch candidates (#48).** `validate` enforces seeds only (`run.seeds`). Candidates are computed by the runner (`listBaseCandidates`, `git/branch-scan.ts`) and listed in the scope prompt; the server never sees them. In the rerun (no seeds, six candidates) the agent left out `day-packages`, the gateway the change needed, on the strength of a Jira sentence, and the review page showed no trace of it.
- **Run control from subagents (#49).** The `agent_run` MCP server is visible to every subagent. In the rerun a Haiku scout called `request_repo`; the hook then ended the parent's turn before any code was written. The runner's `PreToolUse` hook sees every call. Claude Agent SDK 0.3.285 sets `agent_id` on hook input only when the call comes from a subagent (`BaseHookInput.agent_id`).
- **Reading repositories in implement (#50).** The server sends `branchScan` only to scope turns (`cloud-agent-turn.service.ts`, `withRunChecks`; implement and delivery assert `branchScan: null`). `read_repo` is registered only when `control.readRepository` is set (`run-control.ts`). `repositoryReader` clones under `<work>/read/`. `TurnGit.publish` commits and pushes only the run's clones.
- **Resumed implement turn (#51).** `TurnGit.prepare` removes and re-clones every repository each turn (`git/turn-git.ts`). `resumeInput` (`claude-executor.ts`) says only "Continue where you stopped." In the rerun the resumed session ran Jest against a tree without `node_modules`.
- **Turn commits (#52).** Every turn commits `wip(<KEY>): turn <ordinal>` (`turn-git.ts`, `publish`). The ordinal counts scope turns too. `CloudAgentRunSpecVersion.title` exists (VarChar 200) but is not in `acceptedSpec`.
- **Untested results (#53).** `notBuiltOrTested` already reaches the PR body (`pull-request-body.ts`) and the run page (`agent-run-page.ts`, `resultPoints`). The rerun filled it, and still submitted `complete`. → day.io skill change, below.
- **Runner plugin (day-ai-plugin).** The day.io runner image extends `ghcr.io/yvp-core/coredoc-agent-runner`, whose `/opt/coredoc-workflows` is the OSS plugin at a pinned commit (`apps/agent-runner/Dockerfile`, plugin stage). The day.io manifest points at that path, so the day.io fork (`plugins/coredoc-workflows`, `0.11.1-dayio.33`) never ran in the runner. The fork's `plugin.json` declares OAuth MCP servers `coredoc` (the day.io workspace URL) and `figma`; the runner supplies its own `coredoc` server.

## Scope

**In (coredoc-platform):**
1. `propose_scope` uses `<work>/spec.md` when it exists.
2. `propose_scope` requires every base-branch candidate repository in `repositories` or `droppedSeeds`.
3. Run-control tools are refused from subagents.
4. `read_repo` in implement turns.
5. The resumed implement prompt says the clones are fresh.
6. The commit of the turn that recorded a result is named after the accepted scope.

**In (day-ai-plugin):**
7. The runner image ships the fork without its `mcpServers`, and the manifest uses it.
8. The implement skill's rule on untested criteria.

**Non-goals:**
- the code defects of oitchau-requests PR #653;
- the upstream plugin routing agent-run implement as `change:large`;
- server-side knowledge of candidates;
- squashing turn commits;
- a dependency cache across turns;
- Jira wording.

## Contracts

- **`propose_scope` (runner).** The file is the specification.
  - When `<work>/spec.md` exists and is non-empty, its content replaces `specMarkdown` before the server call, and the success text tells the agent the file was used.
  - When the file is absent or empty, the call is refused without calling the server: "Write the full specification to <path>, then call propose_scope again." This also covers a resumed scope turn, whose scratch was wiped: the agent writes the file again.
- **Candidates (runner).** The handler refuses, without calling the server, when a key from the turn's candidate listings is missing from both `repositories[].key` and `droppedSeeds[].key`: "Base-branch candidate repository "<key>" must be included or listed in droppedSeeds with a reason." The scope prompt's step 3 says "Every seed repository and every base-branch candidate repository …".
  - LIM-1: a resumed scope session (a scope change request) gets no listings, because the scan is skipped on resume, so its re-proposal is not checked. The first proposal was.
- **Subagents (runner).** In the `PreToolUse` hook, a call to `mcp__agent_run__*` with `agent_id` set is denied: "Only the main agent may call run-control tools; return what you need to the main agent." This is checked before the wind-down refusal, so a subagent's call never ends the turn. The preamble's run-control section says the same.
- **Protocol.** `TurnAssignmentSchema.branchScan` comment: scope and implement turns. `acceptedSpec.title: z.string().nullable().default(null)`, so an older server still parses.
- **Server.** Implement turns get `branchScan` built like scope's, with `maxReads` the run's repository cap. Delivery keeps `null`. `acceptedSpec` returns `title`.
- **`read_repo` in implement (runner).** Registered when `turn.branchScan` is set; same reader, under `<work>/read/`, never pushed. The preamble's implement section lists it as read-only reference reading, beside `request_repo` for repositories the change must modify.
- **Resume (runner).** `resumeInput` for implement appends: "The repositories were cloned again from the pushed run branch: dependencies, build output and files outside the repositories are gone, so set the repositories up again before running anything."
- **Commit (runner).** When `control.submitted`, the turn's commit is `<KEY>: <acceptedSpec.title>` (falling back to `wip(<KEY>): turn <n>` without a title) with the trailer. Other turns keep `wip(...)`.
- **day-ai-plugin image.** `services/agent-runner/Dockerfile` gains a stage that:
  - copies the named build context `coredoc-workflows` (`plugins/coredoc-workflows`);
  - removes `node_modules`, `test` and non-linux Bun runtimes;
  - verifies the linux-x64 Bun against `runtime/bun/provenance.json`, like upstream;
  - deletes `mcpServers` from `.claude-plugin/plugin.json`;
  - installs the result root-owned at `/opt/dayio/plugins/coredoc-workflows`.

  `manifest.json` points there, and `COREDOC_WORKFLOWS_PLUGIN_PATH` follows. `pull-coredoc.yml` passes `--build-context coredoc-workflows=plugins/coredoc-workflows`.
- **day-agent-run implement skill.** A criterion whose only proof is a test that did not run in the runner is unmet: list it in `unmetCriteria` and submit `partial`. Plugin version bump.

## Acceptance

| ID | Pass/fail outcome | Observer / validation |
| --- | --- | --- |
| AC-1 | A scope proposal whose `specMarkdown` is a pointer is stored with the full `spec.md` content. Without the file, the call is refused and the server is not called. | `claude-executor.test.ts` scope tests (fake SDK writes `spec.md`, assert the proposal the fake API received) |
| AC-2 | A proposal omitting a candidate repository is refused with the candidate message, and the server is not called. One listing it in `droppedSeeds` passes. | Same suite, scope with a branch scan |
| AC-3 | `request_repo`, `submit_result` and `propose_scope` called with `agent_id` are denied, the turn does not end, and the main session's call still works. | `claude-executor.test.ts` hook tests |
| AC-4 | An implement assignment carries `branchScan`, `read_repo` clones under `<work>/read`, and nothing from it is pushed. | `cloud-agent-runs-implement.postgres.integration.test.ts`; `implement-turn.test.ts` |
| AC-5 | A resumed implement session's input names the re-clone. | `implement-turn.test.ts` resume case |
| AC-6 | The turn that recorded a result commits `<KEY>: <title>`; a turn without a result keeps `wip(<KEY>): turn <n>`. | `implement-turn.test.ts` (existing commit-message assertion) |
| AC-7 | The day.io image lists exactly one `coredoc-workflows` plugin, at the fork's path, with no `mcpServers`, and the runner start-up check passes. | Local `docker build` with the build context, then `docker run … cat`/`node -e` on plugin.json and manifest; a person runs the image's start-up check |

**How a check could pass while behaviour is broken:**
- AC-1 passes if the handler reads the file but the server still receives the argument. Assert on what the fake server received.
- AC-3 passes if the deny path also winds the turn down. Assert that the next main-session call succeeds.

## Implementation plan

| Step | Change boundary | Traces to |
| --- | --- | --- |
| 1 | `packages/core/src/agent-runner/protocol.ts`: `acceptedSpec.title`, `branchScan` comment | AC-4, AC-6 |
| 2 | Server `cloud-agent-turn.service.ts` (implement `branchScan`), `cloud-agent-run-implement.service.ts` (`title`), implement integration test | AC-4, AC-6 |
| 3 | Runner `run-control.ts`: `specPath` + candidate keys in state, both checks in `propose_scope`, `read_repo` in implement | AC-1, AC-2, AC-4 |
| 4 | Runner `claude-executor.ts`: subagent deny in the hook, `readRepository` + `specPath` + candidates wiring, `resumeInput`, submitted flag to `publish` | AC-1–AC-6 |
| 5 | Runner `turn-git.ts`: commit subject from title when submitted | AC-6 |
| 6 | Runner `prompts.ts`: step 3 candidates, run-control section (subagents, `read_repo` in implement) | AC-2, AC-3, AC-4 |
| 7 | day-ai-plugin: Dockerfile stage, `manifest.json`, `pull-coredoc.yml`, implement skill + version | AC-7 |

**Validation:** `pnpm --filter @coredoc/agent-runner test` and `typecheck`; the server's agent-run integration suites (Postgres) for steps 1–2; `pnpm --filter @coredoc/core typecheck`; `pnpm check`. For day-ai-plugin, a local `docker build` of the runner image against `ghcr.io/yvp-core/coredoc-agent-runner:1.8.5`.

**Reachable failure modes:**
- **`spec.md` not written before the call:** refused, the agent writes it and calls again.
- **An older server without `title`:** `wip` subject.
- **An older runner on a newer server:** it ignores implement `branchScan` and `title`.
- **The fork's Bun hash mismatch:** the image build fails.

**Rollout/rollback:**
- Release the platform as a new server/runner version. Bump `V` in `pull-coredoc.yml` after merging day-ai-plugin, then run the mirror workflow.
- Rollback is the previous `V`. The manifest change rolls back with the image.

## Unresolved decisions

NO UNRESOLVED DECISIONS.
