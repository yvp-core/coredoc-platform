# 12: Pilot

**What to build:** Enable agent runs on one Jira project and run three tickets of increasing scope: one repository known up front, one to be discovered, and three repositories with a contract change. Tune prompts and budgets, and list any repository the agent could not set up.

**Blocked by:** 07, 08, 09, 10, 11, 13

**Status:** ready-for-human

- [ ] Three draft pull requests a person would review without rewriting
- [ ] A written list of the questions the agent asked, with whether each was needed
- [ ] Prompt and budget changes recorded in the spec
- [ ] Session-end hook budget measured with five clones on the real runner
- [ ] Bot checks (no push or merge on the default branch, push to `coredoc/**`, tag ruleset) repeated with the pilot organisation's bot token
