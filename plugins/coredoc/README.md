# coredoc

The `coredoc-mcp` navigation skill and session tooling for exploring the team's
codebases through the shared cloud graph.

## Install

Two steps: the plugin, then the MCP server it navigates.

**1. The plugin**

```
/plugin marketplace add yvp-core/coredoc-platform
/plugin install coredoc@coredoc-plugins
```

**2. The MCP server**

The plugin does **not** ship the MCP entry. Its URL contains your workspace id
and your deployment's host, so no static manifest can be right for everyone —
add it yourself, once:

```
claude mcp add --transport http --scope user coredoc https://api.coredoc.ai/api/v1/workspaces/<your-workspace-id>/mcp
```

Use `--scope user` to make it available in every project, or `--scope project`
to commit it in this repo's `.mcp.json` for the whole team. Your workspace
settings page shows the exact snippet with the id already filled in. Name the
server `coredoc` — `/coredoc:setup` and the docs below assume that name.

On first use of a coredoc tool, Claude Code opens a browser for a one-time
sign-in (OAuth). You must be a member of that workspace.

## What you get

- **Skill `coredoc:coredoc-mcp`** — when and how to reach for the graph tools
  (tool selection, error recovery, cross-repo tracing): `describe_repository`,
  `search_symbols`, `explain`, `list_entrypoints`, `list_file_symbols`,
  `find_callers`, `find_dependents`, `find_entity_usage`,
  `analyze_change_impact`, `describe_db_schema`, `trace_cross_repo_call`,
  `list_service_dependencies`.
- **`/coredoc:setup`** — pre-approves those read-only tools and optionally
  installs the status line.

Telemetry is not provisioned by this legacy plugin. Use Coredoc Desktop's
managed-relay provisioning; this plugin does not mint/cache a cloud telemetry
bearer or write one into Claude's generic environment.

No local build, no parser packages, no database — the tools run against the
cloud graph.

## Skip permission prompts

All coredoc tools are **read-only** (they query the graph, never mutate), so
they're safe to allow without prompting. Pick whichever is convenient:

- **`/coredoc:setup`** (easiest) — run it once after installing. It adds the
  allow rule for every coredoc tool to your user settings
  (`~/.claude/settings.json`), idempotently and atomically (it never clobbers an
  existing settings file). Restart Claude Code or start a new session for it to
  take effect.
- **One click, first use** — alternatively, the first time a coredoc tool runs,
  choose the "don't ask again for this server" option in the prompt.
- **By hand** — add the rule to `~/.claude/settings.json` yourself:

  ```json
  {
    "permissions": {
      "allow": ["mcp__coredoc__*"]
    }
  }
  ```

  MCP tools are named `mcp__<server>__<tool>`, so the prefix follows the name you
  gave the server in step 2 above. Confirm the exact prefix anytime with
  `/permissions`.

## Bundled scripts

Beyond the skill, the plugin ships two small, dependency-free dev
helpers under `scripts/`. Both are **opt-in** and documented in full (purpose,
install, usage) in [`docs/dev-tooling.md`](../../docs/dev-tooling.md).

- **`validate-commit-message.mjs`** — enforces the team commit convention:
  Conventional Commits, a 72-char ceiling, no vague subjects, and a mandatory
  Jira reference `ABC-<number>` in the subject. Enable it by uncommenting the
  line in `.husky/commit-msg`:

  ```sh
  node plugins/coredoc/scripts/validate-commit-message.mjs --file "$1" || exit 1
  ```

- **`coredoc-statusline.sh`** — a non-blocking status line showing context-window
  and 5h/7d rate-limit usage, model, branch, and directory. Install it the easy
  way via **`/coredoc:setup`** (its optional second step asks first), or point
  `statusLine.command` in `~/.claude/settings.json` at its absolute path by hand.

## Maintainers

The bundled skill is synced from the repo-root source of truth, not hand-edited
here. After changing `skills/coredoc-mcp/`, run:

```
pnpm sync:plugin-skills
```

Then commit the regenerated `plugins/coredoc/skills/coredoc-mcp/`.

`resources/coredoc-tool-classes.json` (which Coredoc MCP tools are reads and
which are writes) is likewise generated — from `COREDOC_TOOL_CLASSES` in
`packages/mcp/src/tool-classes.ts`, which both MCP servers import. After adding
or reclassifying a tool, run `pnpm gen:tool-classes` and commit the result;
`plugins/coredoc/scripts/tool-classes.test.mjs` fails on drift.

### Session feedback

The agent collects observations while it works and prepares one feedback draft
when the whole task is delivered, not after individual tool calls.
`/coredoc:feedback` also starts this flow explicitly. The redacted draft is
offered for review once and an explicit Skip is respected. A non-interactive
session submits the draft as `unreviewed`, and feedback never blocks the
engineering result.
