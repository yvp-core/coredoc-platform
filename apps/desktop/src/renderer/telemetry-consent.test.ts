/**
 * Tests for the first-run telemetry consent helper (P0.10).
 *
 * The helper persists the user's first-run choice through the existing IPC
 * surface (no direct `@coredoc/core/telemetry` import from the renderer). Enable
 * opts in AND marks prompted; Not-now marks prompted WITHOUT ever enabling
 * (opt-in is explicit only — the hard invariant). window.electronAPI is fully
 * mocked; no real IPC (see memory feedback_storybook_no_real_ipc_in_ci).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTelemetryConsent } from './telemetry-consent.js';

const setTelemetryEnabled = vi.fn(async () => undefined);
const markTelemetryConsentPrompted = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { window?: unknown }).window = {
    electronAPI: { setTelemetryEnabled, markTelemetryConsentPrompted },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('applyTelemetryConsent', () => {
  it('Enable opts in (true) and marks prompted, then reports enabled=true', async () => {
    const enabled = await applyTelemetryConsent('enable');

    expect(setTelemetryEnabled).toHaveBeenCalledTimes(1);
    expect(setTelemetryEnabled).toHaveBeenCalledWith(true);
    expect(markTelemetryConsentPrompted).toHaveBeenCalledTimes(1);
    expect(enabled).toBe(true);
  });

  it('Not-now marks prompted WITHOUT enabling, and reports enabled=false', async () => {
    const enabled = await applyTelemetryConsent('dismiss');

    expect(markTelemetryConsentPrompted).toHaveBeenCalledTimes(1);
    expect(setTelemetryEnabled).not.toHaveBeenCalled();
    expect(enabled).toBe(false);
  });

  it('marks prompted for both choices (once-only gate is always stamped)', async () => {
    await applyTelemetryConsent('enable');
    await applyTelemetryConsent('dismiss');
    expect(markTelemetryConsentPrompted).toHaveBeenCalledTimes(2);
  });
});
