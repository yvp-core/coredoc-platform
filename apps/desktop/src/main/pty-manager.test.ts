import { afterEach, describe, expect, it } from 'vitest';
import { buildPtyEnvironment } from './pty-manager';

describe('buildPtyEnvironment', () => {
  const originalCodexApiKey = process.env.CODEX_API_KEY;

  afterEach(() => {
    if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = originalCodexApiKey;
  });

  it('treats an explicitly supplied environment as authoritative', () => {
    process.env.CODEX_API_KEY = 'ambient-secret';

    expect(buildPtyEnvironment({ PATH: '/usr/bin' })).toEqual({
      PATH: '/usr/bin',
      TERM: 'xterm-256color',
    });
  });

  it('inherits the process environment only when no environment is supplied', () => {
    process.env.CODEX_API_KEY = 'ambient-secret';

    expect(buildPtyEnvironment()).toMatchObject({
      CODEX_API_KEY: 'ambient-secret',
      TERM: 'xterm-256color',
    });
  });
});
