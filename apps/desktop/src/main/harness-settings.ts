import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  HarnessAuthMode,
  HarnessCredentialStatus,
  HarnessProvider,
  HarnessSettingsStatus,
  HarnessSettingsUpdate,
  HarnessSettingsUpdateResult,
} from '../shared/ipc-types.js';

export interface HarnessSettings {
  provider: HarnessProvider;
  authMode: HarnessAuthMode;
  credentials: Partial<Record<HarnessProvider, string>>;
}

const ENV_KEYS = {
  provider: 'COREDOC_HARNESS_PROVIDER',
  authMode: 'COREDOC_HARNESS_AUTH_MODE',
  claudeCredential: 'COREDOC_CLAUDE_API_TOKEN',
  codexCredential: 'COREDOC_CODEX_API_TOKEN',
} as const;

const CREDENTIAL_ENV_KEYS = new Set([
  'CLAUDE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
  'COREDOC_CLAUDE_API_TOKEN',
  'COREDOC_CODEX_API_TOKEN',
]);

function isHarnessProvider(value: unknown): value is HarnessProvider {
  return value === 'claude-code' || value === 'codex';
}

function isHarnessAuthMode(value: unknown): value is HarnessAuthMode {
  return value === 'subscription' || value === 'api-token';
}

function readFile(envPath: string): string {
  try {
    return fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function parseValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : value;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function valuesFrom(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], parseValue(match[2]));
  }
  return values;
}

function settingsFrom(contents: string): HarnessSettings {
  const values = valuesFrom(contents);
  const storedProvider = values.get(ENV_KEYS.provider);
  const storedAuthMode = values.get(ENV_KEYS.authMode);
  const claudeCredential = values.get(ENV_KEYS.claudeCredential)?.trim();
  const codexCredential = values.get(ENV_KEYS.codexCredential)?.trim();
  const credentials: HarnessSettings['credentials'] = {};
  if (claudeCredential) credentials['claude-code'] = claudeCredential;
  if (codexCredential) credentials.codex = codexCredential;

  return {
    provider: isHarnessProvider(storedProvider) ? storedProvider : 'claude-code',
    authMode: isHarnessAuthMode(storedAuthMode) ? storedAuthMode : 'subscription',
    credentials,
  };
}

export function readHarnessSettings(envPath: string): HarnessSettings {
  return settingsFrom(readFile(envPath));
}

function mask(value: string | undefined): HarnessCredentialStatus {
  if (!value) return { isSet: false };
  return {
    isSet: true,
    maskedValue: value.length > 8 ? `${'•'.repeat(8)}${value.slice(-8)}` : '•'.repeat(value.length),
  };
}

export function getHarnessSettingsStatus(envPath: string): HarnessSettingsStatus {
  const settings = readHarnessSettings(envPath);
  return {
    provider: settings.provider,
    authMode: settings.authMode,
    credentials: {
      'claude-code': mask(settings.credentials['claude-code']),
      codex: mask(settings.credentials.codex),
    },
  };
}

function setEnvLine(lines: string[], key: string, value: string | undefined): void {
  const matcher = new RegExp(`^\\s*${key}\\s*=`);
  const indexes = lines.flatMap((line, index) => (matcher.test(line) ? [index] : []));
  if (!value) {
    for (const index of indexes.reverse()) lines.splice(index, 1);
    return;
  }

  const nextLine = `${key}=${JSON.stringify(value)}`;
  if (indexes.length > 0) {
    lines[indexes[0]] = nextLine;
    for (const index of indexes.slice(1).reverse()) lines.splice(index, 1);
    return;
  }

  if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
  lines.push(nextLine);
}

export function updateHarnessSettings(envPath: string, update: HarnessSettingsUpdate): HarnessSettingsUpdateResult {
  if (update.provider !== undefined && !isHarnessProvider(update.provider)) {
    return { success: false, error: 'Unknown harness provider.' };
  }
  if (update.authMode !== undefined && !isHarnessAuthMode(update.authMode)) {
    return { success: false, error: 'Unknown harness authentication mode.' };
  }
  if (update.credential && !isHarnessProvider(update.credential.provider)) {
    return { success: false, error: 'Unknown harness provider.' };
  }
  if (update.credential && /[\r\n]/.test(update.credential.value)) {
    return { success: false, error: 'API token must be a single line.' };
  }

  const directory = path.dirname(envPath);
  const tempPath = path.join(directory, `.${path.basename(envPath)}.${randomUUID()}.tmp`);
  let tempFd: number | undefined;
  try {
    fs.mkdirSync(directory, { recursive: true });

    try {
      const existing = fs.lstatSync(envPath);
      if (!existing.isFile()) throw new Error('Harness settings path must be a regular file.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const contents = readFile(envPath);
    const current = settingsFrom(contents);
    const lines = contents.split(/\r?\n/);
    setEnvLine(lines, ENV_KEYS.provider, update.provider ?? current.provider);
    setEnvLine(lines, ENV_KEYS.authMode, update.authMode ?? current.authMode);
    if (update.credential) {
      const key = update.credential.provider === 'claude-code' ? ENV_KEYS.claudeCredential : ENV_KEYS.codexCredential;
      setEnvLine(lines, key, update.credential.value.trim() || undefined);
    }

    const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0);
    tempFd = fs.openSync(tempPath, flags, 0o600);
    fs.writeFileSync(tempFd, lines.join('\n'), { encoding: 'utf8' });
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;
    fs.renameSync(tempPath, envPath);
    return { success: true };
  } catch (error) {
    if (tempFd !== undefined) {
      try {
        fs.closeSync(tempFd);
      } catch {
        // The descriptor may already have been closed by a failed write.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The write may have failed before the temporary file was created.
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save harness settings.',
    };
  }
}

function providerLabel(provider: HarnessProvider): string {
  return provider === 'claude-code' ? 'Claude Code' : 'Codex';
}

export function buildHarnessEnvironment(baseEnv: NodeJS.ProcessEnv, settings: HarnessSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_ENV_KEYS.has(key.toUpperCase())) delete env[key];
  }

  if (settings.authMode === 'subscription') return env;

  const credential = settings.credentials[settings.provider]?.trim();
  if (!credential) {
    throw new Error(`Add a ${providerLabel(settings.provider)} API token in Settings before starting this run.`);
  }
  if (settings.provider === 'claude-code') env.ANTHROPIC_API_KEY = credential;
  else env.CODEX_API_KEY = credential;
  return env;
}
