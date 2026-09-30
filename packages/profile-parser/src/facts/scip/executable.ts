import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { outsideSource } from './isolated-process.js';

/** Locate an installed executable without invoking a package manager or a project shell. */
export function executableOnPath(name: string, repoRoot: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    try {
      const path = join(directory, name);
      accessSync(path, constants.X_OK);
      const executable = outsideSource(repoRoot, realpathSync(path));
      if (statSync(executable).isFile()) return executable;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return undefined;
}
