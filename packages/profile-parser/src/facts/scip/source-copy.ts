import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { outsideSource } from './isolated-process.js';

/** Copy only the language's selected inputs; no tool receives a writable client checkout. */
export function copyIndexSource(repoRoot: string, work: string, files: string[]) {
  return indexSource(repoRoot, files, join(outsideSource(repoRoot, work), 'source'));
}

/** Fingerprint the original inputs without copying the checkout. */
export function readIndexSource(repoRoot: string, files: string[]) {
  return indexSource(repoRoot, files);
}

function indexSource(repoRoot: string, files: string[], destination?: string) {
  const sourceRoot = realpathSync(repoRoot);
  const root = destination ?? sourceRoot;
  if (destination) mkdirSync(root, { recursive: true });
  const hash = createHash('sha256');
  const stamp = createHash('sha256');
  const sourceHashes: Record<string, string> = {};
  for (const file of [...new Set(files)].sort()) {
    const parts = file.split('/');
    if (isAbsolute(file) || /[\\\0\r\n]/.test(file) || parts.includes('..'))
      throw new Error('Index inputs must be repository-relative files.');
    if (
      parts.some(
        (p) =>
          /^\.env(?:\.|$)/i.test(p) ||
          ['.git', '.npmrc', '.netrc', '.git-credentials', '.pypirc'].includes(p.toLowerCase()),
      )
    )
      continue;
    let source = sourceRoot;
    let missing = false;
    for (const part of parts) {
      source = join(source, part);
      const entry = lstatSync(source, { throwIfNoEntry: false });
      if (!entry) {
        missing = true;
        break;
      }
      if (entry.isSymbolicLink()) throw new Error(`Indexing does not follow source symbolic links: ${file}`);
    }
    if (missing) continue;
    const info = lstatSync(source);
    if (!info.isFile()) continue;
    // Also catch edits reverted during compilation: equal final bytes alone are insufficient.
    stamp.update(JSON.stringify([file, info.ino, info.size, info.mtimeMs, info.ctimeMs]));
    const bytes = readFileSync(source);
    sourceHashes[file] = createHash('sha256').update(bytes).digest('hex');
    hash.update(JSON.stringify([file, bytes.length])).update(bytes);
    if (destination) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
  }
  return { root, hash: hash.digest('hex'), stamp: stamp.digest('hex'), sourceHashes };
}
