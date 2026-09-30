/**
 * Tests for the CLI first-run telemetry notice (P0.10).
 *
 * The notice is a one-time, honest, NON-enabling nudge: on the first `coredoc`
 * invocation it prints (to stderr) that anonymous telemetry exists and is OFF by
 * default, then stamps `consentPromptedAt` so it never shows again. It must NEVER
 * flip telemetry on (opt-in is explicit only), must be skipped for the
 * `telemetry` subcommands, and must be non-fatal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getTelemetryConfigMock, markConsentMock, setEnabledMock } = vi.hoisted(() => ({
  getTelemetryConfigMock: vi.fn(),
  markConsentMock: vi.fn(async () => undefined),
  setEnabledMock: vi.fn(async () => undefined),
}));

vi.mock('@coredoc/core/utils', () => ({
  getTelemetryConfig: getTelemetryConfigMock,
  markTelemetryConsentPrompted: markConsentMock,
  setTelemetryEnabled: setEnabledMock,
}));

import { maybeShowFirstRunTelemetryNotice } from './first-run-notice.js';

const NOT_PROMPTED = { installId: 'i', enabled: false, firstSeenAt: 't' };
const PROMPTED = { ...NOT_PROMPTED, consentPromptedAt: '2026-07-18T00:00:00.000Z' };

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errSpy.mockRestore();
});

describe('maybeShowFirstRunTelemetryNotice', () => {
  it('prints the notice and marks prompted on the first invocation', async () => {
    getTelemetryConfigMock.mockResolvedValue(NOT_PROMPTED);

    await maybeShowFirstRunTelemetryNotice(['node', 'coredoc', 'parse']);

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(markConsentMock).toHaveBeenCalledTimes(1);
    // The notice is honest about the OFF-by-default default and points at the
    // real enable command.
    const printed = String(errSpy.mock.calls[0][0]);
    expect(printed).toMatch(/telemetry/i);
    expect(printed).toContain('coredoc telemetry on');
  });

  it('never enables telemetry (opt-in is explicit only)', async () => {
    getTelemetryConfigMock.mockResolvedValue(NOT_PROMPTED);

    await maybeShowFirstRunTelemetryNotice(['node', 'coredoc', 'parse']);

    expect(setEnabledMock).not.toHaveBeenCalled();
  });

  it('does not re-print once consent has already been prompted (once-only)', async () => {
    getTelemetryConfigMock.mockResolvedValue(PROMPTED);

    await maybeShowFirstRunTelemetryNotice(['node', 'coredoc', 'parse']);

    expect(errSpy).not.toHaveBeenCalled();
    expect(markConsentMock).not.toHaveBeenCalled();
  });

  it('skips the notice for the telemetry subcommands themselves', async () => {
    getTelemetryConfigMock.mockResolvedValue(NOT_PROMPTED);

    await maybeShowFirstRunTelemetryNotice(['node', 'coredoc', 'telemetry', 'on']);

    expect(errSpy).not.toHaveBeenCalled();
    expect(markConsentMock).not.toHaveBeenCalled();
    expect(getTelemetryConfigMock).not.toHaveBeenCalled();
  });

  it('is non-fatal when the config read/write fails', async () => {
    getTelemetryConfigMock.mockRejectedValue(new Error('disk gone'));

    await expect(maybeShowFirstRunTelemetryNotice(['node', 'coredoc', 'parse'])).resolves.toBeUndefined();
    expect(setEnabledMock).not.toHaveBeenCalled();
  });
});
