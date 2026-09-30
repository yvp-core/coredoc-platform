/**
 * First-run telemetry consent helper (P0.10).
 *
 * DOM-free glue between the consent card and the main-process telemetry config,
 * routed through the existing IPC surface — the renderer never imports
 * `@coredoc/core/telemetry`. Kept separate from the card component so the consent
 * decision is unit-testable in the node-env vitest (no DOM, no posthog-js).
 *
 * Hard invariant: NEVER enable telemetry without an explicit Enable choice.
 */

export type TelemetryConsentChoice = 'enable' | 'dismiss';

/**
 * Persist the user's first-run consent choice.
 *  - `enable`  → opt in (`setTelemetryEnabled(true)`) AND mark prompted.
 *  - `dismiss` → mark prompted ONLY; telemetry stays OFF (default), never enabled.
 *
 * Both choices stamp `consentPromptedAt` so the card shows exactly once.
 *
 * @returns whether telemetry ended up enabled (so the caller can init the client).
 */
export async function applyTelemetryConsent(choice: TelemetryConsentChoice): Promise<boolean> {
  const enable = choice === 'enable';
  if (enable) {
    await window.electronAPI.setTelemetryEnabled(true);
  }
  await window.electronAPI.markTelemetryConsentPrompted();
  return enable;
}
