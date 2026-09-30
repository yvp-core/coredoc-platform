import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  getTelemetryConfig,
  setTelemetryEnabled,
  markTelemetryConsentPrompted,
  resetTelemetryConfigCache,
} from './telemetry-config.js';

describe('telemetry-config', () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalCoredocHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'coredoc-telemetry-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    // resolveCoredocHome() honors COREDOC_HOME over HOME; a developer machine
    // that runs the dev desktop exports it (~/.coredoc-dev), so overriding HOME
    // alone made these tests read the REAL config — enabled, consent recorded —
    // and fail on every local `pnpm test`. The override must be cleared too.
    originalCoredocHome = process.env.COREDOC_HOME;
    delete process.env.COREDOC_HOME;
    resetTelemetryConfigCache();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalCoredocHome === undefined) delete process.env.COREDOC_HOME;
    else process.env.COREDOC_HOME = originalCoredocHome;
    resetTelemetryConfigCache();
  });

  describe('getTelemetryConfig', () => {
    it('should create config with install ID on first call', async () => {
      const config = await getTelemetryConfig();
      expect(config.installId).toBeDefined();
      expect(config.installId).toMatch(/^[0-9a-f-]{36}$/);
      expect(config.enabled).toBe(false);
    });

    it('should return same install ID on subsequent calls', async () => {
      const config1 = await getTelemetryConfig();
      resetTelemetryConfigCache(); // force re-read from file
      const config2 = await getTelemetryConfig();
      expect(config1.installId).toBe(config2.installId);
    });

    it('should respect COREDOC_TELEMETRY_DISABLED env var', async () => {
      process.env.COREDOC_TELEMETRY_DISABLED = '1';
      await setTelemetryEnabled(true); // enable in file
      resetTelemetryConfigCache();
      const config = await getTelemetryConfig();
      expect(config.enabled).toBe(false); // env var overrides
      delete process.env.COREDOC_TELEMETRY_DISABLED;
    });
  });

  describe('setTelemetryEnabled', () => {
    it('should update enabled state and persist', async () => {
      await getTelemetryConfig();
      await setTelemetryEnabled(true);
      resetTelemetryConfigCache();
      const config = await getTelemetryConfig();
      expect(config.enabled).toBe(true);
    });

    it('should preserve install ID when toggling', async () => {
      const initial = await getTelemetryConfig();
      await setTelemetryEnabled(true);
      resetTelemetryConfigCache();
      const after = await getTelemetryConfig();
      expect(after.installId).toBe(initial.installId);
    });
  });

  describe('markTelemetryConsentPrompted', () => {
    it('should persist consentPromptedAt as an ISO timestamp', async () => {
      await getTelemetryConfig();
      expect((await getTelemetryConfig()).consentPromptedAt).toBeUndefined();

      await markTelemetryConsentPrompted();
      resetTelemetryConfigCache();

      const config = await getTelemetryConfig();
      expect(config.consentPromptedAt).toBeDefined();
      expect(() => new Date(config.consentPromptedAt as string).toISOString()).not.toThrow();
      expect(new Date(config.consentPromptedAt as string).toISOString()).toBe(config.consentPromptedAt);
    });

    it('should be idempotent — a second call does not move the timestamp', async () => {
      await markTelemetryConsentPrompted();
      resetTelemetryConfigCache();
      const first = (await getTelemetryConfig()).consentPromptedAt;
      expect(first).toBeDefined();

      // Even after time passes, the first-prompt stamp is preserved.
      await new Promise((r) => setTimeout(r, 5));
      await markTelemetryConsentPrompted();
      resetTelemetryConfigCache();
      const second = (await getTelemetryConfig()).consentPromptedAt;

      expect(second).toBe(first);
    });

    it('should NOT change the enabled state (never auto-enables)', async () => {
      await getTelemetryConfig();
      await markTelemetryConsentPrompted();
      resetTelemetryConfigCache();

      const config = await getTelemetryConfig();
      expect(config.enabled).toBe(false);
      expect(config.consentPromptedAt).toBeDefined();
    });

    it('should preserve an existing opt-in when stamping prompted', async () => {
      await setTelemetryEnabled(true);
      await markTelemetryConsentPrompted();
      resetTelemetryConfigCache();

      const config = await getTelemetryConfig();
      expect(config.enabled).toBe(true);
      expect(config.consentPromptedAt).toBeDefined();
    });
  });
});
