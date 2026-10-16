# 15: Structured agent activity and the trace drawer

**What to build:** The runner reports what the agent does as structured events instead of raw text lines, and the run page can show the full trace per turn in a right-hand drawer, with the transcript downloadable. See the spec's "Run page redesign" decision and the prototype at `apps/web/src/features/agent-runs/agent-run-page.prototype.html` (Trace and Skills drawers).

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] The shared runner contract gains structured events: `tool` (tool name, a short target such as a path, command or MCP call, result summary, error flag, a capped error output), `skill` (skill name) and `result` (the `submit_result` summary and points); raw `[text]` lines become `message` events with the agent's text. Old `raw` events still render.
- [ ] The runner emits them from SDK messages, pairing each tool call with its result and masking credentials as today; payload caps and redaction apply.
- [ ] The server serves per-turn activity for a run (turn, phase, start, duration, spend, tool-call count, failures) and skill and tool counts for the run, from the stored events.
- [ ] The server streams the run's transcript (Claude Code's session JSONL) from the latest state archive as a download, for human sessions only.
- [ ] The run page opens a Trace drawer (turns, tool rows with result, failures highlighted with their output, agent messages) and a Skills and tools drawer (counts), and a turn's trace opens directly from that turn.
- [ ] Tests at the runner seam (fake SDK query → structured events), the server seam (activity and download on Postgres), and the web drawers.

## Answer

Done in the working copy (uncommitted, on top of `74ebf1a`). Contract events `message`, `tool`, `skill`, `result` (additive, protocol 1); the runner's stateful `SessionEvents` pairs each tool call with its result; events carry `turnId`; `GET /:runId/activity` (per-turn metadata, skill and tool counts) and `GET /:runId/transcript?phase=` (session JSONL from the latest archive, redacted line by line including lines over 64 KiB, 256 MiB cap); Trace and Skills drawers on the run page with a per-turn Trace link. Deviations: no per-turn trace endpoint (the drawer groups loaded events by `turnId`); subagent transcripts are not in the download; `TodoWrite` and successful `Skill` calls are not counted as tool calls. Needs `docker compose up -d --build coredoc-server agent-runner`; server before runner.
