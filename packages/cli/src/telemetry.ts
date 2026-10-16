/**
 * CLI Telemetry shim.
 *
 * Thin adapter over the shared `@coredoc/core/telemetry` client — the SINGLE
 * telemetry channel for the whole product. The CLI no longer owns a PostHog
 * client of its own; identity, opt-in gating, BaseProps merging, path
 * scrubbing, channel routing, and bounded flush all live in core.
 *
 * This shim owns the CLI's command-funnel emit shape (P1.T1). The self-executing
 * `index.ts` entrypoint (`void main()`) cannot be imported for unit testing, so
 * the emit seam lives here where a fake `track`/`trackError` can assert the
 * event + props:
 *  - `trackCommandCompleted` / `trackCommandFailed` — the two funnel events the
 *    `postAction` / `reportCliError` hooks fire (P0's `command_run` /
 *    `command_error` raw-string events are retired).
 *  - `classifyError` — error → `error_code` bucket, re-exported from core.
 *
 * No free-text error report is emitted for ANY bucket. An unhandled failure's
 * message can carry un-redactable workspace / repo / branch names (e.g.
 * `workspace 'acme' not found`, `Repo not found for: samplerepo`) that
 * `scrubPaths` does NOT redact — so forwarding it to core `trackError` would
 * ship those names to the anon channel and break the `telemetry show` promise
 * that repo names are NEVER sent. `command_failed` already carries `error_code`
 * as the grouping key, so the free-text is dropped rather than softened.
 */

import { type BaseProps, type ErrorCode, EventName, track } from '@coredoc/core/telemetry';

export { classifyError } from '@coredoc/core/telemetry';

/**
 * Emit the `command_completed` funnel event. `command` is the resolved
 * name-path (e.g. `parser list`), never argv — see `index.ts` postAction hook.
 */
export function trackCommandCompleted(command: string, durationMs: number): void {
  track(EventName.CommandCompleted, { command, duration_ms: durationMs });
}

/**
 * Emit the `command_failed` funnel event. Scalar props only — `error_code` plus
 * the error class name (`TypeError`, a custom error, …), which carries no user
 * data. The raw free-text message is intentionally NOT sent: it can carry
 * un-redactable repo / workspace / branch names, which the `telemetry show`
 * privacy copy promises are never shipped.
 */
export function trackCommandFailed(command: string, durationMs: number, code: ErrorCode, errorName?: string): void {
  track(EventName.CommandFailed, { command, duration_ms: durationMs, error_code: code, error_name: errorName });
}

/**
 * Emit the `profile_authored` product-funnel event from the `profile score`
 * command. `outcome` is the sole prop: the author loop is agent-driven, so
 * `iterations` / `run_id` have no code source and are intentionally NOT shipped
 * (YAGNI — don't fake always-empty schema fields). `coverage_after` is deferred
 * (needs a scoreProfile API that returns the per-category ratios). The emit
 * shape lives here because the `profile score` action is in the self-executing
 * `index.ts`, which cannot be imported for unit testing.
 */
export function trackProfileAuthored(pass: boolean): void {
  track(EventName.ProfileAuthored, { outcome: pass ? 'pass' : 'fail' });
}

/**
 * True when a resolved command name-path is a `telemetry` subcommand
 * (`telemetry`, `telemetry on`, `telemetry show`, …). Toggling / inspecting
 * telemetry must never emit its OWN funnel event — so both the `postAction`
 * success hook and the `reportCliError` crash handler in `index.ts` gate their
 * emit on this. Kept here (not inlined at both call sites) so the skip is a
 * single tested predicate that can't drift between the two hooks.
 *
 * Matches the leaf `telemetry` command and any nested subcommand under it, but
 * NOT an unrelated command that merely starts with the letters (a trailing
 * space is required for the prefix arm, so `telemetryfoo` → false).
 */
export function isTelemetryCommandPath(commandPath: string): boolean {
  return commandPath === 'telemetry' || commandPath.startsWith('telemetry ');
}

/**
 * Human-readable one-liners for every {@link EventName} the shared client can
 * emit. Typed `Record<EventName, string>` so the compiler forces a description
 * for each member — a new event added to the enum fails the build until it is
 * disclosed here, which is what keeps `coredoc telemetry show` from drifting
 * back into under-disclosure (the P0 `command_*`-only leak this replaced).
 */
const EVENT_DESCRIPTIONS: Record<EventName, string> = {
  [EventName.CommandCompleted]: 'a CLI command finished (command name-path + duration_ms)',
  [EventName.CommandFailed]:
    'a command exited with an error (command + duration_ms + error_code bucket + error type; desktop adds the redacted message)',
  [EventName.RepoAdded]: 'a repository was added to the local workspace',
  [EventName.ProfileAuthored]: 'an extraction profile was authored/scored (pass|fail outcome)',
  [EventName.ParseCompleted]: 'a parse run finished (counts + duration, no names)',
  [EventName.ParseFailed]: 'a parse run failed (error_code bucket + error type/message, paths and repo names redacted)',
  [EventName.ParseAnomaly]: 'a parse scorecard anomaly was detected (rule_id only, no source)',
  [EventName.SummarizeCompleted]: 'a summarize run finished (counts + duration)',
  [EventName.PushCompleted]: 'a push to the local/cloud graph finished',
  [EventName.PushFailed]: 'a push failed (error_code bucket + error type/message, paths and repo names redacted)',
  [EventName.ResolveCompleted]: 'cross-repo resolution finished (counts + duration)',
  [EventName.McpFirstAnswer]: 'the MCP server answered its first query in a session',
  [EventName.McpSessionSummary]: 'a coarse MCP session summary (counts only)',
  [EventName.McpFeedback]: 'explicit MCP answer feedback (thumbs up/down)',
  [EventName.AgentRun]: 'a coarse agent-run summary (cost bucket, outcome, turns)',
};

/**
 * Human-readable one-liners for every auto-carried {@link BaseProps} key. Typed
 * `Record<keyof BaseProps, string>` so the compiler forces a description for
 * each key — the REAL base props (no `$lib`, no `distinctId`) merged onto every
 * event in `@coredoc/core/telemetry`. Kept in sync with the interface by the
 * type, not by hand.
 */
const BASE_PROP_DESCRIPTIONS: Record<keyof BaseProps, string> = {
  install_id: 'random install id, not tied to your identity',
  session_id: 'groups events from one session',
  invocation_id: 'unique per process invocation',
  surface: 'which surface emitted it (cli / desktop / ci / mcp)',
  repo_id: 'salted, non-reversible hash of the repo path (only when a repo is in scope)',
  cli_version: 'coredoc CLI version',
  engine_version: 'extraction engine version',
  platform: 'OS platform (e.g. darwin / linux / win32)',
  schema_version: 'telemetry payload schema version',
};

/**
 * Build the exact text `coredoc telemetry show` prints. The first-run notice
 * points users here for "exactly what would be sent", so this MUST enumerate
 * every event the shared client emits (derived from {@link EventName}, never a
 * hand-maintained subset) and the REAL {@link BaseProps} auto-carried on each —
 * not the stale `distinctId` + `$lib` pair the CLI never actually sends.
 *
 * Pure + injected `installId` so it is unit-testable without touching config.
 */
export function buildTelemetryShowText(installId: string): string {
  const eventLines = Object.values(EventName)
    .map((event) => `  ${event}: ${EVENT_DESCRIPTIONS[event]}`)
    .join('\n');

  const basePropLines = (Object.keys(BASE_PROP_DESCRIPTIONS) as (keyof BaseProps)[])
    .map((key) => {
      const suffix = key === 'install_id' ? ` (${installId})` : '';
      return `  ${key}${suffix}: ${BASE_PROP_DESCRIPTIONS[key]}`;
    })
    .join('\n');

  return [
    'Telemetry sends these events (when enabled):',
    '',
    eventLines,
    '',
    'Auto-carried properties on every event:',
    basePropLines,
    '',
    'On a failed parse/summarize/push an error report (type, message, stack trace)',
    'is sent with file paths and repo/project names redacted.',
    '',
    'What is NEVER sent:',
    '  - Source code, file contents, or diffs',
    '  - File paths, function names, or repo names',
    '  - Git commit messages or environment variables',
    '  - Any personally identifiable information',
  ].join('\n');
}
