import { existsSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { SandboxedParseLaunchOptions } from './profile-parse-sandbox.js';
import { createProfileScoreHost } from './profile-score-host.js';

const { launch, prepare, prepareOptional, terminate } = vi.hoisted(() => ({
  launch: vi.fn(),
  prepare: vi.fn(),
  prepareOptional: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('./profile-parse-sandbox.js', () => ({
  spawnSandboxedParse: (opts: SandboxedParseLaunchOptions) => {
    launch(opts);
    return { terminate };
  },
}));
vi.mock('./csharp-index-host.js', () => ({ prepareDesktopCSharpIndex: prepare }));
vi.mock('./optional-index-host.js', () => ({ prepareDesktopOptionalIndex: prepareOptional }));
afterEach(() => {
  vi.resetAllMocks();
});

function setup() {
  const controller = new AbortController();
  const host = createProfileScoreHost({
    profilePath: '/draft/profile.ts',
    controller,
    compiler: {
      repoRoot: '/source',
      nodeExecutable: '/node',
      sourceEnv: {},
      onLog: vi.fn(),
      onProgress: vi.fn(),
      ask: vi.fn(),
    },
    sandbox: {
      nodeExecutable: '/node',
      childScript: '/child',
      sourceEnv: {},
      runtimeBinDirs: [],
      homeDir: '/home',
      readPaths: ['/source', '/draft'],
      readFiles: [],
      writePaths: ['/draft'],
      writeFiles: [],
      deniedReadPaths: [],
    },
  });
  return { host, controller };
}
const request = { projects: ['App.csproj'], defines: [], fallback: true };

it('does not reuse optional compiler coordinates across scoring revisions', async () => {
  const { host } = setup();
  prepareOptional
    .mockResolvedValueOnce({ path: '/artifact/before-edit.scip' })
    .mockResolvedValueOnce({ path: '/artifact/after-edit.scip' });
  const paths: unknown[] = [];
  launch.mockImplementation((opts: SandboxedParseLaunchOptions) =>
    queueMicrotask(async () => {
      const request = { language: 'go', fallback: true };
      paths.push(await opts.prepareOptionalIndex!(request));
      await opts.prepareOptionalIndex!(request);
      opts.onResult({ type: 'result', success: true });
      opts.onClose(0, null);
    }),
  );
  try {
    await host.score();
    await host.score();
    expect(paths).toEqual([{ path: '/artifact/before-edit.scip' }, { path: '/artifact/after-edit.scip' }]);
    expect(prepareOptional).toHaveBeenCalledTimes(2);
  } finally {
    await host.dispose();
  }
});

it('does not reuse score coordinates in the independent parse handoff', async () => {
  const { host } = setup();
  const request = { language: 'python', fallback: true };
  prepareOptional
    .mockResolvedValueOnce({ path: '/artifact/score.scip' })
    .mockResolvedValueOnce({ path: '/artifact/current-source.scip' });
  launch.mockImplementation((opts: SandboxedParseLaunchOptions) =>
    queueMicrotask(async () => {
      await opts.prepareOptionalIndex!(request);
      opts.onResult({ type: 'result', success: true });
      opts.onClose(0, null);
    }),
  );
  try {
    await host.score();
    host.beginParse();
    expect(await host.prepareOptionalIndex(request)).toEqual({ path: '/artifact/current-source.scip' });
    expect(prepareOptional).toHaveBeenCalledTimes(2);
  } finally {
    await host.dispose();
  }
});

it('rechecks optional prerequisites after a basic answer instead of caching it', async () => {
  const { host } = setup();
  prepareOptional.mockResolvedValueOnce({ basic: true }).mockResolvedValueOnce({ path: '/artifact/installed.scip' });
  try {
    expect(await host.prepareOptionalIndex({ language: 'python', fallback: true })).toEqual({ basic: true });
    expect(await host.prepareOptionalIndex({ language: 'python', fallback: true })).toEqual({
      path: '/artifact/installed.scip',
    });
  } finally {
    await host.dispose();
  }
});

it('scores through the compiler host and reuses its decision/index for subsequent revisions', async () => {
  const { host } = setup();
  prepare.mockResolvedValue({ path: '/artifact/index.scip' });
  launch.mockImplementation((opts: SandboxedParseLaunchOptions) =>
    queueMicrotask(async () => {
      expect(opts.message).toEqual({ command: 'score-profile', profilePath: '/draft/profile.ts', repoRoot: '/source' });
      expect(await opts.prepareCSharpIndex!(request)).toEqual({ path: '/artifact/index.scip' });
      opts.onLog('=== Profile completion: PASS ===');
      opts.onResult({ type: 'result', success: true });
      opts.onClose(0, null);
    }),
  );
  try {
    expect(await host.score()).toEqual({ success: true, output: '=== Profile completion: PASS ===' });
    await host.score();
    expect(prepare).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![0].writePaths).toEqual(['/draft']);
  } finally {
    await host.dispose();
  }
  expect(existsSync(prepare.mock.calls[0]![1].artifactDir)).toBe(false);
});

it('does not provision tools for non-C# scores and stops three identical blockers', async () => {
  const { host, controller } = setup();
  launch.mockImplementation((opts: SandboxedParseLaunchOptions) =>
    queueMicrotask(() => {
      opts.onLog('=== Profile completion: BLOCKED ===');
      opts.onResult({ type: 'result', success: false });
      opts.onClose(0, null);
    }),
  );
  try {
    for (let i = 0; i < 3; i++) expect((await host.score()).success).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason.message).toContain('same blocking diagnostics repeated 3 times');
    expect(launch).toHaveBeenCalledTimes(3);
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    await host.dispose();
  }
});

it('allows longer runs while blocking category counts improve', async () => {
  const { host, controller } = setup();
  let count = 0;
  launch.mockImplementation((opts: SandboxedParseLaunchOptions) =>
    queueMicrotask(() => {
      opts.onLog(`  - dbOperations: FAIL (${++count}/20)\n=== Profile completion: BLOCKED ===`);
      opts.onResult({ type: 'result', success: false });
      opts.onClose(0, null);
    }),
  );
  try {
    for (let i = 0; i < 5; i++) await host.score();
    expect(controller.signal.aborted).toBe(false);
    expect(launch).toHaveBeenCalledTimes(5);
  } finally {
    await host.dispose();
  }
});

it('also stops repeated scorer failures that occur before a completion marker exists', async () => {
  const { host, controller } = setup();
  launch.mockImplementation((opts: SandboxedParseLaunchOptions) =>
    queueMicrotask(() => {
      opts.onLog('The C# target passed; starting the TS target.');
      opts.onResult({ type: 'result', success: false, error: 'Cannot find module pre-scan.mjs' });
      opts.onClose(0, null);
    }),
  );
  try {
    for (let i = 0; i < 3; i++) await host.score();
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason.message).toContain('blocking diagnostics repeated 3 times');
  } finally {
    await host.dispose();
  }
});

it('terminates the scorer on cancellation and rejects rather than attesting partial output', async () => {
  const { host, controller } = setup();
  const pending = host.score();
  const rejected = expect(pending).rejects.toThrow('cancelled');
  controller.abort(new Error('cancelled'));
  expect(terminate).toHaveBeenCalledOnce();
  launch.mock.calls[0]![0].onClose(null, 'SIGTERM');
  await rejected;
  await host.dispose();
});
