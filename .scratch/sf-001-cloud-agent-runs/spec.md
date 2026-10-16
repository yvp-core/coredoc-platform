# SF-001 — Cloud agent runs: Jira ticket to draft pull requests

Status: ready-for-agent. Implementation beyond Phase 0 starts only after the
acceptance gate in the Implementation plan.

Last reviewed: 2026-10-08

Source: the SF-001 design draft of 2026-10-07, revised on 2026-10-08 to run the
agent in its own runner pod that holds only the customer's credentials. Every
behavioural deviation from the draft is listed under Further Notes.

## Problem Statement

Product owners at an on-prem Coredoc customer write PRDs into Jira issue
descriptions. Turning one PRD into working code today takes an engineer who
works out which of the workspace's roughly forty repositories are affected,
writes a specification, gets it reviewed, implements it across one to five
repositories, and opens pull requests. The customer has standardised that
process in the external `coredoc-workflows` Claude Code plugin (PRD, spec, plan
review, implement, review, git delivery), but the plugin only runs in an
engineer's interactive session. Nothing runs it against a ticket without
someone at the keyboard.

The customer wants a ticket to travel from PRD to reviewable pull requests
without an engineer driving each step, while people keep control of the
decisions that matter: what the scope is, how ambiguities are resolved, and
what gets merged. Their constraints are firm:

- Source code stays inside their infrastructure. The only party outside it
  that sees file contents is the model API, under their own API key.
- Jira must not become the place where technical questions, spec reviews or
  fixes are discussed. It should see a trigger, the status changes the
  workspace configures, and one comment with the result.
- Every human decision happens in the Coredoc web app, where the workspace
  graph, product intent and the run's details already live.
- Clarifying questions either wait for a person or are resolved on stated
  assumptions, configurable per workspace and per run.
- The agent works with a restricted service account and cannot merge into
  protected branches. Ticket text and repository content are untrusted.

## Solution

Coredoc gains **agent runs**. A product owner adds the workspace's trigger
label (default `coredoc-agent`) to a Jira issue whose description is a PRD, or
a workspace member starts a run from the web app with the issue key. Within a
minute Coredoc creates the run and, when the workspace has capacity, queues
its first turn.

The work itself happens in an **agent runner**: a pod the customer runs next
to Coredoc, from an image Coredoc publishes. The runner holds only the
customer's own credentials — the Anthropic API key and the GitHub token of a
restricted bot account — and talks to Coredoc over HTTPS with a narrow runner
token. It claims turns, runs Claude Code with the plugin, reports events and
questions, and does all git work. Coredoc's server never executes agent or
repository code, and the runner never holds Coredoc's secrets.

A run has three phases:

1. **Scope.** An agent session with no repository on disk, only the PRD and
   the Coredoc MCP over the whole workspace graph, runs the plugin's spec
   route. It checks the PRD's claims against the graph and proposes a scope:
   the specification, each affected repository with the reason, a merge order,
   and the risks. A member accepts the proposal in the web app or requests
   changes and gets a new version. A workspace can instead choose automatic
   acceptance.
2. **Implement.** A fresh agent session works in clones of the accepted
   repositories, side by side. It runs the plugin's implement and review
   steps. When it needs a decision it asks: under the pause policy the run
   waits for a person to answer in the web app; under the assume policy the
   agent records an assumption and continues. Every turn ends with a commit
   pushed to the run branch `coredoc/<ISSUE-KEY>` in each touched repository,
   so no work lives only inside the runner.
3. **Delivery.** The runner opens one draft pull request per touched
   repository with a title and body Coredoc assembles. Coredoc verifies each
   pull request, posts one Jira comment with the links in merge order, and
   moves the issue to the configured status.

The run page shows the timeline, spend against budget, the pending question or
scope review, every spec version, the repositories and the pull requests.
Members answer, accept, request changes, cancel and re-run from there. A
failed run posts one Jira comment with the reason. The feature is built for
on-prem first: an optional agent runner Deployment in the Helm chart, with its
own image and Secret, which customers derive to add their toolchains.

## User Stories

### Starting runs

1. As a product owner, I want to start an agent run by adding the configured trigger label to a Jira issue that holds a PRD, so that I can request an implementation without leaving Jira.
2. As a product owner, I want Jira to stay quiet while the run works, with no comments for questions or reviews, so that the ticket stays readable for the team.
3. As a product owner, I want to add `coredoc-repo:<repository key>` labels to name repositories I already know are affected, so that the agent starts from known ground.
4. As a product owner, I want a mistyped repository label to fail the run immediately with the reason in one Jira comment, so that I can fix the label instead of waiting for a wrong scope.
5. As a product owner of an epic-shaped PRD, I want the run to read the epic and its child issues as one PRD, so that stories split across child issues are not lost.
6. As a workspace member, I want to start a run from the web app with an issue key and optional policy overrides, so that I can run tickets without touching Jira labels.
7. As a workspace member, I want a second run for the same issue refused while one is active, so that two agents never work one ticket at once.
8. As a product owner, I want a finished, failed or cancelled run never to restart because the label is still on the issue, so that finished tickets do not silently start paid work again.
9. As a workspace member, I want to re-run a finished, failed or cancelled run from its page, so that a deliberate retry takes one click.
10. As a workspace admin, I want runs beyond the workspace's concurrency limit to wait in a visible queue and start oldest first, so that cost and review load stay bounded without dropping requests.
11. As a workspace admin, I want only issues in the Jira projects configured on the workspace's Jira connector to trigger runs, so that labels in unrelated projects cannot start work.
12. As a workspace admin, I want no run created, started or acted on while the license is expired, with queued runs waiting for renewal and started runs failing at their time or waiting limit, so that an expired license stops new spending without hiding existing runs.

### Scope

13. As a reviewer, I want the agent to scope the work against the whole workspace graph before any repository is cloned, so that the affected repositories come from evidence rather than guesses.
14. As a reviewer, I want each scope proposal to contain the spec, every repository with the reason it is affected, the merge order and the risks, so that I can judge the plan in one place.
15. As a reviewer, I want the PRD's claims checked against the graph and the unverifiable ones marked, so that I can see where the PRD may be wrong.
16. As a reviewer, I want to accept a proposed scope in the web app, so that implementation starts only after a person agreed with the plan.
17. As a reviewer, I want to request changes in free text and receive a new spec version that addresses them, so that I can steer the scope without writing the spec myself.
18. As a reviewer, I want to see every spec version and the feedback that produced it, so that I understand how the scope evolved.
19. As a reviewer, I want an attempt to accept an outdated version refused with a message, so that I never accept something I have not seen.
20. As a workspace admin, I want automatic scope acceptance available per workspace and per run, so that trusted, low-risk work can flow without a review step.
21. As a reviewer, I want accepting a run's scope to leave all product intent candidates for Intent review, so that intent still goes through its own review.
22. As a reviewer, I want repositories named by labels that the agent left out of its proposal listed with its reason, so that I can see why known ground was dropped.

### Questions and assumptions

23. As a reviewer, I want the agent's clarifying questions shown in the web app with their options, descriptions and a free-text "Other", so that I can answer in context.
24. As a reviewer, I want my answer, whenever I give it, to resume the same agent session where it stopped, so that answering later loses nothing.
25. As a reviewer, I want each question answerable exactly once, with a second answer refused, so that the agent never receives conflicting answers.
26. As a workspace admin, I want a policy under which the agent never waits and records its assumptions instead, so that runs can complete unattended.
27. As a reviewer, I want every assumption the agent made listed on the run page and in the pull requests, so that I can check the decisions nobody was asked about.
28. As a workspace admin, I want a run that waits for a person longer than the configured limit to fail with that reason, so that forgotten questions and reviews do not hold a slot forever.
29. As a reviewer, I want a run whose agent stops twice in a row without finishing to fail with the agent's last message as its reason, so that I can see what it was stuck on.
30. As a reviewer, I want the agent's request for an extra repository to need my consent when scope acceptance is required, so that the agent cannot widen an accepted scope on its own.
31. As a product owner, I want the product questions my PRD leaves open listed in the scope proposal as candidates for the PRD, never decided by the agent, so that the reviewer settles them before implementation starts.

### Implementation

32. As a reviewer, I want implementation to happen only in the accepted repositories, on a branch named after the issue, so that the work is easy to find and bounded.
33. As a developer, I want every agent turn to end with a pushed commit on the run branch, so that I can watch progress and nothing is lost between turns.
34. As a developer, I want the agent to set each repository up from the repository's own instructions, lockfile and package scripts, so that changes build and test the way a person's would.
35. As a developer, I want the agent to follow each repository's own agent instructions and run the plugin's review per repository, so that code is reviewed before it reaches me.
36. As a reviewer, I want a run that exceeds its spend or time budget to stop and fail clearly while keeping the work already pushed, so that overruns are visible and recoverable.
37. As a developer, I want changes to files under `.github/workflows` withheld from every push and shown on the run page as a diff for a person to apply, so that the bot account never needs permission to change workflows.
38. As a developer, I want my own push to an active run branch to fail the run with that reason rather than be overwritten, so that my commits are never lost.
39. As a developer, I want the repositories the agent could not build or test in the runner marked on the run page and in their pull requests, so that I test those myself.

### Delivery

40. As a developer, I want one draft pull request per touched repository, against that repository's default branch, so that I review the change in my normal workflow.
41. As a developer, I want each pull request to say what it changes in that repository, the merge order across repositories, the assumptions made, and to link the run page with the full spec, so that I can review without hunting.
42. As a developer, I want commits made during a run marked as co-authored by Claude, so that the history is honest about how they were produced.
43. As a product owner, I want exactly one Jira comment listing the pull requests when the run is done, and the issue moved to the configured status, so that Jira reflects the outcome without noise.
44. As a product owner, I want exactly one Jira comment with the reason when a run fails, so that I know a retry or a fix is needed.
45. As a developer, I want a retried delivery never to open duplicate pull requests or post duplicate comments, so that infrastructure retries stay invisible.
46. As a product owner, I want an unavailable or rejected Jira transition recorded as a warning rather than failing a run whose pull requests are open, so that workflow quirks do not throw away finished work.
47. As a team, I want agent pull requests linked to the Jira issue's delivery task like any other pull request on the issue's branch, so that Delivery analytics counts them.
48. As a team, I want agent-written pull request text never to mention other ticket keys in a form that links them, so that Delivery analytics does not credit unrelated tasks.

### Run page

49. As a reviewer, I want a run list showing issue, status, phase, how the run started, spend and pull requests, so that I can see all agent work at a glance.
50. As a reviewer, I want a run page with the timeline, a checklist of the agent's current tasks, spend against budget, the pending question or scope review, the repositories and the pull requests, so that I can follow a run end to end.
51. As a reviewer, I want the run page to say explicitly when spend is unknown or partial, so that I never mistake missing data for zero.
52. As a reviewer, I want the run page to say when a run is waiting for an agent runner and since when, so that I can tell a stalled deployment from a slow agent.
53. As a reviewer, I want the run page to refresh by itself while the run is active, so that I do not have to reload.
54. As a reviewer, I want pull requests and Jira comments to deep-link to the run page, so that I can jump from any surface to the details.
55. As a workspace member, I want to cancel a run at any point, including during delivery, so that a wrong direction stops immediately.
56. As a workspace member, I want a failed run's reason in plain words, so that I can decide whether to re-run or fix the input.
57. As a reviewer, I want the agent's raw tool activity collapsed by default but available, so that the timeline stays readable.
58. As a reviewer, I want agent-written text on the run page shown without loading remote images or other remote content, so that opening a run cannot leak data to an outside server.

### Administration

59. As a workspace admin, I want an Agent runs settings panel to enable the feature and set the trigger label, done status, policies, budgets, waiting limit, repository cap and model, so that the feature fits my team.
60. As a workspace admin, I want the panel to tell me exactly why agent runs are unavailable, such as no object storage, no encryption key or a missing connector, and to show separately when a runner last claimed work, so that I can fix the deployment.
61. As a workspace admin, I want Jira-triggered runs to act as the admin who enabled agent runs, and to be refused with a clear reason if that person is no longer a member, so that every run has an accountable Coredoc identity.
62. As a workspace admin, I want the Agent runs navigation entry to appear only where the feature is enabled or runs exist, so that other workspaces are not confused.
63. As a workspace admin, I want to create and revoke runner tokens for my workspace, so that I control which runners may take its work.

### Operations

64. As an on-prem operator, I want to enable an agent runner in the Helm chart with its own image, Secret, resources and scratch volume, so that agent runs do not affect the API or regular jobs.
65. As an on-prem operator, I want the agent runner pod to receive none of Coredoc's database, storage, encryption, OAuth or license secrets, so that a compromised agent cannot reach the platform.
66. As an on-prem operator, I want documented instructions for deriving the runner image with my repositories' toolchains, so that the agent can build and test our code.
67. As an on-prem operator, I want a complete egress list for the runner and an optional NetworkPolicy in the chart, so that the runner's direct connections are limited to what it needs.
68. As an on-prem operator, I want the runner to log its versions at start, report them with every claim, and claim nothing while its plugin, SDK or bot account is unusable, so that a broken runner makes runs wait visibly instead of failing at random.
69. As an on-prem operator, I want run events and session archives pruned after a retention window while human answers, reviews and specs are kept, so that storage stays bounded without losing decisions.
70. As an on-prem operator, I want the runner image signed and shipped in the air-gap kit like the server image, so that it follows our supply-chain process.
71. As an on-prem operator, I want the install documentation to state plainly that file contents are sent to the model API, so that our data-handling review is accurate.
72. As an on-prem operator, I want the install guide to explain that pushes and draft pull requests run the repositories' existing CI on agent-written code, so that I keep CI secrets away from agent branches.

### Security

73. As a security reviewer, I want ticket text and repository content treated as untrusted input that cannot widen what the runner's credentials allow, so that prompt injection is contained by credential scope.
74. As a security reviewer, I want the runner pod to be the isolation boundary, holding only the model key, the bot's GitHub token and the runner token, so that the worst case is bounded by those three credentials.
75. As a security reviewer, I want the bot account to have the Write role only, a fine-grained token without Workflows or Administration permission, and the runner to refuse to work when the bot is an admin or maintainer, so that a misconfigured account is caught before it can bypass branch protection.
76. As a security reviewer, I want the runner token refused everywhere except the runner API of its own workspace, so that a stolen runner token cannot read the workspace, accept scopes, answer questions or change settings.
77. As a security reviewer, I want Coredoc to verify every pull request the runner reports before recording it or linking it from Jira, so that a compromised runner cannot post arbitrary links.
78. As a security reviewer, I want a secret scan before every push, so that credentials found or created during a run are not published.
79. As a security reviewer, I want the agent's Coredoc MCP token to be MCP-only, short-lived, least-privilege, minted per turn and revoked when the turn ends, so that a leaked token is of little use.
80. As a security reviewer, I want only human sessions to read or act on runs through the run API, so that no service token, including a runner's, can steer the agent.
81. As a security reviewer, I want secrets redacted from run events before they are stored, so that the run page never shows a credential the agent read.

### Engineering

82. As a desktop user, I want desktop's own agent runs to behave exactly as before, so that the cloud feature carries no risk for desktop.
83. As a Coredoc engineer, I want the server's run logic testable end to end with a scripted fake runner, and the runner testable against a fake Coredoc API with a scripted fake agent, so that state-machine and git changes are safe without model calls.
84. As a Coredoc engineer, I want the plugin behaviour the runner relies on written down as a contract with the plugin version that meets it, so that plugin changes for remote agents do not break runs silently.

## Implementation Decisions

### Scope decision and trust boundary

- This spec is the explicit scope decision that the repository's simplicity bar
  and guardrails require for a new runner protocol, new tables, a new approval
  flow, and untrusted execution. Ticket text, agent-written code and the target
  repositories' own build and test scripts run under the direction of
  untrusted input. That happens only in the customer's agent runner pod, never
  in a Coredoc server process. It needs a maintainer's acceptance (see the gate
  in the Implementation plan).
- **The runner pod is the boundary.** It holds exactly three credentials: the
  customer's Anthropic API key, the bot account's GitHub token, and the
  workspace's runner token. Everything inside the pod — the runner process,
  Claude Code, hooks, Bash, the repositories' scripts — is treated as one
  trust zone that the agent controls. Containment comes from the scope of
  those three credentials and from the pod's network policy, not from
  sandboxing inside the pod.
- **The worst case**, a fully prompt-injected agent, can:
  - use the customer's model key directly, or send it out through an allowed
    host, so its spend is bounded by the key's provider-side limit, not by the
    run's budget;
  - do what the bot's token allows: push to unprotected branches of the
    repositories it covers, open and comment on pull requests, and merge only
    where branch rules let a Write-role account merge;
  - act as a runner of its workspace: claim queued turns, post events,
    questions, proposals and results, upload archives.

  It cannot reach Coredoc's database, storage, encryption key or connector
  credentials, read the workspace through the REST API, accept a scope, answer
  a question or change settings. The server posts to Jira only fixed text and
  links it verified. Human decisions stay with human sessions on the server.
- The run preamble's rule to treat ticket and repository text as data is a
  courtesy, not a control.
- Supported deployment: on-prem, with Jira Cloud and repositories in GitHub
  organisations on github.com or GitHub Enterprise Server. The pilot uses Jira
  Cloud and a single GitHub organisation on github.com.

### Components

- **Server, cloud agent runs module.** Split per house convention into an API
  module (the human run API, the runner API and their guards), a core module
  (run service and state machine, turns and leases, settings, availability,
  ADF conversion, pull request body assembly) and a worker schedule module.
  The worker schedule module holds three scheduled jobs: the trigger cron, the
  run sweep and the retention sweep. The existing desktop telemetry module for
  agent runs is not touched.
- **Agent runner.** A new app in the monorepo, released as its own image. A
  long-running process that polls Coredoc for turns, runs Claude Code through
  the Agent SDK with the plugin, bridges questions and run-control tools to
  the runner API, does all git and pull request work with the bot's token, and
  uploads the session state archive. It pins its own SDK version; desktop and
  the CLI keep theirs.
- **Runner protocol contract.** The runner API's request and response schemas
  live in a shared package that both the server and the runner import, so the
  two sides cannot drift.
- **Web app.** An Agent runs list and detail route, and an Agent runs settings
  panel.
- **Reused.**
  - The Jira Delivery analytics connector supplies Jira credentials and
    coordinates; the Jira client gains write methods.
  - The GitHub Delivery analytics connector supplies the host and organisation
    for repository resolution, and its read-only token verifies pull requests
    through the existing strict pull read. The server makes no GitHub writes.
  - Service tokens (a new runner scope), the cloud MCP, the object storage
    service and the shared retention helpers are used as they are.
- **Desktop and the CLI are unchanged.** The runner owns its Claude adapter,
  started from a copy of desktop's message, question and result mapping.

### Run lifecycle

- **Phases:** scope, then implement, then delivery.
- **Turn:** one unit of runner work, recorded as a turn row. Scope and
  implement turns are one agent session invocation (the first of a phase, or
  a resume), plus at most one in-turn re-invocation after a blocked secret
  scan. A delivery turn has no agent.
- **Statuses:** `queued`, `scoping`, `awaiting_answer`,
  `awaiting_scope_acceptance`, `implementing`, `delivering`, `done`, `failed`,
  `cancelled`. The run's `phase` tells which phase an `awaiting_answer`
  belongs to.
- **One turn at a time.** A partial unique index allows at most one queued or
  claimed turn per run.
  - Every runner request about a turn, reads included, is fenced on the turn
    id plus the claim's lease token, checked against the turn row locked for
    update. A request with a stale lease gets 409 `LEASE_LOST` and the runner
    stops the turn.
  - A runner that loses its lease (expired, or the run became terminal) kills
    the agent's process tree, skips pushes and stops.
- **Terminal statuses** (`done`, `failed`, `cancelled`) are enforced by one
  shared precondition on state-advancing writes: status, questions, spec
  versions, repositories and new turns.
  - Every transition to a terminal status, in the same transaction, marks the
    run's queued or claimed turn `abandoned` and deletes its MCP token. Claim
    selects only turns of non-terminal runs, and lease expiry ignores turns
    of terminal runs, so a terminal run never gets a new code or new work.
  - A runner write that finds the run terminal records only the turn's own
    facts (events, spend, versions, completion, and pull requests a delivery
    turn already opened) and is told to stop.
- **Turn completion.** During a turn, run-control calls only record their
  payload:
  - `propose_scope` stores a draft version the human API does not show;
  - `request_repo` and `submit_result` store the request or the result;
  - `propose_scope` exists only in scope turns, and `request_repo` and
    `submit_result` only in implement turns.

  Two state changes happen mid-turn, both fenced by the lease and the
  terminal precondition: `awaiting_answer`, when the agent asks under the
  pause policy (the turn then ends), and appending a repository through
  `request_repo` under automatic acceptance (the turn continues). Everything else happens in
  one transaction when the runner completes the turn, after its pushes and
  its archive upload. That transaction records the archive key, spend,
  outcome and pushed heads, publishes any draft version, opens any
  repository-request question, sets the next status and queues the next turn.
  A repeated completion of an already completed turn is a no-op.
- **Human actions that need a turn** (an answer, accept, request changes, a
  repository decision) store the decision first, then queue the next turn
  only if the run has no queued or claimed turn. If a turn is still
  completing, its completion transaction finds the stored decision and queues
  the turn instead. Exactly one turn is queued.

| From | Event | To | Effect |
| --- | --- | --- | --- |
| (new) | Jira trigger or manual start passes validation | `queued` | Run row created; label or request repositories stored as seeds |
| (new) | A Jira-triggered run fails validation at creation | `failed` | Code and reason recorded; failure comment by the sweep |
| `queued` | A concurrency slot is free and the feature is enabled and available (at creation, or when the trigger cron promotes the oldest queued run) | `scoping` | First scope turn queued |
| `scoping`, `implementing` | Agent asks under the pause policy | `awaiting_answer` | Question opened; the turn ends |
| `awaiting_answer` | A member answers a clarification | `scoping` or `implementing` | Resume turn queued with the answer |
| `scoping`, `implementing` | Agent asks under the assume policy | unchanged | Runner answers at once; the turn continues |
| `scoping`, `implementing` | Turn ends without an outcome, the first time in a row | unchanged | Resume turn queued with the nudge |
| `scoping`, `implementing` | Turn reaches the duration limit or the SDK turn cap | unchanged | Work pushed; continuation turn queued |
| `scoping` | Turn ends after a valid proposal; acceptance required, or automatic with a repository not eligible or open candidates for the PRD | `awaiting_scope_acceptance` | Version published as `proposed` |
| `scoping` | Turn ends after a valid proposal; acceptance automatic, every repository eligible and no candidates for the PRD | `implementing` | Version accepted by the system; first implement turn queued |
| `awaiting_scope_acceptance` | A member accepts the latest version | `implementing` | First implement turn queued (new session) |
| `awaiting_scope_acceptance` | A member requests changes | `scoping` | Scope session resumed with the feedback |
| `implementing` | `request_repo` under automatic acceptance (mid-turn) | `implementing` | Repository appended; the runner clones it and the turn continues |
| `implementing` | Turn ends after `request_repo` under required acceptance | `awaiting_answer` | Repository request question opened |
| `awaiting_answer` | A member answers a repository request | `implementing` | "Add": repository appended and cloned next turn; "Don't add": resume with the decline |
| `implementing` | Turn ends after `submit_result`, the push succeeded and at least one repository was touched | `delivering` | Delivery turn queued |
| `implementing` | Turn ends after `submit_result` and no repository was touched | `failed` | `no_changes` |
| `delivering` | The delivery turn completes with every pull request verified | `delivering` | Done comment and transition handed to the sweep |
| `delivering` | The done comment and the transition outcome are recorded | `done` | Transition problems become warnings |
| any non-terminal | Budget, wall clock or waiting limit exceeded; second outcome-less turn; second scan block; permanent error; a turn lost its runner three times | `failed` | Code and reason recorded; queued or claimed turn abandoned; failure comment by the sweep |
| any non-terminal | A member cancels | `cancelled` | Queued or claimed turn abandoned; the runner is told to stop at its next heartbeat; open questions cancelled |

- **Turns that end without an outcome.** An outcome-less turn ends without a
  run-control call and without a question. It is resumed once with a nudge:
  - under pause: "finish with `propose_scope` or `submit_result`, or ask
    through AskUserQuestion";
  - under assume: "finish on stated assumptions and list them".

  The outcome-less count tracks consecutive outcome-less turns. It resets
  after any turn that ends with a run-control call or a question, and
  checkpoint turns neither count nor reset it. A second outcome-less turn in a
  row fails the run with `no_outcome` and the agent's last message as the
  reason.
- **Checkpoints.** Reaching the maximum turn duration, or the SDK's turn cap
  (a high fixed runaway guard, not a setting), is a checkpoint, not a failure.
  The work is pushed and a continuation turn is queued with "continue where
  you stopped". The run's spend and active-time budgets bound how many
  checkpoints happen.

### Starting runs: Jira trigger and manual start

- **Trigger cron.**
  - Runs every minute, for each workspace where agent runs are enabled and
    available.
  - Jira-triggered runs need at least one valid project key on the
    workspace's Jira connector. With none, the cron searches nothing, and
    settings show the reason.
  - Otherwise it runs one bounded JQL search through the connector: the
    project keys, AND the trigger label, AND `updated >= "-1d"`. The label and
    the relative date are quoted, as Atlassian's JQL reference recommends. The
    query is never issued without the project clause.
  - It reads id, key, summary, labels, issue type, status and updated, using a
    search option that leaves out changelog expansion.
- **Deduplication.**
  - A run is created only for an issue that has never had a run in the
    workspace. The key is the immutable Jira issue id, because the issue key
    changes when an issue moves between projects.
  - A partial unique index allows at most one non-terminal run per workspace
    and Jira issue id.
  - The trigger cron and the sweeps run in every all-role API replica and in
    every worker. So run creation of every kind (trigger, manual, re-run), the
    "never had a run" check, the count of started runs and promotion all run
    in one transaction under a per-workspace advisory lock with its own key
    namespace.
- **No restart from the label.** A label never restarts an issue that already
  had a run. The label stays on the issue and Coredoc's own comment bumps
  `updated`, so restarting would loop. Re-running is a deliberate web action.
- **Repository key.** The durable key the intent tools use: the repository's
  `key` in its Coredoc configuration, or its name when none is set (for
  example `orders-api`). It is not the 12-character graph hash.
  - The settings panel lists each repository with its key and eligibility.
  - A repository is eligible when it has a durable key and the shared resolver
    (see GitHub integration) maps it to the workspace's GitHub connector.
  - A repository without a durable key is shown as not eligible, with the
    remedy (push again with a current CLI or desktop, or set the key).
- **Seeds.** `coredoc-repo:<repository key>` labels, or the repository keys of
  a manual start, become the run's seeds. A seed that is unknown, ambiguous or
  not eligible fails a Jira-triggered run at creation
  (`invalid_repository_label`). More seeds than the repository cap fail it
  with `too_many_repositories`.
- **PRD freshness.** The PRD text is read when each scope turn is claimed, not
  at creation.
- **Manual start.** Takes an issue key, optional policy overrides and optional
  repository keys.
  - The issue must be readable through the connector and belong to one of the
    connector's configured project keys; otherwise the answer is 400
    `ISSUE_NOT_READABLE`.
  - Unknown or ambiguous keys get 400 `UNKNOWN_REPOSITORY`, and too many get
    400 `TOO_MANY_REPOSITORIES`; no run is created.
  - It is refused with `ACTIVE_RUN_EXISTS` while the issue has a non-terminal
    run.
- **Re-run.** Creates a new run for the same issue from a terminal run, and
  starts at `queued` with new session ids.
  - It copies the previous run's policies and seeds, and takes budgets and the
    model from current settings.
  - It never touches the previous run's pull requests; its own pull request
    bodies link the previous run.
- **Concurrency.** At most N started, unfinished runs per workspace, meaning
  every status except `queued` and the terminal ones. Runs waiting for a
  person keep their slot.
  - Further runs wait in `queued` and start oldest first, and manual starts
    queue the same way.
  - The trigger cron promotes queued runs only while the feature is enabled and
    available. Otherwise queued runs stay queued with the reason shown, and can
    be cancelled.
- **License expiry.** While the license is expired, nothing creates or promotes
  runs, as connector sync already behaves. The global license guard refuses
  every API write, so members cannot cancel, answer, accept or re-run, and
  runners cannot claim or report. Queued runs stay queued and are promoted
  after renewal. Started runs fail at the active-time limit, and runs waiting
  for a person fail at the waiting limit. The "can be cancelled" clause under
  Concurrency applies to every other kind of unavailability.

### Run owner and Coredoc credentials

- **Run owner.** Every run acts as one current, non-pending workspace member:
  - Manual starts and re-runs act as the member who started them.
  - Jira-triggered runs act as the admin recorded as run owner in the
    settings. That is recorded when agent runs are switched from off to on, or
    when an admin explicitly takes over ownership. Saving other settings never
    changes it.
  - If the recorded owner is no longer a member, the trigger cron creates no
    runs and settings show the reason until an admin takes over.
  - The Jira account that added the label is not resolved to a member in v1.
- **Runner token.** A service token minted by an admin in a human session
  with a new `agent-runner` token scope, whose curated permission set is one
  new runner permission. It is bound to one workspace.
  - **Exact-purpose fence.** Like the existing telemetry fence, a token whose
    permissions are exactly the runner permission is refused by the auth
    guard on every route that does not require that permission, and refused
    by the MCP middleware on both its paths. So it works only on the runner
    API.
  - The runner permission joins the wildcard-exempt permissions, so a legacy
    grant-all token never passes a runner route, and a service token can never
    reveal a runner token.
  - Like every service token, it acts through its creator's current
    membership. If the creator leaves or is demoted below admin, its requests
    are refused and settings show the reason until an admin mints a new one.
  - **Runner seen.** The module records the time and reported versions of the
    last successful claim or heartbeat per runner token, and settings show
    that. The token's own last-used time is stamped before guards run, so it
    is not used.
  - Revoking it stops that runner at its next request.
- **Per-turn MCP token.**
  - When a scope or implement turn is claimed, the server mints a service
    token for the cloud MCP with the run owner as its creator and returns it
    once in the claim response.
  - Service tokens gain a nullable owning-turn column. A token with it is
    accepted only by the MCP middleware, is left out of the workspace token
    list, and is written hash-only, with no revealable copy, through a
    dedicated write; the general token path keeps an encrypted copy that
    admins can reveal. Its name is derived from the turn id, and cleanup
    deletes by owning turn, never by name.
  - It expires at the maximum turn duration plus 15 minutes, and is deleted
    when the turn completes, when its lease expires, and when the turn is
    abandoned.
  - MCP tool availability, the role-based intent rollout and usage
    attribution therefore follow the run owner. Intent proposals the agent
    makes are recorded as service-token actions of the run owner.
- **Permissions.**
  - Scope turns: intent read only. Proposing intent while scoping a PRD could
    overwrite candidates the product owner's tooling created.
  - Implement turns: intent read and intent propose, for successor candidates
    when implementation contradicts accepted intent.
  - Graph and cross-repo MCP tools need no permission. Granting graph read
    would only open the REST graph routes, so it is not granted.
- **How the MCP token reaches Claude Code.** Only inside the session's MCP
  server configuration, under the server key `coredoc` (the plugin recognises
  Coredoc tools by that name segment). That configuration sets a per-server
  tool-call timeout (2 minutes), because the SDK's default leaves MCP calls
  effectively unbounded.
- **Intent limits.** Under a service token, intent handoff saving, intent
  review and tree edits are refused. The agent can read intent and propose
  candidates, nothing more. Accepting a run's scope accepts no intent
  candidate; candidates wait for Intent review.
- **Jira credentials** stay in the workspace's Jira Delivery analytics
  connector and are used only by the server.
- **GitHub and model credentials** are the customer's own and live only in the
  runner's Secret (see Agent runner pod and tool policy). Coredoc never stores, supplies, resells
  or proxies model access, and the bundled Claude Code runs unmodified.
  Subscription OAuth tokens are not supported (see Further Notes).

### Turns, leases and the runner API

- **Turn row.** Run, workspace, ordinal, kind (`scope`, `implement` or
  `delivery`), input text (an answer, review feedback, a nudge, a
  continuation, a repository notice), state (`queued`, `claimed`,
  `completed`, `abandoned`), attempt count, lease token and expiry, the runner
  token that claimed it, outcome, spend, and the versions the runner reported.
- **Why not the job queue.** Agent turns are executed outside the server, so
  the server's job processor would never run them. A turn row gives the
  one-turn-per-run invariant as an index, keeps the regular worker unaware of
  agent work, and gives the run page per-turn spend and outcomes.
- **Claim.** The runner polls `claim` every 5 seconds while idle, sending its
  protocol and component versions. A runner whose protocol version the server
  does not support is refused with `RUNNER_INCOMPATIBLE`, and settings show
  why. The server picks the oldest queued turn of a non-terminal run in the
  token's workspace with a skip-locked row claim, sets a new lease token and an expiry 2 minutes out, and returns the
  turn's assignment:
  - run id, kind, phase, policies, the model, remaining spend, limits, the
    phase's predetermined session id, and the run page URL;
  - the PRD markdown (scope), the accepted spec markdown and its acceptance
    record (implement), and the input text;
  - each repository with its HTTPS clone URL from the shared resolver, merge
    order, run branch and whether this run created it;
  - the per-turn MCP token and the internal MCP URL;
  - for delivery, the assembled pull request title and body per repository;
  - whether a state archive exists to download.

  Before returning a scope or implement turn, the server re-checks the
  run-level conditions (run owner still a member, connectors active, the
  issue still in a configured project, every repository still eligible) and
  fails the run with the matching code instead of returning it.
- **Heartbeat.** Every 20 seconds the runner extends its lease. The response
  says `stop` when the run is terminal or the lease is no longer this
  runner's, and the runner stops within one heartbeat.
- **Reports during a turn**, all fenced by the lease:
  - events, in batches, which the server redacts and numbers;
  - a question;
  - `propose_scope`, `request_repo` and `submit_result`, validated by the
    server; validation errors go back to the agent as tool errors;
  - a branch reservation before the runner's first push of a run branch,
    which records "created by this run"; a retried attempt that finds that
    branch on the remote continues on it.
- **Archive.** It holds only Claude Code's config and session directory and
  the plugin's state home; tool caches and installed dependencies live in a
  per-turn home outside it. The runner downloads the previous archive at turn
  start, with the live lease, and uploads the new one before completing, as a
  raw binary body on a route with its own body-size tier, sized from Phase 0
  (the parser tarball upload is the prior art; its 500 MiB tier is not
  reused). An archive over the cap fails the run with `archive_too_large`.
  The server stores it under a new key with a create-only write and deletes
  the previous archive after the completion transaction commits. The runner
  extracts only regular files and directories whose paths stay inside the
  state directory.
- **Complete.** One request with the outcome, spend (or unknown), versions,
  pushed heads, withheld paths, repositories that could not be built or
  tested and, for delivery, the pull requests opened or reused. It runs the
  completion transaction.
- **Lease expiry.** The run sweep handles a claimed turn of a non-terminal run
  whose lease expired, and deletes its MCP token:
  - if the run is already `awaiting_answer` with an open question from this
    turn, the turn is completed as paused; the answer queues the next turn
    under the usual rule;
  - otherwise the turn goes back to `queued` with the attempt count raised,
    and the third expiry abandons it and fails the run with `runner_lost`.

  A re-claimed turn starts again from the previous archive and the remote
  branches.
- **Guards.** Runner routes accept only service tokens that carry the runner
  permission and belong to the path's workspace; a small token-only guard
  refuses human sessions, because the permissions guard passes human sessions
  through. Human routes refuse every service token.
- **Runner reports are untrusted.** The server validates every payload against
  the run's state and the shared contract, and verifies pull requests itself
  (see Delivery).
  - Per-turn caps: 5,000 events and 8 MiB of event payload, 10 proposals, 20
    questions. Exceeding one fails the run with `report_limit_exceeded`.
  - Runner routes have a per-token request rate limit.
  - Spend is self-reported. A run with three turns of unknown spend fails with
    `budget_exhausted`, because its budget can no longer be enforced.

### Turn execution in the runner

- **One turn at a time per runner process.** Concurrency comes from replicas.
- **Step 1, claim** a turn as above. A runner whose start-up check failed (see
  Agent runner deployment and image) never claims.
- **Step 2, directories.**
  - Each run has deterministic absolute paths, identical in every turn and in
    every pod: a work directory (the agent's working directory) and a state
    directory (Claude Code's config directory, plus the plugin's state home).
    They must not change, because Claude Code finds a session by
    its working directory and the plugin keys run state by absolute path.
  - A per-turn home and temp directory hold tool caches, git's global
    configuration and anything else written outside the work tree; they are
    not archived.
  - The scratch root sits outside every git work tree, because the plugin and
    git walk upwards. It is the only writable volume in the pod.
  - The state directory is restored from the downloaded archive.
  - The work directory is rebuilt every turn. Scope: the PRD file only.
    Implement: one clone per repository, named by repository, plus the
    accepted spec file and the PRD file outside the clones.
- **Step 3, clone and branch** (implement turns), with the bot's token:
  - Clones are never recursive and keep the default branch and `origin/HEAD`,
    which the plugin's review uses as its diff base.
  - The first turn that touches a repository creates the run branch from the
    remote default branch. If a branch with that name already exists on the
    remote and the assignment says this run did not create it, the run fails
    with `branch_exists`. Later turns check out the remote run branch.
  - Before any session starts, in every turn including scope turns, the
    runner reads each repository the run may touch with the bot's token and
    fails the run with `repository_not_eligible` when GitHub reports admin or
    maintain permission. This catches a misconfigured account; it is not a
    control against a compromised agent.
- **Step 4, run the session.**
  - The first turn of a phase passes the predetermined session id; later
    turns resume it. The runner checks that the session id reported at start
    matches, and fails the run with `session_mismatch` otherwise.
  - It checks at session start that the plugin and its skills are listed and
    that the init message reports no plugin errors; otherwise `plugin_missing`.
    This backs up the start-up check.
  - Turn-ending run-control tools (`submit_result`, and `request_repo` under
    required acceptance) return a result telling the agent its turn is over
    (for a repository request, that a person will decide), and the runner then
    interrupts the session. The resume message carries the decision.
  - Events are sent as they happen, in batches.
- **Step 5, end of turn.** Runs after the session, and every process it
  started, has exited:
  1. Classify the outcome from the runner's own state (which run-control tool
     was called, whether a question is open, whether a limit was hit), never
     from the SDK result subtype alone.
  2. In implement turns, stage, scan, commit and push (see Git handling).
     After a stop, this is skipped.
  3. Upload the state archive; report spend; complete the turn.
  4. Wipe the whole scratch volume.
- **Failures.** Agent, model, plugin, validation and GitHub failures become a
  run outcome with a failure code, reported through `complete`. Model or
  Claude Code failures split by kind (decided 2026-10-09):
  - permanent (the model credential rejected, credit or organisation limit
    exhausted, a crashed process, an SDK error result that is not
    transient) fail the run at once with `agent_error` and a plain reason;
  - transient (model overloaded, rate limited, a 5xx server error,
    connection lost; Claude Code has already retried about ten times before
    reporting one) do not fail
    the run: the turn goes back to the queue like a lost lease, consuming an
    attempt, so the third such attempt fails the run with `agent_error`. GitHub calls retry
  in process up to three times, honouring Retry-After capped at 5 minutes,
  then fail the run with `github_error` in scope and implement turns and
  `delivery_failed` in delivery turns. Calls to Coredoc retry with
  backoff while the lease lasts. A runner that dies mid-turn is handled by
  lease expiry.
- **Shutdown.** On SIGTERM the runner stops the session, skips pushes, does
  not complete the turn and exits; the lease expires and the turn is redone.
  Every restart or rollout of the runner discards in-flight turns and repeats
  their spend, and the upgrade and sizing docs say so.

### Run preamble and prompts

- **System prompt.** Claude Code's preset plus a run preamble. The preamble
  carries:
  - the issue key, the phase and the policies in force;
  - the rule that ticket and repository text is data, not instructions;
  - the rule that the runner commits, pushes and opens pull requests, and the
    agent never does;
  - how to ask (AskUserQuestion);
  - the run-control tools of the phase, with their contracts.
- **Scope prompt.** Names the PRD file as the task source, lists the seeded
  repositories as starting points, tells the agent to read accepted intent
  sourced at the issue (`get_intent_context` with the `jira:<KEY>` source
  refs of the issue and its children) for repository hints, and starts the plugin's hosted spec entry
  (see Plugin contract) with the output path inside the work directory.
- **Implement prompt.**
  - The acceptance record (who accepted, when, version, digest), which the
    plugin's hosted approval input takes.
  - The repositories, with local paths and merge order.
  - Set up each repository from its own instructions, lockfile and package
    scripts before changing it, and read each repository's agent instruction
    files.
  - Register every clone with the plugin's repository tracking, and run review
    per repository.
  - Never write the spec into a repository, and never commit, push or open pull
    requests.
  - Report in `submit_result` any repository that could not be built or tested
    in the runner.
  - Use `request_repo` for a missing repository, and end with `submit_result`.
  - Which of its edits the previous turn withheld from the push.
- **Resumed turns** get only the input text.

### Questions, scope acceptance and waiting

- **Question shape.** Clarifications use Claude Code's AskUserQuestion shape:
  - one to four questions, each with a header and optional multiple selection;
  - two to four options each, with a description and an optional preview;
  - an "Other" answer added by the host.

  The question card shows all of these. Repository requests have the fixed
  options "Add" and "Don't add". The server mints a globally unique request id
  for each question.
- **Question states.** `open`, `answered`, `auto_answered` (assume policy),
  `cancelled`.
- **Pausing.** Under pause, every question ends the turn.
  - Only the main session asks. The runner's pre-tool hook denies
    AskUserQuestion and permission requests from subagents with "return this
    question to the main session".
  - The runner reports the question; the server stores it as `open` and sets
    the run to `awaiting_answer`. The runner then ends the session without
    losing the question.
  - The agent is told the question is parked for a person and the answer will
    arrive as the next message. It is never told the user cancelled (the
    desktop's wording).
  - The mechanism is the pinned SDK's deferral: the pre-tool hook defers the
    AskUserQuestion call, the session ends with the deferred call, and the
    resume turn re-runs that call, which the hook then allows with the answers
    in its input. Phase 0 confirmed this on the pin, including when the same
    message holds other tool calls (they run first). AskUserQuestion is only
    offered when a permission callback is set, so the runner always sets one.
  - A permission callback or hook that times out or errors never lets a
    question through unanswered.
- **Answering.** One compare-and-set moves a question from `open` to
  `answered`, and a second answer is refused. The next turn is then queued
  through the rule under Run lifecycle.
- **Assume policy.** The runner answers at once and reports the question as
  `auto_answered`. The answer reads: "No one is available to answer. Choose
  the option you judge best, continue, and list this decision in the
  assumptions of your next `propose_scope` or `submit_result` call."
  - The assumptions the agent lists are stored on the run and shown on the run
    page and in pull request bodies.
  - The plugin itself never decides product questions; this is the host
    answering the plugin's question.
- **Waiting limit.** A run that waits for a person, in `awaiting_answer` or
  `awaiting_scope_acceptance`, longer than the waiting limit (default 7 days)
  fails with `waiting_expired`. Elapsed time never answers a question.
- **Scope acceptance.**
  - Only the latest proposed version can be accepted or sent back. A request
    against another version is refused with `SPEC_VERSION_STALE`; the web app
    sends the version it displayed.
  - Accepting records who and when.
  - Requesting changes stores the reviewer's text on the version and resumes
    the scope session with it.
- **Who acts.** Any workspace member (owner, admin, member or product) in a
  human session can answer, accept, request changes, cancel and re-run. This
  mirrors intent review, which every member role may perform. Settings changes
  and runner tokens need an admin.

### Scope phase

- **PRD input.**
  - When a scope turn is claimed, the server reads the issue's summary,
    description, labels, type, status and key through the Jira connector.
  - It builds a PRD document with a short header (issue key, link, title)
    followed by the description converted from Atlassian Document Format to
    markdown, and returns it in the assignment; the runner writes it as the
    PRD file.
  - When the issue is an epic, its child issues' descriptions follow in Jira
    rank order (`parent = <KEY> ORDER BY rank`); JQL gives no order otherwise.
    The pilot's PRD tooling splits oversized PRDs into that shape.
  - When the issue is a child of an epic, the epic's description follows as
    shared context, because PRD tooling keeps shared decisions only on the
    epic.
  - An issue that is missing, not visible to the connector, or no longer in a
    configured project fails the run with `issue_not_readable`. Rate limits
    and server errors retry in process up to three times, then fail the run
    with `jira_error`.
  - Epic child issues outside the configured projects are left out.
- **Conversion coverage.**
  - headings, paragraphs, and strong, emphasis, code and link marks;
  - bullet and ordered lists, code blocks, tables (with cell pipes escaped),
    blockquotes, rules and hard breaks;
  - smart links by their URL;
  - status lozenges by their text; emoji by their text, else their short
    name; mentions by their text, else a placeholder;
  - dates from their timestamp as an ISO date, accepting 10-digit and 13-digit
    epoch values;
  - panel and expand contents rendered inline; media as a placeholder;
  - extension nodes rendered from their nested ADF content when they carry
    one (legacy macros do), else as their text; inline cards inside headings
    by their URL; ordered lists keep their start number;
  - any other node degraded to its text.

  Literal markers such as `[unverified]` survive unescaped.
- **`propose_scope`.**
  - Fields: spec markdown (size-capped), title, summary, repositories
    (repository key, reason, what changes there), merge order, risks, intent
    references, assumptions, dropped seeds with reasons, and candidates for
    the PRD: product questions the PRD leaves open, each with what it blocks.
  - Validation, returned to the agent as a tool error to fix:
    - at least one repository;
    - every repository eligible through the shared resolver;
    - every seed either included or listed as dropped with a reason;
    - repositories unique, and the merge order covering every repository;
    - the per-run repository cap respected.
  - A valid proposal becomes a draft version, published at turn completion,
    and supersedes the previous proposed version.
- **Change requests** resume the same scope session with the reviewer's text.
- **Product questions are not asked.** The plugin keeps product choices out
  of AskUserQuestion by design: gaps the PRD leaves open go into the proposal
  as candidates for the PRD. The reviewer settles them at scope acceptance,
  by accepting the scope as it stands or requesting changes with the
  decisions, and a proposal with open candidates is never accepted
  automatically. Only developer-owned questions pause a run, under either
  policy. Decided at the gate on 2026-10-08.

### Implement phase

- **Session.** A new agent session with its own session id starts after
  acceptance. It starts from the accepted spec rather than the scope
  conversation, which holds superseded versions and review feedback, and it
  routes a fresh plugin change run instead of resuming the closed spec run.
- **Work directory.** It holds the clones, the accepted spec file and the PRD
  file. The spec file sits outside every clone, so the agent and the plugin's
  subagents can re-read it after context compaction, and it is never pushed.
- **`request_repo`.** Takes a repository key and a reason.
  - Validated like proposal repositories and against the cap. A repository
    already declined in the run is a tool error. A repository the run already
    has returns its path, so a retried attempt can repeat its request.
  - Automatic acceptance: the server appends the repository (origin
    "request", the agent's reason, merge order last) and returns its clone
    URL; the runner clones it into the work directory and the tool returns its
    path. The turn continues.
  - Required acceptance: a repository request question is opened, whatever the
    questions policy, because a person widens an accepted scope, not the
    agent. The turn ends.
    - "Add" appends the repository and resumes with "repository `<key>` is now
      cloned at `<path>`".
    - "Don't add" resumes with "repository `<key>` was declined; continue
      without it or call `submit_result` noting the gap".
- **`submit_result`.** Takes a summary, per-repository summaries,
  assumptions, the repositories that could not be built or tested, and notes.
  It ends the turn.
  - The run moves to `delivering` only if the end-of-turn push succeeds and at
    least one repository is touched, meaning this run has a recorded push to
    its run branch there.
  - With no touched repository, the run fails with `no_changes`. The run page
    shows the summary and the withheld paths, and the issue is not
    transitioned.

### Agent runner pod and tool policy

- **Pod contents.** The runner process, the pinned SDK (which bundles Claude
  Code), the pinned plugin, git, and the customer's toolchains. Its Secret
  holds the model key (and an optional gateway base URL), the bot's GitHub
  token, and the runner token, plus optional read-only credentials for other
  private package registries.
- **Package registries.** Repositories may keep their own registry
  configuration encrypted (for example SOPS-encrypted `.npmrc` files); the
  runner never decrypts it. Instead it writes a user-level registry
  configuration into the per-turn home before the session: a mapping of
  package scopes to registry URLs from a runner setting, with the bot's
  token for GitHub Packages and any other configured credential. The staging
  rule keeps `.npmrc` files out of commits. GitHub Packages' npm registry
  accepts only a classic token with package read, so installs that use it
  give the bot a classic token (see GitHub integration). Decided 2026-10-09. It receives no Coredoc
  database, storage, Neo4j, encryption, OAuth or license configuration.
- **Pod settings.** Non-root user; a read-only root filesystem, with the
  runner, SDK, plugin and git owned by root; no service-account token
  automount; a scratch emptyDir, the only writable volume, sized per
  concurrent turn; one turn per process. The chart
  ships an optional NetworkPolicy that limits egress to the hosts listed
  under Egress.
- **Between turns** the whole scratch volume is wiped and every process the
  turn started has been killed, so a compromised turn cannot leave code for
  the next run in the pod: it cannot write outside scratch, and scratch does
  not survive the turn.
- **One workspace per runner.** A runner token belongs to one workspace, and
  the bot's token usually to one GitHub organisation. Installs with several
  workspaces run one runner Deployment per workspace.
- **Claude Code environment.** The runner starts Claude Code with an explicit
  environment rather than its own, as hygiene: it keeps the bot's token and
  the runner token out of `env` output, transcripts and commits. It is not a
  boundary, because everything in the pod runs as one user. It contains:
  - PATH from the image; Claude Code's config directory in the state
    directory; home and temp in the per-turn directory; locale; proxy and CA
    variables when set;
  - the model key, and the gateway base URL when configured;
  - Claude Code's opt-outs for non-essential traffic, telemetry, error
    reporting and auto-update, and the Claude.ai connector opt-out;
  - auto-memory off; tool search off, so the question tool is available
    without a search step;
  - the session-end hook budget, long enough for the plugin to suspend its
    run;
  - the plugin's state home, its hosted-mode switch, and its session id set to
    the phase's session id so resumed turns stay attributed.
- **Tool policy.** Owned by the runner, small and explicit:
  - Denied: WebSearch and WebFetch, worktree and scheduling tools. This is
    hygiene, not an egress control: with the model key in hand, the agent can
    call the model API's own server-side tools from Bash (see Limitations and risks).
  - AskUserQuestion is bridged to questions.
  - Everything else is allowed, including Bash, Skill, subagents and the
    `coredoc` MCP tools. The permission mode is set explicitly to `default`,
    and a pre-tool hook applies the policy before Claude Code's own automatic
    approvals.
  - There is no Bash sandbox and no path policy. Inside the pod they would
    protect nothing the agent cannot already reach, and the sandbox would
    need user namespaces in the customer's cluster.
- **Claude Code settings.** Setting sources are disabled, so the target
  repositories' own Claude settings and hooks are not loaded; the prompt tells
  the agent to read their instruction files instead. Only the configured MCP
  servers are used, and the plugin is loaded by path.
- **Run-control server.** The in-process MCP server for `propose_scope`,
  `request_repo` and `submit_result` has a name without a "coredoc" segment
  (for example `agent_run`). Otherwise the plugin counts its calls as Coredoc
  MCP writes. Each tool forwards to the runner API and returns the server's
  validation result.
- **SDK pin.** The runner pins one exact SDK version, chosen in Phase 0, that
  reports plugin errors in its init message (0.3.283 or later), supports
  deferring a pending tool call, and whose hook schema accepts every event in
  the pinned plugin's hooks file.

### Plugin contract (hosted mode)

The `coredoc-workflows` plugin is external and is expected to change for
remote agents. The runner pins a plugin version that provides the following,
switched on by a hosted-mode environment variable the runner sets. Until a
release provides an item, the runner falls back to the prompt instruction
named in brackets. Items without a bracket are prerequisites the pinned
version must meet before the gate. Phase 0 records which items the pinned
version meets.

1. **Spec from a PRD file, without an interview.** A routable entry that takes
   the PRD path and an output path, verifies claims against the Coredoc MCP,
   writes the spec, and lists product gaps as candidates for the PRD instead
   of asking them; only developer-owned questions go through AskUserQuestion.
   [Invoke the spec skill explicitly in PRD-input mode.]
2. **One proposal closes the spec run.** After the spec is written, the
   plugin's workflow run is closed rather than left open for review.
   [Tell the agent to close the run after each proposal.]
3. **External approval.** The implement route accepts an approval record (who,
   when, version, digest) as satisfying its user-approval gate. [Pass the
   record in the prompt with the routing flags Phase 0 settles.]
4. **No git delivery and no pull requests in hosted mode.** Implement and
   review leave changes in the work tree; the runner commits and pushes.
   [Tell the agent never to commit, push or open pull requests.]
5. **Questions only from the main session.** Subagents return questions to the
   main session instead of asking or requesting permissions themselves.
   [A preamble rule, and the runner's pre-tool hook denying AskUserQuestion
   and permission requests from subagents with "return this question to the
   main session".]
6. **Session end suspends the run** within the hook budget, and a resume with
   the same session id continues it. This holds today and stays required.
7. **A secret preflight the host can call** on a work tree and its outbound
   commits, with an explicit git directory, as the current git delivery
   preflight does. This holds today and stays required.
8. **Pinned by release.** Release tags for the versions the runner pins, and a
   Linux launcher for the runner image's platform.

### Git handling

All git work happens in the runner with the bot's token, after the session has
exited. The agent's own git use is limited to reads.

- **Clone URL.** `https://<git origin>/<owner>/<name>.git`, built by the
  server from the repository's normalized remote through the shared resolver.
  The git origin is derived from the GitHub connector's base URL, which is an
  API origin, and is never the API origin itself:
  - github.com: the connector's API base is `api.github.com`, and the git
    origin is `https://github.com`;
  - GitHub Enterprise Server: the API base is `https://<host>[:port]/api/v3`,
    and the git origin is the same scheme, host and port without the
    `/api/v3` path.

  Stored SSH URLs are never used directly.
- **Credentials.** The runner passes the token to each network git command as
  a per-command HTTP authorization setting. It is never written into a remote
  URL or a config file inside the work directory.
- **Staging rule.**
  - tracked modifications and deletions are staged;
  - new regular files are staged when they are under 1 MiB, not ignored, and
    do not look like credentials (`.env`, `.env.*`, `*.pem`, `*.key`,
    `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`,
    `.netrc`, `credentials*.json`);
  - gitlinks, submodule files and LFS or filter-attributed paths are never
    staged;
  - files under `.github/workflows` are never staged, because the bot's token
    has no Workflows permission and GitHub would refuse the push. Their diff
    is sent as a withheld-workflow-diff event, whose payload cap is 64 KiB
    instead of 16 KiB, after passing the same secret scan, for a person to
    apply; above the cap only the paths are shown, with a note;
  - other withheld paths are reported by path only, never by content.
- **Scan.** The plugin's secret preflight runs on the staged change and the
  outbound commits of every changed clone before any clone is pushed.
  - Blocking verdicts are blocked and needs-action with credential findings.
    A binary-file review lists the paths in the pull request body instead of
    blocking.
  - If any clone is blocked, nothing is pushed and the runner resumes the
    session once inside the same turn with the findings. When it exits, the
    outcome is classified again and staging and the scan run again. Both
    invocations count toward the turn's spend and limits.
  - A second block fails the run with `secret_scan_blocked`, discards the
    unpushed changes and lists the blocked paths, never their contents.
- **Commit** as `wip(<ISSUE-KEY>): turn <n>` with the trailer
  `Co-Authored-By: Claude <noreply@anthropic.com>`. n is the run's count of
  agent turns, and retried attempts keep the same n. The author and committer
  are the bot account's name and no-reply address, a runner setting.
- **Push** fast-forward to the run branch only. A rejection because someone
  else pushed to the branch fails the run with `push_rejected`. The runner
  reserves each run branch before its first push (see Turns, leases and the
  runner API) and reports pushed heads at completion.
- **Branch names.** Computed once at creation and stored:
  `coredoc/<ISSUE-KEY>` for the first run of an issue and
  `coredoc/<ISSUE-KEY>-<n>` for the n-th run.

### Delivery

- **Delivery turn.** Claimed by a runner like any other turn, with no agent.
  For each touched repository, in merge order, the runner:
  - looks up pull requests for the head branch first;
  - reuses an open one and refreshes its body;
  - records a closed or merged one without reopening it;
  - otherwise creates a draft pull request against the default branch GitHub
    reports, with the title and body from the assignment; a "no commits"
    refusal records the repository as unchanged.

  A 422, timeout or 5xx on create is followed by a lookup by head before any
  retry. The runner checks its heartbeat before each write. When told to stop,
  it opens nothing more but still completes the turn with the pull requests
  it already opened or reused, so they are verified and recorded on the
  cancelled run.
- **Title and body**, assembled by the server so agent-written text is
  sanitised in one place. Title `<ISSUE-KEY>: <spec title>`; body capped at
  60,000 characters with a truncation note:
  - what this pull request changes in this repository;
  - the merge order across repositories;
  - the assumptions made;
  - withheld workflow files and binary paths for review;
  - whether the agent could not build or test this repository in the runner,
    with its reason;
  - a link to the run page, which holds the full accepted spec;
  - for a re-run, a link to the previous run.

  Every issue-key-shaped token in the agent-written parts, except the run's
  own key, gets a non-breaking hyphen, so Delivery analytics does not link
  unrelated tasks; epic child keys count as unrelated. Markdown image syntax
  is removed. There is no full spec text.
- **Verification.** For each pull request the runner reports, the server reads
  it through the GitHub connector with the strict pull read the intent
  handoff uses (not the lenient supplementary read), and records it only if
  its base repository and head repository are both that repository and its
  head branch is the run branch. Rate limits, timeouts and 5xx retry in
  process up to three times. A confirmed mismatch, or a permanent 404 or
  authentication error, fails the run with `delivery_failed`.
- **Jira done comment and transition**, by the run sweep:
  - It claims runs in `delivering` whose pull requests are verified and whose
    transition outcome is not yet recorded.
  - Before any Jira write it re-checks that the issue is still in a
    configured project; if it moved, it skips the comment and transition with
    a warning.
  - One comment in Atlassian Document Format: the verified pull requests in
    merge order, the run link, and a run marker. Before posting, existing
    comments are checked for the marker, and the comment id is recorded.
  - Then, when a target status is configured, skip if the issue is already
    there; otherwise apply a transition to that status, preferring one
    without a screen. Success, skip, or a warning (none available, a
    rejection with 400, 404, 409, 413 or 422, exhausted retries) is recorded
    as the transition outcome.
  - Only then is the run `done`. A crash between the comment and the
    transition is retried on the next tick; the marker check and the
    already-in-status skip keep it to one comment and one transition.
- **Errors before the done comment.** A permanent GitHub error in the runner,
  or a permanent Jira error on the done comment, fails the run with
  `delivery_failed`. The failure comment lists every verified pull request.
- **Cancelled runs** post no Jira comment.
- **Failure notification.** The run sweep posts one failure comment per failed
  run:
  - it claims failed runs that have no failure comment with skip-locked row
    claims and a next-attempt time, re-claimable after 5 minutes, as the intent
    handoff cron does;
  - it re-checks the issue's project as above, checks the issue's comments for
    the run marker, then posts and records the id. The comment carries only
    the failure code's fixed message, any verified pull requests, the run
    link and the marker; agent-written reasons, questions and summaries stay
    on the run page;
  - after a permanent Jira error or five failed attempts, it records the
    outcome as not posted, shows that on the run and stops.

  Done comments use the same claim, marker check and attempt limit.
- **Delivery analytics.** Pull requests on `coredoc/<ISSUE-KEY>` branches link
  to the issue's delivery task through the existing GitHub import, which reads
  issue keys from the branch, title and body, with no new code. On GitHub
  Enterprise Server the existing import reads only the repositories listed on
  the GitHub connector, so agent-run repositories must be listed there to be
  counted.

- **Status transitions (decided 2026-10-09).** Four optional target statuses
  in the agent run settings, each chosen in the web app from the statuses the
  workspace's Jira connector already knows (the delivery status map). An unset
  status means no transition for that event:
  - **started:** when the run leaves `queued` (its first scope turn is queued);
  - **done:** after the done comment, as before;
  - **failed:** after the failure comment is posted, skipped or given up on;
  - **cancelled:** when a member cancels (cancelled runs still post no
    comment).

  Each transition goes through the run sweep with the same claim, next-attempt
  time, project re-check and already-in-status skip as the done transition;
  problems become warnings on the run and never change its outcome. A
  transition is matched by the target status name, preferring one without a
  screen.

### Jira integration

- **Client additions:**
  - get issue, with explicit fields including the description;
  - list an epic's child issues;
  - add a comment (Atlassian Document Format body) and list comments;
  - list transitions and transition an issue;
  - a search option that leaves out changelog expansion (the importer keeps the
    current default).
- **Response handling.**
  - No-content responses (a successful transition) are not parsed as JSON.
  - Authentication, permission and validation failures map to permanent
    errors. Jira answers 404 or 400 for missing permissions, not 401 or 403.
  - Rate-limit errors carry their retry delay; the sweep retries in process up
    to three times with waits capped at 5 minutes.
- **Comment bodies** are built directly as Atlassian Document Format by two
  functions: the done comment, and the failure comment (the code's fixed
  message, verified pull requests when there are any, and the run link). No
  agent-written text goes to Jira.
- **Permissions.** The connector's user needs browse, add comments and
  transition issues in the configured projects. Jira Cloud only, as the
  existing connector already is.

### GitHub integration

- **Server: reads only.** The existing strict pull read verifies reported pull
  requests. The server's connector token stays read-only.
- **Shared resolver.** The intent handoff's resolver is extracted and
  exported, and it is extended:
  - It maps a durable key to a normalized remote, then to the active GitHub
    connector on that host whose repository list, when set, includes the owner
    and name.
  - It also parses `ssh://host[:port]/owner/name` and
    `https://host[:port]/owner/name` forms, matching the host name (ignoring
    the port) against the connector's git host: `github.com` for an
    `api.github.com` base, as the handoff resolver already maps it, and the
    API base's own host for GitHub Enterprise Server. The same git host
    yields the clone URL (see Git handling). GitHub Enterprise Server origins
    registered over SSH are normalized to the `ssh://` form.
  - Labels, proposals, requests, clone URLs and verification all use it.
- **Runner: writes.** Clone, push, get repository (default branch,
  permissions), list pull requests by head, create a draft pull request,
  update a pull request body, with an explicit API version header. Redirects
  map to a permanent "repository moved" error.
- **Bot account and token.**
  - A dedicated machine account that is a member of the organisation, not an
    outside collaborator, with the Write role only.
  - One fine-grained token, limited to the repositories agent runs may touch,
    with Contents read and write, Pull requests read and write, and Metadata
    read; no Workflows and no Administration. It must be approved where the
    organisation requires approval.
  - When the toolchains install from GitHub Packages, a classic token with
    the `repo` and `read:packages` scopes and no `workflow` scope replaces
    it, because GitHub Packages' npm registry accepts no fine-grained token.
    The bot account's repository access then bounds what the token reaches.
  - It lives only in the runner's Secret. Coredoc never stores it.
- **Branch rules prerequisite.** Rulesets or classic branch protection on the
  default branch must:
  - require a pull request with at least one approval and approval of the
    latest push, which the bot account cannot bypass;
  - restrict deletions and force pushes.

  Recommended in addition:
  - a merge gate, either a Restrict-updates rule whose bypass is the merging
    teams or classic "Restrict who can push" without the bot;
  - a ruleset that restricts creating, updating and deleting branches outside
    `coredoc/**` to people, so the bot can write only to run branches;
  - a tag ruleset that restricts creating, updating and deleting tags to
    people. Branch rulesets do not cover tags, and a Write-role token can
    otherwise push a tag that starts a release workflow with its secrets.
    Required wherever tags start release workflows (Phase 0 measured that a
    Write-role bot can push tags).

  Contents write lets a token merge through the API, so these rules, not the
  runner, are what keep agent code out of protected branches. The runner
  enforces only the admin or maintainer check; the install guide documents
  the rest.

### Data model

House conventions apply: uuid ids, timestamps with time zone, the workspace id
on every child row with same-workspace foreign keys, and JSON validated at the
boundary. One migration creates the tables and the hand-written partial
indexes, and adds a nullable owning-turn column to service tokens; no other
existing table changes, and the workspace only gains relation fields. The
token scope and the runner permission are code values, not schema.

**Cloud agent run**

| Field | Notes |
| --- | --- |
| id, workspace | |
| Jira issue id, issue key, Jira connector | The id is the identity; the key is for display and refreshed on read |
| Trigger, started by, previous run | Trigger is `jira_label`, `manual` or `rerun` |
| Run owner | The member the run acts as |
| Status, phase, failure code, failure reason | Codes from the closed set below |
| Questions policy, scope acceptance policy | `pause`/`assume`, `required`/`automatic`; copied from settings at creation, overridable on manual start |
| Model | Copied from settings at creation; empty means Claude Code's default |
| Repositories | Repository key, workspace repository, reason, merge order, origin (`label`, `manual`, `proposal`, `request`), eligibility, branch created, touched, last pushed head, not built or tested in the runner (with the agent's reason) |
| Seeds, dropped seeds | Seed keys; seeds the proposal dropped, with reasons |
| Run ordinal, branch | Computed once at creation |
| Scope session id, implement session id | Predetermined per phase |
| State archive key | Latest archive of the state directory |
| Spend | Cost estimate, agent turns, turns with unknown spend |
| Budgets | Max spend, max active time, waiting limit, max turn duration, repository cap; copied at creation |
| Clocks | Accumulated active seconds and the start of the current active interval; waiting since |
| Pull requests | Repository key, number, URL, state, draft, verified at |
| Jira outcome | Done comment id and outcome, failure comment id and outcome, comment next attempt, transition outcome |
| Assumptions | List with phase |
| Outcome-less count | For the nudge rule |
| Timestamps | Created, started, finished, last turn ended |

**Cloud agent run turn.** As described under Turns, leases and the runner
API. A partial unique index allows one `queued` or `claimed` turn per run.

**Cloud agent run spec version.** Run, version (unique per run), status
(`proposed`, `accepted`, `changes_requested`, `superseded`), markdown
(size-capped at 256 KiB), structured content (repositories with reasons and
eligibility, merge order, risks, intent references, assumptions, dropped
seeds), proposed at, reviewed by and at, review text for change requests, and a
flag for automatic acceptance.

**Cloud agent run question.** Run, request id (unique), kind
(`clarification` or `repository_request`), phase, questions (the
AskUserQuestion shape), state, answers (per question: chosen labels or free
text), asked at, answered at, answered by (null when automatic).

**Cloud agent run event.** Run, sequence (unique per run), type, payload
(redacted, size-capped at 16 KiB, with a truncation flag), created at.

- **Types.** The six agent events (phase, todos, question, question resolved,
  raw summary, done), plus status changed, turn started (kind, attempt,
  versions), turn ended (outcome, spend), and one generic run event. The run
  event carries a code from a closed enum, with display text: scope
  proposed, scope accepted, changes requested, repository added or declined,
  branch pushed, workflow diff withheld, pull request opened or reused, Jira
  commented, transition skipped, warning.
- **Redaction.** The server redacts payloads before storing them with a
  server-owned secret-pattern list, starting from the intent module's existing
  secret pattern. The runner additionally masks the exact values of the model
  key, the bot's token, the runner token and the turn's MCP token before
  sending. What the patterns miss is listed under Limitations and risks.
- **Transcripts.** Full transcripts are not stored as events; they live in the
  archived state.

**Agent run settings**, one per workspace: enabled, run owner, trigger label,
done status (Jira status id and name), default policies, budgets, waiting
limit, repository cap, model, updated by and at, and per runner token the last
successful claim or heartbeat with the versions it reported. Settings live in their own
table because no workspace settings store exists and the feature has more than
ten fields.

**Constraints.**

- Hand-written partial unique indexes allow one non-terminal run per workspace
  and Jira issue id, and one queued or claimed turn per run. Prisma cannot
  express them, so they get the same protection as the existing hand-written
  queue index: a migration-invariant test that fails if a generated migration
  drops them.
- Spec versions are unique per run and version; questions are unique by
  request id; events are unique per run and sequence.

**Failure codes.** A closed set, each with a plain-words message:

| Code | Message |
| --- | --- |
| `invalid_repository_label` | A repository label names no eligible workspace repository. |
| `too_many_repositories` | More repositories were named than the run's cap allows. |
| `issue_not_readable` | The Jira issue could not be read through the workspace's Jira connector. |
| `run_owner_removed` | The member this run acts as is no longer in the workspace. |
| `connector_inactive` | The workspace's Jira or GitHub connector is missing or paused. |
| `plugin_missing` | The workflow plugin or its skills did not load in the runner. |
| `agent_error` | The model or Claude Code failed: authentication, unavailable after retries, or crashed. |
| `session_mismatch` | Claude Code reported a different session than the run expects. |
| `repository_not_eligible` | A repository cannot be used: no durable key, a remote outside the GitHub connector, not readable with the bot's token, or the bot is an admin or maintainer there. |
| `branch_exists` | The run branch already exists on the remote and this run did not create it. |
| `push_rejected` | Someone else pushed to the run branch during the turn. |
| `secret_scan_blocked` | The secret scan blocked the push twice. |
| `no_outcome` | The agent stopped twice in a row without finishing. |
| `budget_exhausted` | The run reached its spend limit. |
| `wall_clock_exceeded` | The run's active time reached its limit. |
| `waiting_expired` | Nobody answered or reviewed within the waiting limit. |
| `no_changes` | The agent finished without changing any repository. |
| `github_error` | GitHub refused a request or kept failing while the agent worked. |
| `jira_error` | Jira kept failing while the PRD was being read. |
| `archive_too_large` | The agent's saved session grew beyond the allowed size. |
| `report_limit_exceeded` | The runner sent more events, proposals or questions than a turn allows. |
| `delivery_failed` | Opening or verifying the pull requests, or posting the Jira done comment, failed. |
| `runner_lost` | The agent runner stopped responding during the same turn three times. |

### REST API

- **Human API prefix:** `/workspaces/:workspaceId/cloud-agent-runs`. The
  `agent-runs` path belongs to desktop telemetry ingest, which shipped desktop
  builds call, and stays untouched. The parameter must be named
  `workspaceId`, because the workspace guards read it by that name.
- **Class guards:** authentication, workspace role and token permissions. Every
  handler declares a workspace role: without one, the role guard skips the
  membership check and admits any authenticated user session.
- **Human sessions only** on the human API, reads included. Routes without a
  token-permission requirement otherwise admit any non-telemetry service token
  whose creator is a member, including a runner token.
- **Availability.** Only start and re-run require the feature to be enabled and
  available (`AGENT_RUNS_DISABLED`, `AGENT_RUNS_UNAVAILABLE`). Reads and
  actions on existing runs stay available. The global license guard already
  refuses writes on expiry.
- **Conventions.** Bodies use the house zod contract pattern, and errors carry
  typed upper-snake codes: `ACTIVE_RUN_EXISTS`, `RUN_TERMINAL`,
  `RUN_NOT_TERMINAL`, `RUN_STATE_CONFLICT`, `SPEC_VERSION_STALE`,
  `QUESTION_ALREADY_ANSWERED`, `ISSUE_NOT_READABLE`, `UNKNOWN_REPOSITORY`,
  `TOO_MANY_REPOSITORIES`, `AGENT_RUNS_DISABLED`, `AGENT_RUNS_UNAVAILABLE`,
  `LEASE_LOST`, `RUNNER_INCOMPATIBLE`, `JIRA_UNAVAILABLE` (503, Jira kept
  failing during a manual start), `ARCHIVE_NOT_FOUND`, `RATE_LIMITED` (429,
  runner routes).

| Route | Role | Purpose |
| --- | --- | --- |
| `GET /` | member | Runs, newest first, paged |
| `POST /` | member | Start: issue key, optional policies, optional repository keys |
| `GET /:runId` | member | Run, latest spec version, open question, repositories with pull requests, spend, current turn state |
| `GET /:runId/specs` | member | All spec versions |
| `GET /:runId/events?after=<seq>&limit=<n>` | member | Timeline page after a sequence |
| `POST /:runId/questions/:requestId/answer` | member | Answer |
| `POST /:runId/specs/:version/accept` | member | Accept the latest proposed version |
| `POST /:runId/specs/:version/request-changes` | member | Send feedback text |
| `POST /:runId/cancel` | member | Cancel |
| `POST /:runId/rerun` | member | New run for the same issue (terminal runs only) |
| `GET /settings` | member | Settings, availability with reasons, runner last seen, repositories with keys and eligibility |
| `PUT /settings` | admin, workspace manage permission | Update; switching on records the caller as run owner; explicit owner takeover |

- **Runner API prefix:** `/workspaces/:workspaceId/agent-runner`, runner
  tokens of that workspace only. Every route under `/turns/:turnId` requires
  the live lease token.

| Route | Purpose |
| --- | --- |
| `POST /claim` | Claim the oldest queued turn; 204 when none |
| `POST /turns/:turnId/heartbeat` | Extend the lease; answer `stop` when the run is terminal or the lease is lost |
| `POST /turns/:turnId/events` | Event batch |
| `POST /turns/:turnId/questions` | Report a question (open or auto-answered) |
| `POST /turns/:turnId/propose-scope`, `/request-repo`, `/submit-result` | Run-control calls; validation errors in the response |
| `POST /turns/:turnId/branches` | Reserve a run branch before its first push |
| `GET /turns/:turnId/archive`, `PUT /turns/:turnId/archive` | Download the previous state archive, upload the new one |
| `POST /turns/:turnId/complete` | Outcome, spend, versions, withheld paths, pull requests |

Runner tokens are minted through the existing token API with the
`agent-runner` scope, which, like the intent-agent scope, needs an admin in a
human session and gets its own curated permission branch.

The `/me` workspace projection gains a stable agent-runs flag, true when agent
runs are enabled or the workspace has runs. It gates navigation; live
availability is shown on the list page and in settings.

### Web app

- **Routes.** `/w/<slug>/agent-runs` (list) and `/w/<slug>/agent-runs/<runId>`
  (detail), both lazily loaded so the markdown renderer stays out of the main
  bundle. The detail route is the first with a path parameter besides the
  workspace slug; pull requests and Jira comments link to it.
- **Navigation.** An "Agent runs" entry, gated by the `/me` flag.
- **List page.** Runs, plus live availability and the reason when runs cannot
  start or are waiting for a runner.
- **Run page redesign (decided 2026-10-09; supersedes the detail-page layout
  below where they differ).** Shipped in ticket 16, which removed the
  prototype (`apps/web/src/features/agent-runs/agent-run-page.prototype.html`).
  - Left column: the stages (scope, review, scope versions, implement,
    delivery) with start time, duration and time spent waiting for a person,
    plus the run total; then artifact cards: pull request and Jira issue as
    links, spec, product intent, skills and tools, and the trace opening a
    right-hand drawer.
  - Main column, minimal: the agent's scope proposals, your reviews and
    acceptances, the agent's questions with the chosen answer, the agent's
    final result (from `submit_result`) and delivery; each agent turn is one
    line with its phase, duration and tool-call count and a link to that
    turn's trace.
  - The full trace (every message, tool call, result and error, per turn) is
    for debugging and lives only in the drawer, with a download of the
    transcript (JSONL) from the run's state archive.
  - The runner reports structured `tool`, `skill` and `result` events instead
    of raw text lines, so the trace, the counts and the turn lines need no
    parsing.
- **Detail page:**
  - header: issue link, status and phase badges, run owner, trigger, policies,
    and spend against budget, with explicit unknown and partial states;
  - a "waiting for an agent runner since …" note while a turn is queued;
  - action card: either a question card or a scope review.
    - The question card is a web mirror of the desktop question card, restyled
      on web tokens. It shows headers, descriptions, previews, multiple
      selection and "Other".
    - The scope review shows the spec, a repositories table (reasons, merge
      order, eligibility), dropped seeds, candidates for the PRD, a version
      selector, and accept and request changes, sent with the displayed
      version;
  - a checklist of the agent's current tasks, built from the latest todos
    event;
  - repositories and pull requests, including withheld workflow diffs and the
    repositories not built or tested in the runner;
  - timeline: appended forwards by sequence, raw activity collapsed, polled
    every 3 seconds while the run is non-terminal and stopped at terminal;
  - cancel and re-run; the failure reason.
- **Agent-written text** (spec, summaries, assumptions, questions) is rendered
  with the existing safe markdown renderer with remote content disabled:
  images show their alt text and URL as plain text, and links show their
  target.
- **Settings panel.** "Agent runs", for admins, next to "Delivery analytics":
  - an availability checklist with reasons, and per runner token when it last
    claimed or heartbeated, with its versions, or why it is refused;
  - an enable toggle that shows the run owner, and a "take over ownership"
    action;
  - trigger label and done status;
  - policies, budgets, waiting limit, repository cap and model;
  - runner tokens: create (shown once), list, revoke;
  - the repository list with keys and eligibility.
- **Types.** The web app restates the wire types locally, as it does for other
  APIs.

### Settings and availability

- **Available** when all of these hold, each unmet one shown with its reason:
  - object storage has a real endpoint, not the per-container local fallback
    (archives must survive across server replicas);
  - the server encryption key is set (the Jira connector needs it);
  - the Jira and GitHub connectors exist and are active (which requires
    Delivery analytics to be enabled);
  - the license is valid.
- **Runner seen.** Settings and the list page show each runner token's last
  successful claim or heartbeat. It is informational: runs queue without a runner and show that
  they are waiting, because a runner restart must not refuse starts.
- **Trigger owner valid** when the recorded run owner is a current, non-pending
  member.
- **Rules.**
  - Start and re-run need enabled and available.
  - The trigger cron and promotion need enabled and available. The trigger
    cron also needs a valid trigger owner and at least one project key.
  - Switching on needs available.
  - The server re-checks the run-level conditions when it hands out each turn.
- **Settings fields and defaults:**
  - trigger label `coredoc-agent`; done status (optional);
  - questions `pause`; scope acceptance `required`;
  - spend per run 25 USD;
  - maximum turn duration 3 hours;
  - active time per run 24 hours; waiting limit 7 days;
  - started runs per workspace 2; repositories per run 5;
  - model (Claude Code's default when unset; this spec pins no model id).

### Runner Claude adapter

- The runner owns a Claude adapter written against its pinned SDK. It starts
  from a copy of desktop's message-to-event mapping, AskUserQuestion bridge
  and result handling.
- It assembles the options: working directory, session id and resume, the
  in-turn budget (`maxBudgetUsd` set to the remaining spend), max turns, the
  plugin, the pre-tool hook, the environment, the MCP servers, the preamble
  and the tool lists.
- It reports spend from the result. Where the pinned SDK reports cumulative
  totals for a resumed session, the turn's spend is the difference from the
  previous total.
- Desktop is not changed: it keeps its adapter, policy, environment builder,
  SDK version and reported economics. Sharing an adapter package is revisited
  only once two hosts pin the same SDK version.

### Agent runner deployment and image

- **Image.** A Coredoc-published runner image: Node, the runner, the pinned SDK
  (which bundles Claude Code, so there is no separate install that could
  drift), the pinned plugin, git and an init process that reaps orphaned
  processes. It is linux/amd64 with glibc only while the plugin's launcher
  supports no other Linux platform. The server image is unchanged and never
  contains the SDK.
- **Start-up check.** At start the runner logs its runner, SDK, Claude Code
  and plugin versions, and checks that the SDK starts, the plugin and its
  skills load with no plugin errors, and the bot account is not an admin or
  maintainer of its organisation's repositories it can see. While a check
  fails it claims nothing, retries periodically, and reports the reason
  through a heartbeat-only call that settings show.
- **Derived images.** Customers derive their own image to add their
  repositories' toolchains; the docs show a neutral example.
- **Helm.** An optional `agentRunner` Deployment, disabled by default, with:
  - its own image reference, not tied to the server image tag;
  - replicas (default 1) and resources; a scratch emptyDir;
  - a Secret reference for the model key, the bot's token and the runner
    token, and optional gateway base URL, proxy and CA settings;
  - the Coredoc API URL, defaulting to the in-cluster Service;
  - a termination grace period covering the session stop;
  - no service-account token automount; a non-root user; a read-only root
    filesystem;
  - an optional NetworkPolicy with the egress list as values.

  It receives none of the server's secrets or environment. The main
  Deployment does not change.
- **Outside the chart.** The runner needs only outbound HTTPS, so it can also
  run anywhere that reaches the Coredoc API; the chart is the documented path.
- **Compose.** The single-VM Compose topology has no runner in v1.
- **Release.** The runner image is built, signed and given an SBOM, and ships
  in the air-gap kit with the server image. The kit's mirroring helper and
  values fragment include it.
- **Upgrade.** The runner reports its protocol version on every claim; the
  server refuses claims from an incompatible runner with a reason shown in
  settings. Derived images must be rebuilt from each new runner release.

### Egress and on-prem documentation

- **Runner egress:**
  - the Anthropic API, or the customer's gateway;
  - GitHub: github.com and api.github.com, or the single GitHub Enterprise
    Server host, which serves git and the REST API under `/api/v3`;
  - the package registries the toolchains use, preferably internal mirrors;
  - the Coredoc API.
- **Server egress** is the Jira Cloud site and the GitHub connector's API host
  (api.github.com or the GitHub Enterprise Server host), which Delivery
  analytics already uses; the install guide lists both.
- **Opt-outs and unavoidable traffic.**
  - The required environment opt-outs remove telemetry and update traffic.
  - With an API key against the Anthropic API, Claude Code polls managed
    settings and policy limits on the same host.
  - One unconditional startup fetch of Claude Code's plugin security list from
    GitHub's raw content host fails harmlessly when blocked.
- **Proxies.** Claude Code and git honour the standard proxy variables; Phase
  0 measures the pinned version behind the customer's proxy.
- **CI on agent branches.** Every push to `coredoc/**` and every draft pull
  request runs the repository's existing push and pull-request workflows on
  agent-written code, with the secrets those workflows receive, on the
  customer's runners. The install guide tells customers to:
  - keep sensitive secrets in environments with required reviewers, or with
    deployment-branch rules limited to protected branches;
  - make the default workflow token read-only;
  - exclude `coredoc/**` from workflows that use sensitive secrets or
    self-hosted runners, but keep pull-request test workflows running on
    them, because they are where compose-tested repositories get tested.
- **Documentation updates:**
  - install prerequisites: a dedicated Anthropic API key with a provider-side
    spend limit; object storage endpoint and encryption key; the
    Jira connector with project keys and permissions; the GitHub connector;
    the bot account, its token and the branch rules; on GitHub Enterprise
    Server, agent-run repositories listed on the GitHub connector; the runner
    Secret and token; the derived image; CI secret handling;
  - the outbound-connections section, which today ends with "nothing else":
    add the Jira site and the GitHub API host for the server, and state that
    the server still calls no LLM while the runner does;
  - upgrade (rebuild the derived image; rollouts discard in-flight turns),
    sizing (runner) and the environment reference;
  - a row in the architecture overview;
  - a plain statement that file contents are sent to the model API.

### Budgets and limits

| Limit | Default | Enforcement |
| --- | --- | --- |
| Spend per run | 25 USD (estimate) | Server checks before handing out each turn; the in-turn SDK budget (`maxBudgetUsd`) is the remainder |
| Maximum turn duration | 3 h | Runner; reaching it is a checkpoint; the MCP token expires 15 min later |
| SDK turn cap | 500, a constant | Runaway guard; reaching it is a checkpoint |
| Active time per run | 24 h | Run sweep |
| Waiting limit (a person) | 7 days | Run sweep |
| Started runs per workspace | 2 | Run creation and promotion |
| Repositories per run | 5 | Labels, proposals and requests |
| Concurrent turns per runner process | 1 | Runner; scale with replicas |

- **Active time.** It starts when the run leaves `queued`. It excludes time in
  `awaiting_answer` and `awaiting_scope_acceptance`, and includes time waiting
  for a runner. The run stores the accumulated seconds and the start of the
  current interval, both updated on each status change, and the sweep
  compares the total with the budget.
- **Running out** of any budget fails the run with its code; work already
  pushed stays on the branches.
- **Implementation constants:**
  - the trigger cron and the run sweep run every minute;
  - claim polling every 5 seconds; heartbeat every 20 seconds; lease 2
    minutes; three lease expiries per turn;
  - comments allow five attempts, re-claimable after 5 minutes;
  - in-process GitHub and Jira retries: three, with waits capped at 5 minutes;
  - caps: spec markdown 256 KiB, event payload 16 KiB (64 KiB for a withheld
    workflow diff), pull request body 60,000 characters, per-turn report caps
    as under Turns, state archive by its own body-size tier from Phase 0.

### Economics

- **Spend** per turn is reported by the runner from the SDK result; the run
  total is the sum. A turn without a reported result has unknown spend, and
  the run page then shows the total as partial ("N of M turns reported"),
  never as zero.
- **Meaning.** Spend is Claude Code's list-price estimate on the customer's own
  key, self-reported by the runner, not billing.
- **Analytics.** Token counts, model usage and the delivery-task link are not
  stored in v1. Agent-run spend does not feed Usage or Delivery analytics.

### Retention and cleanup

- **Machine-derived data.** Event rows, turn rows and state archives are
  deleted by the retention sweep 30 days after the run ends, in bounded
  batches. The sweep has its own enable flag and is on by default.
- **Human records.** Runs, spec versions, questions and answers, acceptances
  and change requests are never deleted automatically.
- **Turn-scoped data.** MCP tokens are deleted at turn completion, lease expiry
  and abandonment. The runner wipes its scratch volume at turn end.

### Implementation plan

The work is tracked as tracer-bullet tickets in `issues/` next to this spec
(01 Phase 0 and gate, 02 shared resolver, 03 end-to-end empty turn, 04 scope,
05 questions, 06 implement, 07 `request_repo`, 08 delivery, 09 Jira trigger
and queue, 10 limits and failures, 11 image, chart and docs, 12 pilot). The
phases below group the same work by layer.

Each phase can be merged on its own; each depends on the previous one, except
that Phases 3 and 4 can proceed in parallel once Phase 1 has merged.

**Phase 0 — spikes (scratch work, nothing merged).** Exit criteria: every point
below answered, with the resulting decision written under Further Notes.

1. **SDK pin.** Choose the exact version above the floor. On it, confirm:
   - pausing by deferral and by deny-with-interrupt, including a turn with
     several tool calls, and the resume;
   - the result shape, whether an error result throws, and per-call versus
     cumulative cost after resume;
   - that the pre-tool hook decides before automatic approvals, and that
     WebSearch and WebFetch are refused;
   - the MCP HTTP timeout;
   - that aborting ends the whole process tree (Bash, background shells,
     hooks) and the init process reaps orphans, so the runner never pushes
     while an agent process is alive.
2. **Plugin in hosted mode.** Against the newest plugin version, record which
   items of the Plugin contract it meets, and settle the fallback prompts for
   the rest:
   - hooks fire with setting sources off, and attribution survives resume
     through the session id set in the environment;
   - session end suspends rather than abandons the plugin run within its
     budget with five clones, and the restored archive resumes it;
   - the question tool is available with tool search off, and subagents never
     need AskUserQuestion or a permission ask;
   - the approval record satisfies the implement route's gate;
   - count the questions on a real PRD.
3. **GitHub.** Record which protection the pilot organisation uses. With the
   bot account's token, confirm that it cannot push to, merge into or update
   refs of the default branch, that it can push `coredoc/**`, and whether the
   optional run-branch ruleset confines it.
4. **Jira fixtures.** Capture and scrub one real PRD description (Atlassian
   Document Format) as the converter fixture. Confirm the comment and
   transition permissions.
5. **Egress and proxies.** Run the pinned Claude Code behind a logging proxy
   with the runner's environment and record every host. Measure proxy and
   mirror behaviour.
6. **Sizing.** Measure the derived image with the pilot's toolchains (several
   Node major versions through a version manager, plus the other runtimes the
   pilot's repositories pin), the scratch volume for five clones with
   dependencies, and the state archive of a long run, to set the archive
   route's size tier.
7. **Tests without Docker.** Decided: compose-tested repositories are
   reported as not tested and rely on pull-request CI (see Limitations and
   risks). Still open: how private package registries are reached.

**Gate — maintainer acceptance.** A maintainer accepts the scope decision
(untrusted execution in the customer's runner pod) and the decisions listed
under Further Notes. Who accepted and when is recorded here. Phases 1 to 6
start after the gate.
Accepted by Yevhen Popenko, 2026-10-08. Accepted with Phase 0 items still
open (the real Jira fixture, tests without Docker, egress, sizing, model and
authentication error results); they are tracked in ticket 13 and gate only the
image and pilot tickets.

**Phase 1 — server foundation.**
- The migration (tables, partial unique indexes, the owning-turn column),
  settings and availability.
- The extended shared resolver and ADF-to-markdown conversion, which claims
  and seed validation need.
- The run service with the full state machine; turns, claims and leases;
  questions and acceptance.
- The human API and the runner API with the runner token's exact-purpose
  fence, the `agent-runner` token scope and the shared runner protocol
  contract.
- The trigger cron, the run sweep and the retention sweep.

Validation:
- module tests at the server seam: every scenario below except 8 and 13,
  which land with Phase 2;
- the Postgres integration suites, each added to the integration test script
  with its own environment variable, or it skips silently in CI;
- the server build.

**Phase 2 — server integrations.** Jira client methods and the comment
builders, pull request body assembly, pull request verification, the done and
failure comments and the transition, event redaction. Validation: as Phase 1, plus the client and
pure-function suites.

**Phase 3 — runner.** The runner app: claim loop and heartbeat, the Claude
adapter, the tool policy and question bridge, the run-control server, clone
and branch, staging, scan, commit and push, delivery, archives, shutdown.
Validation: the runner's tests at its seam, typecheck and build.

**Phase 4 — web.** Routes, queries, navigation flag, settings panel with
runner tokens, question card, scope review, checklist, timeline. Validation:
web tests and typecheck, including the full-app router tests with a stubbed
fetch.

**Phase 5 — image, chart, release, docs.** The runner image and its PR-time
build job, the Helm Deployment, Secret wiring and optional NetworkPolicy,
release and air-gap kit entries, and the documentation listed above.
Validation:
- the image builds in CI;
- `helm template` renders the runner Deployment as intended (inspected, not
  asserted line by line);
- docs checks with `git diff --check`.

The first end-to-end pass in a browser happens on a real runner after this
phase, in staging or the pilot.

**Phase 6 — pilot.** Enable on one Jira project with three tickets of
increasing scope: one repository known up front, one to be discovered, and
three repositories with a contract change. Tune prompts and budgets, and list
any repository the agent could not set up. Exit criteria: three draft pull
requests a person would review without rewriting, and a written list of the
questions the agent asked, with whether each was needed.

## Testing Decisions

- **What a good test is.** It drives the feature from outside through a seam
  and asserts observable outcomes: rows a user would see through the API,
  requests sent to Jira and GitHub, commits on a remote, events on the
  timeline. It never asserts private helpers, call order inside a module, or
  configuration restated as a test (for example, that a token scope maps to a
  permission list, or that an option is passed through unchanged).
  Deterministic time comes from injected clocks and parameterised limits, so a
  7-day waiting limit or a 24-hour active-time budget never runs in real time.
- **Two seams, because there are two processes.** The server and the runner
  only meet at the runner API, whose schemas both import from the shared
  contract.

**Server seam: the cloud agent runs module boundary.** Tests drive the module
through the human API and the runner API (real guards), and the three
scheduled jobs, on a real Postgres. The runner is a scripted fake that makes
runner API calls. Fakes sit only at three ports:

- the Jira client and the GitHub client: stateful in-memory fakes, injected
  through the existing client-factory pattern;
- the state-archive store: in memory.

Scenarios:

1. Concurrent trigger ticks create exactly one run per issue, including a run
   that fails at creation. A terminal run is never re-created by the label.
   No project keys means no search.
2. The concurrency queue starts runs oldest first under concurrent manual
   starts and promotion.
3. Scope proposal, acceptance and implementation. The change-request loop. An
   outdated version is refused. Dropped seeds are shown. Automatic acceptance
   with an ineligible repository waits for a person.
4. Questions: a pause and an answer that resumes exactly once, including an
   answer that arrives while the turn is completing. A second answer is
   refused. The assume policy records assumptions. The waiting limit fails a
   forgotten run.
5. Outcome-less turns get one nudge and then fail. Duration checkpoints
   continue the run.
6. `request_repo` under automatic and required acceptance, covering add,
   decline and duplicate requests.
7. Two runners claiming at once get different turns; a turn whose lease
   expired is re-queued, a stale runner's requests (archive download
   included) get `LEASE_LOST`, and the third expiry fails the run with
   `runner_lost` and deletes the MCP token. A lease that expires after the
   turn parked a question completes the turn as paused. Cancel while a turn
   is queued leaves nothing to claim; cancel while it is claimed means lease
   expiry neither re-queues it nor changes the code.
8. Delivery: reported pull requests are recorded only when the strict read
   confirms base repository, head repository and head branch; a fork head or
   a mismatched report fails the run, and a transient GitHub error is
   retried. Running the done comment twice posts one comment and at most one
   transition, including after a crash between the two. A transition that
   answers 400 still ends `done`. A cancel during delivery records the pull
   requests already opened. Assembled bodies carry no foreign issue keys and
   no images. An issue moved out of the configured projects gets no comment.
9. Budget exhaustion, the active-time limit, and cancel during a turn and
   while waiting; the runner's next heartbeat answers `stop`.
10. The per-turn MCP token exists only while the turn is claimed.
11. Every human route refuses service tokens, including runner tokens; every
    runner route refuses human sessions, tokens of another workspace and a
    legacy grant-all token; a runner token is refused by the cloud MCP and by
    an existing permission-less member route; the per-turn MCP token is
    refused on REST; a runner token whose creator left is refused, and
    settings say why; non-members get 403.
12. Retention never deletes human rows. A manual start for an issue outside
    the configured projects is refused. Exceeding a per-turn report cap fails
    the run with `report_limit_exceeded`; three turns of unknown spend fail
    it with `budget_exhausted`.
13. Two concurrent sweep ticks post one failure comment, and a crash after
    posting is recovered by the marker check without a second comment.

Prior art:
- the intent module's Postgres integration suites with real guards;
- the importers' client-factory fakes;
- the intent handoff cron's claim test.

**Runner seam: the runner loop.** Tests run the runner against a fake Coredoc
API built on the shared contract, with fakes only at three ports:

- the SDK query: a scripted fake that emits messages, asks questions, calls
  run-control tools and reports results;
- the GitHub REST API: a stateful in-memory fake for repository reads and pull
  requests;
- git remotes: local bare repositories with real git.

Scenarios:

1. A scope turn writes the PRD file, forwards a proposal, uploads the archive
   and completes.
2. A pause parks the question and ends the session; the resume turn continues
   the same session id; a mismatched session id fails the run.
3. End of turn: the staging rule against a fixture repository (a gitlink, a
   large file, a workflow file, a credential file); the scan blocks once, the
   session is re-invoked, and a second block fails without pushing.
4. Branch rules: an existing foreign run branch fails with `branch_exists`; a
   person's push fails the run with `push_rejected`; an admin bot is refused
   before any session starts. A runner that dies between reserving and
   pushing a run branch, or between pushing and completing, is retried and
   continues on the branch.
5. Delivery opens one draft pull request per touched repository and reuses
   them when run twice; a 422 on create is followed by a lookup.
6. A `stop` heartbeat ends the session, skips pushes and does not complete
   the turn, except that a delivery turn completes with the pull requests it
   already opened; a lost lease stops it without completing.
7. Automatic `request_repo` clones the repository mid-turn and returns its
   path, and repeating it returns the same path.
8. Start-up: a broken plugin or an admin bot means no claim, with the reason
   reported. An archive with an entry that escapes the state directory is
   rejected.

Prior art: the desktop agent-run service tests with inline fake adapters, and
the plugin's preflight tests with bare remotes.

**Supporting seams.**

- **New pure modules with table tests:**
  - Atlassian Document Format to markdown, with the scrubbed real fixture and
    synthetic nodes including dates, mentions, emoji, tables and smart links;
  - the two ADF comment builders, including a failure comment with verified
    pull requests and one without;
  - the pull request body assembler and its sanitiser for issue keys and
    images, including a repository not built or tested in the runner;
  - the clone URL builder and resolver: github.com SSH and HTTPS; GitHub
    Enterprise Server scp, `ssh://` and HTTPS origins with ports; a missing
    remote; a connector repository list; the clone URL for a github.com
    connector is `https://github.com/<owner>/<name>.git`, never
    `api.github.com`, and for GitHub Enterprise Server drops `/api/v3`;
  - the runner's tool policy: denied tools, the question bridge, and allowed
    calls returning their input unchanged.
- **Real Postgres:** the two partial unique indexes, the advisory-lock creation
  race, the skip-locked claim, and the migration.
- **Web.** The full-app router with a stubbed fetch covers:
  - the list and the detail deep link;
  - answering; accepting a stale version; requesting changes; cancelling;
  - settings, runner tokens and ownership takeover;
  - a remote image in spec markdown is not rendered as an image.

  Prior art: the analytics route test and the CI/CD panel test. Polling and
  timeline merging live in a pure presentation module with its own table
  tests, so no timer-driven component tests are needed.
- **The Jira client**, through a stubbed global fetch: 204 with no body, 201
  bodies, and permission errors mapped to permanent ones.
- **Deliberately not tested:** chart values restated as assertions, the token
  scope's permission list, and the Phase 0 spikes, which are not merged.

## Out of Scope

1. A review-fix loop in which pull request review comments resume the session.
2. Automatic intent handoff per pull request. It is also impossible under a
   service token, because saving a handoff requires a human session.
3. Alternative runners, including Managed Agents. The runner protocol is the
   seam: another runner can implement it later.
4. Temporal or any external workflow engine. Revisit if the run grows review
   loops and reminders.
5. A GitHub App instead of a personal access token; Slack notifications.
6. Hosted-cloud availability. The runner protocol is outbound HTTPS and does
   not preclude a customer-run runner against hosted Coredoc, but enabling it
   is a separate decision.
7. Codex as the agent.
8. Subscription OAuth tokens for model access.
9. Repositories outside GitHub (GitLab, Bitbucket, others) and Jira Server or
   Data Center.
10. Agent-run spend, tokens and the delivery-task link in Usage and Delivery
    analytics.
11. Resolving the Jira account that added the label to a Coredoc member, and
    any admin flow for linking Jira identities.
12. Sandboxing inside the runner pod. Revisit only if the runner must one day
    hold credentials the agent may not reach.
13. Webhook triggers from Jira. The server has no inbound webhook surface, and
    connector sync already polls.
14. The plugin's workflow capture and gates in agent runs. Capture is not
    configured, so gates evaluate as unbound.
15. Changing desktop or the CLI, including their SDK versions.
16. A server-side deadline for slow intent context reads; the agent's MCP
    timeout bounds the wait.
17. Building or testing repositories whose toolchain cannot run in a Linux
    container, such as iOS projects that need Xcode. The agent can edit them
    and reports them in `submit_result`.
18. An inline answer wait inside a turn. It can be added if pilot runs show
    answers routinely arriving within minutes.
19. Changes to the `coredoc-workflows` plugin itself. They happen in the
    plugin's own repository; this spec only states the contract it relies on.
20. PRDs that live in Confluence pages linked from the issue. v1 reads the
    PRD from the Jira issue description, where the PRD tooling now writes it.

## Further Notes

### Deviations from the SF-001 draft

| Draft said | This spec says | Why |
| --- | --- | --- |
| D2: the SDK runs as a child process of a dedicated worker Deployment (server image plus Claude Code) | A separate agent runner pod with only the customer's credentials, talking to Coredoc over a runner API | The worker pod holds the database URL, the key that decrypts every connector credential, OAuth and storage secrets; an agent next to them could write its own approvals into the database. Removing the secrets from the pod removes the need for any in-pod sandbox |
| `agent_run` job type on the push job queue, claimed by the agent worker | Turn rows with leases, claimed over the runner API | The runner has no database access; turn rows give the one-turn-per-run invariant and keep the regular worker unaware of agent work |
| Sandbox with bubblewrap, or the permission policy plus pod isolation when it is unusable | The pod is the boundary; no sandbox and no path policy inside it; a small tool denylist | Inside a pod that holds only the customer's credentials a sandbox protects nothing the agent cannot reach, and it would require user namespaces in the customer's cluster |
| D6: the server opens pull requests; the agent only pushes; the token is injected into the remote URL and never exported to the agent | The runner, holding the bot's token, commits, pushes and opens draft pull requests; the server assembles titles and bodies and verifies every pull request | The bot's token is the customer's and is scoped by GitHub; Contents write can merge through the API anyway, so branch rules, not who calls the API, keep code out of protected branches |
| Runner runs `coredoc-workflows` unchanged | The runner relies on a written hosted-mode contract with the plugin, with prompt fallbacks until a release meets it | The plugin is expected to change for remote agents; the contract keeps those changes from breaking runs silently |
| Routes `POST/GET /workspaces/:id/agent-runs` | Prefix `/workspaces/:workspaceId/cloud-agent-runs` | The path belongs to desktop telemetry ingest, which shipped desktop builds call; the guards read `workspaceId` |
| "member" guard on start, list, detail and events | Human session on every human route; runner routes for runner tokens only | Routes without a permission requirement admit any member-created service token |
| Trigger creates a run for every labelled issue without a non-terminal run | Only for issues that never had a run, keyed by Jira issue id; partial unique index plus a per-workspace advisory lock | The label stays and Coredoc's own comment bumps `updated`, so the draft loops; scheduled jobs run in every API and worker process |
| JQL `labels = "x" AND updated >= -1d` | Bounded by the connector's project keys (required); relative date quoted | Without project keys a label anywhere on the site starts paid runs |
| `doneTransitionId` in the connector config | Target status in the agent run settings; transition problems are warnings | Transition ids depend on the current status; connector config is replaced on credential rotation |
| Policies "copied from workspace config" | A new agent run settings table | No workspace settings store exists |
| `repoKeys` and `coredoc-repo:<repoKey>` | The durable repository key, with eligibility | `repoKey` on a workspace repository is a 12-character graph hash |
| Clone from the stored git URL with the token in the remote URL | HTTPS URL from the shared resolver; per-command credentials | Stored URLs are SSH; a token in the remote URL ends up in the clone's config and in transcripts |
| Executor runs a configured bootstrap command | The agent sets each repository up from its own instructions | The plugin already derives setup commands; no extra configuration |
| Sandbox network limited to the Anthropic API, GitHub, Coredoc and registries; "allowed network hosts" in the workspace panel | Pod egress, optionally as a chart NetworkPolicy | Egress is the operator's control, not a workspace setting |
| Reuse the desktop permission policy | A small runner tool policy; desktop unchanged | Desktop's denies Bash, Skill, Agent and every MCP tool |
| `packages/agent-runner` shared by desktop and the server | A runner app with its own adapter; desktop and the CLI unchanged | Desktop and the CLI pin older SDK versions; sharing would move them for no benefit |
| Separate pinned `@anthropic-ai/claude-code` install in the server image | The runner image pins the SDK, which bundles Claude Code; the server image never contains it | A second CLI would drift from the SDK |
| `maxCostUsd` | The SDK's budget option (`maxBudgetUsd`) | Correct option name |
| `costUsd`, `tokensIn`, `tokensOut`; `deliveryTaskId` | Spend per turn with version-aware resume semantics; tokens and the delivery-task link not stored | Some versions report cumulative totals after resume; nothing in v1 reads tokens or the link |
| Raw transcript lines in events | Redacted summaries; transcripts in the archived state | Event size bounded; secrets kept out of the run page |
| Retention "like capture retention, 30 days" | Its own sweep deletes events, turns and archives 30 days after the run ends; human rows never deleted | Capture retention is 90 days and off by default; human answers are ground truth |
| Run token with graph read, intent read and intent propose, per run | Per-turn hash-only MCP token; scope: intent read; implement: intent read and propose | Turns run in different pods and cannot reuse a once-shown secret; MCP graph tools ignore graph read; proposing during scope can overwrite PRD candidates |
| The plugin "may still call `intent_handoff`" | It cannot under a service token | Saving a handoff requires a human session |
| PR base is the production branch when set | The repository's default branch | The production branch is defined for intent releases |
| PR body carries the approved spec | Summary and link to the full spec; foreign issue keys and images neutralised | GitHub caps the body; the importer links tasks by keys in title and body; remote images leak data |
| GitHub token needs `contents: write` and `pull-requests: write`; "branch protection is a deployment prerequisite" | Write-role bot account, fine-grained token without Workflows; runner refuses admin or maintainer accounts; rules documented, including latest-push approval, a merge gate and an optional run-branch ruleset | Branch rules do not bind admins and maintainers; Contents write can merge through the API |
| Pilot may use a subscription OAuth token | API key only, the customer's own, held only by the runner | Anthropic's terms (below) |
| "Run economics already exist here" | Spend on the run page only | Existing economics cover desktop runs only |
| Web reuses the desktop question and checklist components | A web mirror of the question card; a checklist from todos events; types restated in web | Web never imports desktop or workspace packages |
| `request_repo` appends the repository without review | Needs a member's consent under required acceptance; under automatic acceptance the runner clones it mid-turn | Otherwise the agent could widen an accepted scope on its own |
| Status `awaiting_scope_approval`; spec status `draft`/`approved`; policy `auto`; route `approve` | `awaiting_scope_acceptance`; `proposed`/`accepted`, plus `changes_requested`; `automatic`; `accept` | The plugin and intent vocabulary say "accept" |
| Inline answer wait (10 min), then deny with interrupt | Every question under pause ends the turn | The wait held a runner slot and added a second delivery path |
| Auto-answer questions after 48 h; wall clock 24 h | No auto-answer; a waiting limit (7 days) fails the run; the 24 h budget counts active time only | The 48 h timer could never fire under a 24 h clock; elapsed time never supplies an answer |
| Session without any outcome: one nudge, then fail | One nudge under both policies, then fail; the duration limit and the SDK turn cap are checkpoints | Long implement turns need checkpoints, not failures |
| Approved spec markdown inline in the implement prompt | Accepted spec file in the work directory, outside every clone | It survives context compaction and is never pushed |
| One session id, resumed whenever present | A predetermined session per phase | Implement starts from the accepted spec, not the scope conversation |
| Only the Claude session directory goes to object storage | The state directory (Claude Code config plus the plugin's state home), uploaded through the runner API | The plugin keeps run state there; the runner has no storage credentials |
| Commit and push every change; check out or create the branch | Staging rule withholds workflow files, gitlinks, LFS, large and credential-like files; fail when the remote branch exists and this run did not create it | The token has no Workflows permission; credentials must not be published; a run must not build on a branch it does not own |
| `queued` until the worker claims the first job | `queued` until a slot frees; oldest-first promotion; manual starts queue too | Cost and review load stay bounded |
| Change request is a question asked on the reviewer's behalf | Review text stored on the spec version | A spec version is where the feedback belongs |
| "Failure at any step marks the run failed" | After the done comment, transition problems are warnings | Finished work must not be discarded over a workflow quirk |
| In-process server `coredoc-run` | A name without a "coredoc" segment | The plugin counts any "coredoc" server's calls as Coredoc MCP writes |
| Helm `agentWorker` with replicas 1 on the server image | Optional `agentRunner` with its own image and Secret, none of the server's secrets | The image is customer-derived and the pod must not hold platform secrets |
| `AgentRunTimeoutCron` every 5 minutes | Run sweep every minute | Limits, lease expiry and Jira comments share one sweep |

### Phase 0 results

- **Item 3, GitHub (2026-10-08).** Measured on a test repository with a
  Write-role bot account and a classic token limited to public repositories,
  under a default-branch ruleset (pull request with one approval and
  latest-push approval, restrict updates, no deletion or force push, admin
  bypass) and a ruleset restricting branches outside `coredoc/**`:
  - push to the default branch, push to another branch, an API merge of the
    bot's own pull request and moving the default branch ref through the API
    were all refused;
  - push to `coredoc/**` and opening a draft pull request worked;
  - **pushing a tag worked**: branch rulesets do not cover tags. Decision: the
    tag ruleset under GitHub integration is a prerequisite, not a
    recommendation, wherever tags start release workflows.

  Still open for the pilot: the same checks with a fine-grained token in an
  organisation.

- **Item 2, SDK pin (2026-10-08, partial).** Measured on SDK 0.3.285, which
  bundles Claude Code 2.1.285 (above both floors); chosen as the pin unless a
  later item fails on it. On it:
  - deferral pauses AskUserQuestion with result reason `tool_deferred`, also
    when the message holds a second tool call, and the resume re-runs the
    deferred call through the pre-tool hook, which supplies the answers;
  - deny-with-interrupt ends with an `error_during_execution` result and the
    SDK iterator throws; resuming with the answer as the prompt works. It is
    not needed, because deferral covers every case measured;
  - AskUserQuestion is offered only when a permission callback is set;
  - `total_cost_usd` after a resume includes the earlier turns, so a turn's
    spend is the difference from the previous total, and the SDK budget
    counts only spend since the current call, so the remaining budget is
    passed as is;
  - the pre-tool hook's deny wins over `acceptEdits` automatic approval, and
    it refuses WebSearch;
  - aborting ends foreground and background Bash children (measured on
    macOS; the Linux image with its init process is checked in Phase 5).

  - the HTTP MCP server configuration takes a per-server tool-call timeout;
    without one, calls are effectively unbounded (SDK documentation on the
    pin), so the runner sets it;
  - the plugin loads by path with setting sources off: 22 skills listed, no
    plugin errors, and its SessionStart hooks run and export the plugin's
    session id equal to the Claude Code session id.

  - model and authentication failures (measured with made-up credentials and
    a stub API): the SDK emits a synthetic assistant message whose `error`
    names the kind (`authentication_failed`, `billing_error`,
    `model_not_found`, `rate_limit`, `server_error`, `unknown`), then a
    result with `terminal_reason` `api_error` and `api_error_status`, and the
    iterator throws; no API failure produces an `error_*` subtype. The
    runner classifies on that `error` field, falling back to the status.

- **Item 2, plugin contract (2026-10-08).** Checked against the plugin source
  at 0.14.0 plus two commits. No hosted-mode switch exists yet.

| Item | Today | What the runner does until the plugin changes |
| --- | --- | --- |
| 1. Spec from a PRD file | Partly: PRD-input mode exists, but there is no PRD-path or output-path input, every question round blocks and restarts the stage, branch-start runs git, and **product questions are never asked**: open product gaps go to "Candidates for the PRD" | Route with explicit `--intent spec` signals and a work-item reference; the prompt names the PRD file and the output path, and forbids git writes |
| 2. One proposal closes the spec run | Not met: a standalone spec run parks for acceptance | The prompt has the agent finish the spec stage and the run with outcome success |
| 3. External approval | Not met: no machine-checked approval exists | The acceptance record is presented as the recorded reply; a plugin change is preferred over routing around the gate |
| 4. No git delivery | Partly: branch-start still fetches, switches and merges | Prompt rule plus the runner's pre-tool hook denying git writes and `gh pr` |
| 5. Questions only from the main session | Partly: a dispatch-prompt rule only | Prompt rule plus the pre-tool hook denying AskUserQuestion from subagents |
| 6. Session end suspends the run | Partly: works with a state home the runner archives and a session-end hook budget; the suspend snapshots every clone | As specified; Phase 0 measures the budget with five clones |
| 7. Host-callable preflight | Partly: callable with `GIT_DIR`/`GIT_WORK_TREE` and `GIT_CONFIG_*` auth; the push check needs a fetched remote branch | As specified |
| 8. Pinned by release | Not met: no release tags; Linux launcher is x86_64 glibc only | Pin by commit, verified against the plugin's provenance file at image build |

  The SessionStart hooks make no network calls when no capture variable is set,
  and leave no process behind.

  **Decided at the gate:** product choices stay out of AskUserQuestion, as the
  plugin intends. Scope proposals carry them as candidates for the PRD for the
  reviewer to settle at scope acceptance; only developer-owned questions pause
  a run. No plugin change is needed for this.
- **Item 5, a sample PRD (2026-10-08).** One real PRD page (written by the PRD
  tooling before it moved to Jira descriptions) was read for its ADF shape: it
  holds panels of three types, inline cards inside headings, code marks,
  ordered lists and legacy `extension` nodes that carry nested ADF. The
  converter coverage now includes them. The fixture itself waits for the first
  PRD the tooling writes into a Jira description.

- **Item 7, sizing (2026-10-09).** Measured with the runner image and local
  checkouts of the pilot's repositories (sizes only):
  - base runner image 703 MB (293 MB compressed); a derived image with five
    Node majors, yarn 1 and Go 1.9 GB (703 MB compressed);
  - scratch per turn for five clones with dependencies: about 6 GiB for the
    largest backend services and about 12 GiB for the largest web apps; the
    chart's scratch volume defaults to 16Gi per replica;
  - state archives, proxied by local Claude Code sessions of two hours or
    more: median 2.3 MiB, p90 25.5 MiB, largest 50.6 MiB compressed, so the
    128 MiB archive cap stays;
  - building the image showed that pnpm installs the workspace root's
    dependencies with every filtered install; the server image now prunes
    the SDK the CLI pulled in, and the image check asserts its absence.

  Not measured: the session-end hook budget with five clones, and the
  runner's start-up check inside the image (the Claude Code binary does not
  run under emulation; the image CI job runs it on x86_64).

### Decisions made during synthesis

These settle questions the draft left open or add what it lacked. They are part
of the acceptance gate.

- **Runner topology.** The agent runs in a customer-run pod holding only the
  customer's model key, the bot's GitHub token and a runner token; Coredoc's
  server never executes agent or repository code. Decided with the owner on
  2026-10-08.
- **Git and pull requests in the runner** with the bot's token; the server
  assembles pull request text and verifies every pull request, and its own
  GitHub token stays read-only.
- **Run owner for Jira-triggered runs.** The run acts as the admin who switched
  agent runs on, not as the label author.
  - Resolving a Jira account to a member is unreliable: Jira hides email
    addresses by default, and the only linking path today is an API-only admin
    merge.
  - The cost: every triggered run is attributed to one admin, and anyone who
    can label issues in the configured projects can start runs.
  - Mitigations: project scoping, budgets, the concurrency limit, and scope
    acceptance required by default.
- **Model credential is the customer's own API key.**
  - Anthropic's legal and compliance page ("Authentication and credential
    use") says developers building products or services on the Agent SDK
    should use API key authentication, and may not route requests through
    Free, Pro or Max plan credentials on behalf of their users, nor collect,
    store or intermediate Claude.ai credentials.
  - The section "Can customers offer Claude Code in their products?" requires
    the Commercial Terms and an unmodified Claude Code binary, and forbids
    intermediating usage. Each key's usage is billed to its owner.
  - The key lives only in the customer's runner Secret; Coredoc never stores
    it. Confirm with the Anthropic account team if any other arrangement is
    ever needed.
- **Turns are not push jobs**; leases and re-queueing live on turn rows.
- **Turn limits are checkpoints**, bounded by spend and active time.
- **Repository cap** of five per run; re-run branches `coredoc/<ISSUE-KEY>-<n>`;
  epic child issues appended to the PRD.
- **License expiry** stops creation and promotion; runs mid-way fail at their
  time limit.
- **Availability** does not depend on a runner being connected; runs wait
  visibly instead.
- **Platform and packaging.** The runner image is linux/amd64 with glibc only
  for now. A gateway base URL is optional. Compose has no runner. The image is
  signed, has an SBOM and ships in the air-gap kit.
- **Analytics.** No Usage or Delivery analytics integration in v1.

### Runner alternatives considered

The draft rejected other runners mainly because the plugin had to run
unchanged. With the plugin now expected to change for remote agents, that
reason is weaker, so the choice rests on these:

- **Agent SDK in a customer-run pod (chosen).** The agent loop, tools and code
  all stay in the customer's infrastructure under the customer's key, and the
  plugin keeps targeting Claude Code's harness (skills, hooks, subagents,
  AskUserQuestion).
- **Managed Agents with self-hosted sandboxes.** Tool execution can run in the
  customer's infrastructure, but the agent loop stays on Anthropic's side.
  Hooks and slash commands move to the client, and there is no question tool,
  so the plugin would need a different shape, not just a hosted mode. Because
  the runner protocol is the seam, a Managed Agents runner can be added later
  without server changes beyond the runner API.
- **Self-hosted Claude Code environments and routines.** Sessions are started
  and answered through claude.ai surfaces on an Anthropic-hosted control plane.
  No documented API exists for answers, streaming or cancel, and dispatch
  needs a claude.ai OAuth token, which a product may not store or
  intermediate.
- **Claude Tag.** Slack is both the trigger and the conversation surface, and
  its pull requests come from the Claude GitHub App. That conflicts with the
  rule that people decide in the Coredoc web app.
- **GitHub Action.** No mid-run pause, and context is rebuilt per run.
- **OpenHands.** Its own agent; the plugin does not port.
- **Temporal.** A second codebase and a second question UI. Revisit if the
  chain grows into review loops and reminders.

### Limitations and risks

- **What the model API sees.** Repositories and clones stay in the customer's
  infrastructure, but whatever the agent reads into its context is sent to the
  model API.
- **The agent holds the runner's credentials.** A prompt-injected agent can use
  the bot's token within its scope (push to unprotected branches, open and
  comment on pull requests, read the repositories it covers), use or send out
  the model key, so spend is bounded by the key's provider-side limit rather
  than the run's budget, and act as a runner of its workspace. The
  mitigations are configuration: a dedicated key with a spend limit, a
  narrowly scoped token, the branch rules, the run-branch ruleset, egress
  policy, and revoking the runner token.
- **Exfiltration.** Anything the agent can read can leave through an allowed
  host that accepts uploads, such as a public npm registry or the GitHub
  organisation itself. The model API is an allowed host too: with the key,
  the agent can call the API's server-side web fetch, web search or code
  execution tools from Bash and reach arbitrary URLs from the provider's
  side, past the pod's network policy. Prefer read-only internal mirrors, and
  turn off server-side tools for the key's organisation where the provider
  allows it, or route through the customer's gateway.
- **CI on agent branches.** CI runs agent-written code with the secrets the
  repositories' workflows receive, unless customers follow the CI guidance in
  the install guide.
- **Archives are unredacted.** State archives hold full transcripts, meaning
  file contents and tool output. They sit in the customer's object storage
  for 30 days, readable by anyone with access to that storage.
- **Self-reported spend.** Spend comes from the runner and is an estimate; the
  run budget limits honest runners, not a compromised one.
- **Redaction gaps.** The server's pattern list catches common credential
  shapes and the runner masks the exact values it holds; other secrets the
  agent reads can reach the run page.
- **Waiting holds slots.** Runs waiting for a person keep their slot, so two
  waiting runs block a workspace at the default limit of 2.
- **Test dependencies.** Many backend repositories run their tests through
  `docker compose` with databases and caches. The runner pod has no Docker,
  so those tests do not run as scripted. Decided for v1 (2026-10-08): the
  agent runs only the tests that need no infrastructure and reports
  compose-tested repositories as not built or tested in the runner; their
  integration tests run in the repository's own CI on the draft pull
  request. Data-store sidecars in the runner pod are revisited if the pilot
  shows the agent often breaking integration tests it could not run. This
  relies on pull-request test workflows still running on `coredoc/**`
  branches, so the CI guidance keeps them running without sensitive
  secrets rather than excluding them.
- **Slow intent reads.** Intent context reads have no server-side deadline. The
  agent's MCP timeout caps the wait, and the agent continues without that
  context.
- **Absent product owners.** Under pause, questions addressed to the product
  owner may be answered by whichever member opens the run page.
- **Crash during turn completion.** If a runner dies after pushing some
  repositories but before completing the turn, the retried turn starts from an
  older session over newer branches. This is rare, and the agent sees the
  committed code.
- **A partitioned runner.** A runner that lost its lease but still runs can
  push once more before its next heartbeat; the re-claimed turn then fails
  with `push_rejected` or builds on that commit. The branch reservation keeps
  the run's own branch from being mistaken for a foreign one.
- **Throughput.** One runner replica runs one turn at a time, deliveries
  included. Size replicas for the expected load.

### Vocabulary

- **Agent run.** UI "Agent runs"; API resource "cloud agent runs". Distinct
  from desktop agent run telemetry, the plugin's workflow runs, and agent
  sessions.
- **Agent runner.** The customer-run pod and process that executes turns.
- **Phase:** scope, implement, delivery. **Turn:** one unit of runner work.
  **Checkpoint:** a turn that stopped at a limit and continues.
- **Run owner:** the member a run acts as.
- **Repository key:** the durable key, as opposed to the graph hash.
- **Accept** is used for scope, matching the plugin's spec acceptance and intent
  authority. Accepting a run's scope never accepts intent.
- **"Delivery"** here is the run's last phase. Delivery analytics, intent
  delivery and the plugin's git delivery skill are separate things.

### ADR and guardrail alignment

- **Explicit degrade, no silent zeros.** Unknown and partial spend, waiting for
  a runner, waiting reasons and availability reasons are rendered states,
  never zeros or hidden failures.
- **Machine-derived rows are prunable; human input is ground truth.** Events,
  turns and archives are pruned. Specs, answers, acceptances and change
  requests are never deleted automatically.
- **No client patterns in shared infrastructure.** Fixtures, docs and examples
  use neutral placeholders, and the converter fixture is scrubbed.
- **Per-member delivery filter (successor to the blameless analytics ADR).**
  The run list shows who started and accepted runs, for accountability. No
  surface ranks members or aggregates spend per person.
- **Simplicity bar.** Each new mechanism and what it answers:

| Mechanism | Requirement or observed failure | Who benefits |
| --- | --- | --- |
| Separate runner pod and runner API | The worker pod holds platform secrets; the agent must not live next to them | Customer security; operators |
| Turn rows with leases | The runner has no database access; one turn per run must hold across pods | Run correctness |
| Runner token scope and exact-purpose fence | Service tokens otherwise reach the cloud MCP and every permission-less route as their creator | Security |
| Per-turn MCP token with an owning-turn column | Turns run in different pods and cannot reuse a once-shown secret; phase-specific permissions; the token must be MCP-only, hidden and cleaned up without name collisions | Security |
| Server-assembled pull request text and verification | The importer links tasks by keys in title and body; a compromised runner must not post arbitrary links | Teams; product owners |
| Staging rule and secret preflight | The token has no Workflows permission; credentials must not be published | Customer security |
| Run-level queue and promotion | Labels can arrive faster than review capacity | Reviewers; cost owners |
| Settings table | No workspace settings store exists; the feature has more than ten fields | Admins |
| Run sweep | Limits, lease expiry and Jira comments need one owner | Users of failed runs |
| Retention sweep | Events, turns and archives grow without bound | Operators |
| Per-turn report caps and rate limit | A compromised runner writes into the shared control-plane database | Operators |
| Repository-request consent | People decide the scope | Reviewers |
| Re-run branch suffix | A re-run must not build on the previous run's branch | Developers |
| GitHub account check | Branch rules do not bind admins and maintainers | Security |
| Plugin contract | The plugin changes independently for remote agents | Coredoc engineers |
