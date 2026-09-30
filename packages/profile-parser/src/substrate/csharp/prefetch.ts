import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { csharpEnvironment, type CSharpTool } from './scip-tool.js';

const run = promisify(execFile);

export interface MSBuildProject {
  path: string;
  /** The project file's own text. */
  text: string;
  /** Directory.Build/Packages props and targets that MSBuild imports for it. */
  shared: string[];
  /** Resolved ProjectReference paths. */
  references: string[];
}

// MSBuild accepts either quote style around attribute values.
const attribute = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
    .exec(tag)
    ?.slice(1)
    .find((v) => v !== undefined);
// A literal NuGet version or range; anything built from MSBuild properties is left to the isolated restore.
const literal = (value: string | undefined) => (value && !/[$@%]/.test(value) ? value.trim() : undefined);

function references(text: string): { id: string; version?: string }[] {
  const found: { id: string; version?: string }[] = [];
  for (const match of text.matchAll(/<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi)) {
    const id = attribute(match[1]!, 'Include') ?? attribute(match[1]!, 'Update');
    if (!id || /[$@%]/.test(id)) continue;
    const version = literal(
      attribute(match[1]!, 'Version') ?? /<Version>([^<]*)<\/Version>/i.exec(match[2] ?? '')?.[1],
    );
    found.push({ id, ...(version ? { version } : {}) });
  }
  return found;
}

function frameworks(text: string): string[] {
  return [...text.matchAll(/<TargetFrameworks?>([^<]*)<\/TargetFrameworks?>/gi)].flatMap((match) =>
    match[1]!
      .split(';')
      .map((value) => value.trim())
      // Platform TFMs (net10.0-windows, -android) need workloads the host may lack.
      .filter((tfm) => /^(net\d+\.\d+|netstandard\d\.\d|netcoreapp\d\.\d)$/.test(tfm)),
  );
}

function ownPackages(project: MSBuildProject): Map<string, { id: string; version: string }> {
  const central = new Map<string, string>();
  for (const text of project.shared)
    for (const match of text.matchAll(/<PackageVersion\b[^>]*>/gi)) {
      const id = attribute(match[0], 'Include') ?? attribute(match[0], 'Update');
      const version = literal(attribute(match[0], 'Version'));
      if (id && version) central.set(id.toLowerCase(), version);
    }
  const packages = new Map<string, { id: string; version: string }>();
  for (const { id, version } of [project.text, ...project.shared].flatMap(references)) {
    const resolved = version ?? central.get(id.toLowerCase());
    if (resolved && !packages.has(id.toLowerCase())) packages.set(id.toLowerCase(), { id, version: resolved });
  }
  return packages;
}

/**
 * One restore plan per project and framework, mirroring that project's own graph:
 * its packages first, then those flowing in through ProjectReferences (nearest wins),
 * so transitive versions resolve exactly as the real restore will.
 */
export function prefetchPlans(
  projects: MSBuildProject[],
): { framework: string; packages: { id: string; version: string }[] }[] {
  const byPath = new Map(projects.map((project) => [project.path, project]));
  const plans = new Map<string, { framework: string; packages: { id: string; version: string }[] }>();
  for (const project of projects) {
    const merged = new Map<string, { id: string; version: string }>();
    const seen = new Set<string>();
    const queue = [project];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next.path)) continue;
      seen.add(next.path);
      for (const [key, value] of ownPackages(next)) if (!merged.has(key)) merged.set(key, value);
      queue.push(...next.references.flatMap((path) => byPath.get(path) ?? []));
    }
    if (!merged.size) continue;
    const tfms = frameworks(project.text);
    for (const framework of tfms.length ? tfms : project.shared.flatMap(frameworks)) {
      const packages = [...merged.values()].sort((x, y) => x.id.localeCompare(y.id));
      plans.set(JSON.stringify([framework, packages]), { framework, packages });
    }
  }
  return [...plans.values()];
}

/** Selected projects, their ProjectReference closure, and the Directory.* files MSBuild imports for each. */
export function projectClosure(snapshot: string, selected: string[]): MSBuildProject[] {
  const pending: string[] = [];
  for (const entry of selected.map((path) => join(snapshot, path))) {
    if (/\.csproj$/i.test(entry)) pending.push(entry);
    else if (existsSync(entry))
      for (const match of readFileSync(entry, 'utf8').matchAll(/["']([^"']+\.csproj)["']/gi))
        pending.push(resolve(dirname(entry), match[1]!.replace(/\\/g, '/')));
  }
  const seen = new Set<string>();
  const projects: MSBuildProject[] = [];
  while (pending.length) {
    const project = pending.pop()!;
    if (seen.has(project) || relative(snapshot, project).startsWith('..') || !existsSync(project)) continue;
    seen.add(project);
    const text = readFileSync(project, 'utf8');
    const references = [...text.matchAll(/<ProjectReference\b[^>]*\bInclude\s*=\s*["']([^"']+)["']/gi)].map((match) =>
      resolve(dirname(project), match[1]!.replace(/\\/g, '/')),
    );
    pending.push(...references);
    const shared: string[] = [];
    for (
      let directory = dirname(project);
      !relative(snapshot, directory).startsWith('..');
      directory = dirname(directory)
    ) {
      for (const name of ['Directory.Build.props', 'Directory.Packages.props', 'Directory.Build.targets'])
        if (existsSync(join(directory, name))) shared.push(readFileSync(join(directory, name), 'utf8'));
      if (directory === snapshot) break;
    }
    projects.push({ path: project, text, shared, references });
  }
  return projects;
}

/**
 * macOS Seatbelt keeps Security.framework, and with it .NET TLS, out of the analysis
 * sandbox, so a cold NuGet cache cannot be filled from inside it. Download the literally
 * declared packages through coredoc-generated projects on the host instead; repository
 * MSBuild is never evaluated here. The isolated restore then resolves from the shared cache.
 * Best effort: anything missed still fails the isolated restore exactly as before.
 */
export async function prefetchCSharpPackages(
  tool: Pick<CSharpTool, 'dotnet' | 'sdkRoot' | 'cacheRoot'>,
  work: string,
  projects: MSBuildProject[],
  signal?: AbortSignal,
  onLog?: (text: string) => void,
): Promise<void> {
  const env = csharpEnvironment(tool, join(work, 'prefetch-home'));
  for (const [index, { framework, packages }] of prefetchPlans(projects).entries()) {
    const directory = join(work, 'prefetch', String(index));
    mkdirSync(directory, { recursive: true });
    const project = join(directory, 'prefetch.csproj');
    writeFileSync(
      project,
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup>',
        `    <TargetFramework>${framework}</TargetFramework>`,
        '    <NuGetAudit>false</NuGetAudit>',
        '    <NoWarn>NU1605;NU1608;NU1701;NU1603;NU1510</NoWarn>',
        '  </PropertyGroup>',
        '  <ItemGroup>',
        ...packages.map(
          ({ id, version }) =>
            `    <PackageReference Include="${xmlAttribute(id)}" Version="${xmlAttribute(version)}" />`,
        ),
        '  </ItemGroup>',
        '</Project>',
        '',
      ].join('\n'),
    );
    try {
      await run(
        tool.dotnet,
        ['restore', project, '-p:ImportDirectoryBuildProps=false', '-p:ImportDirectoryBuildTargets=false'],
        { cwd: directory, env, signal, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      const output = (error as { stdout?: string }).stdout ?? String(error);
      onLog?.(`[coredoc] C# package prefetch incomplete (${framework}): ${output.slice(0, 2000)}\n`);
    }
  }
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
