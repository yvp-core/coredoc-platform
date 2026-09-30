/**
 * Telemetry Configuration
 *
 * Manages telemetry opt-in state and anonymous install ID.
 * Config stored at ~/.coredoc/telemetry.json.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCoredocHome } from './coredoc-home.js';

export interface TelemetryConfig {
  installId: string;
  enabled: boolean;
  firstSeenAt: string;
  lastOptInChangeAt?: string;
  /**
   * ISO timestamp of the FIRST time a consent surface (CLI first-run notice /
   * desktop consent card) was shown. Absent until then. It is the once-only
   * gate both surfaces read; it says nothing about opt-in — telemetry stays
   * OFF unless the user explicitly enables it.
   */
  consentPromptedAt?: string;
}

function getCoredocDir(): string {
  return resolveCoredocHome();
}

function getTelemetryFile(): string {
  return join(getCoredocDir(), 'telemetry.json');
}

let cachedConfig: TelemetryConfig | null = null;

export async function getTelemetryConfig(): Promise<TelemetryConfig> {
  if (process.env.COREDOC_TELEMETRY_DISABLED === '1') {
    if (cachedConfig) return { ...cachedConfig, enabled: false };
    const config = await readOrCreateConfig();
    return { ...config, enabled: false };
  }

  if (cachedConfig) return cachedConfig;
  cachedConfig = await readOrCreateConfig();
  return cachedConfig;
}

export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  const config = await readOrCreateConfig();
  config.enabled = enabled;
  config.lastOptInChangeAt = new Date().toISOString();
  cachedConfig = config;
  await writeConfig(config);
}

/**
 * Stamp `consentPromptedAt` the first time a consent surface is shown, so the
 * CLI notice / desktop card show exactly once. Idempotent: a second call is a
 * no-op that preserves the original first-prompt timestamp. Never touches
 * `enabled` — showing the prompt must never opt the user in.
 */
export async function markTelemetryConsentPrompted(): Promise<void> {
  const config = await readOrCreateConfig();
  if (config.consentPromptedAt) {
    // Already prompted — keep the original stamp (and refresh the cache so a
    // caller that read a disabled-override copy still sees the persisted value).
    cachedConfig = config;
    return;
  }
  config.consentPromptedAt = new Date().toISOString();
  cachedConfig = config;
  await writeConfig(config);
}

export function resetTelemetryConfigCache(): void {
  cachedConfig = null;
}

async function readOrCreateConfig(): Promise<TelemetryConfig> {
  try {
    const raw = await readFile(getTelemetryFile(), 'utf-8');
    return JSON.parse(raw) as TelemetryConfig;
  } catch {
    const config: TelemetryConfig = {
      installId: randomUUID(),
      enabled: false,
      firstSeenAt: new Date().toISOString(),
    };
    await writeConfig(config);
    return config;
  }
}

async function writeConfig(config: TelemetryConfig): Promise<void> {
  await mkdir(getCoredocDir(), { recursive: true });
  await writeFile(getTelemetryFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}
