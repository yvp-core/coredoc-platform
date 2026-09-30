/**
 * CLI first-run telemetry notice (P0.10).
 *
 * A one-time, honest nudge printed on the first `coredoc` invocation: anonymous
 * telemetry exists and is OFF by default. It NEVER enables telemetry — opt-in is
 * explicit only (`coredoc telemetry on` or the desktop settings). After showing
 * once it stamps `consentPromptedAt` so it never appears again.
 *
 * Non-interactive by design: it only prints (to stderr, so machine-readable
 * stdout like `coredoc ops` is never corrupted) and marks prompted — there is no
 * prompt to answer, so a non-TTY / `--yes` / CI run behaves the same (telemetry
 * stays OFF). Every step is best-effort: a failed config read/write must never
 * break the command.
 */

import { getTelemetryConfig, markTelemetryConsentPrompted } from '@coredoc/core/utils';

const NOTICE =
  'coredoc collects anonymous usage telemetry to improve the product — it is OFF by default. ' +
  'No source code, file paths, or personal information is ever sent. ' +
  'Enable it with `coredoc telemetry on` (or in the desktop settings); ' +
  'run `coredoc telemetry show` to see exactly what would be sent.';

/**
 * Show the first-run telemetry notice at most once. Skips the `telemetry`
 * subcommands (so toggling telemetry never triggers its own notice) and is a
 * silent no-op once `consentPromptedAt` is set.
 *
 * @param argv Process argv (`argv[2]` is the top-level subcommand).
 */
export async function maybeShowFirstRunTelemetryNotice(argv: string[]): Promise<void> {
  // Skip the telemetry subcommands themselves — running `coredoc telemetry ...`
  // must not print the first-run notice about telemetry.
  if (argv[2] === 'telemetry') {
    return;
  }

  try {
    const config = await getTelemetryConfig();
    if (config.consentPromptedAt) {
      return; // Once-only: already shown on a previous invocation.
    }

    // Diagnostic → stderr (keeps stdout clean for piped/JSON-emitting commands).
    console.error(NOTICE);

    // Stamp prompted so this never shows again. Never enables telemetry.
    await markTelemetryConsentPrompted();
  } catch {
    // Non-fatal: telemetry bookkeeping must never change command semantics.
  }
}
