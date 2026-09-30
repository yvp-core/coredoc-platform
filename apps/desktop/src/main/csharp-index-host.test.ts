import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareDesktopCSharpIndex, type CSharpHostOptions } from './csharp-index-host.js';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
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
let options: CSharpHostOptions;
let root: string;
const request = { projects: ['App.csproj'], defines: [], fallback: true };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'csharp-host-test-'));
  child = makeChild();
  spawn.mockReturnValue(child);
  options = {
    repoRoot: root,
    artifactDir: root,
    nodeExecutable: process.execPath,
    sourceEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'must-not-pass' },
    signal: new AbortController().signal,
    ask: vi.fn().mockResolvedValue('run'),
    onLog: vi.fn(),
    onProgress: vi.fn(),
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const frame = (message: unknown) => child.stdio[3].write(`${JSON.stringify(message)}\n`);
describe('desktop compiler boundary', () => {
  it('shares a bounded, plain-text log budget across stdout, stderr and result errors', async () => {
    const pending = prepareDesktopCSharpIndex(request, options);
    await flush();
    child.stdout.write('\x1b]52;c;clipboard\x07\x1b[31mvisible\x1b[0m');
    child.stderr.write('x'.repeat(256 * 1024));
    child.stdout.write('ignored'.repeat(100_000));
    frame({ type: 'result', error: 'also ignored after truncation' });
    child.emit('close');
    await expect(pending).rejects.toThrow('See the analysis log');
    const logged = vi
      .mocked(options.onLog)
      .mock.calls.map(([text]) => text)
      .join('');
    expect(logged).not.toContain('\x1b');
    expect(logged).not.toContain('\x07');
    expect(logged).toContain('visible');
    expect(logged).not.toContain('ignored');
    expect(logged.match(/Compiler output truncated/g)).toHaveLength(1);
    expect(Buffer.byteLength(logged)).toBeLessThan(256 * 1024 + 100);
  });
  it.each([
    false,
    true,
  ])('rejects an oversized protocol frame (newline=%s) and drains later output', async (newline) => {
    const pending = prepareDesktopCSharpIndex(request, options);
    await flush();
    const rejected = expect(pending).rejects.toThrow('64 KiB');
    child.stdio[3].write('x'.repeat(64 * 1024 + 1) + (newline ? '\n' : ''));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    frame({ type: 'install-progress', message: 'must not be forwarded' });
    expect(options.onProgress).not.toHaveBeenCalledWith('must not be forwarded');
    child.emit('close');
    await rejected;
    expect(options.onLog).toHaveBeenCalledWith(expect.stringContaining('protocol truncated'));
  });
  it('bounds the total protocol traffic even when individual messages fit', async () => {
    const pending = prepareDesktopCSharpIndex(request, options);
    await flush();
    const rejected = expect(pending).rejects.toThrow('1 MiB');
    for (let i = 0; i < 40; i++) frame({ type: 'install-progress', message: 'x'.repeat(32 * 1024) });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    await rejected;
  });
  it('does not spawn until explicit execution consent, even with provisioned tools', async () => {
    let answer!: (choice: 'run') => void;
    options.ask = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const pending = prepareDesktopCSharpIndex(request, options);
    expect(spawn).not.toHaveBeenCalled();
    expect(options.ask).toHaveBeenCalledWith(expect.stringContaining('network access'), true, false, 'execution');
    answer('run');
    await flush();
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty('ANTHROPIC_API_KEY');
    const input = JSON.parse(child.stdin.read().toString());
    frame({ type: 'result', path: input.artifactPath });
    child.emit('close');
    await expect(pending).resolves.toEqual({ path: input.artifactPath });
  });
  it.each(['basic', 'cancel', 'retry', 'install'] as const)('never starts MSBuild on %s', async (choice) => {
    options.ask = vi.fn().mockResolvedValue(choice);
    if (choice === 'basic') await expect(prepareDesktopCSharpIndex(request, options)).resolves.toEqual({ basic: true });
    else await expect(prepareDesktopCSharpIndex(request, options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects basic for strict requests before spawning', async () => {
    options.ask = vi.fn().mockResolvedValue('basic');
    await expect(prepareDesktopCSharpIndex({ ...request, fallback: false }, options)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('keeps progress visible until the installer finishes', async () => {
    options.ask = vi.fn().mockResolvedValueOnce('run').mockResolvedValueOnce('install');
    const pending = prepareDesktopCSharpIndex(request, options);
    await flush();
    frame({ type: 'prerequisites', message: 'Missing indexer', canInstall: true });
    await flush();
    expect(options.onProgress).toHaveBeenLastCalledWith('Downloading C# indexer…');
    frame({ type: 'install-progress', message: 'Downloading C# indexer: 3.0 of 18.0 MB' });
    expect(options.onProgress).toHaveBeenLastCalledWith('Downloading C# indexer: 3.0 of 18.0 MB');
    frame({ type: 'install-complete' });
    expect(options.onProgress).toHaveBeenLastCalledWith(undefined);
    frame({ type: 'result', basic: true });
    child.emit('close');
    await pending;
  });
  it('handles protocol errors and escalates an ignored SIGTERM', async () => {
    vi.useFakeTimers();
    const pending = prepareDesktopCSharpIndex(request, options);
    await flush();
    const rejected = expect(pending).rejects.toThrow('broken protocol');
    child.stdio[3].emit('error', new Error('broken protocol'));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close');
    await rejected;
  });
  it('bounds unattended compiler work and keeps build output out of the profile response', async () => {
    vi.useFakeTimers();
    const pending = prepareDesktopCSharpIndex(request, options);
    await flush();
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close');
    await rejected;
    const next = prepareDesktopCSharpIndex(request, options);
    await flush();
    const failed = expect(next).rejects.toThrow('See the analysis log');
    frame({ type: 'result', error: 'private build diagnostics' });
    child.emit('close');
    await failed;
    expect(options.onLog).toHaveBeenCalledWith('private build diagnostics');
  });
});
