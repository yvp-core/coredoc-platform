# Intent eval corpus

`eval:intent` is an A/B gate over cloud intent. Both arms read a copy of `fixture-repo/`
with Read/Grep/Glob; the intent arm also gets the workspace MCP server with exactly
`get_intent_context` and `intent_read` allowlisted, plus the canonical `coredoc-workflows`
intent-context methodology inlined. The control gets no MCP server. The run is Claude-only.

What lives here:

- `tasks.ts` — the task corpus, with the routed ids, required facts and forbidden facts
  each task is judged on.
- `seed-intent.json` — the reviewed intent the corpus is written against (domains and
  items in the retired overlay shape). `seed-document.ts` converts it to the
  `CloudIntentWorkspaceDocumentV1` that `POST workspaces/:id/intent/import/workspace` takes.
- `setup.ts` — seeds a workspace and writes the run config (`eval:intent:setup`).
- `fixture-repo/`, `coredoc.config.json`, `coredoc-parsers/` — the code the tasks are about
  and the config and profile that parse it.
- `context-first/` and `ci-anchors/` — retrieval and CI-anchor suites, run by `pnpm test`.

The blind fact judge is `harness/judge-intent.ts`, the transcript analyzer
`harness/analyze-intent.ts` and the runner `harness/run-intent.ts`.

## Running it

The full run is **paid**: it runs 4 tasks × 2 arms × 3 reps of agent sessions plus a
judge call per artifact. Start with `--smoke` (one task, one rep, both arms).

1. Start the server: `pnpm server:dev` (listens on `http://localhost:3000` unless `PORT`
   is set).
2. Sign in once against that server: `pnpm cli login --server http://localhost:3000`.
   The workspace import requires a user session, so setup uses the access token this
   stores in `~/.coredoc/credentials.json` (or `$COREDOC_HOME`).
3. Seed: `pnpm --dir evals run eval:intent:setup`.
4. Run: `pnpm --dir evals run eval:intent --smoke`, then the full matrix with
   `pnpm --dir evals run eval:intent`. Pass flags without a `--` separator. Other flags:
   `--task <id>`, `--arm baseline|intent`, `--reps <n>`, `--concurrency <n>`, `--model`,
   `--judge-model`. Reports go to `evals/runs-intent/<timestamp>/REPORT.md`.

Setup creates a fresh workspace (`intent-eval-<time>`) on every run and deletes the one the
previous setup recorded, because the import only accepts a workspace with no intent content.
It enables intent, imports the seed, mints an `intent-agent` token (read and propose only),
checks the context read serves the seed with that token, and copies the fixture to a temp
directory outside the repository. The run config is
`cases-intent/workspace/cloud-run.json`; the token is in `cases-intent/workspace/mcp-token`
(mode 0600, git-ignored). Re-run setup after a reboot clears the temp checkout.

| Variable | Used by | Meaning |
| --- | --- | --- |
| `COREDOC_EVAL_SERVER_URL` | setup | Server base URL. Default `http://localhost:3000`; set it to a staging URL to seed there. |
| `COREDOC_EVAL_ACCESS_TOKEN` | setup | A user session token to use instead of the stored `coredoc login`. Service tokens (`cdt_`) are refused. |
| `COREDOC_EVAL_MCP_TOKEN` | runner | Overrides the token file setup wrote. |
| `COREDOC_WORKFLOWS_PLUGIN_DIR` | runner | The `coredoc-workflows` plugin directory holding `resources/methodology/intent-context.md`. Default: `../coredoc-workflows/plugins/coredoc-workflows` beside this checkout. |

## Known limitation: runs are diagnostic

A workspace document carries no code anchors and no item-to-item relations, and the seeded
workspace has no published graph. The required facts `reports-anchor-not-current`
(implement-service-fee) and `separates-unverified-code-evidence` (investigate-cent-shortfall)
depend on a stored anchor reading `changed` or a stale snapshot, so neither arm can meet them.
Setup records `anchorsStaged: false` and every report is headlined as a diagnostic run, never a
gate result. Staging those traps on the cloud needs the fixture parsed and pushed to the
workspace, anchors added through the REST anchor route, then a drift commit pushed again.
