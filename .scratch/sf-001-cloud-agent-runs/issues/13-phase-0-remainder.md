# 13: Phase 0 remainder

**What to build:** Close the Phase 0 items that were still open when the gate was accepted, and record each result under "Phase 0 results" in the spec. They only gate the runner image and the pilot.

**Blocked by:** None (can start immediately)

**Status:** ready-for-human

- [ ] Real converter fixture: the first PRD the PRD tooling writes into a Jira issue description, captured as ADF and scrubbed of names and customer terms; comment and transition permissions of the connector user confirmed; done status "Code Review" configured
- [x] Tests without Docker decided: compose-tested repositories reported as not tested; integration tests run in pull-request CI (2026-10-08)
- [x] Private package registry access decided: the bot's classic token (`repo`, `read:packages`, no `workflow`) also serves GitHub Packages; the runner writes a user-level registry config per turn (2026-10-09)
- [ ] Runner egress host list measured behind a logging proxy with the runner's environment
- [x] Derived image size, scratch volume and archive size measured (archive cap 128 MiB kept, scratch 16Gi); session-end hook budget with five clones still unmeasured, moved to 12
- [x] SDK error results recorded (synthetic message `error` kind, `api_error` terminal reason, iterator throws) and the transient/permanent rule implemented (`613f565`, `828e70a`)
- [ ] ~~Bot checks repeated with a fine-grained token in the pilot organisation~~ moved to 12 (pilot), now with the classic token

## Carried over from 04

- Archive cap is a provisional 128 MiB (`MAX_STATE_ARCHIVE_BYTES`, body tier = cap + 1 MiB); set it from the sizing measurement.
- Check the runner's start-up probe (a streaming prompt that sends nothing, read from the init message) against the real SDK in the image.
- Start-up refusal reported to settings through a heartbeat-only call is not built (ticket 11).
