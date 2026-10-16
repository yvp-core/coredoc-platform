# 04: Scope phase with Claude

**What to build:** A started run scopes a real PRD. When a scope turn is claimed, the server reads the Jira issue (and an epic's child issues in configured projects), converts Atlassian Document Format to markdown and hands it out as the PRD. The runner runs Claude Code through the Agent SDK with the plugin in hosted mode, the run preamble, the tool policy and the `agent_run` run-control server; the agent calls `propose_scope`, the server validates it, and at turn completion the version is published. Reviewers see the scope review on the run page (spec, repositories with reasons and eligibility, merge order, dropped seeds, version selector) and accept or request changes; a change request resumes the same session. The state archive round-trips through the runner API between turns.

**Blocked by:** 02, 03

**Status:** resolved

- [ ] PRD built from Jira with the conversion coverage the spec lists; scrubbed fixture and synthetic table tests
- [ ] Runner start-up check logs versions and claims nothing when the SDK or plugin is unusable; `plugin_missing` and `session_mismatch` at session start
- [ ] `propose_scope` validation errors return to the agent; a valid proposal publishes as `proposed` at completion
- [ ] Accept moves the run to `implementing` (implement itself lands in 06); accepting a stale version is refused with `SPEC_VERSION_STALE`; request changes resumes the scope session with the text
- [ ] Proposals carry candidates for the PRD (product questions the PRD leaves open); the scope review shows them, and automatic acceptance accepts only when every repository is eligible and no candidate is open
- [ ] ADF conversion renders legacy extension nodes from their nested content and inline cards inside headings
- [ ] State archive holds only Claude Code's config and the plugin's state home, uses its own body-size tier, is fetched with the live lease, and extracts only inside the state directory; `archive_too_large` over the cap
- [ ] Agent-written markdown renders without remote images
- [ ] `agent_error` for model or Claude Code failures

## Carried over from 03

- Replace the placeholder `CloudAgentRunIssueResolver` (issue key used as id) with the Jira read, including `ISSUE_NOT_READABLE` and the configured-project check.
- Add the spec-versions table; extend `TurnAssignmentSchema` (PRD, repositories, MCP token, archive flag) and `CompleteTurnRequestSchema.outcome` (failure outcomes).
- Swap the runner's `SkeletonExecutor` for the Claude executor behind `TurnExecutor.run(assignment, io)`.
- Add the no-remote mode to the markdown renderer; build the scope review on the run page.

## Answer

Done on `feat/sf-001-cloud-agent-runs` (`3169024`..`8da73f5`). PRD read from Jira by issue id (epic children in rank order, parent epic for a child), ADF conversion, spec-version table, `propose_scope`, publish at completion, accept and request changes, per-turn MCP token, state archive under the lease, `ClaudeExecutor` on SDK 0.3.285 with the plugin by path, scope review on the run page. Security fixes: every run and spec-version query scoped by workspace (`f0e7455`); no session without a positive spend budget and a duration limit (`9eb00fa`). Deviations: Jira retry waits capped at 5 s inside the claim; archive cap 128 MiB provisional; AskUserQuestion denied with assume wording until 05; a rejected archive is retried through lease expiry.
