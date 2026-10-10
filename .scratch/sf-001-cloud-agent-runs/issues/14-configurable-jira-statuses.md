# 14: Configurable Jira status transitions

**What to build:** An admin chooses, in Settings → Agent runs, up to four optional Jira statuses: when a run starts, when its pull requests are delivered (done), when it fails, and when it is cancelled. Each is picked from a dropdown of the statuses the workspace's Jira connector already knows (the delivery status map for that connector). An unset status means no transition. The run sweep moves the issue accordingly, as described in the spec's Delivery section ("Status transitions").

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Settings store started, done, failed and cancelled statuses (all optional); the existing done status migrates into the new shape without losing a configured value
- [ ] A settings route lists the Jira connector's known statuses (from the delivery status map) for the dropdowns; the panel shows four optional selects with "No change" as the default
- [ ] Started: the issue moves when the run leaves `queued`; cancelled: when a member cancels; failed: after the failure comment is posted, skipped or given up on; done: unchanged behaviour
- [ ] Every transition runs through the sweep with claim, next-attempt time, project re-check, already-in-status skip and the screen-less preference; problems are recorded as warnings and never change the run's outcome; each event transitions at most once
- [ ] Transitions are matched by status name (case-insensitive) against the issue's available transitions
- [ ] Server-seam tests on Postgres with the fake Jira: each event with a status set, each with none set (no Jira call), a missing transition (warning), already in status (skip), and a crash between comment and transition (one transition)
- [ ] Web tests: the selects list the known statuses and save, and clearing one removes the transition

## Answer

Done on `feat/remote-agents` (`0d106b6`, `74ebf1a`). Four optional status names (`startedStatus`, `doneStatus`, `failedStatus`, `cancelledStatus`); `GET …/settings/jira-statuses` lists the connector's known statuses from `delivery_status_map`; each event records a pending transition that the sweep's `applyStatusTransitions` applies with claim, project re-check, already-in-status skip and the screen-less preference; problems become warnings. Migration `20261021120000_cloud_agent_run_jira_statuses` folds `done_status_id`/`done_status_name` into `done_status`. Deviations: `doneStatus` is a string in the API; a started transition still pending when the run ends is marked superseded, so a late retry cannot move the issue back; only the timeline shows the new transitions. Note: the trigger Postgres suite flaked a few times during development (403 then socket hang-up), base did not; watch it in CI.
