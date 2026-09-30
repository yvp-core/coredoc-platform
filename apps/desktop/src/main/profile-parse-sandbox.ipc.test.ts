import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawnSandboxedParse, type SandboxedParseLaunchOptions } from './profile-parse-sandbox.js';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('./git-runtime.js', () => ({ resolveMacGit: () => ({ directory: '/usr/bin', readPaths: [] }) }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, existsSync: (path: string) => path === '/usr/bin/sandbox-exec' || fs.existsSync(path) };
});
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const makeChild = () =>
  Object.assign(new EventEmitter(), {
    pid: 123456789,
    exitCode: null,
    signalCode: null,
    connected: true,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()],
    send: vi.fn(),
    kill: vi.fn(),
  });
let child: ReturnType<typeof makeChild>;
let options: SandboxedParseLaunchOptions;
let root: string;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  root = mkdtempSync(join(tmpdir(), 'parse-ipc-test-'));
  child = makeChild();
  spawn.mockReturnValue(child);
  options = {
    nodeExecutable: process.execPath,
    childScript: '/unused-child.js',
    sourceEnv: {},
    runtimeBinDirs: [],
    databaseUrl: `file:${root}/db`,
    homeDir: root,
    readPaths: [],
    readFiles: [],
    writePaths: [],
    writeFiles: [],
    deniedReadPaths: [],
    message: { command: 'parse', projectId: 'test' } as SandboxedParseLaunchOptions['message'],
    prepareCSharpIndex: vi.fn().mockResolvedValue({ basic: true }),
    onLog: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
});
afterEach(() => {
  child.emit('close', 0, null);
  Object.defineProperty(process, 'platform', platform);
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
it('returns validated host results over IPC and does not forward raw host errors to profile code', async () => {
  spawnSandboxedParse(options);
  const request = { projects: ['App.csproj'], defines: [], fallback: true };
  child.emit('message', { type: 'csharp-index', id: 1, request });
  await flush();
  expect(options.prepareCSharpIndex).toHaveBeenCalledWith(request);
  expect(child.send).toHaveBeenCalledWith({ type: 'csharp-index-result', id: 1, result: { basic: true } });
  vi.mocked(options.prepareCSharpIndex!).mockRejectedValueOnce(new Error('private host build output'));
  child.emit('message', { type: 'csharp-index', id: 2, request });
  await flush();
  await vi.waitFor(() =>
    expect(options.onLog).toHaveBeenCalledWith(expect.stringContaining('private host build output')),
  );
  expect(child.send.mock.calls.at(-1)?.[0].error).not.toContain('private host build output');
});
it('answers the excessive request and terminates instead of leaving a blocked child', async () => {
  spawnSandboxedParse(options);
  for (let id = 1; id <= 65; id++) child.emit('message', { type: 'csharp-index', id, request: {} });
  await flush();
  expect(child.send).toHaveBeenCalledWith({
    type: 'csharp-index-result',
    id: 65,
    error: 'Too many compiler requests.',
  });
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(options.prepareCSharpIndex).not.toHaveBeenCalled();
});
it('catches fd-3 errors in the main process and terminates the child', () => {
  spawnSandboxedParse(options);
  const error = new Error('broken fd 3');
  child.stdio[3].emit('error', error);
  expect(options.onError).toHaveBeenCalledWith(error);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});

it('dispatches optional index requests independently of the C# host', async () => {
  options.prepareOptionalIndex = vi.fn().mockResolvedValue({ path: '/owned/ruby.scip' });
  spawnSandboxedParse(options);
  const request = { language: 'ruby', fallback: true };
  child.emit('message', { type: 'optional-index', id: 1, request });
  await flush();
  expect(options.prepareOptionalIndex).toHaveBeenCalledWith(request);
  expect(options.prepareCSharpIndex).not.toHaveBeenCalled();
  expect(child.send).toHaveBeenCalledWith({
    type: 'optional-index-result',
    id: 1,
    result: { path: '/owned/ruby.scip' },
  });
});
