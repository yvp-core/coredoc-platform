import * as systemTools from '../../facts/scip/system-tools.js';
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyCSharpWorkspace, runCSharpProcess } from './workspace.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'coredoc-csharp-isolation-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('C# compiler process completion', () => {
  it.each([
    false,
    true,
  ])('drains diagnostics after exit without killing the exited process (cancel: %s)', async (cancel) => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(systemTools, 'systemToolPath').mockReturnValue('/usr/bin/bwrap');
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const controller = new AbortController();
    const work = temp();
    const result = runCSharpProcess('test-compiler', [], {
      cwd: work,
      writeRoots: [work],
      readRoots: [],
      timeoutMs: 50,
      signal: controller.signal,
      failOnOutput: /build failed/,
    });
    const assertion = expect(result).rejects.toThrow(cancel ? 'Cancelled after exit' : 'reported a build/index error');
    child.emit('exit', 0);
    // Output already in transit may arrive after the parent exit event.
    child.stderr.write('build failed');
    if (cancel) controller.abort(new Error('Cancelled after exit'));
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it('still terminates a running compiler at its deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(systemTools, 'systemToolPath').mockReturnValue('/usr/bin/bwrap');
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const work = temp();
    const result = runCSharpProcess('test-compiler', [], {
      cwd: work,
      writeRoots: [work],
      readRoots: [],
      timeoutMs: 50,
    });
    const assertion = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    child.emit('exit', null);
    child.emit('close', null);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('C# indexing source isolation', () => {
  it.skipIf(process.platform !== 'darwin')(
    'finishes a successful process whose descendant keeps stdout open without reporting a timeout',
    async () => {
      const work = temp();
      const script = join(work, 'parent.cjs');
      writeFileSync(
        script,
        `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', "setTimeout(() => {}, 3500)"], {
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        child.unref();
        process.stdout.write('index complete\\n');
      `,
      );
      await expect(
        runCSharpProcess(process.execPath, [script], {
          cwd: work,
          writeRoots: [work],
          readRoots: [process.execPath, work],
          timeoutMs: 2500,
        }),
      ).resolves.toContain('index complete');
    },
  );

  it.skipIf(process.platform !== 'darwin')('streams progress and cancels an isolated process', async () => {
    const work = temp();
    const script = join(work, 'wait.cjs');
    writeFileSync(script, "process.stdout.write('ready'); setInterval(() => {}, 1000);");
    const controller = new AbortController();
    let output = '';
    await expect(
      runCSharpProcess(process.execPath, [script], {
        cwd: work,
        writeRoots: [work],
        readRoots: [process.execPath, work],
        signal: controller.signal,
        onLog(text) {
          output += text;
          if (output.includes('ready')) controller.abort(new Error('Analysis cancelled'));
        },
      }),
    ).rejects.toThrow('Analysis cancelled');
    expect(output).toContain('ready');
  });
  it('does not execute repository fsmonitor hooks while preparing the trusted source copy', () => {
    const source = temp();
    execFileSync('git', ['init', '--quiet', source]);
    writeFileSync(join(source, 'App.csproj'), '<Project/>');
    writeFileSync(join(source, '.gitignore'), 'ignored.cs\n');
    writeFileSync(join(source, 'ignored.cs'), 'class Ignored {}');
    const hook = join(source, '.git', 'fsmonitor-hook');
    writeFileSync(hook, '#!/bin/sh\ntouch hook-ran\nprintf "1\\0"\n');
    chmodSync(hook, 0o755);
    execFileSync('git', ['-C', source, 'config', 'core.fsmonitor', hook]);
    expect(enumerateRepoFiles(source)).toContain('App.csproj');
    const snapshot = copyCSharpWorkspace(source, temp());
    expect(existsSync(join(source, 'hook-ran'))).toBe(false);
    expect(existsSync(join(snapshot, 'App.csproj'))).toBe(true);
    expect(existsSync(join(snapshot, 'ignored.cs'))).toBe(false);
  });

  it('copies current source and build inputs without linking files or including generated/credential files', () => {
    const source = temp();
    const work = temp();
    writeFileSync(join(source, 'App.csproj'), '<Project/>');
    writeFileSync(join(source, 'Code.cs'), 'class Current {}');
    writeFileSync(join(source, '.env'), 'PRIVATE=not-a-real-secret');
    mkdirSync(join(source, 'obj'));
    writeFileSync(join(source, 'obj/generated.cs'), 'class Generated {}');
    const snapshot = copyCSharpWorkspace(source, work);
    expect(readdirSync(snapshot).sort()).toEqual(['App.csproj', 'Code.cs']);
    writeFileSync(join(snapshot, 'Code.cs'), 'changed in copy');
    expect(readFileSync(join(source, 'Code.cs'), 'utf8')).toBe('class Current {}');
  });

  it('refuses a workspace inside the source root and a source link instead of writing through it', () => {
    const source = temp();
    expect(() => copyCSharpWorkspace(source, join(source, 'cache'))).toThrow(/outside/);
    const outside = temp();
    writeFileSync(join(outside, 'Code.cs'), 'class Other {}');
    symlinkSync(join(outside, 'Code.cs'), join(source, 'Code.cs'));
    expect(() => copyCSharpWorkspace(source, temp())).toThrow(/symbolic link/);
  });

  it.skipIf(process.platform !== 'darwin')(
    'allows build output only in the workspace, including on a failed process',
    async () => {
      const source = temp();
      const work = temp();
      writeFileSync(join(source, 'Code.cs'), 'original');
      const sourceNames = readdirSync(source);
      const script = join(work, 'attempt.cjs');
      writeFileSync(
        script,
        `const fs=require('node:fs');fs.writeFileSync('index.scip','output');fs.writeFileSync(${JSON.stringify(join(source, 'Code.cs'))},'wrong');`,
      );
      await expect(
        runCSharpProcess(process.execPath, [script], {
          cwd: work,
          writeRoots: [work],
          readRoots: [process.execPath, work],
        }),
      ).rejects.toThrow(/Code\.cs/);
      expect(readFileSync(join(work, 'index.scip'), 'utf8')).toBe('output');
      expect(readFileSync(join(source, 'Code.cs'), 'utf8')).toBe('original');
      expect(readdirSync(source)).toEqual(sourceNames);
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'rejects an indexer that logs failure then exits successfully after long output',
    async () => {
      const work = temp();
      const script = join(work, 'failure.cjs');
      writeFileSync(script, "process.stdout.write('fail: project could not be loaded\\n' + 'x'.repeat(256 * 1024));");
      await expect(
        runCSharpProcess(process.execPath, [script], {
          cwd: work,
          writeRoots: [work],
          readRoots: [process.execPath, work],
          failOnOutput: /fail:/,
        }),
      ).rejects.toThrow(/reported a build\/index error/);
    },
  );
});
