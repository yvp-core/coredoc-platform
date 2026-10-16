# 05: Questions, policies and the waiting limit

**What to build:** The agent can ask. Under the pause policy, AskUserQuestion is parked: the run goes to `awaiting_answer`, the session ends without losing the question, and the run page shows a question card (headers, options, descriptions, previews, multiple selection, "Other"). A member's answer resumes the same session exactly once. Under the assume policy the runner answers at once, the question is stored as `auto_answered`, and the assumptions the agent lists show on the run page. Subagent questions are bounced to the main session. A run waiting for a person longer than the waiting limit fails; an outcome-less turn gets one nudge, then fails.

**Blocked by:** 04

**Status:** resolved

- [ ] Pause parks the question and ends the turn; an answer queues exactly one resume turn, including when it arrives while the turn is completing
- [ ] A second answer is refused with `QUESTION_ALREADY_ANSWERED`
- [ ] A lease that expires after the turn parked a question completes the turn as paused instead of re-queuing it
- [ ] Assume policy answers immediately and records the agent's assumptions
- [ ] Subagent AskUserQuestion and permission requests are denied with "return this question to the main session"
- [ ] The waiting limit fails a forgotten run with `waiting_expired`; elapsed time never answers a question
- [ ] A second consecutive outcome-less turn fails with `no_outcome` and the agent's last message

## Carried over from 03

- Questions table and runner route; question card on the run page.
- Completion must advance the run: `CloudAgentTurnService.complete` currently records `no_outcome` and leaves the run in place; the nudge rule hooks in there (`outcomeLessCount` exists).

## Carried over from 04

- AskUserQuestion is currently denied in `ClaudeExecutor` with the assume-policy wording; replace it with the real bridge (deferral, Phase 0 results) and deny subagent questions in the pre-tool hook.

## Answer

Done on `feat/sf-001-cloud-agent-runs` (`2e4e62e`..`f161028`). Deferral-based question bridge in the runner, subagent questions bounced, questions table with one open question per run, answer compare-and-set with exactly one resume turn, assume policy auto-answers, completion advances the run with the policy-worded nudge and `no_outcome` on the second, the run sweep (`CloudAgentRunSweep.tick()`) with paused-turn lease expiry and the waiting limit, question card and assumptions on the run page. Interpretations: only AskUserQuestion and ExitPlanMode are denied to subagents (other permission requests would block allowed subagent Bash); outcome classification for questions happens server-side; new `QUESTION_NOT_FOUND` (404).
