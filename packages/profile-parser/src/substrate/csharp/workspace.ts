import { gitListFiles } from '../../facts/discovery/git-files.js';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_IGNORE_DIRS, isDefaultIgnored } from '../../facts/discovery/ignore.js';
import { outsideSource, runIsolatedProcess, type IsolatedProcessOptions } from '../../facts/scip/isolated-process.js';
export { outsideSource } from '../../facts/scip/isolated-process.js';
export type ProcessOptions = Omit<IsolatedProcessOptions, 'label' | 'macPolicy'>;

/** This runs on the trusted host: Git must not execute a checkout's fsmonitor hook. */
export function listCSharpWorkspaceFiles(root: string): string[] {
  const gitFiles = gitListFiles(root);
  if (gitFiles) return gitFiles.filter((file) => !isDefaultIgnored(file));
  const files: string[] = [];
  const stack = [''];
  while (stack.length) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const file = directory ? `${directory}/${entry.name}` : entry.name;
      if (isDefaultIgnored(file) || DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`C# indexing does not follow source symbolic links: ${file}`);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  return files;
}

/** MSBuild creates intermediate files even during restore; never give it the source checkout. */
export function copyCSharpWorkspace(repoRoot: string, workDir: string): string {
  const root = realpathSync(repoRoot);
  const snapshot = join(outsideSource(root, workDir), 'source');
  mkdirSync(snapshot, { recursive: true });
  for (const file of listCSharpWorkspaceFiles(root)) {
    const parts = file.split(/[\\/]/);
    if (parts.some((p) => ['bin', 'obj', '.git', 'node_modules'].includes(p))) continue;
    if (parts.some((p) => /^\.env(?:\.|$)/.test(p) || ['.npmrc', '.netrc', '.git-credentials', '.pypirc'].includes(p)))
      continue;
    if (file.endsWith('.scip')) continue;
    // Check every component: a directory symlink is just as dangerous as a file symlink.
    let source = root;
    let missing = false;
    for (const part of parts) {
      source = join(source, part);
      const entry = lstatSync(source, { throwIfNoEntry: false });
      if (!entry) {
        missing = true;
        break;
      }
      if (entry.isSymbolicLink()) throw new Error(`C# indexing does not follow source symbolic links: ${file}`);
    }
    if (missing) continue;
    if (!lstatSync(source).isFile()) continue;
    const destination = join(snapshot, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return snapshot;
}

export function runCSharpProcess(command: string, args: string[], options: ProcessOptions): Promise<string> {
  const writeRoots = [...options.writeRoots];
  if (process.platform === 'darwin') {
    // CoreCLR uses these coordination directories independently of TMPDIR.
    for (const name of ['.dotnet', `.dotnet-uid${process.getuid!()}`]) {
      const dir = join('/private/tmp', name);
      if (options.sourceRoot) outsideSource(options.sourceRoot, dir);
      mkdirSync(dir, { recursive: true });
      writeRoots.push(dir);
    }
  }
  return runIsolatedProcess(command, args, {
    ...options,
    writeRoots,
    label: 'C#',
    // Roslyn's build host ignores TMPDIR for GUID-named Unix sockets.
    macPolicy: [
      '(allow file-read* file-write* (regex #"^/private/tmp/[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$"))',
      // CoreCLR creates the coordination directories via mkdtemp("<dir>.XXXXXX") + rename.
      '(allow file-read* file-write* (regex #"^/private/tmp/\\.dotnet(-uid[0-9]+)?\\.[A-Za-z0-9]+(/|$)"))',
      '(allow network-bind network-inbound (local unix-socket (path-regex #"^(/private)?/tmp/[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$")))',
      '(allow network-outbound (remote unix-socket (path-regex #"^(/private)?/tmp/[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$")))',
    ],
  });
}
