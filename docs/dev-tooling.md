# Developer tooling

Small, dependency-free helpers kept because each earns its place: a deterministic
script or a one-line prompt rule, never a workflow that blocks coding or burns
tokens. This file is the single reference for what they are, how to turn them on,
and how to use them.

Everything here is opt-in and inert until you enable it. Nothing can slow a
session unless you explicitly wire it in.

| Tool | Where | Ships in plugin? | Blocks anything? |
|---|---|---|---|
| Status line | `plugins/coredoc/scripts/coredoc-statusline.sh` | yes | no (always exits 0) |
| Summarizer signal-to-noise | `packages/cli/src/summarize/prompts.ts` | n/a (product) | no |

## 1. Status line

**Purpose.** A fast, non-blocking Claude Code status line that surfaces the
numbers that matter for cost and limits: context-window %, the 5-hour and 7-day
rate-limit bars, plus model, git branch (with a worktree hint), directory, and
time. Every segment degrades gracefully and the script always exits 0.

**Location.** `plugins/coredoc/scripts/coredoc-statusline.sh` (requires `jq`).

**Install / enable.** Two ways:

- **Programmatic (recommended):** run `/coredoc:setup` — its second step asks
  whether to install the status line and, if you agree, runs
  `setup-statusline.mjs`. That script is the single writer of
  `~/.claude/settings.json`: idempotent, atomic, and it **refuses** rather than
  clobber an existing non-coredoc status line. You can also run it directly:

  ```sh
  node plugins/coredoc/scripts/setup-statusline.mjs
  # already have a different status line and want to replace it? (prints the old
  # value first, so you can restore it):
  node plugins/coredoc/scripts/setup-statusline.mjs --force
  ```

- **By hand:** add a `statusLine` key to `~/.claude/settings.json` pointing at the
  script's absolute path:

  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "bash \"/absolute/path/to/plugins/coredoc/scripts/coredoc-statusline.sh\""
    }
  }
  ```

**Usage.** Claude Code pipes the status JSON to it automatically. To preview:

```sh
echo '{"model":{"display_name":"Opus 4.8"},"context_window":{"used_percentage":42},"rate_limits":{"five_hour":{"used_percentage":88},"seven_day":{"used_percentage":12}}}' \
  | bash plugins/coredoc/scripts/coredoc-statusline.sh
```

Renders, e.g.:
`Opus 4.8 │ ctx ███░░░░░ 42% │ 5h ███████░ 88% │ 7d ░░░░░░░░ 12% │ <branch> │ <dir> │ 23:09`

## 2. Summarizer signal-to-noise

**Purpose.** A three-line hardening of the `summarize` system prompts so generated
summaries describe behaviour and point at where things live, instead of
transcribing source, reproducing directory trees, or restating
signatures/enums — the discipline that keeps generated docs from going stale.

**Location.** `packages/cli/src/summarize/prompts.ts` — the function, repo, and
package summarizer system prompts.

**Note.** This is the one change that alters product LLM output. The existing
`prompts.test.ts` stays green (it asserts on substrings), but the wording can
shift generated summaries — run `pnpm eval` on the summarize path before relying
on it in production.

## Origin

These are the only artifacts judged worth keeping from a retired, heavier Claude
Code plugin after a full audit. The rejected machinery — an always-on router, a
code-blocking gate, chained sub-agent pipelines, an eval factory — is
deliberately *not* here. The lesson kept was simple: ship deterministic scripts
and one-line rules, not workflows that block coding or burn tokens.
