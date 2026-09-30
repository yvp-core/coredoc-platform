import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, runCodexExecMock, homedirMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  runCodexExecMock: vi.fn(),
  homedirMock: vi.fn((): string => '/missing-coredoc-test-home'),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => homedirMock(),
}));
vi.mock('./codex-exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codex-exec.js')>()),
  runCodexExec: (...args: unknown[]) => runCodexExecMock(...args),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTextGenerator } from './text-generator';

describe('createTextGenerator', () => {
  beforeEach(() => {
    queryMock.mockReset();
    runCodexExecMock.mockReset();
    homedirMock.mockReset();
    homedirMock.mockReturnValue('/missing-coredoc-test-home');
  });

  it('defaults to tool-free Claude Code generation', async () => {
    queryMock.mockReturnValue(
      (async function* () {
        yield { type: 'assistant', message: { content: [{ text: 'Claude answer' }] } };
      })(),
    );

    const generator = createTextGenerator({ cwd: '/repo', sdkEnv: { PATH: '/usr/bin' } });
    await expect(generator.generate('user prompt', 'system prompt')).resolves.toBe('Claude answer');
    expect(queryMock).toHaveBeenCalledWith({
      prompt: 'user prompt',
      options: expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        allowedTools: [],
        systemPrompt: 'system prompt',
        cwd: '/repo',
        env: { PATH: '/usr/bin' },
      }),
    });
  });

  it('uses the system Codex CLI with no repo/tool access and an isolated Codex home', async () => {
    runCodexExecMock.mockResolvedValue('Codex answer');

    const generator = createTextGenerator({
      harness: 'codex',
      cwd: '/repo',
      codexCliPath: '/usr/local/bin/codex',
      sdkEnv: { PATH: '/usr/bin', CODEX_API_KEY: 'selected-token', DROP_ME: undefined },
    });
    await expect(generator.generate('user prompt', 'system prompt')).resolves.toBe('Codex answer');

    expect(runCodexExecMock).toHaveBeenCalledWith({
      executablePath: '/usr/local/bin/codex',
      cwd: expect.stringContaining('coredoc-codex-summarize-'),
      env: expect.objectContaining({
        PATH: '/usr/local/bin:/usr/bin',
        CODEX_API_KEY: 'selected-token',
        CODEX_HOME: expect.stringContaining('coredoc-codex-summarize-'),
      }),
      model: 'gpt-6-luna',
      prompt: 'system prompt\n\nuser prompt',
    });
  });

  it('fails before execution when no compatible system Codex is available', () => {
    expect(() => createTextGenerator({ harness: 'codex' })).toThrow('System Codex CLI path is required');
  });

  it('preserves isolated-home rollouts while persistence is on and skips them when it is off', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-fake-home-'));
    homedirMock.mockReturnValue(fakeHome);
    let runNumber = 0;
    runCodexExecMock.mockImplementation(async (options: { env: NodeJS.ProcessEnv }) => {
      runNumber += 1;
      const day = path.join(options.env.CODEX_HOME as string, 'sessions', '2026', '08', '20');
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(path.join(day, `rollout-run-${runNumber}.jsonl`), '{"type":"session_meta"}\n');
      return 'Codex answer';
    });
    const preservedDay = path.join(fakeHome, '.codex', 'sessions', '2026', '08', '20');

    try {
      const generator = createTextGenerator({
        harness: 'codex',
        codexCliPath: '/usr/local/bin/codex',
        sdkEnv: { PATH: '/usr/bin' },
      });
      await generator.generate('user prompt', 'system prompt');
      expect(runCodexExecMock.mock.lastCall?.[0].env.COREDOC_CODEX_PERSIST_SESSIONS).toBe('true');
      expect(fs.existsSync(path.join(preservedDay, 'rollout-run-1.jsonl'))).toBe(true);

      const generatorOff = createTextGenerator({
        harness: 'codex',
        codexCliPath: '/usr/local/bin/codex',
        sdkEnv: { PATH: '/usr/bin', COREDOC_CODEX_PERSIST_SESSIONS: 'false' },
      });
      await generatorOff.generate('user prompt', 'system prompt');
      expect(runCodexExecMock.mock.lastCall?.[0].env.COREDOC_CODEX_PERSIST_SESSIONS).toBe('false');
      expect(fs.existsSync(path.join(preservedDay, 'rollout-run-2.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
