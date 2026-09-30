---
description: Configure coredoc — pre-approve the coredoc MCP tools and optionally install the coredoc status line.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-permissions.mjs"), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.mjs"), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.mjs" --force), AskUserQuestion
---

# coredoc setup

Step 1 always runs. Step 2 is optional — ask the user before doing it. Both
steps go through a dedicated script that is the single writer of the relevant
settings file (atomic, idempotent, never clobbers an existing file). Do not edit
settings files yourself.

## 1. Permissions (always)

Idempotently add the coredoc MCP permission rule (`mcp__coredoc__*`) so the user
is not prompted on each tool call.

The rule assumes the MCP server is registered under the name `coredoc` — the
plugin does not ship the server itself (its URL is workspace-specific), so the
user adds it per the README. If they named it something else, the rule to use is
`mcp__<their-server-name>__*`.

1. Run the script with the Bash tool, using the plugin root variable so the path
   resolves regardless of where the plugin is installed (keep the quotes — the
   install path may contain spaces):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-permissions.mjs"
   ```

2. Report the script's full stdout/stderr to the user verbatim, then state the
   outcome based on its exit code:
   - Exit 0 — the rule is now present (either it was added, or it was already
     there). Remind the user to restart Claude Code or start a new session.
   - Non-zero exit — setup did not complete. Relay the script's error message and
     the manual remediation it printed (add `mcp__coredoc__*` to
     `permissions.allow` in `~/.claude/settings.json` by hand).

## 2. Status line (optional — ask first)

The coredoc status line is a non-blocking line that shows context-window % and
the 5-hour / 7-day rate-limit usage, plus model, git branch, and directory. It
always exits 0 and can never block or slow a session.

1. Use **AskUserQuestion** to ask whether to enable it. Offer two options:
   "Enable coredoc status line" and "Skip". Make clear it edits
   `~/.claude/settings.json` and replaces nothing if another status line is
   already set.

2. **If the user chooses to skip**, do nothing further — step 1 is enough.

3. **If the user chooses to enable it**, run the installer (same quoting rule):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.mjs"
   ```

   Report the script's full stdout/stderr verbatim, then state the outcome by
   exit code:
   - Exit 0 — the status line is installed (added, already present, or its path
     was refreshed). Remind the user to restart Claude Code or start a new
     session.
   - Exit 2 — a *different* status line is already configured; the script left it
     untouched on purpose. Relay the refusal and the previous value it printed.
     Only if the user then explicitly confirms they want to replace it, re-run
     with `--force` appended (it prints the old value first so it can be
     restored). Never force without that explicit confirmation.
   - Other non-zero — relay the error and the manual remediation it printed.

## Telemetry provisioning

Report this bounded outcome and do nothing else:

> Telemetry provisioning is unavailable in the legacy coredoc plugin. Use
> Coredoc Desktop managed-relay provisioning.

Do not inspect credentials, mint or cache a telemetry token, run a telemetry
setup/verification script, or write telemetry values into Claude settings. The
managed relay and host configuration are owned by Coredoc Desktop and the
`coredoc-workflows` plugin.
