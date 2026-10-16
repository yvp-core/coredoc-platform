# 08: Delivery: draft pull requests and the Jira outcome

**What to build:** A `delivering` run gets a delivery turn. The server assembles each pull request's title and body (per-repository summary, merge order, assumptions, withheld paths, not-built flag, run link, previous run link) with foreign issue keys neutralised and images removed. The runner opens or reuses one draft pull request per touched repository against the default branch and reports them. The server verifies each one with the strict pull read (base repo, head repo, head branch) and records it. The run sweep then posts one Jira done comment and applies the configured transition, and only then marks the run `done`. Failed runs get one failure comment with the code's fixed message, verified pull requests and the run link.

**Blocked by:** 06

**Status:** resolved

- [ ] Running delivery twice yields one pull request per repository; a 422 on create is followed by a lookup by head
- [ ] A fork head or mismatched report fails with `delivery_failed`; a transient GitHub error is retried
- [ ] Done comment and transition are idempotent across a crash between them; a transition answering 400 still ends `done` with a warning
- [ ] Two concurrent sweep ticks post one failure comment; a crash after posting is recovered by the marker check
- [ ] No agent-written text goes to Jira; an issue moved out of the configured projects gets no comment
- [ ] A cancel during delivery records the pull requests already opened
- [ ] Assembled bodies carry no foreign issue keys and no images (table tests)

## Carried over from 09

- The run sweep does not exist yet; the worker schedule module holds only the trigger cron. Add the sweep there with the done and failure comments, including the failure comment for runs that fail at creation. Failure codes and messages are in `failure-codes.ts`.
- The strict pull read (`getPullMetadata`) checks only the number and base repository; add head repository and head branch to its schema for verification.

## Carried over from 05

- The run sweep exists: add the done and failure comment jobs to `CloudAgentRunSweep.tick()`.

## Carried over from 06

- Delivery turns are queued at `delivering`; per-repository summaries, assumptions, binary paths and withheld paths are stored for the body. The runner needs the delivery executor (open or reuse draft PRs with the bot token) and the server needs body assembly and verification.

## Answer

Done on `feat/sf-001-cloud-agent-runs` (`7654713`..`a0dd7fc`). Server-assembled titles and bodies, runner delivery executor (reuse, record closed/merged, create draft, lookup after 422/timeout/5xx), strict server verification (base and head repository, head branch, default-branch base, draft when opened by the run, "unchanged" only when compare shows nothing ahead, `created` derived on the server), done comment and transition and failure comments in the sweep with marker checks and project re-checks, pull requests and Jira outcome on the run page. Security fixes: escaping instead of removal (`87be772`), caps before escaping and whole-block truncation (`c92445d`), every delivery claim verified (`f6c9c4e`). Deviations: comment progress kept in the `jiraOutcome` JSON column; GitHub `Retry-After` not honoured (client does not expose it); exhausted verification retries fail with `delivery_failed`.
