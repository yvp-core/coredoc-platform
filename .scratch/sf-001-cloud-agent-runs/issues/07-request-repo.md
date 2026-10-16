# 07: Requesting an extra repository

**What to build:** During implementation the agent can call `request_repo`. Under automatic acceptance the server appends the repository mid-turn and the runner clones it and returns its path; the turn continues. Under required acceptance a repository-request question ("Add" / "Don't add") opens and the turn ends; the member's decision resumes the session with the clone path or the decline.

**Blocked by:** 05, 06

**Status:** resolved

- [ ] Automatic acceptance clones mid-turn; repeating the request returns the same path
- [ ] Required acceptance opens a repository-request question regardless of the questions policy
- [ ] "Add" appends and clones next turn; "Don't add" resumes with the decline; a declined repository requested again is a tool error
- [ ] The repository cap and eligibility apply

## Carried over from 05

- The questions table has a `kind` column and the answer flow is in place; add the `repository_request` kind with fixed "Add" / "Don't add" options.

## Carried over from 06

- Clone, branch reservation, the bot permission check and the git template live in the runner's git module; reuse them for a mid-turn clone.

## Answer

Done on `feat/sf-001-cloud-agent-runs` (`b6035af`, `e7007ae`, `ef839b3`). Automatic acceptance appends the repository mid-turn and the runner clones it (a repeated request returns the same path); required acceptance opens a repository-request question with fixed "Add" / "Don't add" and ends the turn; the decision resumes the session with the clone path or the decline. The implementer was cut off twice by an API safeguard false positive; final verification was run by the orchestrator: typecheck of core, agent-runner, server and web; tests core 447, agent-runner 74, web 231, server 3313; cloud-agent-runs Postgres suites and migration invariants 122/122 on an isolated container.
