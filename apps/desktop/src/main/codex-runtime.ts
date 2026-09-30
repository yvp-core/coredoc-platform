import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SystemCodexResolutionOptions {
  pathValue?: string;
  homeDir: string;
  platform?: NodeJS.Platform;
  systemBinDirs?: string[];
  probe?: (candidate: string) => boolean;
}

function isExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function buildSystemCodexEnvironment(baseEnv: NodeJS.ProcessEnv, executablePath: string): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const existingPathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const existingPath = existingPathKey ? env[existingPathKey] : undefined;
  if (existingPathKey) delete env[existingPathKey];
  env.PATH = [path.dirname(executablePath), existingPath].filter(Boolean).join(path.delimiter);
  return env;
}

function supportsAppServer(candidate: string, baseEnv: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(candidate, ['app-server', '--help'], {
    encoding: 'utf8',
    env: buildSystemCodexEnvironment(baseEnv, candidate),
    stdio: 'pipe',
    timeout: 5_000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function versionManagerBinDirs(homeDir: string): string[] {
  const dirs = [
    path.join(homeDir, '.volta', 'bin'),
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.local', 'share', 'pnpm'),
    path.join(homeDir, 'Library', 'pnpm'),
  ];
  const nvmVersions = path.join(homeDir, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmVersions, { withFileTypes: true });
    for (const version of versions
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name))) {
      dirs.push(path.join(nvmVersions, version.name, 'bin'));
    }
  } catch {
    // NVM is optional.
  }
  return dirs;
}

function defaultSystemBinDirs(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin'];
  if (platform === 'linux') return ['/usr/local/bin', '/usr/bin'];
  return [];
}

/** Resolve a user-installed Codex CLI only after proving that it supports App Server. */
export function resolveSystemCodexCliPath(options: SystemCodexResolutionOptions): string | null {
  const platform = options.platform ?? process.platform;
  const binary = platform === 'win32' ? 'codex.exe' : 'codex';
  const pathDirs = (options.pathValue ?? '').split(path.delimiter).filter(Boolean);
  const userBinDirs = [
    path.join(options.homeDir, '.local', 'bin'),
    path.join(options.homeDir, '.npm-global', 'bin'),
    ...versionManagerBinDirs(options.homeDir),
  ];
  const directories = [...pathDirs, ...userBinDirs, ...(options.systemBinDirs ?? defaultSystemBinDirs(platform))];
  const probe =
    options.probe ??
    ((candidate: string) =>
      supportsAppServer(candidate, {
        ...process.env,
        PATH: options.pathValue ?? process.env.PATH,
      }));
  const visited = new Set<string>();

  for (const directory of directories) {
    const candidate = path.resolve(directory, binary);
    if (visited.has(candidate) || !isExecutable(candidate, platform)) continue;
    visited.add(candidate);
    if (probe(candidate)) return candidate;
  }
  return null;
}
