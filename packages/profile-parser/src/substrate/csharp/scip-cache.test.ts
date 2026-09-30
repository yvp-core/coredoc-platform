import { create, toBinary } from '@bufbuild/protobuf';
import { IndexSchema } from '@scip-code/scip';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareCSharpIndex } from './scip-run.js';
import * as tooling from './scip-tool.js';
import * as workspace from './workspace.js';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'coredoc-csharp-cache-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

it('cancels active compiler work on parent termination and removes its source copy', async () => {
  const root = temp();
  const cache = temp();
  writeFileSync(join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
  writeFileSync(join(root, 'App.cs'), 'class Worker {}');
  vi.spyOn(tooling, 'findCSharpTool').mockReturnValue({
    dotnet: '/tools/dotnet',
    sdkRoot: '/tools',
    command: '/tools/scip-dotnet',
    args: [],
    directory: '/tools',
    cacheRoot: temp(),
    fingerprint: 'cancel-tool',
  });
  const before = process.listeners('SIGTERM');
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  vi.spyOn(workspace, 'runCSharpProcess').mockImplementation(async (_command, _args, options) => {
    ready();
    if (!options.signal) throw new Error('No cancellation signal supplied');
    return new Promise((_resolve, reject) =>
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }),
    );
  });
  const parse = prepareCSharpIndex(root, ['App.csproj'], cache);
  const rejected = expect(parse).rejects.toMatchObject({ name: 'AbortError' });
  await started;
  const terminate = process.listeners('SIGTERM').find((listener) => !before.includes(listener));
  terminate?.('SIGTERM');
  await rejected;
  expect(terminate).toBeDefined();
  expect(process.listeners('SIGTERM')).toEqual(before);
  expect(readdirSync(cache).filter((name) => name.startsWith('run-'))).toEqual([]);
});

it('reuses the compiler index, invalidates imported build inputs and tool changes, and heals corruption', async () => {
  const root = temp();
  const cache = temp();
  const abandoned = join(cache, 'run-1234-abandoned');
  const active = join(cache, `run-${process.pid}-active`);
  mkdirSync(abandoned);
  mkdirSync(active);
  writeFileSync(join(abandoned, 'source.cs'), 'class PrivateSource {}');
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 1234 && signal === 0) throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    return kill(pid, signal);
  });
  writeFileSync(join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
  writeFileSync(join(root, 'App.cs'), 'class Worker {}');
  const tool = {
    dotnet: '/tools/dotnet',
    sdkRoot: '/tools',
    command: '/tools/scip-dotnet',
    args: [],
    directory: '/tools',
    cacheRoot: temp(),
    fingerprint: 'first-tool',
  };
  vi.spyOn(tooling, 'findCSharpTool').mockImplementation(() => tool);
  let indexes = 0;
  vi.spyOn(workspace, 'runCSharpProcess').mockImplementation(async (command, args) => {
    if (command === tool.command) {
      indexes++;
      const destination = args[args.indexOf('--output') + 1]!;
      writeFileSync(
        destination,
        toBinary(IndexSchema, create(IndexSchema, { documents: [{ relativePath: 'App.cs' }] })),
      );
    }
    return '';
  });
  const first = await prepareCSharpIndex(root, ['App.csproj'], cache);
  expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(active)).toBe(true);
  expect(first.manifest.receiverTypes).toBeUndefined();
  expect(await prepareCSharpIndex(root, ['App.csproj'], cache)).toEqual(first);
  expect(indexes).toBe(1);
  writeFileSync(
    join(root, 'Directory.Build.props'),
    '<Project><PropertyGroup><LangVersion>latest</LangVersion></PropertyGroup></Project>',
  );
  const changed = await prepareCSharpIndex(root, ['App.csproj'], cache);
  expect(changed.manifest.cacheKey).not.toBe(first.manifest.cacheKey);
  expect(readdirSync(cache).filter((name) => name.endsWith('.index'))).toHaveLength(1);
  expect(indexes).toBe(2);
  tool.fingerprint = 'updated-tool';
  const updated = await prepareCSharpIndex(root, ['App.csproj'], cache);
  expect(updated.manifest.cacheKey).not.toBe(changed.manifest.cacheKey);
  expect(indexes).toBe(3);
  writeFileSync(join(cache, `${updated.manifest.cacheKey}.index`, 'index.scip'), 'corrupt');
  expect(await prepareCSharpIndex(root, ['App.csproj'], cache)).toEqual(updated);
  expect(indexes).toBe(4);
});

it.each([
  false,
  true,
])('keeps concurrent readers valid when another result prunes their cache (same key: %s)', async (sameKey) => {
  const root = temp();
  const cache = temp();
  writeFileSync(join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
  writeFileSync(join(root, 'App.cs'), 'class Worker {}');
  vi.spyOn(tooling, 'findCSharpTool').mockReturnValue({
    dotnet: '/tools/dotnet',
    sdkRoot: '/tools',
    command: '/tools/scip-dotnet',
    args: [],
    directory: '/tools',
    cacheRoot: temp(),
    fingerprint: 'concurrent-tool',
  });
  const pending: (() => void)[] = [];
  vi.spyOn(workspace, 'runCSharpProcess').mockImplementation(async (command, args) => {
    if (command !== '/tools/scip-dotnet') return '';
    await new Promise<void>((resolve) => pending.push(resolve));
    writeFileSync(
      args[args.indexOf('--output') + 1]!,
      toBinary(
        IndexSchema,
        create(IndexSchema, {
          documents: [{ relativePath: 'App.cs' }],
        }),
      ),
    );
    return '';
  });
  const first = prepareCSharpIndex(root, ['App.csproj'], cache);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  if (!sameKey) writeFileSync(join(root, 'Directory.Build.props'), '<Project />');
  const second = prepareCSharpIndex(root, ['App.csproj'], cache);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[0]!();
  const reader = await first;
  pending[1]!();
  const replacement = await second;
  expect(reader.index.documents.map((document) => document.relativePath)).toEqual(['App.cs']);
  expect(reader.manifest.sourceHashes).toEqual(replacement.manifest.sourceHashes);
  expect(readdirSync(cache).filter((name) => name.startsWith('run-'))).toEqual([]);
  expect(await prepareCSharpIndex(root, ['App.csproj'], cache)).toEqual(replacement);
});

it('sends profile defines to both restore and the capable indexer, and refuses stock tools', async () => {
  const root = temp();
  const cache = temp();
  writeFileSync(join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
  writeFileSync(join(root, 'App.cs'), 'class Worker {}');
  const tool = {
    dotnet: '/tools/dotnet',
    sdkRoot: '/tools',
    command: '/tools/scip-dotnet',
    args: [],
    directory: '/tools',
    cacheRoot: temp(),
    fingerprint: 'defines-tool',
    supportsDefines: true,
  };
  vi.spyOn(tooling, 'findCSharpTool').mockReturnValue(tool);
  const run = vi.spyOn(workspace, 'runCSharpProcess').mockImplementation(async (command, args) => {
    if (command === tool.command)
      writeFileSync(
        args[args.indexOf('--output') + 1]!,
        toBinary(IndexSchema, create(IndexSchema, { documents: [{ relativePath: 'App.cs' }] })),
      );
    return '';
  });
  await prepareCSharpIndex(root, ['App.csproj'], cache, ['FEATURE_ONE', 'FEATURE_TWO']);
  expect(run.mock.calls[0]![1]).toContain('-p:DefineConstants=FEATURE_ONE%3BFEATURE_TWO');
  expect(run.mock.calls[1]![1].slice(-4)).toEqual(['--define', 'FEATURE_ONE', '--define', 'FEATURE_TWO']);
  run.mockClear();
  tool.supportsDefines = false;
  await expect(prepareCSharpIndex(root, ['App.csproj'], cache, ['FEATURE_ONE'])).rejects.toThrow(
    'does not support profile defines',
  );
  expect(run).not.toHaveBeenCalled();
  await expect(prepareCSharpIndex(root, ['App.csproj'], cache, ['FEATURE;Invalid'])).rejects.toThrow(
    'preprocessor identifiers',
  );
});
