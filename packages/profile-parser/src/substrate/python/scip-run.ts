import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homebrewRuntimeReadRoots } from '../../facts/scip/homebrew-runtime.js';
import { runIndexer } from '../../facts/scip/indexer-shell.js';
import { runIsolatedProcess } from '../../facts/scip/isolated-process.js';
import { installedPythonTool, pythonScipPrereqs } from './scip-tool.js';

export async function runScipPython(
  repoRoot: string,
  options: { outDir?: string; signal?: AbortSignal; onLog?: (text: string) => void } = {},
) {
  return runIndexer(
    {
      degradePrefix: 'scip-python',
      outSubdir: 'python',
      prereqs: pythonScipPrereqs,
      // Pyright reads source/stubs without executing Python. Supplying an explicit empty package
      // environment also disables pip discovery; no venv activation or dependency installation occurs.
      inputs: (files) =>
        files.filter(
          (file) =>
            /\.pyi?$/.test(file) &&
            !file.split('/').some((p) => ['.venv', 'venv', 'site-packages', '__pycache__'].includes(p)),
        ),
      index: async (ctx) => {
        const tool = installedPythonTool(ctx.root)!;
        const environment = join(ctx.work, 'environment.json');
        writeFileSync(environment, '[]');
        const bin = join(ctx.work, 'bin');
        mkdirSync(bin);
        const index = join(ctx.work, 'index.scip');
        // Packaged Desktop runs Node through an Electron helper. Its shared framework and
        // resources live outside the executable directory and must remain readable by dyld.
        const resourcesPath: unknown = Reflect.get(process, 'resourcesPath');
        const runtimeRoots =
          process.versions.electron && typeof resourcesPath === 'string'
            ? [resourcesPath, resolve(resourcesPath, '../Frameworks')]
            : [];
        await runIsolatedProcess(
          process.execPath,
          [
            tool,
            'index',
            '--project-name',
            'coredoc-local',
            '--project-version',
            ctx.snapshot.hash,
            '--cwd',
            ctx.snapshot.root,
            '--output',
            index,
            '--environment',
            environment,
            '--quiet',
          ],
          {
            label: 'Python',
            cwd: ctx.snapshot.root,
            sourceRoot: ctx.root,
            readRoots: [
              dirname(process.execPath),
              dirname(tool),
              ...runtimeRoots,
              ...homebrewRuntimeReadRoots(process.execPath),
            ],
            writeRoots: [ctx.work],
            signal: ctx.signal,
            onLog: ctx.onLog,
            env: {
              // Pyright otherwise probes the system interpreter despite an explicit empty
              // package environment. This source-only mode uses its bundled type stubs.
              PATH: bin,
              HOME: ctx.work,
              TMPDIR: ctx.work,
              ELECTRON_RUN_AS_NODE: '1',
              PYTHONDONTWRITEBYTECODE: '1',
            },
          },
        );
        return index;
      },
    },
    repoRoot,
    options,
  );
}
