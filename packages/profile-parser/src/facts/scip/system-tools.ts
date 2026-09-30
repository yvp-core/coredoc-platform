import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

/** Launchers run outside isolation, so only OS tool directories are eligible, never repo PATH. */
export function systemToolPath(name: 'bwrap' | 'tar'): string {
  const directories =
    process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
  for (const directory of directories) {
    const executable = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      /* Next OS directory. */
    }
  }
  throw new Error(
    `${name === 'bwrap' ? 'bubblewrap (bwrap)' : name} is required in ${directories.join(' or ')}. Install the operating system package or choose basic analysis.`,
  );
}

/**
 * The gate an optional indexer passes before it may run at all: process isolation must be
 * available, and this platform must be one the sandbox supports. Returns null when the indexer may
 * proceed, otherwise the reason the caller degrades to basic analysis.
 *
 * `unsupportedPlatform` is the caller's own message — the shared gate names no tool.
 */
export function isolatedPlatformPrerequisite(unsupportedPlatform: string): string | null {
  const isolationIssue = isolationPrerequisite();
  if (isolationIssue) return isolationIssue;
  return ['darwin', 'linux'].includes(process.platform) ? null : unsupportedPlatform;
}

export function isolationPrerequisite(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    systemToolPath('bwrap');
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
