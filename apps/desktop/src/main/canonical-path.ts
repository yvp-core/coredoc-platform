import * as fs from 'node:fs';
import * as path from 'node:path';

/** Resolve symlinks in the existing portion of a path and fail closed on unreadable/dangling links. */
export function canonicalPath(candidate: string): string | null {
  let current = path.resolve(candidate);
  const missingSegments: string[] = [];

  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;

      // A dangling link can otherwise masquerade as a missing in-scope file and later
      // redirect a write outside the authorized root.
      try {
        if (fs.lstatSync(current).isSymbolicLink()) return null;
      } catch (lstatError) {
        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') return null;
      }

      const parent = path.dirname(current);
      if (parent === current) return null;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function isCanonicalInside(root: string, target: string): boolean {
  const canonicalRoot = canonicalPath(root);
  const canonicalTarget = canonicalPath(target);
  if (!canonicalRoot || !canonicalTarget) return false;
  const relative = path.relative(canonicalRoot, canonicalTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
