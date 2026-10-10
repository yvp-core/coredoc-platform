# 06: Implement phase: clones, commits and pushes

**What to build:** After acceptance, a fresh implement session works in clones of the accepted repositories. Each claim mints a per-turn MCP-only token for the run owner. The runner checks the bot is not an admin or maintainer, clones over HTTPS with the bot's token, reserves and creates or checks out the run branch, and after the session applies the staging rule, runs the plugin's secret preflight, commits `wip(<ISSUE-KEY>): turn <n>` with the Claude co-author trailer and pushes fast-forward. `submit_result` moves the run to `delivering` when a repository was touched, or fails it with `no_changes`. Duration checkpoints continue the run. The run page lists repositories, pushed heads, withheld workflow diffs and repositories not built or tested in the runner.

**Blocked by:** 02, 04

**Status:** resolved

- [ ] Per-turn MCP token: MCP-only, hidden from the token list, phase permissions (scope: intent read; implement: intent read and propose), deleted at completion, lease expiry and abandonment
- [ ] Admin or maintainer bot refused before any session starts, in every turn
- [ ] Branch reserved before its first push; a retry after dying between reserve, push and completion continues on the branch; a foreign existing branch fails with `branch_exists`
- [ ] Staging rule against a hostile fixture repository (gitlink, large file, workflow file, credential file); workflow diffs shown as 64 KiB events
- [ ] A blocked scan re-invokes the session once in the same turn; a second block fails with `secret_scan_blocked` and pushes nothing
- [ ] A person's push to the run branch fails the run with `push_rejected`
- [ ] The scratch volume is wiped at turn end; the runner pod runs with a read-only root filesystem
- [ ] `github_error` after three in-process retries

## Carried over from 04

- Implement turns are acknowledged with no outcome; build the implement executor on `ClaudeExecutor`.
- Add clone URLs (shared resolver `cloneUrl`) and run branches to the assignment.
- MCP token minting exists at claim (implement: intent read and propose); deletion on lease expiry and abandonment is ticket 10.

## Carried over from 05

- Checkpoints (duration, SDK turn cap) need their own outcome that neither counts nor resets the outcome-less count; today they look outcome-less and get nudged.
- `submit_result` appends its assumptions to `run.assumptions` with the implement phase.

## Answer

Done on `feat/sf-001-cloud-agent-runs` (`ebcb539`..`3888064`). Bot permission check before any session (scope turns included), clone from the assignment URL, reserved run branch, staging rule, plugin preflight, `wip(<KEY>): turn <n>` commits, fast-forward push, one in-turn re-invocation on a scan block, withheld workflow diffs, `submit_result` → `delivering` or `no_changes`, checkpoints as their own outcome, repositories card on the run page. Security fix `2a84dc5`: the runner rewrites `.git/config` from a template, pushes to the explicit clone URL with a URL-scoped header, and runs git with hooks, fsmonitor and credential helpers off. Deviations: no SDK interrupt after `submit_result` (tools refused, 60 s abort fallback); a parked question plus a scan block fails with `secret_scan_blocked`; an agent-written non-directory `.git` fails with `agent_error`.
