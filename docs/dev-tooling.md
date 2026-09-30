# Developer tooling

Small, dependency-free helpers kept because each earns its place: a deterministic
script or a one-line prompt rule, never a workflow that blocks coding or burns
tokens. This file is the single reference for what they are, how to turn them on,
and how to use them.

Everything here is opt-in and inert until you enable it. Nothing can block a
commit or slow a session unless you explicitly wire it in.

| Tool | Where | Ships in plugin? | Blocks anything? |
|---|---|---|---|
| Commit-message validator | `plugins/coredoc/scripts/validate-commit-message.mjs` | yes | only if you enable the git hook |
| Status line | `plugins/coredoc/scripts/coredoc-statusline.sh` | yes | no (always exits 0) |
| CLAUDE.md validator | `scripts/validate-claude-md.mjs` | no (repo dev tool) | no (a lint) |
| Summarizer signal-to-noise | `packages/cli/src/summarize/prompts.ts` | n/a (product) | no |

## 1. Commit-message validator

**Purpose.** Enforce the team commit convention deterministically: Conventional
Commits shape, a 72-char subject ceiling (warns past 50), no vague subjects
(`fix: bug`, `wip`, `chore: update`, …), and a **mandatory Jira reference
`ABC-<number>` in the subject line**.

**Location.** `plugins/coredoc/scripts/validate-commit-message.mjs` — ships inside
the plugin, so any project that installs coredoc can wire it in.

**Install / enable.** Opt-in via the repo's git hook, disabled by default so it
never surprises anyone. Uncomment the single line in `.husky/commit-msg`:

```sh
node plugins/coredoc/scripts/validate-commit-message.mjs --file "$1" || exit 1
```

Husky already registers the `commit-msg` wrapper, so it takes effect on the next
commit — no `pnpm prepare` needed. Bypass once with `git commit --no-verify`.

For a project that *installed* the plugin (rather than this repo), point the hook
at the installed path instead, e.g.
`node "$HOME/.claude/plugins/.../coredoc/scripts/validate-commit-message.mjs" --file "$1"`.

**Usage (manual / CI).**

```sh
# validate a subject string
node plugins/coredoc/scripts/validate-commit-message.mjs "feat(reports): add csv exporter (ABC-123)"

# validate a commit-message file (what the hook does)
node plugins/coredoc/scripts/validate-commit-message.mjs --file .git/COMMIT_EDITMSG
```

Exit `0` = valid (a subject over 50 chars still passes, with a stderr warning),
`1` = invalid (prints the exact reason on stderr), `2` = usage error.

**Examples.**

| Subject | Result |
|---|---|
| `feat(reports): add csv exporter (ABC-123)` | pass |
| `fix: handle empty token list ABC-7` | pass |
| `feat(reports): add csv exporter` | fail — no `ABC-<number>` |
| `feat(x): do thing (abc-123)` | fail — key must be uppercase `ABC-<digits>` |
| `feat: Add thing (ABC-3)` | fail — description must start lowercase |
| `wip ABC-1` | fail — not a Conventional Commits subject |

The Jira key is fixed to `ABC-<number>` (a placeholder example); change `JIRA_RE`
in the script for your project key.

## 2. Status line

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

## 3. CLAUDE.md validator

**Purpose.** Structural lint for `CLAUDE.md` / `AGENTS.md` and skill docs:

- line count — warns past 200, hard-fails past 400 (long instruction files reduce
  adherence; split into `@path` imports);
- duplicate top-level (`# `) headings;
- unresolved `@path` imports declared in the file — a silent context drop, since
  Claude Code skips a missing import with no error.

It is markdown-aware: fenced code blocks, HTML comments, and inline `backtick`
spans are ignored, so examples never false-positive. Import resolution is
single-level (the file's own imports).

**Location.** `scripts/validate-claude-md.mjs` — a repo dev tool, not shipped in
the plugin, since it is not part of coredoc's product surface.

**Usage (manual / CI).**

```sh
node scripts/validate-claude-md.mjs CLAUDE.md
node scripts/validate-claude-md.mjs AGENTS.md --json
node scripts/validate-claude-md.mjs path/to/SKILL.md --max-lines 150
```

Exit `0` when there are no errors (warnings never fail), `1` on any error. It is a
lint — never a commit-blocking hook.

## 4. Summarizer signal-to-noise

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
