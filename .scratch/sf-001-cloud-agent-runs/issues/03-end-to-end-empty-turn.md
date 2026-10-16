# 03: End-to-end empty turn: settings, runner token, manual start, run page

**What to build:** The first tracer bullet through server, runner and web, with no agent yet. An admin enables agent runs in a minimal Agent runs settings panel (recording the run owner) and mints a runner token. A member starts a run from the web app with an issue key. A skeleton runner process claims the queued scope turn over the runner API, heartbeats, posts a few events and completes the turn. The run list and run page show the run, its status and its timeline, polling while it is active.

Covers from the spec: the migration (runs, turns, events, settings, the partial unique indexes, the owning-turn column on service tokens), the `agent-runner` token scope with the exact-purpose fence and wildcard exemption, the token-only guard, turn rows with claim, lease, heartbeat, `LEASE_LOST` fencing and completion, runner-seen tracking, the human API's start/list/get/events routes with human-session guards, the `/me` agent-runs flag and navigation entry, and the shared runner protocol contract.

**Blocked by:** 01

**Status:** resolved

- [ ] Admin enables agent runs and mints a runner token (shown once, listed, revocable) in settings
- [ ] Manual start creates a `queued` run and queues a scope turn; a second start for the same issue is refused with `ACTIVE_RUN_EXISTS`
- [ ] The skeleton runner claims the turn, heartbeats, posts events and completes; the run page shows the timeline in sequence order
- [ ] Two runners claiming at once get different turns; a stale lease gets `LEASE_LOST`
- [ ] Server seam tests: human routes refuse service tokens; runner routes refuse human sessions, other workspaces' tokens and a legacy grant-all token; a runner token is refused by the cloud MCP and by an existing permission-less member route
- [ ] Settings show when each runner token last claimed or heartbeated, with its versions
- [ ] Migration-invariant test guards the hand-written partial indexes

## Answer

Done on `feat/sf-001-cloud-agent-runs` (`441365d`..`40a94d7`), verified by hand against a real server on Postgres: enable and mint a runner token, manual start, the skeleton runner claims, heartbeats, posts events and completes; events come back in order and settings show the runner's last claim and versions. Lease token travels in `x-coredoc-lease-token`. Deferred on purpose and carried into later tickets: Jira identity (04), spec-version and question tables (04, 05), completion advancing the run and the nudge (05), concurrency queue, availability checks and the full settings PUT (09), event redaction, per-turn caps and rate limit (10), question card and scope review UI (04, 05).
