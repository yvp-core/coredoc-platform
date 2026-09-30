import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, posix } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { Project } from './model.js';

const xml = new XMLParser({ ignoreAttributes: false, processEntities: false });
function array<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function hasBuildImports(root: string, projectPath: string, document: Record<string, unknown>): boolean {
  if (['Import', 'ImportGroup', 'Sdk', 'Choose', 'Target'].some((name) => document[name] !== undefined)) return true;
  if (
    array<unknown>(document.ItemGroup).some(
      (group) => group && typeof group === 'object' && 'PackageReference' in group,
    )
  )
    return true;
  const importProperties = [
    'DirectoryBuildPropsPath',
    'DirectoryBuildTargetsPath',
    'CustomBeforeMicrosoftCommonProps',
    'CustomAfterMicrosoftCommonProps',
    'CustomBeforeMicrosoftCommonTargets',
    'CustomAfterMicrosoftCommonTargets',
  ];
  if (
    array<unknown>(document.PropertyGroup).some(
      (group) => group && typeof group === 'object' && importProperties.some((name) => name in group),
    )
  )
    return true;

  // Build imports may be ignored by Git and still affect compilation. Check the actual project
  // ancestors, not the enumerated source list; a sibling project's customizations do not apply.
  for (let directory = dirname(projectPath); ; directory = dirname(directory)) {
    try {
      if (
        ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Build.rsp'].some((name) =>
          lstatSync(posix.join(root, directory, name), { throwIfNoEntry: false }),
        )
      )
        return true;
    } catch {
      return true; // Unreadable build configuration cannot justify inferred namespaces in basic mode.
    }
    if (directory === '.') return false;
  }
}

function sdkUsings(sdk: string, properties: Record<string, unknown>[]): Project['globalUsings'] {
  if (!['Microsoft.NET.Sdk', 'Microsoft.NET.Sdk.Web', 'Microsoft.NET.Sdk.Worker'].includes(sdk)) return [];
  const literal = (name: string): string | undefined => {
    const declarations = properties.filter((p) => name in p);
    if (declarations.some((p) => p['@_Condition'] || !['string', 'boolean'].includes(typeof p[name]))) return undefined;
    const value = declarations.at(-1)?.[name];
    return value === undefined ? undefined : String(value);
  };
  if (!['enable', 'true'].includes(literal('ImplicitUsings')?.toLowerCase() ?? '')) return [];
  const frameworks = (literal('TargetFramework') ?? literal('TargetFrameworks'))?.split(';') ?? [];
  // These imports are defined by Microsoft.NET.Sdk.CSharp.props. Restrict inference to
  // explicit modern .NET targets: conditional/imported MSBuild properties need the compiler.
  if (!frameworks.length || !frameworks.every((f) => /^net(?:[6-9]|[1-9]\d+)\.\d+(?:-|$)/.test(f.trim()))) return [];
  return [
    'System',
    'System.Collections.Generic',
    'System.IO',
    'System.Linq',
    'System.Net.Http',
    'System.Threading',
    'System.Threading.Tasks',
  ].map((name) => ({ name, static: false }));
}

export function readProjects(root: string, files: string[]): Project[] {
  return files
    .filter((f) => f.endsWith('.csproj'))
    .sort()
    .map((path) => {
      const document = xml.parse(readFileSync(posix.join(root, path), 'utf8')).Project;
      const properties = array<Record<string, string>>(document?.PropertyGroup);
      const groups = array<Record<string, unknown>>(document?.ItemGroup);
      const references: string[] = [];
      const dependencies: Record<string, string> = {};
      // Literal project properties are not evaluated MSBuild facts. Imported props/targets and
      // package build assets can change both the properties and the resulting Using items.
      const globalUsings = hasBuildImports(root, path, document ?? {})
        ? []
        : sdkUsings(document?.['@_Sdk'], properties);
      for (const group of groups) {
        for (const ref of array<Record<string, string>>(group.ProjectReference as Record<string, string> | undefined)) {
          if (ref['@_Include'])
            references.push(posix.normalize(posix.join(dirname(path), ref['@_Include'].replaceAll('\\', '/'))));
        }
        for (const ref of array<Record<string, string>>(group.PackageReference as Record<string, string> | undefined)) {
          if (ref['@_Include']) dependencies[ref['@_Include']] = ref['@_Version'] ?? ref.Version ?? '*';
        }
        for (const ref of array<Record<string, string>>(
          group.FrameworkReference as Record<string, string> | undefined,
        )) {
          if (ref['@_Include']) dependencies[ref['@_Include']] = '*';
        }
        for (const item of array<Record<string, string>>(group.Using as Record<string, string> | undefined)) {
          if (item['@_Remove']) {
            // A conditional removal may apply; abstaining is safer than assuming its namespace.
            const removed = item['@_Remove'].split(';').map((name) => name.trim());
            for (let i = globalUsings.length - 1; i >= 0; i--) {
              if (removed.some((name) => name.includes('*') || name.includes('?') || name === globalUsings[i]?.name))
                globalUsings.splice(i, 1);
            }
          }
          if (item['@_Include'])
            globalUsings.push({ name: item['@_Include'], alias: item['@_Alias'], static: item['@_Static'] === 'true' });
        }
      }
      return {
        sdk: document?.['@_Sdk'],
        path,
        directory: dirname(path),
        name: properties.find((p) => p.AssemblyName)?.AssemblyName ?? basename(path, '.csproj'),
        references,
        dependencies,
        globalUsings,
      };
    });
}

export function owningProject(file: string, projects: Project[]): Project | undefined {
  const candidates = projects.filter((p) => p.directory === '.' || file.startsWith(`${p.directory}/`));
  const max = Math.max(...candidates.map((p) => p.directory.length));
  const closest = candidates.filter((p) => p.directory.length === max);
  return closest.length === 1 ? closest[0] : undefined;
}
