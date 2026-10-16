import { describe, expect, it } from 'vitest';
import { sessionEnvironment } from './session-environment.js';

const base = {
  hostEnv: { PATH: '/usr/bin' },
  paths: {
    work: '/scratch/w',
    home: '/scratch/h',
    tmp: '/scratch/t',
    claudeConfig: '/scratch/s/claude',
    pluginStateHome: '/scratch/s/plugin',
  },
  sessionId: '00000000-0000-4000-8000-000000000000',
  modelApiKey: 'secret-value',
  sessionEndHookTimeoutMs: 30_000,
} as unknown as Parameters<typeof sessionEnvironment>[0];

describe('sessionEnvironment model credential', () => {
  it('passes the model key as ANTHROPIC_API_KEY by default', () => {
    const env = sessionEnvironment(base);
    expect(env.ANTHROPIC_API_KEY).toBe('secret-value');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('passes a development subscription token as CLAUDE_CODE_OAUTH_TOKEN and no API key', () => {
    const env = sessionEnvironment({ ...base, modelCredentialKind: 'subscription' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('secret-value');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
