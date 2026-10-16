# 09: Jira trigger and the run queue

**What to build:** Product owners start runs by labelling issues. The trigger cron searches each enabled workspace's configured Jira projects for the trigger label, creates a run only for issues that never had one, turns `coredoc-repo:` labels into seeds, and fails invalid labels at creation. Runs beyond the workspace's concurrency limit wait in `queued` and start oldest first. Members can re-run a terminal run.

**Blocked by:** 03

**Status:** resolved

- [ ] Concurrent trigger ticks create exactly one run per issue, including a run that fails at creation; a terminal run is never re-created by the label
- [ ] No project keys means no search, with the reason in settings; manual starts outside the configured projects are refused
- [ ] Unknown, ambiguous or ineligible seeds fail with `invalid_repository_label`; too many with `too_many_repositories`
- [ ] The concurrency queue promotes oldest first under concurrent manual starts; all creation runs under the per-workspace advisory lock
- [ ] Jira-triggered runs act as the recorded run owner; a removed owner stops creation with a reason until an admin takes over
- [ ] Re-run creates a new run with branch `coredoc/<ISSUE-KEY>-<n>` and links the previous run

## Carried over from 03

- Started-runs count and keeping runs `queued` when no slot is free (`CloudAgentRunService.start` currently starts at once).
- Availability checks (object storage, encryption key, connectors, license) and `AGENT_RUNS_UNAVAILABLE`.
- The full settings PUT (policies, budgets, trigger label, done status, model) and the list page's availability banner.
- A `CloudAgentRunsWorkerScheduleModule` for the crons (update `app.module.isolation.test.ts`).

## Answer

Done on `feat/sf-001-cloud-agent-runs` (`57e3615`..`35f6a2f`). Trigger cron in the new worker schedule module, `coredoc-repo:` seeds through the shared resolver, oldest-first promotion under the creation lock, availability with reasons (`AGENT_RUNS_UNAVAILABLE`), re-run with `coredoc/<KEY>-<n>`, the full settings PUT and web form. Decisions: ineligible seeds on a manual start are kept for scope review; Delivery analytics disabled is an availability reason; settings carry bounds (turn 5 min–24 h, active 10 min–30 days, waiting 1 h–90 days, started runs 1–50, repositories 1–20, spend ≤ 10,000 USD). The manual-start project check compares the key prefix until 04's issue read lands.
