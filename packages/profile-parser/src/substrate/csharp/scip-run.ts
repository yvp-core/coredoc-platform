import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveCoredocHome } from '@coredoc/core/utils';
import { loadScip, type LoadedScip } from '../../facts/scip/decode.js';
import { csharpEnvironment, findCSharpTool } from './scip-tool.js';
import { copyCSharpWorkspace, listCSharpWorkspaceFiles, outsideSource, runCSharpProcess } from './workspace.js';
import { prefetchCSharpPackages, projectClosure } from './prefetch.js';
import type { CSharpReceiverType } from './receiver-types.js';
export { installCSharpTool, installedCSharpTool } from './scip-install.js';

interface CSharpIndexManifest {
  cacheKey?: string;
  repoRoot: string;
  sourceHashes: Record<string, string>;
  receiverTypes?: CSharpReceiverType[];
}

interface CSharpIndex {
  index: LoadedScip;
  manifest: CSharpIndexManifest;
}

export function readCSharpIndex(repoRoot: string, indexPath: string): CSharpIndex {
  const manifest = JSON.parse(readFileSync(`${indexPath}.json`, 'utf8'));
  if (manifest.repoRoot !== realpathSync(repoRoot) || !manifest.sourceHashes) {
    throw new Error('The prepared C# index belongs to a different source repository.');
  }
  const index = loadScip(indexPath);
  if (!index.documents.length || index.lenientUtf8)
    throw new Error('C# semantic index is empty or contains invalid strings.');
  return { index, manifest };
}

/** One C# target shares an index across all selected projects. No command uses repoRoot as cwd. */
export async function prepareCSharpIndex(
  repoRoot: string,
  projects: string[],
  outDir?: string,
  defines: string[] = [],
  artifactPath?: string,
): Promise<CSharpIndex> {
  const sourceRoot = realpathSync(repoRoot);
  if (artifactPath) outsideSource(sourceRoot, artifactPath);
  if (defines.some((value) => !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(value)))
    throw new Error('C# defines must be preprocessor identifiers.');
  const tool = findCSharpTool(sourceRoot);
  if (defines.length && !tool.supportsDefines) throw new Error(DEFINES_UNSUPPORTED);
  if (!projects.length) throw new Error('C# indexing requires at least one project or solution.');
  const projectList = projects.every((project) => project.endsWith('.csproj'));
  if (!projectList && projects.length !== 1)
    throw new Error('C# indexing accepts one solution or a list of .csproj files.');
  for (const project of projects) {
    const rel = relative(sourceRoot, resolve(sourceRoot, project));
    if (isAbsolute(project) || rel.startsWith('..') || !/\.(csproj|sln|slnx)$/.test(project))
      throw new Error('C# indexing projects must be repository-relative .csproj, .sln or .slnx paths.');
  }
  const outputRoot = outsideSource(
    sourceRoot,
    outDir ??
      join(resolveCoredocHome(), 'scip', createHash('sha256').update(sourceRoot).digest('hex').slice(0, 16), 'csharp'),
  );
  mkdirSync(outputRoot, { recursive: true });
  // SIGKILL cannot execute finally. Reclaim only runs whose recorded owner is
  // gone; another live parse's source snapshot must remain untouched.
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    const owner = /^run-([1-9]\d*)-/.exec(entry.name);
    if (!entry.isDirectory() || !owner) continue;
    try {
      process.kill(Number(owner[1]), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        rmSync(join(outputRoot, entry.name), { recursive: true, force: true });
    }
  }
  const work = mkdtempSync(join(outputRoot, `run-${process.pid}-`));
  const controller = new AbortController();
  const cancel = (signal: string) =>
    controller.abort(new DOMException(`C# analysis cancelled by ${signal}`, 'AbortError'));
  const interrupt = () => cancel('SIGINT');
  const terminate = () => cancel('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    const snapshot = copyCSharpWorkspace(sourceRoot, work);
    // MSBuild inputs include imported props/targets, configs and lockfiles, not
    // just .cs/.csproj. Hash the complete copied input to avoid stale bindings.
    const inputHash = createHash('sha256').update(
      JSON.stringify({
        format: 3,
        projects: [...projects].sort(),
        defines: [...defines].sort(),
        tool: tool.fingerprint,
      }),
    );
    for (const file of listCSharpWorkspaceFiles(snapshot).sort()) {
      const bytes = readFileSync(join(snapshot, file));
      inputHash.update(JSON.stringify([file, bytes.length])).update(bytes);
    }
    const cacheKey = inputHash.digest('hex');
    const destination = join(outputRoot, `${cacheKey}.index`);
    if (existsSync(destination)) {
      try {
        const cached = readCSharpIndex(sourceRoot, join(destination, 'index.scip'));
        if (cached.manifest.cacheKey === cacheKey) {
          if (artifactPath) {
            copyFileSync(join(destination, 'index.scip'), artifactPath);
            writeFileSync(`${artifactPath}.json`, JSON.stringify(cached.manifest));
          }
          return cached;
        }
      } catch {
        // Corruption or a concurrent prune naturally heals through a fresh index.
      }
      rmSync(destination, { recursive: true, force: true });
    }
    const sourceHashes = Object.fromEntries(
      listCSharpWorkspaceFiles(snapshot)
        .filter((file) => file.endsWith('.cs'))
        .map((file) => [
          file,
          createHash('sha256')
            .update(readFileSync(join(snapshot, file)))
            .digest('hex'),
        ]),
    );
    for (const project of projects)
      if (!existsSync(join(snapshot, project)))
        throw new Error(`C# project is absent from the isolated source snapshot: ${project}`);
    let indexProjects = projects.map((project) => join(snapshot, project));
    if (projectList) {
      // Opening App.csproj then its referenced Library.csproj separately makes
      // MSBuildWorkspace throw "already part of the workspace". One solution
      // also ensures every selected project contributes definitions to the index.
      const solution = join(snapshot, `.coredoc-${randomUUID()}.sln`);
      const entries = [...new Set(projects)].map((project) => {
        if (/["\r\n]/.test(project)) throw new Error('C# project paths cannot contain quotes or newlines.');
        return `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${project}", "${project}", "{${randomUUID().toUpperCase()}}"\nEndProject`;
      });
      writeFileSync(
        solution,
        ['Microsoft Visual Studio Solution File, Format Version 12.00', ...entries, 'Global', 'EndGlobal', ''].join(
          '\n',
        ),
      );
      indexProjects = [solution];
    }
    const processOptions = {
      signal: controller.signal,
      cwd: snapshot,
      sourceRoot,
      writeRoots: [work, tool.cacheRoot],
      readRoots: [tool.sdkRoot, tool.directory],
      onLog: (text: string) => {
        process.stderr.write(text);
      },
      // Audit/pruning advisories do not change symbol binding, but MSBuildWorkspace
      // reports them as load failures. NU1510 only names redundant framework packages;
      // suppress that advisory in this disposable analysis, retaining other diagnostics.
      env: {
        ...csharpEnvironment(tool, work),
        NuGetAudit: 'false',
        NoWarn: 'NU1510',
        COREDOC_CSHARP_RECEIVER_TYPES: join(work, 'receiver-types.jsonl'),
        COREDOC_CSHARP_SNAPSHOT: snapshot,
      },
    };
    // macOS: the sandbox cannot reach NuGet over TLS (see prefetch.ts); restore offline
    // from the prefetched cache, which doubles as a local feed for range lookups.
    const offline = process.platform === 'darwin';
    if (offline)
      await prefetchCSharpPackages(
        tool,
        work,
        projectClosure(snapshot, projects),
        controller.signal,
        processOptions.onLog,
      );
    // The indexer can return exit 0 after a failed restore. Run restore ourselves
    // with an explicit project, then disallow its implicit cwd-based restore.
    for (const project of projects) {
      await runCSharpProcess(
        tool.dotnet,
        [
          'restore',
          join(snapshot, project),
          '-m:1',
          '-p:UseSharedCompilation=false',
          '--disable-build-servers',
          ...(defines.length ? [`-p:DefineConstants=${defines.join('%3B')}`] : []),
          ...(offline ? ['--source', join(tool.cacheRoot, 'nuget')] : []),
        ],
        { ...processOptions, allowNetwork: !offline },
      );
    }
    const index = join(work, 'index.scip');
    await runCSharpProcess(
      tool.command,
      [
        ...tool.args,
        'index',
        ...indexProjects,
        '--working-directory',
        snapshot,
        '--output',
        index,
        '--skip-dotnet-restore',
        ...defines.flatMap((symbol) => ['--define', symbol]),
      ],
      { ...processOptions, failOnOutput: /\bfail:|\berror (?:CS|MSB|NU)\d+|\bSkipping document\b/i },
    );
    const loaded = loadScip(index);
    if (!loaded.documents.length || loaded.lenientUtf8)
      throw new Error('C# semantic index is empty or contains invalid strings.');
    const staged = join(work, 'complete');
    mkdirSync(staged);
    copyFileSync(index, join(staged, 'index.scip'));
    const receiverTypes: CSharpReceiverType[] = (
      existsSync(join(work, 'receiver-types.jsonl')) ? readFileSync(join(work, 'receiver-types.jsonl'), 'utf8') : ''
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => JSON.parse(line))
      .filter((fact: CSharpReceiverType) => Object.hasOwn(sourceHashes, fact.file));
    const manifest: CSharpIndexManifest = {
      cacheKey,
      repoRoot: sourceRoot,
      sourceHashes,
      ...(existsSync(join(work, 'receiver-types.jsonl')) ? { receiverTypes } : {}),
    };
    writeFileSync(join(staged, 'index.scip.json'), JSON.stringify(manifest));
    if (artifactPath) {
      copyFileSync(index, artifactPath);
      writeFileSync(`${artifactPath}.json`, JSON.stringify(manifest));
    }
    try {
      // Publish index and manifest together. A concurrent writer of this same
      // immutable key may win; either parse already owns its complete result.
      renameSync(staged, destination);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    for (const entry of readdirSync(outputRoot)) {
      if (/^[a-f0-9]{64}\.(?:index|scip(?:\.json)?)$/.test(entry) && !entry.startsWith(cacheKey))
        rmSync(join(outputRoot, entry), { recursive: true, force: true });
    }
    // Returning decoded data avoids a path lease: pruning cannot invalidate a
    // result already handed to another parse.
    return { index: loaded, manifest };
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    rmSync(work, { recursive: true, force: true });
  }
}

const DEFINES_UNSUPPORTED =
  'This scip-dotnet does not support profile defines. Run coredoc tools install csharp or use basic analysis.';
/** Discovery executes no repository code and never installs missing tools. */
export function checkCSharpPrerequisites(repoRoot: string, defines: string[] = []): string | undefined {
  try {
    const tool = findCSharpTool(repoRoot);
    if (defines.length && !tool.supportsDefines) return DEFINES_UNSUPPORTED;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
