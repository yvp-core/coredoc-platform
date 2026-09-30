---
name: coredoc-feedback
description: Use at the end of a task where you used Coredoc tooling (MCP tools, coredoc-workflows routes, or coredoc plugin skills), when a workflow run reported feedbackOwed, or when the user runs /coredoc:feedback, to submit structured session feedback. Report which MCP tools were noisy, incomplete, wrong, slow, or misleadingly described; what went wrong outside the tools (workflow routing, skill instructions, missing task details, transport, host, your own missed or hallucinated facts); and which capabilities you needed. Collect observations while you work; at final task delivery, not after individual tool calls, draft it, show it to the user, record their review, then call submit_session_feedback once.
---

# coredoc feedback

Reflect on how the whole session went — the **coredoc MCP tools** and everything
around them (workflow routing, plugin skills, the task description, transport,
your own behaviour) — draft the feedback, let the user correct it, then submit
it once via `submit_session_feedback` so the coredoc team can improve the tooling.

## When to run
An individual MCP call, including the first one, never triggers drafting, a review
question, or submission. During ongoing work only collect observations. Feedback
starts once the entire requested task reaches its final delivery, not at an
intermediate stage, commit, or repository. An explicit `/coredoc:feedback` may
start the flow earlier.

- After a task where you used coredoc tools, a coredoc-workflows route, or a
  coredoc plugin skill, or when the user runs `/coredoc:feedback`.
- When a coredoc workflow run has just finished and its result reported
  `feedbackOwed` — that is the last point where you still remember how the
  session behaved. Reuse the `runId` it reported.
- A session that used no MCP tool still counts: routing, skills, and task
  context are exactly what you can only judge from inside the session.
- Prepare one session draft at the final delivery step, including work across
  repositories. Workers return observations to the parent. Respect an explicit
  Skip or no-feedback instruction; do not repeat a completed review or submission.

## What to assess (be specific and honest)

**MCP tools** — for each coredoc tool you used, one `perToolIssues` entry per
problem:
- **noise** — returned too much / irrelevant data you had to sift.
- **incomplete** — missing results you knew existed; you fell back to grep/read.
- **wrong** — returned inaccurate or stale data.
- **misleading_description** — the tool or an argument's description implied behavior it didn't deliver.
- **slow** — noticeably delayed the task.

**Everything else** — one `sessionIssues` entry per problem, keyed by `area`:
- **workflow-routing** — wrong or confusing route, stage, or approval gate.
- **skill-instructions** — a plugin skill was unclear, contradictory, or missed a step; name it in `skill`.
- **task-context** — the task lacked details you needed and had to guess or ask.
- **mcp-transport** — auth, timeouts, a tool that was listed but failed, or missing entirely.
- **agent-behavior** — you hallucinated a symbol or fact, over- or under-scoped, or missed something you later found. Describe *expected vs observed*, not a confession.
- **host-environment** — permissions, sandbox, missing binary, blocked command.
- **capture** — telemetry or relay problems.
- **other** — anything that fits nowhere above.

Each entry gets an `issueType` (`confusing`, `missing`, `wrong`, `blocked`,
`slow`, `hallucination`, `missing_context`), a `severity` 1 (minor) to 5
(blocking), a one-line `description`, and, when it belongs to one routed
stage, the `stageId`.

Also report:
- **missingCapabilities** — a tool, skill, or extension you wished existed, with the `useCase`.
- **misleadingMetadata** — specific tool or attribute descriptions that misled you and why.
- **summary** — one short narrative of how the session went.
- **overallRating** — your own 1..5 for the session.

## Draft, then let the user review

Your self-assessment is systematically optimistic: you cannot report the skill
or capability you never knew was missing. So before submitting:

1. Show the draft to the user in one compact block: your rating, the session
   issues, the tool issues, and the missing capabilities.
2. Ask exactly one question with at most three options, in this order:
   **Submit as is** / **Add or correct** / **Skip**. Use the host's structured
   question tool when it has one (`AskUserQuestion` on Claude Code,
   `request_user_input` on Codex); otherwise ask the same three options in
   prose and wait.
3. On **Add or correct**, ask one open question in prose: what did the agent
   miss, what was lacking, and their own rating 1..5. Put their words into
   `userNotes` verbatim (truncated to 2000 characters, never paraphrased),
   their rating into `userRating`, and set `reviewStatus: amended`. You may
   additionally turn their notes into structured `sessionIssues`, but the
   notes stay.
4. On **Submit as is**, set `reviewStatus: confirmed`. On **Skip**, send
   nothing and say so.
5. If the user answers with a new task instead of the question, submit the
   draft with `reviewStatus: unreviewed` and continue with their task. In a
   non-interactive top-level session, submit as `unreviewed` immediately
   rather than waiting. A subagent or worker inside a workflow does not
   submit; it returns its observations to the parent, which submits once.

Submit once. There is no update call and the server caps submissions per
session, so do not send a draft and then a correction.

## How to submit
Call `submit_session_feedback` once with the structured payload. Pass the
Claude Code `sessionId` if a hook told you it — it lets the team correlate this
feedback with the session's cost. Pass `repoKey` if the work was in a specific
repo. If a coredoc workflow run produced this work, pass its `runId`
(`cdr-YYYYMMDD-xxxxxx`) — it joins your judgment to that run's measured
outcome. Send it only if a run actually reported that id to you. The server
checks the shape but cannot tell a real id from an invented one, so a guessed
id does not fail — it silently attaches your feedback to a run that did not
earn it. Omit the field when you are unsure.

Redact everything you write: no source, diffs, prompts, commands, secrets, or
full paths in any description, example, or summary. The user's own notes are
theirs to phrase, but remind them not to paste secrets.

Keep it grounded in what actually happened this session. If everything worked,
an empty issue list with a high rating that the user confirmed is valid signal
too — the confirmation is the point.
