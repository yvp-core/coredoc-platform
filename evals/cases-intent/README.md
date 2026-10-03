# Intent eval corpus

The `eval:intent` A/B runner is being rebuilt on cloud intent. It used to seed the
repo-local overlay (`.coredoc/intent.json`) and serve it through the local MCP
`get_intent_context`; both were removed when product intent became cloud-only.

What stays here, independent of how intent is served:

- `tasks.ts` — the task corpus, with the routed ids, required facts and forbidden facts
  each task is judged on.
- `seed-intent.json` — the reviewed intent the corpus is written against (domains and
  items in the retired overlay shape). The rebuilt setup seeds it into a cloud workspace.
- `fixture-repo/`, `coredoc.config.json`, `coredoc-parsers/` — the code the tasks are about
  and the config and profile that parse it.
- `context-first/` and `ci-anchors/` — retrieval and CI-anchor suites, run by `pnpm test`.

The blind fact judge (`harness/judge-intent.ts`) and the transcript analyzer
(`harness/analyze-intent.ts`) are kept as they are.
