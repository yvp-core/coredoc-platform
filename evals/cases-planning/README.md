# Planning eval (coredoc MCP)

Compares four planning-agent arms on real workspace tasks: {plan-mode, superpowers} × {no-MCP, +coredoc-MCP}.
Each arm produces an implementation spec; specs are scored by a blinded pairwise judge (reads real
source, never the graph) + an on-disk hallucination check.

## Preconditions
- `pnpm build` (MCP server runs from `packages/mcp/dist`).
- `coredoc.db.d/<projectId>.db`, populated with the target project's repos.
- The workspace's repos checked out under `$COREDOC_EVAL_WORKSPACE_ROOT` (default: the parent
  directory of this checkout).
- `evals/cases-planning/tasks.ts` + `target.ts` adapted to your repos — the committed versions are
  examples against a fictional "acme" workspace.
- `ANTHROPIC_API_KEY` set. `SUPERPOWERS_PLUGIN_DIR` optional (auto-resolved from the plugin cache).

## Run
    pnpm eval:planning --smoke                 # 1 task × 4 arms × 1 rep — wiring check
    pnpm eval:planning                         # 4 tasks × 4 arms × 3 reps (full)
    pnpm eval:planning --task=t1-color-propagation --arm=D --reps=1

## Output: `evals/runs-planning/<ts>/`
- `<task>/<arm>/rep-<i>/spec.md` + `transcript.json` + `usage.json`
- `records.jsonl`, `verdicts.jsonl`, `REPORT.md`
