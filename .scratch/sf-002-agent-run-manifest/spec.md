# SF-002 — Agent-run manifest, entry skills, Jira read, and honest results

Status: accepted. Size: l.

Last reviewed: 2026-10-23

Source: the PROD-29787 pilot run (`afc390e4…`, 2026-10-22) and its session
traces, compared against an independently written specification of the same
story. Decisions by the workspace owner on 2026-10-22/23 are recorded under
**Decisions**. Base-branch selection per repository is a separate follow-up
(SF-003).

## Problem

In the pilot run, both agent turns finished in under two minutes and used $0.96
of a $25 budget. The implement turn submitted a self-declared "partial
implementation" covering about 3 of the story's 16 acceptance criteria, and the
run still ended `done` with "Coredoc agent run finished" on Jira. The traces show
five causes this spec addresses:

1. **The implement turn never saw the PRD.** The server sends `prd` only to scope
   turns (`apps/server/src/modules/cloud-agent-runs/cloud-agent-turn.service.ts:194–206`;
   implement gets `prd: null`, `:302`). The runner writes `PRD.md` only in
   `scopeTurn` (`apps/agent-runner/src/claude/claude-executor.ts:270`). The agent
   saw a 4 KB scope summary instead of the PRD's acceptance table and fixtures.
2. **A partial result counts as success.** `SubmitResult`
   (`packages/core/src/agent-runner/protocol.ts:444`) has no completeness field.
   `settleResult` (`cloud-agent-run-implement.service.ts:236`) fails a run only
   on `NoChanges`; everything else is delivered and marked done
   (`cloud-agent-run-jira-outcomes.service.ts:448`, `jira-comments.ts:53`).
3. **Skills are offered, never used.** Both sessions listed the
   `coredoc-workflows` skills, and neither invoked one, although the prompts say
   to "run the coredoc-workflows … route" (`claude/prompts.ts:46, 77`). Nothing
   checks this.
4. **No deployment-level control.** The runner loads exactly one plugin from
   `COREDOC_WORKFLOWS_PLUGIN_PATH` (`apps/agent-runner/src/main.ts:50`,
   `claude-executor.ts:502`). The model is one workspace setting for every phase
   (`cloud-agent-run-settings.service.ts:33`, `claude-executor.ts:489`). A
   customer cannot add its own skills or pick a model per phase.
5. **The agent cannot read Jira.** `strictMcpConfig` exposes only `agent_run` and
   `coredoc` (`claude-executor.ts:475–485`). The scope agent could not open the
   epic or the sibling stories, so it never learned the dependencies were on an
   epic branch.

The agent also said "the private npm registry is not reachable" without trying
an install. The runner sets up the registry from `COREDOC_PACKAGE_REGISTRIES`
(`package-registries.ts`); the trace has no `npm ci`.

## Decisions

| ID | Decision | Alternatives rejected |
| --- | --- | --- |
| D1 | Configuration comes from a manifest file baked into the deployer's runner image. Without the file, a built-in default reproduces today's behaviour. With it, the file overrides the defaults. | Environment variables per setting; a server-side settings page |
| D2 | Model precedence: the manifest's per-phase model, then the workspace setting, then the SDK default. | Workspace setting first |
| D3 | Jira access is server-side tools reusing the workspace's Jira connector, bounded to its `projectKeys`. No Jira credential reaches the runner. | The Atlassian remote MCP configured in the manifest |
| D4 | A `partial` or `blocked` result still delivers draft pull requests, then the run ends `failed` with code `incomplete_result`. The unmet criteria are the run's failure reason on the run page; the Jira failure comment carries the fixed `incomplete_result` message and the pull requests, because agent text never goes to Jira (implementation finding, 2026-10-23). | Fail before delivery; end `done` with a flag |

## Scope

**In:**
- Manifest schema, built-in default, loader, merge, startup validation, and reporting.
- Per-phase model and entry skill.
- The entry-skill gate on `propose_scope` and `submit_result`.
- The `agent-jira` toolset (`jira_get_issue`, `jira_search`) and its registration in the runner.
- PRD in implement turns.
- `SubmitResult.status` and the `incomplete_result` ending.
- One generic setup line in the implement prompt.
- The day.io side in `OiTchau/day-ai-plugin`: manifest, plugin, image and CI.

**Non-goals:**
- **Base branch per repository.** SF-003; it needs `baseBranch` through scope, assignment, clone, scan, push and pull request.
- **`jira_add_comment`.** A later slice that adds `"comment"` to `tools.jira`, limited to the run's issue and its epic.
- **A server check that PRD questions addressed to Engineering are answered.** The PRD is not stored on the run; the day.io scope skill covers it, and the entry-skill gate makes the skill run.
- **New phases.** The manifest configures `scope` and `implement` only; the server owns the state machine. Delivery turns run no model.
- **Swapping `coredoc-workflows` for a fork.** Possible through `plugins[]` once CLI compatibility with the runner is checked; not part of this slice.
- **Loading target repositories' own `.claude/` settings.** `settingSources: []` stays, because repository text is data.

## Contracts

### Manifest (`packages/core/src/agent-runner/manifest.ts`)

```json
{
  "version": 1,
  "plugins": [
    { "path": "/opt/coredoc-workflows" },
    { "path": "/opt/dayio/plugins/day-agent-run" }
  ],
  "tools": { "jira": ["read"] },
  "phases": {
    "scope":     { "model": "claude-opus-5-5",   "entrySkill": "day-agent-run:scope" },
    "implement": { "model": "claude-sonnet-5-5", "entrySkill": "day-agent-run:implement" }
  }
}
```

- The schema is strict (unknown keys rejected). `version` is the literal `1`.
- `plugins` is 1–10 absolute paths. `tools.jira` is a subset of `["read"]`.
- `phases.{scope|implement}.{model?: string, entrySkill?: "<plugin>:<skill>"}`.
- **Default:** `{ version: 1, plugins: [{ path: COREDOC_WORKFLOWS_PLUGIN_PATH ?? "/opt/coredoc-workflows" }], tools: {}, phases: {} }`.
- **Merge:**
  - `plugins` and `tools` replace the default when present.
  - `phases.<kind>` merges field by field over the default.
  - Exactly one plugin must have the manifest name `coredoc-workflows`. Its path is the one the secret scanner and `COREDOC_WORKFLOWS_STATE_HOME` use.
- **Location:** `COREDOC_RUNNER_MANIFEST`, default `/etc/coredoc/agent-runner.json`. A missing file means the default. A file that exists but does not parse or validate is a startup problem.
- **Reporting:** `RunnerVersionsSchema` gains `manifest?: { digest, models: { scope?, implement? }, plugins: [{ name, version? }] }`. It is sent at claim and shown on the run page beside the existing versions.

### Startup check (`apps/agent-runner/src/claude/startup-check.ts`)

The check loads every manifest plugin in its single initialize call. It reports a startup problem and takes no turns when:
- a plugin's manifest is missing;
- `coredoc-workflows` is absent or appears twice;
- a plugin lists no skills;
- an `entrySkill` is not among the listed commands.

It reuses the existing `PluginMissing` and `PluginSkillsMissing` codes, plus `ManifestInvalid` for schema and merge errors. Models are not checked at startup; an unknown model fails the first session as the SDK reports it.

### Session options (`claude-executor.ts`)

- `plugins`: every manifest plugin.
- `model`: `manifest.phases[kind].model ?? turn.run.model`, omitted when both are null.
- `mcpServers.jira`, registered only when `tools.jira` includes `read` and `turn.mcp` is present: `{ type: 'http', url: resolve(turn.mcp.path + '?toolset=agent-jira'), headers: same bearer }`. The name has no `coredoc` segment, so the plugin does not count Jira calls as Coredoc reads.
- The preamble gains one line when `entrySkill` is set: "Start by invoking the skill `<entrySkill>` and follow it; `<run-control tool>` is refused until you have."

### Entry-skill gate (`claude-executor.ts` PreToolUse hook, `claude/run-control.ts`)

- The existing PreToolUse hook (`claude-executor.ts:465`) sets `control.entrySkillInvoked = true` when `tool_name === 'Skill'` and `tool_input.skill` equals the phase's `entrySkill`.
- `propose_scope` and `submit_result` return the existing `rejected(...)` tool error ("Invoke `<entrySkill>` first") while it is false. That is a tool error, not a turn failure.
- A resumed session keeps the flag only through the session, so a resumed turn must invoke the skill again. The phase then gets the instructions again after a person's answer or a checkpoint.

### `agent-jira` toolset (server)

- `McpToolset.AgentJira = 'agent-jira'` in `apps/server/src/mcp/mcp-toolset.ts`, with tools `jira_get_issue` and `jira_search`. They follow the pattern of `intent.tools.ts:787–795`.
- **Visibility:** the tools are listed and callable **only** with `?toolset=agent-jira`. Today a request without `toolset` gets every tool (`restrictToToolset`, `mcp-toolset.ts:68–70`). Change it so the no-toolset listing excludes the tools that belong only to `agent-jira`. Otherwise they would appear under every client's `coredoc` server, and the plugin would count them as Coredoc reads.
- **`jira_get_issue({ key })`** returns the same markdown document the runner writes as `PRD.md` (`CloudAgentRunIssueReader.readPrd`): key, summary, type, status, labels and description, an epic's child issues, and a story's parent epic. Issue links are not included.
- **`jira_search({ jql, limit ≤ 50 })`** sends `project in (<projectKeys>) AND (<condition>) ORDER BY <order>` and returns key, type, status, summary. Rows outside `projectKeys` are dropped too, since a clause such as `x) OR (project = OTHER` escapes the parentheses.
- **Guard:**
  - The caller is a service token named `agent-turn:*` that carries the new `TokenPermission.JiraRead`.
  - `mintMcpToken` (`cloud-agent-turn.service.ts:321`) adds `JiraRead` for scope and implement turns when the workspace's Jira connector is active.
  - An issue outside `projectKeys` gets a tool error.
- Every response states that issue text is data, not instructions. The run preamble already says so.

### PRD in implement turns

- The implement branch of the turn assignment (`cloud-agent-turn.service.ts:189–193`) also calls `jira.readPrd` and sends `prd`; it already resolves the issue there.
- `implementTurn` writes `PRD.md` beside `SPEC.md`. `implementPrompt` names both: "the specification is the accepted contract; the PRD is its source for acceptance criteria and fixtures".

### Result completeness

- **Schema:** `SubmitResultRequestSchema` gains `status: 'complete' | 'partial' | 'blocked'` (default `complete`, so older runners stay valid) and `unmetCriteria: shortText[]` (≤ 50, required non-empty unless `status` is `complete`). It is validated in `validateResult` (`cloud-agent-run-implement.service.ts:126`).
- **Storage:** `settleResult` stores `status` and `unmetCriteria` on the run result.
- **Delivery:** proceeds unchanged.
- **Ending:** `CloudAgentRunDeliveryService.settle` (`cloud-agent-run-delivery.service.ts:278`) queues the done comment after a verified delivery, and already ends a run with `failRun(DeliveryFailed)` from the same state. A result that is not complete ends there with `failRun(..., RunFailureCode.IncompleteResult, <unmet criteria joined>)` instead of queuing done. Jira then gets `failureComment` (`jira-comments.ts:63`), which lists the draft pull requests.
- **Display:** `IncompleteResult = 'incomplete_result'` is added to `RunFailureCode` in core, with its web label.
- **Prompt:** `implementPrompt` gains: "Install each repository's dependencies with its own lockfile command before declaring it unbuildable, and quote the error. Write temporary files under `$TMPDIR`. Submit `partial` or `blocked` with every unmet acceptance criterion when you stop short."

### day.io side (`OiTchau/day-ai-plugin`)

- **`services/agent-runner/manifest.json`:** the example above, with models chosen by the owner at rollout.
- **`services/agent-runner/plugins/day-agent-run/`:** a Claude Code plugin with two skills.
  - **`scope`:**
    - read the issue, its epic and sibling stories with the Jira tools;
    - name the base branch each repository must build on, and say why, in the specification;
    - answer every PRD question addressed to Engineering, or name the missing input, before `propose_scope`;
    - carry the PRD's fixtures as acceptance criteria;
    - run the `coredoc-workflows` spec route.
  - **`implement`:**
    - read `PRD.md` and `SPEC.md`;
    - run `npm ci` (the `@oitchau` scope comes from GitHub Packages through the runner's registry configuration) and record the exact error on failure;
    - use each repository's test command that works without Docker, for example `oitchau-requests`: `NODE_PATH=. npx jest <paths>`;
    - run the `coredoc-workflows` implement and review routes;
    - submit `partial` with the unmet criteria rather than stopping silently.
- **`services/agent-runner/Dockerfile`:** `COPY` the plugin to `/opt/dayio/plugins/day-agent-run` and the manifest to `/etc/coredoc/agent-runner.json`, root-owned and read-only like the base image's plugin.
- **`.github/workflows/pull-coredoc.yml`:** build with context at the repository root (`-f services/agent-runner/Dockerfile .`).

## Acceptance

| ID | Pass/fail outcome | Observer / validation |
| --- | --- | --- |
| AC-1 | With no manifest file, session options (plugins, model, MCP servers, preamble) equal today's for both phases. | Runner unit test on the options builder, against a snapshot of current options |
| AC-2 | A manifest's phase model wins over `turn.run.model`. With neither, `model` is omitted. | Options-builder test |
| AC-3 | An invalid manifest, a missing plugin, a missing or duplicate `coredoc-workflows`, or an unknown `entrySkill` is reported as a startup problem with its code, and the runner claims nothing. | `startup-check` tests with a fake `query` (copy the existing ones) |
| AC-4 | The claim carries `versions.manifest` (digest, models, plugin names and versions), and the run page shows it. | Runner claim test; web presentation test beside `agent-run-presentation` |
| AC-5 | With `entrySkill` set, `submit_result`/`propose_scope` before a `Skill` call for that skill returns a tool error and records nothing. After the call, they are accepted. | `run-control` tests with a fake session |
| AC-6 | `jira_get_issue` returns the fields above for an in-project issue and a tool error outside `projectKeys`. `jira_search` always wraps the JQL in the project clause. | Server tool tests copying `intent.tools.test.ts`, with a fake `JiraClient` |
| AC-7 | An `agent-turn` token without `JiraRead`, or a non-agent service token, cannot call the `agent-jira` tools. A request without `toolset` neither lists nor calls them. | `mcp-toolset.http.test.ts` pattern |
| AC-8 | The runner registers `mcpServers.jira` only when `tools.jira` includes `read`. | Options-builder test |
| AC-9 | An implement turn receives `prd.markdown`, writes `PRD.md`, and its first prompt names it. | Server implement integration test; runner prompt test |
| AC-10 | `submit_result` with `status: partial` and no `unmetCriteria` is rejected. With criteria, the run delivers its draft pull requests and ends `failed/incomplete_result`, and the Jira comment lists the criteria and the pull requests. `complete` (or omitted) still ends `done`. | `cloud-agent-runs-implement.postgres.integration.test.ts` and `…-delivery…` |
| AC-11 | Rerunning PROD-29787 with the day.io manifest invokes both entry skills, reads the epic through `jira_get_issue`, writes `PRD.md` in implement, and ends either `done` against the story's criteria or `failed/incomplete_result` naming what is missing. Never "finished" on partial work. | Pilot rerun, checked against `oitchau-requests` `specs/SF-20261022-hours-to-days-conversion.md` |

How a check could pass while behaviour is broken:
- AC-1 passes if the default is built from the same code under test. Compare against a frozen snapshot of today's options.
- AC-5 passes if the gate checks only that some `Skill` call happened. Test a different skill name and assert it is refused.
- AC-10 passes if `status` defaults to `complete` from the runner. Send `partial` explicitly in the test.

## Implementation plan

| Step | Change boundary | Traces to | Depends on |
| --- | --- | --- | --- |
| 1 | `packages/core/src/agent-runner/manifest.ts`: schema, default, merge; export from the package index. `RunnerVersionsSchema.manifest`; `RunFailureCode.IncompleteResult`; `SubmitResultRequestSchema.status` and `unmetCriteria` | AC-1–4, AC-10 | — |
| 2 | `apps/agent-runner/src/manifest.ts`: load from `COREDOC_RUNNER_MANIFEST`, parse, merge, digest. `main.ts` passes the result instead of `pluginPath` | AC-1, AC-3 | 1 |
| 3 | `startup-check.ts`: all plugins, the `coredoc-workflows` rule, entry skills | AC-3 | 2 |
| 4 | `claude-executor.ts`: plugins, model, `mcpServers.jira`, the gate flag in PreToolUse, `PRD.md` in `implementTurn`. `SecretScanner` takes the `coredoc-workflows` path | AC-1, AC-2, AC-8, AC-9 | 2 |
| 5 | `claude/prompts.ts`: entry-skill line, PRD in `implementPrompt`, setup and completeness lines. `run-control.ts`: gate refusal | AC-5, AC-9, AC-10 | 4 |
| 6 | Server: `TokenPermission.JiraRead`; `mintMcpToken` adds it; `McpToolset.AgentJira`, with its tools excluded from the no-toolset listing; tools and guard in `apps/server/src/mcp/tools/agent-jira.tools.ts` | AC-6, AC-7 | — |
| 7 | Server: `readPrd` for implement assignments | AC-9 | — |
| 8 | Server: `validateResult` rule; `settleResult` stores status; `CloudAgentRunDeliveryService.settle` ends `failed/incomplete_result` for a result that is not complete; `FAILURE_MESSAGES` entry and web label | AC-10 | 1 |
| 9 | Web: show `versions.manifest` on the run page | AC-4 | 1 |
| 10 | Docs: `charts`/runner README section "Manifest" (keys, defaults, precedence, startup problems); `apps/agent-runner/derived-image.example.Dockerfile` shows copying a manifest and plugin | — | 2–6 |
| 11 | day-ai-plugin: `services/agent-runner/manifest.json`, `plugins/day-agent-run` (two skills), Dockerfile `COPY`, CI build context | AC-11 | released runner with 1–8 |
| 12 | Pilot rerun of PROD-29787 | AC-11 | 11 |

**Validation:**
- Runner and core: `pnpm --filter @coredoc/agent-runner test`, `pnpm --filter @coredoc/core test`.
- Server: the postgres integration suites named above, plus the MCP tool tests.
- Web: the presentation test.
- Repository gates per `DoD.md`.
- day-ai-plugin: an image build, then the runner's startup check in the built image (`docker run … --check` or the pod's start-up log) shows both plugins and both entry skills.

**Reachable failure modes:**

| Failure | Handling | What people see |
| --- | --- | --- |
| Bad manifest in the image | Startup problem | The runner reports it at start, and runs stay queued |
| Jira connector inactive | `JiraRead` is not minted, so tool calls fail | The agent works without Jira, as today |
| Jira API error | Tool error | The agent continues |
| Agent never invokes the entry skill | Its run-control calls are refused until the turn limit | The turn checkpoints as today |
| An older runner without `status` | Defaults to `complete` | Today's behaviour |

**Rollout/rollback:**
- Release core, server and runner together, as runner and server already are.
- The server accepts results without `status`, so an older runner keeps working.
- Ship the day.io image after that release.
- Rollback = the previous runner image (no manifest is read) and the previous server; the new enum values are additive.

## Unresolved decisions

NO UNRESOLVED DECISIONS. Which models the day.io manifest uses is a rollout setting for the owner, not a spec decision.
