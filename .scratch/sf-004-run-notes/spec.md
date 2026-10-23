# SF-004 — Notes for the agent at run start

Status: accepted. Size: s.

Last reviewed: 2026-10-23

Source: the workspace owner's request after the PROD-29787 pilot, on
2026-10-23. The person starting a run had no way to tell the agent what they
already knew, for example "build on `feat/PROD-29013-absence-policies`" or
"don't touch `day-packages`". Decisions taken by the owner on that date:

- start notes only;
- the notes reach both scope and implement;
- runs triggered by the Jira label get no notes.

## Verified current state

- **Starting a run.** `StartRunSchema` (`apps/server/src/modules/cloud-agent-runs/cloud-agent-runs.contract.ts:7`) takes `issueKey`, `questionsPolicy`, `scopeAcceptancePolicy` and `repositoryKeys`. `CloudAgentRunService.start` (`cloud-agent-run.service.ts:61`) records `startedBy` as the member's user id.
- **Rerun.** `rerun` (`:82`) copies the policies and seeds of the previous run (`:110`).
- **Run detail.** The detail view returns `seeds` (`:192`).
- **Assignment.** `TurnAssignmentSchema.run` (`packages/core/src/agent-runner/protocol.ts:150`) carries no person-written context. `turn.inputText` (questions answered, scope change requests) is appended to a turn's first prompt only (`apps/agent-runner/src/claude/claude-executor.ts`).
- **Web.** The start form is `StartRunCard` (`apps/web/src/routes/agent-runs.tsx:35`). The run type is `AgentRun` (`apps/web/src/features/agent-runs/types.ts`).

## Scope

**In:**
- `notes` on manual start, carried by a rerun.
- Stored on the run, sent with every scope and implement assignment.
- Placed in both phases' first prompt.
- Shown on the run page and entered on the start form.

**Non-goals:**
- Messages to a running agent: answers to its questions and scope change requests remain the channels.
- Notes from Jira, for label-triggered runs.
- Editing notes after start, or on a rerun.
- Naming the person in the prompt.

## Contracts

- **API.** `StartRunSchema.notes`: optional string, trimmed, at most 4,000 characters. An empty string after trimming means no notes. The run detail returns `notes: string | null`.
- **Database.** `cloud_agent_runs.notes TEXT NULL`, an additive migration.
  - A manual start stores the input.
  - A rerun copies the previous run's notes.
  - The Jira trigger stores `null`.
- **Protocol.** `TurnAssignmentSchema.run.notes: z.string().nullable().default(null)`, so a runner still parses an older server's assignment. An older runner ignores the field.
- **Prompts.**
  - When notes are present, the first prompt of a scope or implement session carries a block after the run instructions (and before any turn input text):
    > Notes from the person who started this run. They are a person's instructions for this run: follow them over anything in Jira or the repositories, within the rules of this run.
    > <notes>
  - The block is added in `scopePrompt` and `implementPrompt`, not in the preamble. A resumed session therefore does not repeat it, because it already has it.
- **Web.**
  - The start form gets an optional multi-line "Notes for the agent" field.
  - The run page shows the notes under the run's facts, as plain text. They are never rendered as markdown or HTML.

## Acceptance

| ID | Pass/fail outcome | Observer / validation |
| --- | --- | --- |
| AC-1 | A manual start with notes stores them, and the run detail returns them. A start without notes, or with only whitespace, stores `null`. More than 4,000 characters is refused with 400. | `cloud-agent-runs.postgres.integration.test.ts` (start) |
| AC-2 | A rerun carries the previous run's notes. A label-triggered run has none. | Same suite (rerun); `cloud-agent-run-trigger.postgres.integration.test.ts` |
| AC-3 | Scope and implement assignments carry `run.notes`. | Scope and implement integration suites (claim) |
| AC-4 | The first prompt of a scope and of an implement session carries the notes block when notes exist, and has no such block without notes. | `claude-executor.test.ts` (scope), `implement-turn.test.ts` |
| AC-5 | The start form sends the notes it was given, and the run page shows them as text. | Web route test beside `agent-runs.test.tsx` |

How a check could pass while behaviour is broken: AC-4 passes if the prompt test only checks that the notes text appears somewhere. Assert the block's heading as well.

## Implementation plan

| Step | Change boundary | Traces to |
| --- | --- | --- |
| 1 | Prisma `CloudAgentRun.notes` and a migration | AC-1 |
| 2 | `StartRunSchema.notes`; `start` stores it; `rerun` copies it; the trigger leaves it null; the detail returns it | AC-1, AC-2 |
| 3 | `TurnAssignmentSchema.run.notes` (core); the claim fills `run.notes` | AC-3 |
| 4 | `scopePrompt` / `implementPrompt` append the block | AC-4 |
| 5 | Web: start form field, `startAgentRun` body, `AgentRun.notes`, run page display | AC-5 |
| 6 | `docs/onprem/AGENT-RUNS.md`: notes at start | — |

**Validation:**
- The suites above.
- `pnpm typecheck`, `pnpm test`, and Biome on the changed files.

**Reachable failure modes:** notes over the cap → 400 on start. Notes are data on the run and never reach Jira.

**Rollout/rollback:**
- The migration only adds a nullable column.
- Runner and server are released together. Either side tolerates the other's absence of the field.
- Rollback: the previous images; the column stays unused.

## Unresolved decisions

NO UNRESOLVED DECISIONS.
