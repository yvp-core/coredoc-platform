import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { HarnessAuthMode, findCodexExecutable, resolveSummarizeHarness } from './harness';

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-harness-test-'));
const codexPath = path.join(binDir, 'codex');
fs.writeFileSync(codexPath, '#!/bin/sh\n', { mode: 0o755 });

afterAll(() => {
  fs.rmSync(binDir, { recursive: true, force: true });
});

describe('resolveSummarizeHarness', () => {
  it('returns undefined when COREDOC_HARNESS_PROVIDER is unset or blank', () => {
    expect(resolveSummarizeHarness({})).toBeUndefined();
    expect(resolveSummarizeHarness({ COREDOC_HARNESS_PROVIDER: '  ' })).toBeUndefined();
  });

  it('throws on an unknown provider instead of silently falling back', () => {
    expect(() => resolveSummarizeHarness({ COREDOC_HARNESS_PROVIDER: 'copilot' })).toThrow(
      /COREDOC_HARNESS_PROVIDER must be "claude-code" or "codex"/,
    );
  });

  it('throws on an unknown auth mode', () => {
    expect(() =>
      resolveSummarizeHarness({ COREDOC_HARNESS_PROVIDER: 'claude-code', COREDOC_HARNESS_AUTH_MODE: 'oauth' }),
    ).toThrow(/COREDOC_HARNESS_AUTH_MODE must be "subscription" or "api-token"/);
  });

  it('selects the codex harness with a resolved executable and defaults to subscription auth', () => {
    const selection = resolveSummarizeHarness({
      COREDOC_HARNESS_PROVIDER: 'codex',
      PATH: binDir,
    });
    expect(selection).toMatchObject({
      harness: 'codex',
      authMode: HarnessAuthMode.Subscription,
      codexCliPath: codexPath,
    });
  });

  it('strips ambient provider credentials so the selected auth mode decides authentication', () => {
    const selection = resolveSummarizeHarness({
      COREDOC_HARNESS_PROVIDER: 'codex',
      COREDOC_HARNESS_AUTH_MODE: HarnessAuthMode.Subscription,
      PATH: binDir,
      OPENAI_API_KEY: 'ambient-openai',
      CODEX_API_KEY: 'ambient-codex',
      ANTHROPIC_API_KEY: 'ambient-anthropic',
      CODEX_HOME: '/somewhere/.codex',
      COREDOC_CODEX_API_TOKEN: 'stored-token',
      UNRELATED: 'kept',
    });
    expect(selection?.sdkEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect(selection?.sdkEnv).not.toHaveProperty('CODEX_API_KEY');
    expect(selection?.sdkEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(selection?.sdkEnv).not.toHaveProperty('CODEX_HOME');
    expect(selection?.sdkEnv).not.toHaveProperty('COREDOC_CODEX_API_TOKEN');
    expect(selection?.sdkEnv.UNRELATED).toBe('kept');
    expect(selection?.sdkEnv.PATH).toBe(binDir);
  });

  it('injects the stored codex token in api-token mode', () => {
    const selection = resolveSummarizeHarness({
      COREDOC_HARNESS_PROVIDER: 'codex',
      COREDOC_HARNESS_AUTH_MODE: HarnessAuthMode.ApiToken,
      COREDOC_CODEX_API_TOKEN: 'codex-token',
      PATH: binDir,
    });
    expect(selection?.authMode).toBe(HarnessAuthMode.ApiToken);
    expect(selection?.sdkEnv.CODEX_API_KEY).toBe('codex-token');
  });

  it('injects the stored claude token as ANTHROPIC_API_KEY in api-token mode', () => {
    const selection = resolveSummarizeHarness({
      COREDOC_HARNESS_PROVIDER: 'claude-code',
      COREDOC_HARNESS_AUTH_MODE: HarnessAuthMode.ApiToken,
      COREDOC_CLAUDE_API_TOKEN: 'claude-token',
    });
    expect(selection?.harness).toBe('claude-code');
    expect(selection?.codexCliPath).toBeUndefined();
    expect(selection?.sdkEnv.ANTHROPIC_API_KEY).toBe('claude-token');
  });

  it('throws in api-token mode when the matching token is missing', () => {
    expect(() =>
      resolveSummarizeHarness({
        COREDOC_HARNESS_PROVIDER: 'codex',
        COREDOC_HARNESS_AUTH_MODE: HarnessAuthMode.ApiToken,
        PATH: binDir,
      }),
    ).toThrow(/requires COREDOC_CODEX_API_TOKEN/);
    expect(() =>
      resolveSummarizeHarness({
        COREDOC_HARNESS_PROVIDER: 'claude-code',
        COREDOC_HARNESS_AUTH_MODE: HarnessAuthMode.ApiToken,
      }),
    ).toThrow(/requires COREDOC_CLAUDE_API_TOKEN/);
  });

  it('throws when the codex harness is selected but no executable is on PATH', () => {
    expect(() =>
      resolveSummarizeHarness({
        COREDOC_HARNESS_PROVIDER: 'codex',
        PATH: path.join(binDir, 'does-not-exist'),
      }),
    ).toThrow(/no `codex` executable was found on PATH/);
  });
});

describe('findCodexExecutable', () => {
  it('resolves the first executable codex on PATH', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-harness-empty-'));
    try {
      const found = findCodexExecutable({ PATH: [emptyDir, binDir].join(path.delimiter) });
      expect(found).toBe(codexPath);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('returns null when PATH is unset or has no codex', () => {
    expect(findCodexExecutable({})).toBeNull();
    expect(findCodexExecutable({ PATH: os.tmpdir() })).toBeNull();
  });

  it('skips a non-executable codex file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-harness-noexec-'));
    try {
      fs.writeFileSync(path.join(dir, 'codex'), '', { mode: 0o644 });
      expect(findCodexExecutable({ PATH: dir }, 'darwin')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
