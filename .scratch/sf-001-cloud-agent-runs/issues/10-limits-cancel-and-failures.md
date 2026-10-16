# 10: Limits, cancel, lost runners, license and retention

**What to build:** Runs stop cleanly. Spend and active-time budgets fail runs; a member can cancel at any point; every terminal transition abandons the queued or claimed turn so nothing restarts it; a turn whose runner disappears is re-queued and fails the run after three losses. Runner reports are capped and rate limited. License expiry stops creation, promotion and every write as the spec describes. The retention sweep prunes events, turns and archives 30 days after a run ends and never touches human rows.

**Blocked by:** 05, 06

**Status:** resolved

- [ ] `budget_exhausted` (including three turns of unknown spend) and `wall_clock_exceeded` on active time only
- [ ] Cancel while queued leaves nothing to claim; cancel while claimed means lease expiry neither re-queues nor changes the code; the runner stops at its next heartbeat
- [ ] Third lease expiry fails with `runner_lost` and deletes the MCP token
- [ ] Per-turn report caps fail with `report_limit_exceeded`; runner routes are rate limited per token
- [ ] License expiry: no creation or promotion; queued runs wait for renewal
- [ ] Retention never deletes runs, spec versions, questions, answers, acceptances or change requests

## Carried over from 03

- Event payload redaction (payloads are only capped at 16 KiB today), per-turn report caps and a rate-limit guard keyed on the service token.
- The lease-expiry sweep must replace `lease_token` when it re-queues; `attempts` is incremented at claim, so "third expiry" is `attempts >= 3`.

## Carried over from 09

- Lease expiry, `runner_lost` and the retention sweep go into the run sweep (worker schedule module).
- Re-check run-level conditions when each turn is handed out, if 04 did not.

## Carried over from 04

- Lease expiry and abandonment must delete the turn's MCP token and orphaned archives.
- The server must refuse to hand out a turn when the run's spend is exhausted (the runner already fails closed).
- Per-turn caps include proposals.

## Carried over from 05

- General lease expiry (re-queue with a new lease token, `runner_lost` on the third) goes into `CloudAgentRunSweep.tick()` next to the paused-turn case; the per-turn cap of 20 questions; cancel reuses the open-question cancellation in `failRun`; decide whether the sweep is license-gated.

## Carried over from 06

- SIGTERM handling in the runner; a start-up check refusing an admin bot before claiming.
- Scope turns do not report checkpoints yet (they end as `ended`); the server already handles a scope checkpoint.
- Typechecking the runner's tests with a scratch tsconfig shows 3 errors around `claude-executor.test.ts:202` (assertions from 05); fix while there.

## Answer

Done on `feat/sf-001-cloud-agent-runs` (`582d88d`..`0a001b5`). One `endRun` for every terminal transition (abandons the turn, deletes its MCP token, cancels questions); cancel route and button; lease expiry re-queues with a fresh token and fails with `runner_lost` at the third attempt; active-time and spend limits (three unknown-spend turns fail with `budget_exhausted`; delivery exempt); per-turn report caps; per-token rate limit (burst 300, 10/s, per process); event redaction in linear time that masks long secrets whole; claim re-checks; retention in the sweep behind `AGENT_RUN_RETENTION_ENABLED`; runner SIGTERM and start-up refusal of an admin bot. Notes: report-cap counters persist across attempts of a turn; question rows themselves are stored unredacted (only events are redacted); cloud-agent-runs Postgres suites must run sequentially because the sweeps act across workspaces.
