import { systemToolPath } from '../../facts/scip/system-tools.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveCoredocHome } from '@coredoc/core/utils';
import { outsideSource } from './workspace.js';
import { installedCSharpTool } from './scip-install.js';

export interface CSharpTool {
  dotnet: string;
  sdkRoot: string;
  command: string;
  args: string[];
  directory: string;
  cacheRoot: string;
  fingerprint: string;
  supportsDefines?: boolean;
}

function executable(name: string): string | undefined {
  const candidates = isAbsolute(name)
    ? [name]
    : [
        ...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute),
        join(homedir(), '.dotnet'),
        join(homedir(), '.dotnet', 'tools'),
        '/usr/local/share/dotnet',
        '/usr/local/bin',
        '/opt/homebrew/bin',
      ].map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // An absent/inaccessible PATH entry does not make the optional tier available.
    }
  }
  return undefined;
}

/** Discovery only: parsing never downloads, patches, compiles or installs tools. */
export function findCSharpTool(repoRoot: string): CSharpTool {
  if (process.platform === 'win32') throw new Error('C# enhanced analysis is not supported on Windows yet.');
  if (process.platform === 'linux') {
    if (existsSync('/etc/alpine-release'))
      throw new Error('C# enhanced analysis is unavailable in the Alpine CLI image.');
    systemToolPath('bwrap');
  } else if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('C# enhanced analysis requires macOS sandbox-exec or Linux bubblewrap.');
  }
  const explicit = process.env.COREDOC_SCIP_DOTNET?.trim();
  let indexer: string | undefined;
  if (explicit) {
    const candidate = resolve(explicit);
    if (candidate.endsWith('.dll') && existsSync(candidate)) indexer = realpathSync(candidate);
    else indexer = executable(candidate);
    if (!indexer) throw new Error('COREDOC_SCIP_DOTNET does not identify an available indexer.');
  } else indexer = installedCSharpTool(repoRoot) ?? executable('scip-dotnet');
  if (!indexer)
    throw new Error('scip-dotnet is not installed. Run coredoc tools install csharp, or choose basic analysis.');

  const dotnet = executable('dotnet');
  if (!dotnet) throw new Error('C# enhanced analysis requires a compatible .NET SDK on PATH.');
  outsideSource(repoRoot, dotnet);
  outsideSource(repoRoot, indexer);
  // Repository build targets may write their NuGet/home cache, never installed executable files.
  const cacheRoot = outsideSource(repoRoot, join(resolveCoredocHome(), 'cache', 'csharp'));
  let sdks: string;
  try {
    sdks = execFileSync(dotnet, ['--list-sdks'], {
      cwd: dirname(dotnet),
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('The .NET SDK could not be inspected.');
  }
  if (!/^\d+\.\S+\s+\[.+\]/m.test(sdks)) throw new Error('No .NET SDK is installed; a runtime alone is insufficient.');
  let supportsDefines = false;
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(indexer), 'coredoc-tool.json'), 'utf8'));
    supportsDefines = manifest.defines === true;
    if (manifest.runtime === 'net10.0' && !/^10\.\S+\s+\[.+\]/m.test(sdks))
      throw new Error('The Coredoc C# indexer requires .NET SDK 10. Install it separately or choose basic analysis.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const identity = createHash('sha256').update(sdks).update(indexer);
  for (const file of [
    ...new Set([
      indexer,
      ...readdirSync(dirname(indexer))
        .filter((name) => /\.(dll|json)$/.test(name))
        .map((name) => join(dirname(indexer), name)),
    ]),
  ].sort()) {
    identity.update(file).update(readFileSync(file));
  }
  return {
    dotnet,
    supportsDefines,
    sdkRoot: dirname(dotnet),
    command: indexer.endsWith('.dll') ? dotnet : indexer,
    args: indexer.endsWith('.dll') ? [indexer] : [],
    directory: dirname(indexer),
    cacheRoot,
    fingerprint: identity.digest('hex'),
  };
}

export function csharpEnvironment(tool: Pick<CSharpTool, 'sdkRoot' | 'cacheRoot'>, work: string): NodeJS.ProcessEnv {
  const home = join(work, 'home');
  const temporary = join(work, 'tmp');
  const packages = join(tool.cacheRoot, 'nuget');
  for (const path of [home, temporary, packages]) mkdirSync(path, { recursive: true });
  return {
    PATH: [tool.sdkRoot, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter),
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    DOTNET_ROOT: tool.sdkRoot,
    DOTNET_CLI_HOME: home,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_EnableDiagnostics: '0',
    // Index a disposable snapshot without subscribing to host filesystem events.
    DOTNET_USE_POLLING_FILE_WATCHER: '1',
    MSBUILDDISABLENODEREUSE: '1',
    NUGET_PACKAGES: packages,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  };
}
