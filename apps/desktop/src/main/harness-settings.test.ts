import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildHarnessEnvironment,
  getHarnessSettingsStatus,
  readHarnessSettings,
  updateHarnessSettings,
} from './harness-settings';

const fixtureDirs: string[] = [];

function fixtureEnv(contents = ''): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'coredoc-harness-settings-'));
  fixtureDirs.push(dir);
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, contents, 'utf8');
  return envPath;
}

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('harness settings', () => {
  it('defaults to Claude Code subscription without exposing a credential', () => {
    const envPath = fixtureEnv('UNRELATED=value\nCLAUDE_OAUTH_TOKEN=legacy-token\n');

    expect(readHarnessSettings(envPath)).toEqual({
      provider: 'claude-code',
      authMode: 'subscription',
      credentials: {},
    });
    expect(getHarnessSettingsStatus(envPath)).toEqual({
      provider: 'claude-code',
      authMode: 'subscription',
      credentials: {
        'claude-code': { isSet: false },
        codex: { isSet: false },
      },
    });
  });

  it('persists both provider credentials while preserving unrelated and legacy lines', () => {
    const envPath = fixtureEnv('UNRELATED=value\nCLAUDE_OAUTH_TOKEN=legacy-token\n');

    expect(
      updateHarnessSettings(envPath, {
        provider: 'codex',
        authMode: 'api-token',
        credential: { provider: 'codex', value: 'codex-secret-12345678' },
      }),
    ).toEqual({ success: true });
    expect(
      updateHarnessSettings(envPath, {
        credential: { provider: 'claude-code', value: 'claude-secret-87654321' },
      }),
    ).toEqual({ success: true });

    expect(readHarnessSettings(envPath)).toEqual({
      provider: 'codex',
      authMode: 'api-token',
      credentials: {
        'claude-code': 'claude-secret-87654321',
        codex: 'codex-secret-12345678',
      },
    });
    expect(getHarnessSettingsStatus(envPath)).toEqual({
      provider: 'codex',
      authMode: 'api-token',
      credentials: {
        'claude-code': { isSet: true, maskedValue: '••••••••87654321' },
        codex: { isSet: true, maskedValue: '••••••••12345678' },
      },
    });

    const persisted = readFileSync(envPath, 'utf8');
    expect(persisted).toContain('UNRELATED=value');
    expect(persisted).toContain('CLAUDE_OAUTH_TOKEN=legacy-token');
  });

  it('clears one credential without changing the other provider selection', () => {
    const envPath = fixtureEnv(
      [
        'COREDOC_HARNESS_PROVIDER=codex',
        'COREDOC_HARNESS_AUTH_MODE=api-token',
        'COREDOC_CLAUDE_API_TOKEN=claude-secret',
        'COREDOC_CODEX_API_TOKEN=codex-secret',
        '',
      ].join('\n'),
    );

    expect(updateHarnessSettings(envPath, { credential: { provider: 'codex', value: '' } })).toEqual({ success: true });
    expect(readHarnessSettings(envPath)).toEqual({
      provider: 'codex',
      authMode: 'api-token',
      credentials: { 'claude-code': 'claude-secret' },
    });
  });

  it('rejects invalid selector values and credential line injection', () => {
    const envPath = fixtureEnv('COREDOC_HARNESS_PROVIDER=other\nCOREDOC_HARNESS_AUTH_MODE=magic\n');

    expect(readHarnessSettings(envPath)).toMatchObject({
      provider: 'claude-code',
      authMode: 'subscription',
    });
    expect(
      updateHarnessSettings(envPath, {
        credential: { provider: 'codex', value: 'safe\nINJECTED=value' },
      }),
    ).toEqual({ success: false, error: 'API token must be a single line.' });
    expect(readFileSync(envPath, 'utf8')).not.toContain('INJECTED=value');
  });

  it('fails closed when the existing env file cannot be read', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'coredoc-harness-settings-'));
    fixtureDirs.push(dir);
    const envPath = path.join(dir, '.env');
    symlinkSync('.env', envPath);

    expect(updateHarnessSettings(envPath, { provider: 'codex' })).toMatchObject({ success: false });
    expect(lstatSync(envPath).isSymbolicLink()).toBe(true);
  });

  it('does not follow a pre-created temp symlink and writes credentials owner-only', () => {
    const envPath = fixtureEnv('UNRELATED=value\n');
    const redirectedPath = path.join(path.dirname(envPath), 'redirected');
    writeFileSync(redirectedPath, 'do-not-touch', 'utf8');
    symlinkSync(redirectedPath, path.join(path.dirname(envPath), '..env.coredoc-settings.tmp'));

    expect(
      updateHarnessSettings(envPath, {
        provider: 'codex',
        authMode: 'api-token',
        credential: { provider: 'codex', value: 'selected-secret' },
      }),
    ).toEqual({ success: true });

    expect(readFileSync(redirectedPath, 'utf8')).toBe('do-not-touch');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });
});

describe('buildHarnessEnvironment', () => {
  const ambient = {
    PATH: '/usr/bin',
    CLAUDE_OAUTH_TOKEN: 'legacy',
    CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
    ANTHROPIC_API_KEY: 'ambient-anthropic',
    ANTHROPIC_AUTH_TOKEN: 'ambient-auth',
    OPENAI_API_KEY: 'ambient-openai',
    CODEX_API_KEY: 'ambient-codex',
    ANTHROPIC_BASE_URL: 'https://attacker.example/anthropic',
    OPENAI_BASE_URL: 'https://attacker.example/openai',
    CODEX_HOME: '/attacker/codex-home',
    COREDOC_CLAUDE_API_TOKEN: 'stored-in-workspace',
    COREDOC_CODEX_API_TOKEN: 'stored-in-workspace',
  };

  it.each(['claude-code', 'codex'] as const)('scrubs manual credentials in %s subscription mode', (provider) => {
    const env = buildHarnessEnvironment(ambient, {
      provider,
      authMode: 'subscription',
      credentials: {
        'claude-code': 'stored-claude',
        codex: 'stored-codex',
      },
    });

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('injects only the selected Claude API token', () => {
    const env = buildHarnessEnvironment(ambient, {
      provider: 'claude-code',
      authMode: 'api-token',
      credentials: { 'claude-code': 'stored-claude', codex: 'stored-codex' },
    });

    expect(env).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'stored-claude' });
  });

  it('injects only the selected Codex API token', () => {
    const env = buildHarnessEnvironment(ambient, {
      provider: 'codex',
      authMode: 'api-token',
      credentials: { 'claude-code': 'stored-claude', codex: 'stored-codex' },
    });

    expect(env).toEqual({ PATH: '/usr/bin', CODEX_API_KEY: 'stored-codex' });
  });

  it('fails before launch when API-token mode has no selected credential', () => {
    expect(() =>
      buildHarnessEnvironment(ambient, {
        provider: 'codex',
        authMode: 'api-token',
        credentials: {},
      }),
    ).toThrow('Add a Codex API token in Settings before starting this run.');
  });
});
