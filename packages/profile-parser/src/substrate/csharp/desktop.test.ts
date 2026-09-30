import { describe, expect, it, vi } from 'vitest';
import { validateCSharpIndexRequest, withCSharpIndexHost } from './desktop.js';
import { csharpProvider } from '../../providers/csharp.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop C# compiler boundary', () => {
  it('refuses host paths and compiler option injection from the profile process', () => {
    for (const projects of [
      ['/tmp/App.csproj'],
      ['C:/App.csproj'],
      ['../App.csproj'],
      ['-p:Foo.csproj'],
      ['App.csproj\n'],
    ]) {
      expect(() => validateCSharpIndexRequest({ projects, defines: [], fallback: true })).toThrow();
    }
    expect(() => validateCSharpIndexRequest({ projects: ['App.csproj'], defines: ['X;Y'], fallback: true })).toThrow();
    expect(validateCSharpIndexRequest({ projects: ['src/App.csproj'], defines: ['DEBUG'], fallback: false })).toEqual({
      projects: ['src/App.csproj'],
      defines: ['DEBUG'],
      fallback: false,
    });
  });
  it('asks the host only for an active C# target and honors a basic choice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-csharp-desktop-'));
    try {
      writeFileSync(join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
      writeFileSync(join(root, 'App.cs'), 'class Worker { void Run() { Save(); } void Save() {} }');
      const host = vi.fn().mockResolvedValue({ basic: true });
      const profile = { parserId: 'desktop', substrate: { language: 'csharp' as const, include: ['**/*.cs'] } };
      const graph = await withCSharpIndexHost(host, () =>
        csharpProvider.parse(profile, { repoRoot: root, repoName: 'desktop' }),
      );
      expect(host).toHaveBeenCalledWith({ projects: ['App.csproj'], defines: [], fallback: true });
      expect(graph.calls.filter((call) => call.calleeId)).toHaveLength(1);
      expect(graph.stats.analysis?.[0]).toMatchObject({ mode: 'basic', fallback: false });
      host.mockClear();
      await withCSharpIndexHost(host, () =>
        csharpProvider.parse(
          { ...profile, substrate: { ...profile.substrate, analysis: { mode: 'basic' } } },
          { repoRoot: root, repoName: 'desktop' },
        ),
      );
      expect(host).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
