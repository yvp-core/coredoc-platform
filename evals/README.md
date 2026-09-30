# @coredoc/evals

Internal harness for measuring how Coredoc changes an agent's repository-analysis work. The runtime contract is the code under `harness/`. Only the Coredoc self-target is published; other target manifests and run artifacts are not part of this repository.

## Run

Use `=` for value flags in governed commands, especially `--judge=`. `--target=` matches the manifest's top-level `name`, not its filename.

```bash
# Provenance and graph checks only: creates no agent or judge request.
pnpm eval --project=<id> --target=<manifest-name> \
  --lifecycle=smoke,diagnostic --preflight-only

# Held-out primary preparation: exact tracked snapshot, no .git, no model request.
pnpm eval --project=<id> --target=<manifest-name> \
  --lifecycle=primary --historyless-snapshot --preflight-only

# Paid permission canary only: repeats deterministic preflight, makes one
# bounded Claude request, writes evidence, then dispatches no primary/judge.
pnpm eval --project=<id> --target=<manifest-name> \
  --lifecycle=primary --historyless-snapshot --preflight-only \
  --run-primary-with-canary --judge=codex:gpt-6-sol

# Primary wave: repeats the same canary in this invocation, then dispatches
# only if it passes. Run each registered primary target as its own project invocation.
pnpm eval --project=<id> --target=<manifest-name> \
  --lifecycle=primary --historyless-snapshot \
  --run-primary-with-canary --judge=codex:gpt-6-sol

# A paid diagnostic slice (only after preflight succeeds).
pnpm eval --project=<id> --target=<manifest-name> \
  --lifecycle=diagnostic --case=type-impact --runs=1 \
  --judge=codex:gpt-6-sol

# Opt-in oracle grading: one blind judge call after all completed answers for
# each target × case. Every selected non-smoke cell must have curated `truth`.
pnpm eval --project=<id> --target=<manifest-name> \
  --lifecycle=diagnostic --runs=3 \
  --judge-mode=oracle-batch --judge=codex:gpt-6-sol

# Explicit arm or factor diagnostic.
pnpm eval --project=<id> --target=<manifest-name> \
  --lifecycle=diagnostic --arm=mcpOnly --runs=1

# Isolated Claude agent: empty cwd, no checkout/base tools.
pnpm eval --project=<id> --target=<manifest-name> \
  --lifecycle=diagnostic --no-checkout --runs=1
```

Other useful selectors are `--case=a,b`, `--arm=withMcp,withoutMcp`, `--provider=claude|codex`, `--claude-model=<exact-id>`, `--codex-model=<exact-id>`, `--backend=ladybug|sqlite`, and `--concurrency=<n>`. A project may contain several repositories, but each invocation is bound to one graph-owning `--project=`. Concurrent paid eval starts should be staggered and concurrency capped to respect provider limits.

The default `--judge-mode=legacy-ungrounded` preserves the historical per-response rubric judge. `--judge-mode=oracle-batch` uses the pre-curated `cell.truth` and never gives the judge source, MCP, arm labels, programmatic scores, transcripts, or tool metadata. It makes one no-retry call per target × case, classifies required/forbidden fact IDs, and lets the harness calculate the score. Missing required facts are `minor_error` with proportional coverage; any contradicted required fact or present forbidden fact is `major_error` with score 0. Because a single blind call decides both the credit and the hard zeros, every verdict that asserts text is quote-gated: the judge must return, in a per-response `evidence` object, a minimal exact verbatim quote of the response behind every `present` required fact, every `contradicted` required fact, and every `present` forbidden fact (only `missing`/`absent` need none — an absence cannot be quoted). The harness re-checks each quote against the graded response after whitespace normalization and, when the quote is missing, empty, or not a contiguous substring of that response, downgrades the verdict (required `present`→`missing`, `contradicted`→`missing`, forbidden `present`→`absent`), scores the downgraded vector, and records the override in `downgradedVerdicts` on the oracle-judge artifact while storing the judge's `raw` output verbatim. Programmatic and oracle scores remain separate endpoints.

`--provider=codex` requires an explicit `--codex-model=` because the Codex JSONL stream does not report its resolved model. `--no-checkout` and `--historyless-snapshot` currently support only `--provider=claude` and are mutually exclusive.

A future actual primary invocation must repeat its own canary with the same command and exact material fingerprints; persisted evidence remains output-only. Registered primary execution requires exactly `withoutMcp` plus `withMcp`, serial alternating AB/BA scheduling, and one project invocation per registered primary target; the commands above default to three pairs, producing AB/BA/AB. The unflagged `--preflight-only` command remains the zero-model first gate; adding `--run-primary-with-canary` makes it a paid canary-only check.

## Arms and access

The arm labels name two independent factors:

- `withMcp`: Coredoc MCP tools plus the product guide.
- `mcpOnly`: Coredoc MCP tools without the product guide; diagnostic only.
- `withoutMcp`: neither MCP nor product guide.

In normal worktree mode, the agent receives a clean worktree pinned to the target SHA and its allowed base read tools. This is a local-development efficiency estimand, not held-out capability evidence. With `--provider=claude`, worktree runs carry the same shape of permission envelope as the historyless mode, scoped to the worktree root: `Read`/`Grep`/`Glob` path arguments must resolve inside the worktree (symlinks are allowed only where they land inside it), every unlisted tool is denied, and MCP tools are untouched — a 2026-08-24 agent otherwise walked out of its pinned worktree and cited the user's live unpinned checkout. The declared surface is the worktree plus the cell's pinned sibling checkouts, which preflight has verified are at their pinned SHA and clean; the user's live unpinned checkout of the target repo stays outside it. `Bash` is only best-effort confined at call time: absolute paths outside the declared roots (other than system binary/device prefixes) and `..`/`~` traversal are rejected, but command substitution, variable expansion, and escapes performed by a child process are not detectable from the command string — so each completed worktree transcript is re-scanned afterwards, and every `Read`/`Grep`/`Glob` path argument and `Bash` command-string token that explicitly named a location outside the declared roots and still returned successfully is recorded on the run and listed in the report under "Confinement breaches (review required)". That post-hoc scan applies the same explicit-path rule the live envelope applied, so a path formed at runtime (variable expansion, command substitution, or a child process reaching out on its own) is not detectable from the transcript and remains the accepted residual of worktree mode. With `--provider=codex`, worktree runs use a named read-only permissions profile granting read on the worktree and on each pinned sibling root, so reads elsewhere on the filesystem are refused by codex itself. Every run records the confinement mode it actually ran under. `--no-checkout` gives the Claude agent an empty temporary cwd and removes base tools; `withMcp`/`mcpOnly` can inspect only the preflighted project graph through Coredoc, while `withoutMcp` has neither repository files nor Coredoc.

`--historyless-snapshot` is required for the two registered primary cells and available to smoke/diagnostic cells; a manifest cell may pin its required mode with a per-cell `requiresAccessMode`, and preflight refuses (loudly, never downgrades) an invocation that selects any other mode. It expands only tracked files from the exact target commit into a temporary directory, contains no `.git`, removes symlinks, and exposes only Read/Grep/Glob under a snapshot-root permission envelope. A separate exact-SHA verifier worktree remains harness-owned and is never exposed to the answer agent. The Claude SDK uses `settingSources: []`, `strictMcpConfig: true`, an empty auto-allow list, a universal `PreToolUse` deny hook, and a second `canUseTool` check. Safe filesystem calls are confined to the real snapshot root; only tools from the exact `coredoc-eval` server may cross the MCP boundary.

The real canary reads a controlled in-snapshot sentinel and must observe denials for an absolute outside path, `..` traversal, a disposable symlink escape, original-checkout Git history, Coredoc manifest/truth files, and outside Grep/Glob paths. Its SDK init record must advertise exactly Read/Grep/Glob plus only connected `coredoc-eval`; the exact MCP probe must succeed. A missing probe/hook, connector or tool drift, leaked outside content, timeout, non-success result, or provider-reported cost above `$0.15` fails closed. Unit tests exercise the contract but do not substitute for this real SDK call.

The harness-owned MCP server name is **`coredoc-eval`**. Do not rename it to `coredoc`: user-level Claude configuration can disable that name. The Claude runner always uses `strictMcpConfig: true` and supplies an explicit server map, including `{}` for controls, so account or project connectors cannot leak into an arm. The Codex runner likewise uses `coredoc-eval`, ignores user config, caps project-doc injection at one byte, and runs under a read-only permissions profile scoped to its declared roots. Codex runs before the 2026-08-22 project-doc isolation fix are confounded on targets with `AGENTS.md`.

## Exact-revision preflight

Every runnable target manifest pins a full `target.gitSha`; runnable cross-repo cells may also pin sibling `repoRevisions`. Before dispatch, preflight requires:

- requested target SHA = verifier worktree SHA = agent worktree SHA when present = graph `gitCommitHash`;
- every sibling pin exists locally when worktree/fleet access needs it and equals the graph's parsed SHA;
- sibling checkout HEAD and tracked-clean state agree with its pin in worktree mode;
- truth-referenced files exist at the pinned target or sibling revision;
- migration-level primary admission and structured-truth shape invariants hold (these are not, by themselves, permission to execute a primary cell);
- a registered historical primary binds the exact repository, target SHA, artifact merge/diff base, source commit, observer, decision, and case-specific verifier;
- the historical commits exist locally, the registered artifact base is the target/source merge base, target-absent/source-present predicates hold, and target-side anchor symbols resolve in their declared files;
- the graph fingerprint is captured before execution and is unchanged after a completed run.

`--preflight-only` performs the same selection, worktree, truth, revision, graph, prompt, verifier, MCP-build, and cohort-manifest preparation, then stops before agents or judges. It is the required first pass for a new or changed cohort. Adding `--run-primary-with-canary` deliberately makes exactly one paid canary request after deterministic preflight and still stops before primary agents and judges.

## Methodology and reporting

New records use terminal statuses, not response byte count or tool count:

- agent: `completed`, `task_failed`, or `infrastructure_error`;
- judge: `completed`, `not_run`, or `missing`.

There is no byte-threshold DNF heuristic for new records. Historical records missing statuses are inferred once at the compatibility boundary, marked as legacy, and excluded from primary.

Programmatic verifier and rubric-judge scores are separate endpoints. New records keep the historical `final` field as `null`; reports do not blend the endpoints. For each endpoint and comparison:

1. pair arms by target × case × `runIndex`;
2. compute paired-run deltas inside each target × case cell;
3. give each comparable cell one equal-weight mean delta in the cell-macro summary.

Reports headline a **per-protocol** estimate (`task_failed` contributes zero; infrastructure, missing endpoints, and noncompliant treatment runs stay missing) and a completed-only estimate, plus comparable/missing cells, macro mean and median, W-T-L, and honest min/max. Dropping noncompliant runs is what makes the headline per-protocol rather than intention-to-treat; the true **ITT** row — every assigned run, noncompliant ones scored on the answer they really produced — is reported descriptively whenever any cell contains a noncompliant run. Smoke and diagnostic partitions remain descriptive even when they contain the same arm pair. `mcpOnly` factor comparisons never enter the primary product headline.

In oracle-batch mode, the exact oracle binding is curated before the run and hashes the prompt, target SHA, sibling SHAs, structured truth, and historical source/base provenance. Batch failure marks every completed answer in that target × case as judge-missing atomically. Batch judge usage is stored and reported once at run level; it is never assigned to an eval arm or blended into answer-agent token/cost comparisons.

Primary report admission requires Claude + `historyless-snapshot`, a manifest cell whose `primaryVerifierId` is registered in `harness/primary-registry.ts`, one cohort, passed canary evidence bound to the harness/MCP/SDK/model fingerprints, and a matching same-run canary transcript hash. Report rewriting reads and revalidates that manifest evidence; it never turns the evidence into execution permission.

No harness-side price table is used. Cost is provider-reported only; unavailable Codex cost is labeled unavailable or partial.

## Preconditions

- Build the MCP package consumed from `dist`: `pnpm --filter @coredoc/mcp build`.
- The chosen project graph exists at `coredoc.db.d/<projectId>.lbdb` for Ladybug or `coredoc.db.d/<projectId>.db` for SQLite and contains each selected target/sibling `repoKey` at its pinned SHA.
- Claude auth is available for Claude agents or judges. Codex CLI auth is available when either endpoint uses Codex.
- Do not start a paid run unless `--preflight-only` succeeds for the exact same selectors, provider/backend, access mode, arms, models, and judge.
- `--preflight-only --run-primary-with-canary` is not a no-paid check: it makes one bounded Claude request and exists to validate the real SDK permission boundary before a full primary wave.

## No-paid smoke and preflight plan

These checks create no model/API requests:

```bash
# Schema-v2 consumer and report-provenance unit tests.
pnpm --filter @coredoc/evals exec vitest run \
  scripts/rewrite-report.test.ts

# Full selected-cell provenance/graph preparation, then stop.
pnpm eval --project=<id> --target=<manifest-name> \
  --lifecycle=smoke,diagnostic --preflight-only
```

The local verifier smokes intentionally select only S+D cells. They never select primary or quarantine implicitly and do not establish an eval delta.

## Output

Each invocation creates
`evals/runs/<timestamp>-<provider>-<backend>[-no-checkout|-historyless-snapshot]/`:

- `run-manifest.json`: cohort inputs and fingerprints, including actual target verifier SHA, graph parsed SHAs, models, selected cells, arm factors, canary configuration/evidence when requested, cohort ID, and the post-run graph-stability result;
- `oracles/<target>/<case>.json`: exact prebuilt oracle binding and hash for every selected cell with structured truth;
- `oracle-judge/<target>/<case>.json`: one blind batch request/result identity, its run-level usage, and any quote-gated `downgradedVerdicts` in oracle-batch mode;
- `permission-canary/transcript.json`: the real SDK canary transcript used by primary report admission; it is evidence, never a future-run unlock token;
- `results.jsonl`: one record per attempted run;
- `REPORT.md`: lifecycle-partitioned endpoint summaries, operability, statuses, provenance header, and methodology;
- `mcp-gaps.jsonl`: derived MCP empty/error/not-found signals and nearby base-tool fallbacks;
- `runs/<target>/<case>/<arm>/run-<i>/`: prompt, response, transcript, usage, verifier, and judge artifacts.

To rebuild a report with current formatting without model calls:

```bash
pnpm --filter @coredoc/evals exec tsx scripts/rewrite-report.ts runs/<run-id>
```

When `run-manifest.json` exists, the rewrite uses its harness HEAD, actual target SHA(s), graph parsed SHA(s), models, backend, and cohort. Legacy directories without a manifest remain readable but display explicit `unknown (legacy: no run-manifest.json)` provenance. Rewriting changes only derived `REPORT.md` and `mcp-gaps.jsonl`; `results.jsonl`, `run-manifest.json`, and per-run source artifacts stay unchanged.

## Target manifests

Every `evals/targets/*.json` file is schema v2 and must contain exactly the 20 canonical kebab-case case IDs under `cells`. Top-level fields are `schemaVersion`, `name`, `path`, optional `baseBranch`, `repoKey`, and full `gitSha`.

A runnable S/D cell contains `lifecycle`, `provenance`, and `params`; `provenance.snapshotCommit` must equal `target.gitSha`. Cross-repo truth adds exact `repoRevisions`. A primary cell additionally requires a registered `admission.verifierId`, a real artifact/observer/decision, `sourceCommit`, `artifactBaseCommit`, and structured required/accepted/forbidden truth. Only verifiers hard-registered in `harness/primary-registry.ts` are admitted, each bound to one exact historical cell. The published registry is empty, so primary cells are rejected at every gate and primary is not runnable from this snapshot. A quarantine cell contains only `lifecycle`, `reasonCode`, and `reason`: no params and no magic `TBD` placeholders.

The 20 templates are: `explain-repo`, `explain-function`, `blast-radius`, `entrypoint-deep-dive`, `entity-impact`, `data-flow-trace`, `type-impact`, `route-deep-dive`, `route-api-surface`, `component-decision`, `cross-repo-trace`, `feature-implementation-plan`, `backend-frontend-pair`, `flag-impact-audit`, `transitive-callers-closure`, `service-dependency-map`, `caller-intersection`, `entrypoint-permission-audit`, `deep-chain-side-effects`, and `impact-diff`.

## Troubleshooting

- Missing MCP entrypoint: rebuild `packages/mcp` before preflight.
- Revision mismatch: re-parse/re-push the exact manifest SHA or correct the manifest; do not relax preflight.
- No runnable cells: select an existing lifecycle/case combination; quarantine is intentionally unselectable.
- Primary execution rejected before setup: first run `--historyless-snapshot --preflight-only`; actual dispatch additionally requires `--run-primary-with-canary`. Worktree/no-checkout and Codex primary runs remain invalid.
- Permission canary rejected: inspect only its failure codes and `permission-canary/transcript.json`; fix the SDK/tool/runtime drift and rerun the entire invocation. Do not copy evidence into a later manifest or relax report admission.
- A primary preflight reports a missing/stale graph: load the existing exact-SHA parsed artifact into the selected local backend; do not relax revision agreement or silently reparse another checkout.
- Codex rejected before preflight: provide exact `--codex-model=` and authenticate the CLI.
- No-checkout rejected: use the Claude provider; Codex no-checkout is unsupported.
