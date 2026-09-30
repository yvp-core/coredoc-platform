# Coredoc PR review

The GitHub-hosted action reviews each eligible PR/update and publishes inline
findings plus one summary automatically. It never approves changes.
The local CLI produces files for prompt/tool evaluation; it is not a deployment runner. The model reads review source at captured
SHAs through Git objects or the GitHub API. Runner bootstrap is described below.

## Local use

Build the CLI and dependencies with `pnpm --filter @coredoc/cli... build`.
Set `COREDOC_REVIEW_LLM_API_KEY` in the host environment, and `GITHUB_TOKEN` for
private repositories or API rate limits. For graph arm B also set
`COREDOC_REVIEW_GRAPH_TOKEN`. Credentials do not belong in settings or requests.

Create settings from `settings.example.json`: the current pilot uses
`openai/gpt-6-luna` on OpenRouter, declared prices of $0.10/M input and
$0.50/M output, and a $2 per-run reservation budget. Not the `-pro` variant: on
OpenRouter it reports about 4.2x more prompt tokens for the same bytes (28,933 vs
6,846 for one 30 KB file, measured 2026-09-17), which quadruples both cost and
per-minute token-limit pressure. The declared prices are also the
`max_price` ceiling sent to OpenRouter with `require_parameters`, so they must admit an
endpoint that supports structured outputs (every OpenAI/Azure Luna endpoint does; for GLM-5.3-flash
the cheapest one did not and a ceiling at its price made every schema-constrained call
fail with HTTP 404). Confirm current endpoint rates before changing them. Policy, limits
and exclusions are maintainer-owned settings.

```sh
coredoc review capture --repository OWNER/REPO --pr 123 --settings settings.json --output request.json
coredoc review run --request request.json --output result.json --markdown result.md
```

`capture` performs read-only API calls and records base, merge-base and head SHAs.
For historical PRs, prepare a request from the cohort manifest instead: set
`mode` to `historical` and the three immutable SHAs recorded at review time.
`run` never replaces them with today's PR metadata. To use a local Git repository,
add `--repo-dir /path/to/repository`; uncommitted files are ignored. Local distance
calculation still tries the compare API first, falling back only to complete Git history.

An exit status of 0 from `run` means a report was written, not that the PR is safe
or that analysis was complete: an `incomplete` report — model-side or coverage gaps —
also exits 0 and says so in the report. `run` exits 1 only when it produced no report
or the run was cancelled. The Actions job (`event`) exits 1 only for infrastructure
outcomes: no report at all, a publication that is `failed` or `partial`, or a cancelled
run. An `incomplete` review that published its summary leaves the job green.
A `superseded` publication (the head moved) or a `disabled` one (the kill switch)
is a correct outcome and also exits 0. `capture` returns 2 for an ineligible PR. Reports identify omissions, model/tool limits and unknown cost.
Model output is never retried for quality; only an unbilled transient refusal from OpenRouter
(HTTP 429/502/503/504) is retried, with a growing back-off (15 s, 30 s, 60 s, 90 s, 120 s, each with
±25 % jitter, sized for per-minute token limits). Retries continue while the call has waited less than
five minutes in total and the run's `maxSeconds` deadline is still ahead; then the call stops with
`OPENROUTER_HTTP_<status>`. Cancellation (SIGTERM, the run timeout) ends a wait in progress at once.
Token prices, when supplied, produce an estimate
labelled `configured-rates`; they are not an invoice. Other providers can cross a cumulative limit because actual usage arrives
only when a call finishes. OpenRouter with `maxUsd` additionally reserves a
conservative UTF-8 byte-based token estimate plus framing headroom before each
call, pins provider price ceilings (fallbacks between endpoints under that ceiling stay
enabled), and stops on unknown accounting. A settled charge above its reservation is
recorded as billed; the next pre-call check then refuses further calls, so a run is bounded
by the budget plus one call (reasoning models ignore max_tokens for reasoning tokens). The report distinguishes settled charges from an uncertain
reservation. This is per-run protection, not an account-wide spending limit.
OpenRouter's reasoning mode and price-ceiling routing (`allow_fallbacks`,
`require_parameters`, `sort`, `max_price`) are model settings sent on every
OpenRouter call, independent of whether `maxUsd` is set; the `maxUsd`
reservation guard only validates that the transmitted price ceiling still
matches the declared prices.

An exhausted tool-call budget is reported to the model as a `TOOL_LIMIT` tool result
instead of ending the run: every later model call is sent without tools, so each phase
answers with the evidence it already read. `TOOL_LIMIT` remains a limitation that makes
the review incomplete. A previous finding that verification rejects with corroborated
fresh head evidence is recorded as a reject in `rechecks` without a separate recheck call.

Recoverable tool errors — `SOURCE_NOT_FOUND`, `SOURCE_RANGE_INVALID`,
`TOOL_INPUT_INVALID` and similar — are recorded as limitations but do not by
themselves make a run incomplete. Collection gaps (for example
`SOURCE_NOT_INSPECTED`, size-limit truncation) and abort codes make a run
incomplete or failed.

## GitHub Actions

Use `.github/workflows/pr-review.yml`. Setup needs exactly one model credential,
configured through `settings.model.provider` and one matching action input.
The job references the `production` environment with `deployment: false`, so it
can read the secret without creating a production deployment record. Any
environment access rules still apply. `GITHUB_TOKEN` is supplied automatically.

The API key path is the default and recommended: set `COREDOC_REVIEW_LLM_API_KEY`
in the repository's `production` environment and pass it as `model-api-key`, with
`settings.example.json`'s provider/price shape.

The alternative is a Claude subscription (Pro, Max, Team or Enterprise). Run
`claude setup-token` as the maintainer whose plan the workflow should consume, and
store the resulting value as the `CLAUDE_CODE_OAUTH_TOKEN` secret in the
`production` environment, passed as `claude-code-oauth-token`. Settings use
`model.provider: "claude-code"` with a required `model.id` and no prices or
`maxUsd` (`settings.subscription.example.json`). Configuring both credentials,
neither, or a credential that does not match `settings.model.provider` ends the
run with `MODEL_CREDENTIAL_MISCONFIGURED` in the job summary before any GitHub
read. On the subscription path no price ceiling applies: the plan's own limits
plus the existing file and line limits bound the run; the summary shows
`auth: subscription` and reports cost as unknown. Plan exhaustion or a rejected
token ends the run incomplete with `SUBSCRIPTION_PLAN_EXHAUSTED` or
`SUBSCRIPTION_CREDENTIAL_REJECTED`, publishes no finding from that attempt, and
leaves earlier comments untouched. The token is personal to whoever ran
`setup-token` and consumes that person's plan windows, so treat it like any other
maintainer credential. The Claude runtime receives an allowlisted environment
(`PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`,
`CLAUDE_CODE_OAUTH_TOKEN`); job-level `ANTHROPIC_*`, proxy or `DEBUG` variables do
not reach it, so self-hosted runners behind a proxy are not supported on this
path. The runtime gets no built-in tool, only the same host read tools through an
in-process MCP server. On-prem, `graph.url` may name a customer-hosted Coredoc MCP
endpoint with its own `graph-token`, on either credential path.

Model, policy, limits and exclusions live in the workflow's `settings` JSON block.
There are no required repository Variables, enable/publish flags or manually
maintained runner SHA. Each run checks out `github.workflow_sha`, the revision
containing its workflow, and records that SHA in the report. New workflow/runner
changes are therefore picked up with subsequent runs without a separate version
update. Rerunning an older event uses its original revision.

The operator-facing limits are 150 eligible changed files, 15,000 added plus
removed lines (context/header lines do not count), and a dollar budget per review.
Lockfiles, generated output and the documented private/eval paths remain excluded.
If either size limit is exceeded, the report is explicitly incomplete; omissions
never become a clean review. Internal ceilings bound memory (2 MB diff / 6 MB
assembled context), provider output (48,000 tokens per call, including reasoning where the provider counts it) and execution
(25 minutes wall clock). Model calls and tool calls have only safety ceilings (1,000 / 2,000 by
default): the per-run dollar budget and the wall clock are the operative limits. There are no
cumulative input/output token caps. `maxLenses` (default 4, ceiling 6) and
`maxParallelLenses` (default 2, ceiling 6) bound how many discovery lenses a review runs and
how many of them are in flight at once.
These are runner safeguards, not additional setup knobs; advanced local evals may
lower them through the existing request schema.

Each phase — the router, every discovery lens, verification and the recheck — runs as one
AI SDK tool loop (`generateText` with `stopWhen` and `prepareStep`). Tool-enabled steps carry the phase JSON schema inside the prompt
and are sent without a provider `response_format`: a provider-enforced schema on a
tool step made the pilot model answer an empty object instead of reading source.
Only the final, tool-less step is provider-constrained through
`Output.object({ schema })` (OpenRouter: `response_format: json_schema`, `strict: true`);
the engine consumes the SDK-validated output and separately verifies the source evidence.
Every discovery lens requires `read_source` until source has actually been returned. An empty
answer, a listing or an EOF response alone cannot complete a review of eligible
changes: the host reports `SOURCE_NOT_INSPECTED` and the report is incomplete.
A successful read is a minimum execution requirement, not a review-quality score.

Discovery also has a coverage floor. The `logic` lens must read every changed file that
carries a patch at head; a focused lens must read the files the router gave it. When a lens
answers on its own before reading them it is
sent back — same tools, same schema, same budget accounting — with a request to
read the files it skipped; a path whose read the host refused (`SOURCE_NOT_FOUND`
and similar) counts as covered, because retrying it cannot return source. Only the
lens's own reads count: a file a sibling lens read in parallel is still unread for this
one. The floor applies once the run has read at least one file; reading nothing at all is
already refused as `SOURCE_NOT_INSPECTED`. After three such nudges, or once the
step budget cannot afford another call, the answer is accepted and the run
reports `SOURCE_COVERAGE_PARTIAL`, which makes it incomplete: an empty verdict
over a tenth of the change is a limitation, not a clean review.

Verification has the same kind of floor on its own evidence. Before its answer is accepted, the
host validates every `confirm` exactly as it will after the phase; when the failure is one a
further read can fix (`EVIDENCE_NOT_READ_THIS_PHASE`, `EVIDENCE_EXCERPT_MISMATCH`,
`EVIDENCE_RANGE_INVALID`, `EVIDENCE_EXCERPT_AMBIGUOUS`), the phase is sent back on the same loop
with the exact intervals it must read and a request for all verdicts again; a candidate left
without any verdict is asked for the same way. An anchor failure or
unavailable source cannot be fixed by reading, so it is not nudged. Its task text also orders the
reads first: read every required interval in one step, then answer, because a text answer before the
tool results is invalid. After three such nudges, or once
the step budget cannot afford another call, the answer is accepted, the post-phase validation drops
the still-unbacked confirm to unresolved as before, and the run reports
`VERIFICATION_EVIDENCE_PARTIAL`. The recheck of previous findings has the same floor and task order: a
confirm or reject whose head evidence was not read in that phase is sent back with the intervals
instead of leaving the previous finding unresolved and the run incomplete.

## Router and lenses

Discovery is not one generic "find anything" pass. A cheap **router** call runs first and
alone: no tools, a provider-constrained `{ lenses: [{ id, reason, focusFiles }] }` answer, and
no review of its own. Each chosen **lens** is then a full discovery loop carrying one focused
checklist, and the host merges every lens's candidates before the single verification phase
judges them.

The catalogue is `logic` (contracts, enum and value completeness, consumers of a new value,
error paths, incorrect state transitions — always on, and added back if the router leaves it
out), `data-safety` (SQL, schema and query names, migrations), `concurrency` (races,
atomicity, retries, cancellation), `trust-boundary` (untrusted or model-generated input,
shell, paths, auth and permissions, secret exposure) and `ui` (rendering states, data
invalidation, accessibility basics, formatting). Style is not a lens: the system prompt
already excludes taste. Unknown ids are dropped, duplicates collapse, `focusFiles` is
restricted to the changed paths this run actually sent, and at most `maxLenses` lenses run,
in catalogue order. `maxParallelLenses` lenses are in flight at a time; each one receives an
equal share of the discovery step budget and the global `maxSteps`, dollar and wall-clock
limits still apply to all of them together.

Every call of a run sends the same two user messages: message 1 is the **prefix** —
revision, changed-file manifest, coverage gaps, graph provenance, the diff and any previous
findings — built once and sent as byte-identical bytes by the router, every lens,
verification and the recheck, so the provider serves it from its prompt cache instead of
charging full input price per lens. Message 2 is the only part that differs: this call's
task, lens policy, run policy, output schema and focus files. Coverage nudges, step
reminders and the final tool-less message are appended after those two; the prefix is never
rebuilt, and it is counted against the assembled-context ceiling once.

A router that cannot answer even after its one schema repair is recorded as
`ROUTER_UNAVAILABLE` and the review continues with `logic` alone. A single lens that ends
with `MODEL_OUTPUT_INVALID`, `MODEL_OUTPUT_LIMIT`, `STEP_LIMIT` or a transient provider refusal
(`OPENROUTER_HTTP_429/502/503/504`, after its back-off ladder above) is recorded as
`LENS_FAILED` (with its own code and in `coverage.lenses[].failed`) while the other lenses'
candidates survive; a budget, time, cancellation or trust-boundary failure still ends the run
and cancels the sibling calls. `coverage.lenses` records, per lens, why it was chosen, its
focus files, its model calls, its candidate count and any failure, and the Markdown report
renders it as a table. When more than one lens runs, candidate ids are prefixed with the lens
id, so two lenses inventing the same local id do not silently discard one defect.

The review runner uses the pinned OpenRouter AI SDK adapter for OpenRouter models.
It preserves Gemini's opaque reasoning metadata between tool calls in memory only;
it is never included in the saved report or published comments. The
`~deepseek/deepseek-pro-latest` id is sent `reasoning.enabled=false`: on this full
PR, its low-effort reasoning consumed both 4,000 and 16,000 token allowances without
emitting text or tools. GLM-5.3-flash gets `effort: minimal` (its endpoints reject disabling
reasoning). Every other model, including the current Luna pilot, gets the low-effort
reasoning request. This runtime choice needs cohort quality evaluation;
completion alone is not quality evidence.

Each completed model call logs metadata only: phase/call number, the lens it belongs to,
elapsed time, finish reason, input/cached-input/output/reasoning tokens, text byte count, tool-call count
the per-call output limit and known tool-error codes from that call. Final-response
diagnostics distinguish JSON, fenced JSON and text, plus bounded schema issue codes
and known field names without their values. Exceptions record unknown usage rather than zero.
The JSON report and Actions step summary retain the same diagnostics. Diagnostic
fields exclude prompts, source, model text, reasoning, tool payloads and provider
error messages.
`MODEL_OUTPUT_LIMIT`, `MODEL_CONTENT_FILTERED` and `MODEL_PROVIDER_ERROR` distinguish
truncation, filtering and a provider error. Truncation still fails closed; the only
transport retry is the bounded one for unbilled 429/5xx refusals described above. If a tool-enabled phase stops with prose or an
invalid result, the runner makes at most one JSON-only finalization call using
the pinned task and observed tool results, within the same call/time/cost budget.
Invalid finalization still fails; the prose is not reused as evidence. Paging
beyond a readable file returns explicit EOF and no evidence interval. Missing
source and non-positive ranges remain visible failures. Read-window endpoints
are absolute line numbers and are ordered before clipping; the returned interval
is always the actual text observed, and evidence outside it is rejected.

Opening/updating an eligible PR starts review and publication. The local
`review run` command remains file-output-only for prompt/tool evaluation.
To stop, disable **Coredoc PR review** in GitHub Actions and cancel active runs.
The publisher checks live workflow state and PR revisions before every write. It reads
that state for the fixed file name `pr-review.yml`, so the workflow file must keep that
name; renaming it requires changing `REVIEW_WORKFLOW_FILE` in the runner in the same change.

The current YAML permits at most $2 per run using pre-call reservations (owner
decision 2026-09-17, replacing the earlier $5 cap). That is not a cumulative account
cap: repeated PR updates can each spend it. When the transport reports settled
charges (OpenRouter `usage.cost`), the run's cost gate uses them instead of the
declared-price estimate, which overstates cached prompts many times over. Count
failed attempts and reconcile uncertain charges before continuing.

Setup installs dependencies at the workflow revision with lifecycle scripts
disabled and bundles only the review entry point. It does not run the target PR's
tests, builds or hooks. The job has `contents: write`, `pull-requests: write` and
`actions: read`; no artifacts are uploaded. `contents: write` exists only because the
GraphQL `resolveReviewThread` mutation refuses the job token without it (measured: with
`contents: read` it returns `FORBIDDEN`, and `pull-requests: write` does not help); the
runner never pushes, and the token is never given to the model. Same-repo contributors are trusted
for workflow and runner administration. The model only receives fixed read tools;
this is not isolation against a malicious workflow author.

Forks, Dependabot, draft/closed PRs and non-default target branches are skipped.
Automatic `pull_request` events do not run for conflicted PRs; manual dispatch is
available. The exact PR head is used, not `GITHUB_SHA`'s synthetic merge commit.

## Graph treatment

Set `arm: "B"` and a `graph` object with `url`, explicit `scope`, `repoName` and
`locallyPreparedBase`. HTTPS or loopback HTTP MCP is accepted. The host
verifies the repository remote and the single-repository evidence metadata.
No MCP-provided tool catalogue or dynamic tools are exposed to the model.
The shipped workflow points `url` at the workspace MCP of the same cloud the
`Coredoc` sync workflow pushes to (`COREDOC_SERVER_URL` / `COREDOC_WORKSPACE_ID`)
and passes that workflow's `COREDOC_TOKEN` as `graph-token`; the MCP only reads.
A graph treatment that cannot be admitted at the start of a run (unreachable MCP,
repository or scope mismatch, missing provenance) is recorded as `failed` with its
code and the review continues on source alone without `graph_lookup`.

The existing MCP exposes a parse identity (repository, parsed timestamp, commit
and parser version), not the cloud snapshot file key. Reports label that identity
`parse:<digest>`. Every graph call must match it; changes make the treatment
incomplete/diagnostic. Missing provenance is never represented as fresh. Source
evidence is always read at the captured PR revision.

Historical arm B is diagnostic unless the maintainer separately prepared the
recorded base graph and set `locallyPreparedBase: true`; observed graph SHA must
equal the recorded base. For local runs, replace `url` with
`local: { "cliPath": "/absolute/trusted/coredoc/dist/index.js", "configPath": "/absolute/config.json", "projectId": "prepared-base", "backend": "ladybug" }`.
The host starts that installed CLI's existing `mcp` stdio command under Node;
only the fixed graph reads are exposed, MCP metrics and CLI telemetry are disabled, and the child closes
with the run. These paths/configuration are trusted maintainer inputs, never files
from the reviewed PR. This local transport is refused by the Actions event adapter.
Prepare the graph separately with the existing parse command. This runner never
indexes or pushes.

## Evaluation and publication

See `evals/pr-review/README.md` for the cohort/adjudication protocol. Mock-provider
tests prove engineering behavior only. Real model results and blind human labels
are required for quality claims. The owner authorized a bounded publishing pilot
before the quality cohort is complete; this is an experiment, not a precision claim.

The publisher binds every review to the captured head, reads existing bot-owned
comments with pagination, and retains a root-cause thread across line shifts and
renames, or across a reworded cause when the title stays on the same line. It reads back uncertain writes before trying missing operations on a
subsequent run. Human comments and replies are never edited. Previous findings
are checked again: only fresh source evidence can label one no longer applicable, and a
thread so labelled is also resolved through the GraphQL API (a failure to resolve is logged by
code and does not fail the publication). Each inline finding carries a collapsed plain-text
"Prompt to fix with AI" and a "Fix in Codex" link that opens the same prompt as a Codex Cloud task
(the finding text is fenced as an untrusted claim inside that prompt);
a "Fix in Claude" button needs an https redirect to the `claude-cli://` scheme, which GitHub
strips from comment Markdown, so it is not offered yet.
An incomplete run still publishes its verified findings — each one passed the same host
evidence validation — and writes the recheck verdicts it did reach, but leaves earlier comments
it could not reverify exactly as they are and reports its status in the summary; a cancelled run publishes nothing at all. Findings without an
inline anchor use source permalinks in the summary.

If the PR head changes during an accepted write, the result is `superseded` and
further writes stop. Already accepted comments retain their explicit reviewed SHA;
the next current-head run reconciles them. A failed or cancelled job is visible
in Actions and cannot be interpreted as a clean review. There is no pre-run comment.

The first end-to-end flow uses the existing AI SDK runtime; the Claude Code
runtime (above) is a second, dispatched runtime behind the same publisher. Eve
remains a separate trial until its adapter and Linux acceptance checks pass; no
local Codex credentials are copied to CI.

## Engineering smoke

Bundle `packages/cli/src/review/entry.ts` with the esbuild command in `action.yml`,
then run `node actions/review/smoke.mjs /absolute/runner.mjs`. This uses a local
HTTP provider and fixture GitHub reads; it makes no paid requests. The same script
runs with both files mounted read-only in a Node.js 22 Linux container using
`--network none`. This proves the bundled path; actual PR event/cancellation and
model quality still require the enabled pilot.


The publisher smoke runs the real bundled `review event` command three times with
fixture GitHub state and a fixture OpenRouter transport:

```sh
node actions/review/publication-smoke.mjs /absolute/runner.mjs
```

It checks first inline publication, same-head idempotence, and a new-head fix
recheck, including model-tool restrictions and per-run cost accounting. Run it
in the same network-disabled Linux container as the source smoke. Fixtures prove
adapter behavior; they do not establish real GitHub permissions or model quality.

## Evidence diagnostics and prompt scope

A rejected confirmation retains `FINDING_EVIDENCE_INVALID` and a specific host code:
`FINDING_ANCHOR_NOT_CHANGED`, `FINDING_ANCHOR_NOT_COVERED`, `EVIDENCE_RANGE_INVALID`,
`EVIDENCE_NOT_READ_THIS_PHASE`, `EVIDENCE_EXCERPT_MISMATCH`, or `EVIDENCE_SOURCE_UNAVAILABLE`.
Rechecks can also report `EVIDENCE_HEAD_REQUIRED`. Codes appear in JSON coverage,
CLI/Actions logs and the Markdown report; the report explains each reason. These
are validation failures, not evidence that the allegation is a real defect.
The host derives each evidence end line from the quoted text before checking its
1–40-line limit, exact source match and fresh read. An unusable quote is not dropped
on arrival: verification is sent back with what is wrong with it (too long, unread,
mismatched, ambiguous, or covering no anchor line) and may re-quote it. A quote still
unusable after those nudges drops its candidate with a visible limitation; it does not
discard other verified findings.
Line numbers claimed by the model are likewise corrected from the verbatim quote when it
occurs exactly once inside a window read in the same phase (the anchor moves with it), and a
quote occurring more than once is rejected with `EVIDENCE_EXCERPT_AMBIGUOUS`.
No rejected excerpt, provider reasoning or credential is added to diagnostics.

The prompt version is `REVIEW_PROMPT_VERSION` in `engine.ts`; it is not tracked as a
number here. It uses a short investigation checklist, explicit counterevidence checks,
a changed-file manifest, remaining phase calls and exact source/line instructions.
Reference ideas: [OpenHands code-review](https://github.com/OpenHands/extensions/blob/ee187dfb84efe78b9da763e58eb156fc8dfe78eb/skills/code-review/SKILL.md)
for grounded findings, [its review prompt](https://github.com/OpenHands/extensions/blob/ee187dfb84efe78b9da763e58eb156fc8dfe78eb/plugins/pr-review/scripts/prompt.py)
for distinguishing omitted patches from absent files, and [gstack's checklist](https://github.com/garrytan/gstack/blob/main/review/checklist.md)
for tracing risky state and data flows. The prose is adapted to this read-only runtime.
No external skill is executed or dynamically loaded. GitHub publication remains
host-controlled; PR-branch instructions cannot redefine policy. Taste ratings,
blanket dependency-age gates, automatic approval, auto-fixes, suggestion blocks
and specialist orchestration are outside this pilot.
