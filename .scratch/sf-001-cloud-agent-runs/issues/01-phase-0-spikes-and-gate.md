# 01: Phase 0 spikes and maintainer gate

**What to build:** Answer the Phase 0 questions of the spec (SDK pin, plugin in hosted mode, GitHub bot and rulesets, Jira fixture, egress and proxies, sizing). Record each decision under Further Notes, then get a maintainer's acceptance of the scope decision (untrusted execution in the customer's runner pod) and of the decisions listed there. Scratch work only; nothing merged except the spec update.

**Blocked by:** None (can start immediately)

**Status:** resolved — gate accepted 2026-10-08; open spike items moved to 13

- [ ] Exact SDK version chosen above the floor, with pause (deferral and deny-with-interrupt), resume, result and cost semantics, pre-tool hook ordering, MCP timeout and process-tree abort confirmed on it — 0.3.285 chosen; all confirmed except the MCP timeout and model/auth error results
- [x] Plugin contract items met by the newest plugin version recorded, with the fallback prompts settled for the rest (open: product questions in hosted mode, decided at the gate)
- [x] Bot token confirmed unable to push to, merge into or update the default branch, able to push `coredoc/**`; run-branch ruleset tested (classic token, test repository; fine-grained token in an organisation still to repeat for the pilot)
- [ ] One scrubbed real PRD (Atlassian Document Format) captured as the converter fixture; comment and transition permissions confirmed
- [ ] Runner egress host list measured behind a logging proxy
- [ ] Derived image size, scratch volume for five clones and the archive size of a long run measured; archive body-size tier set
- [ ] Decided how compose-tested repositories are tested in the runner pod (data-store sidecars or reported as not tested) and how private package registries are reached
- [x] Maintainer acceptance recorded in the spec's gate, with who and when
