import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { csharpProvider } from '../../providers/csharp.js';
import type { CSharpProfile } from '../../types/csharp-profile.js';
import * as indexing from './scip-run.js';
import * as discovery from '../../facts/discovery/discover.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function source() {
  const root = mkdtempSync(join(tmpdir(), 'coredoc-csharp-optional-'));
  roots.push(root);
  writeFileSync(join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
  writeFileSync(join(root, 'App.cs'), 'class Worker { void Run() { Save(); } void Save() {} }');
  return root;
}
const profile: CSharpProfile = {
  parserId: 'optional-csharp',
  substrate: { language: 'csharp', include: ['**/*.cs'] },
};

function removeCompilerToolsFromPath(root: string) {
  // These tests exercise optional compiler setup, not failed Git discovery. Enumerate the real
  // fixture first so clearing PATH removes SDK/indexers without masking a Git operational error.
  const files = discovery.enumerateRepoFiles(root);
  vi.spyOn(discovery, 'enumerateRepoFiles').mockReturnValue(files);
  vi.stubEnv('PATH', '');
}

describe('C# optional compiler analysis', () => {
  it('uses the desktop basic default without probing compiler tools', async () => {
    vi.stubEnv('COREDOC_CSHARP_DEFAULT_MODE', 'basic');
    const prepare = vi.spyOn(indexing, 'prepareCSharpIndex');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const graph = await csharpProvider.parse(profile, { repoRoot: source(), repoName: 'desktop' });
    expect(prepare).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(graph.calls.filter((call) => call.calleeId)).toHaveLength(1);
    expect(graph.stats.analysis).toEqual([
      { language: 'csharp', mode: 'basic', compilerReceiverTypes: false, fallback: false },
    ]);
  });
  it('preserves explicit strict enhanced despite the desktop basic default', async () => {
    vi.stubEnv('COREDOC_CSHARP_DEFAULT_MODE', 'basic');
    const prepare = vi.spyOn(indexing, 'prepareCSharpIndex').mockRejectedValue(new Error('Missing indexer'));
    await expect(
      csharpProvider.parse(
        { ...profile, substrate: { ...profile.substrate, analysis: { mode: 'enhanced', fallback: false } } },
        { repoRoot: source(), repoName: 'desktop-strict' },
      ),
    ).rejects.toThrow('Missing indexer');
    expect(prepare).toHaveBeenCalledOnce();
  });
  it('propagates cancellation instead of completing a basic fallback', async () => {
    const root = source();
    vi.spyOn(indexing, 'prepareCSharpIndex').mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(csharpProvider.parse(profile, { repoRoot: root, repoName: 'cancelled' })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(warning).not.toHaveBeenCalled();
  });
  it('does not request compiler indexing in explicit basic mode', async () => {
    const root = source();
    const prepare = vi.spyOn(indexing, 'prepareCSharpIndex');
    const graph = await csharpProvider.parse(
      { ...profile, substrate: { ...profile.substrate, analysis: { mode: 'basic' } } },
      { repoRoot: root, repoName: 'basic' },
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(graph.calls.filter((call) => call.calleeId)).toHaveLength(1);
    expect(graph.stats.analysis).toEqual([
      { language: 'csharp', mode: 'basic', compilerReceiverTypes: false, fallback: false },
    ]);
  });
  it('retains the basic graph after an indexer failure', async () => {
    const root = source();
    vi.spyOn(indexing, 'prepareCSharpIndex').mockRejectedValue(new Error('Indexer exited with 1'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const graph = await csharpProvider.parse(profile, { repoRoot: root, repoName: 'failed-indexer' });
    expect(graph.calls.filter((call) => call.calleeId)).toHaveLength(1);
    expect(graph.errors).toEqual([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('Indexer exited with 1') }),
    ]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(graph.stats.analysis).toEqual([
      { language: 'csharp', mode: 'basic', compilerReceiverTypes: false, fallback: true },
    ]);
  });
  it('parses and retains lexical calls without any SDK or indexer on PATH', async () => {
    const root = source();
    const cache = mkdtempSync(join(tmpdir(), 'coredoc-csharp-tools-'));
    roots.push(cache);
    vi.stubEnv('COREDOC_HOME', cache);
    removeCompilerToolsFromPath(root);
    vi.stubEnv('COREDOC_SCIP_DOTNET', '');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const graph = await csharpProvider.parse(profile, { repoRoot: root, repoName: 'optional' });
    const save = graph.functions.find((fn) => fn.name.includes('Save'))!;
    expect(save).toBeDefined();
    expect(graph.calls.some((call) => call.calleeId === save.id)).toBe(true);
    expect(graph.errors?.filter((error) => error.severity === 'error')).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toMatch(/C#.*basic.*(?:scip-dotnet|bubblewrap|Alpine|Windows)/i);
  });
});
