import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prefetchPlans, projectClosure, type MSBuildProject } from './prefetch.js';

const project = (path: string, text: string, shared: string[] = [], references: string[] = []): MSBuildProject => ({
  path,
  text,
  shared,
  references,
});

describe('C# package prefetch declarations', () => {
  it('plans each project with its own versions first, then its references, per framework', () => {
    const web = `<Project Sdk="Microsoft.NET.Sdk.Web">
      <PropertyGroup><TargetFrameworks>net10.0;net10.0-windows;$(Extra)</TargetFrameworks></PropertyGroup>
      <ItemGroup>
        <PackageReference Include="Polly" Version="8.6.4" />
        <PackageReference Version="1.2.3" Include="Refit" />
        <PackageReference Include="Quartz"><Version>3.13.1</Version></PackageReference>
        <PackageReference Include="AutoMapper" />
        <PackageReference Include="Computed" Version="$(ComputedVersion)" />
      </ItemGroup></Project>`;
    const central = `<Project><ItemGroup><PackageVersion Include="AutoMapper" Version="15.0.1" /></ItemGroup></Project>`;
    const legacy = `<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>
      <ItemGroup><PackageReference Include="Polly" Version="7.2.4" /></ItemGroup></Project>`;
    expect(prefetchPlans([project('/web', web, [central], ['/legacy']), project('/legacy', legacy)])).toEqual([
      {
        framework: 'net10.0',
        packages: [
          { id: 'AutoMapper', version: '15.0.1' },
          { id: 'Polly', version: '8.6.4' },
          { id: 'Quartz', version: '3.13.1' },
          { id: 'Refit', version: '1.2.3' },
        ],
      },
      { framework: 'net9.0', packages: [{ id: 'Polly', version: '7.2.4' }] },
    ]);
  });

  it('reads single-quoted MSBuild attributes', () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-prefetch-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write(
        'Directory.Packages.props',
        "<Project><ItemGroup><PackageVersion Include='Refit' Version='8.0.0' /></ItemGroup></Project>",
      );
      write('App.slnx', "<Solution><Project Path='Api/Api.csproj' /></Solution>");
      write(
        'Api/Api.csproj',
        "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include='../Lib/Lib.csproj' /><PackageReference Include='Refit' /></ItemGroup></Project>",
      );
      write(
        'Lib/Lib.csproj',
        "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include='Polly' Version='8.6.4' /></ItemGroup></Project>",
      );
      expect(prefetchPlans(projectClosure(root, ['App.slnx']))).toEqual([
        {
          framework: 'net10.0',
          packages: [
            { id: 'Polly', version: '8.6.4' },
            { id: 'Refit', version: '8.0.0' },
          ],
        },
        { framework: 'net10.0', packages: [{ id: 'Polly', version: '8.6.4' }] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows the selected solution and project references, never unrelated projects', () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-prefetch-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write(
        'Directory.Build.props',
        '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
      );
      write('App.slnx', '<Solution><Project Path="Api/Api.csproj" /></Solution>');
      write(
        'Api/Api.csproj',
        '<Project><ItemGroup><ProjectReference Include="..\\Lib\\Lib.csproj" /></ItemGroup></Project>',
      );
      write(
        'Lib/Lib.csproj',
        '<Project><ItemGroup><PackageReference Include="Polly" Version="8.6.4" /></ItemGroup></Project>',
      );
      write(
        'Other/Other.csproj',
        '<Project><ItemGroup><PackageReference Include="Unrelated" Version="1.0.0" /></ItemGroup></Project>',
      );
      expect(prefetchPlans(projectClosure(root, ['App.slnx']))).toEqual([
        { framework: 'net10.0', packages: [{ id: 'Polly', version: '8.6.4' }] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
