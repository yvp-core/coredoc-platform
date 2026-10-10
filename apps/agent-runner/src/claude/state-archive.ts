/**
 * Archives come back from the server, so extraction trusts nothing: only regular files and
 * directories whose paths stay inside the state directory.
 */
import { mkdir } from 'node:fs/promises';
import { isAbsolute, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

export class ArchiveRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveRejectedError';
  }
}

const ALLOWED_TYPES = new Set(['File', 'OldFile', 'ContiguousFile', 'Directory']);

function safeEntryPath(path: string): boolean {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return false;
  const normalized = normalize(path);
  return normalized !== '..' && !normalized.startsWith(`..${sep}`) && !normalized.split(sep).includes('..');
}

/** Links are left out. */
export async function packStateArchive(stateDir: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = tar.create(
    {
      gzip: true,
      cwd: stateDir,
      portable: true,
      follow: false,
      filter: (_path, stat) => ('isFile' in stat && (stat.isFile() || stat.isDirectory())) || false,
    },
    ['.'],
  );
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** The whole archive is checked first, so a rejected archive writes nothing. */
export async function extractStateArchive(archive: Buffer, stateDir: string): Promise<void> {
  const problems: string[] = [];
  await pipeline(
    Readable.from([archive]),
    tar.list({
      strict: true,
      onReadEntry: (entry) => {
        if (!ALLOWED_TYPES.has(entry.type)) problems.push(`${entry.path} (${entry.type})`);
        else if (!safeEntryPath(entry.path)) problems.push(entry.path);
        entry.resume();
      },
    }),
  );
  if (problems.length) {
    throw new ArchiveRejectedError(`The state archive has entries outside the state directory: ${problems.join(', ')}`);
  }
  await mkdir(stateDir, { recursive: true });
  await pipeline(
    Readable.from([archive]),
    tar.extract({
      cwd: stateDir,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => 'type' in entry && ALLOWED_TYPES.has(entry.type) && safeEntryPath(path),
    }),
  );
}
