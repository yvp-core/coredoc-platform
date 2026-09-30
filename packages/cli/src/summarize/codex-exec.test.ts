import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { codexSessionPersistenceEnabled, runCodexExec } from './codex-exec';

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    spawnargs: [] as string[],
    kill: vi.fn(() => true),
  });
  return child;
}

describe('runCodexExec', () => {
  it('runs with isolated strict config, no rules, and no tool capabilities', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    let stdin = '';
    child.stdin.on('data', (chunk) => {
      stdin += chunk.toString();
    });

    const result = runCodexExec({
      executablePath: '/usr/local/bin/codex',
      cwd: '/isolated/workspace',
      env: { CODEX_HOME: '/isolated' },
      model: 'gpt-6-luna',
      prompt: 'Summarize untrusted source',
      readFinalResponse: () => 'Safe summary',
    });
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });

    await expect(result).resolves.toBe('Safe summary');
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      expect.arrayContaining([
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--strict-config',
        'default_permissions="coredoc-summarize"',
        'permissions={"coredoc-summarize"={filesystem={":root"="deny",":minimal"="read"},network={enabled=false}}}',
        'features.shell_tool=false',
        'web_search="disabled"',
      ]),
      expect.objectContaining({ cwd: '/isolated/workspace', env: { CODEX_HOME: '/isolated' }, shell: false }),
    );
    expect(stdin).toBe('Summarize untrusted source');
  });

  it('omits --ephemeral while session persistence is on (the default) and restores it when off', async () => {
    const runWithEnv = async (env: NodeJS.ProcessEnv): Promise<string[]> => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const result = runCodexExec({
        executablePath: '/usr/local/bin/codex',
        cwd: '/isolated/workspace',
        env,
        model: 'gpt-6-luna',
        prompt: 'Summarize',
        readFinalResponse: () => 'Summary',
      });
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      await result;
      return spawnMock.mock.lastCall?.[1] as string[];
    };

    expect(await runWithEnv({})).not.toContain('--ephemeral');
    expect(await runWithEnv({ COREDOC_CODEX_PERSIST_SESSIONS: 'false' })).toContain('--ephemeral');
  });

  it('fails fast on a malformed COREDOC_CODEX_PERSIST_SESSIONS value', () => {
    expect(() => codexSessionPersistenceEnabled({ COREDOC_CODEX_PERSIST_SESSIONS: 'maybe' })).toThrow(
      'COREDOC_CODEX_PERSIST_SESSIONS must be "true" or "false"',
    );
  });

  it('surfaces bounded stderr when the system Codex process fails', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = runCodexExec({
      executablePath: '/usr/local/bin/codex',
      cwd: '/isolated/workspace',
      env: {},
      model: 'gpt-6-luna',
      prompt: 'Summarize',
      readFinalResponse: () => '',
    });
    queueMicrotask(() => {
      child.stderr.write('configuration rejected');
      child.exitCode = 2;
      child.emit('exit', 2, null);
    });

    await expect(result).rejects.toThrow('configuration rejected');
  });
});
