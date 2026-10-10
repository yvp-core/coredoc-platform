import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveRejectedError, extractStateArchive, packStateArchive } from './state-archive.js';

/** A one-entry ustar archive written by hand, so the entry can claim any path or type. */
function handMadeTar(entries: Array<{ name: string; type: '0' | '2' | '5'; body?: string; link?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii');
    header.write(entry.type, 156, 1, 'ascii');
    if (entry.link) header.write(entry.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

describe('state archive', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'state-archive-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips the state directory', async () => {
    const source = join(root, 'source');
    await mkdir(join(source, 'projects', 'work'), { recursive: true });
    await writeFile(join(source, 'projects', 'work', 'session.jsonl'), '{"turn":1}\n');
    await writeFile(join(source, '.claude.json'), '{}');

    const archive = await packStateArchive(source);
    const target = join(root, 'target');
    await extractStateArchive(archive, target);

    expect(await readFile(join(target, 'projects', 'work', 'session.jsonl'), 'utf8')).toBe('{"turn":1}\n');
    expect(await readFile(join(target, '.claude.json'), 'utf8')).toBe('{}');
  });

  it.each([
    ['a path that escapes the state directory', [{ name: '../escape.txt', type: '0' as const, body: 'x' }]],
    ['an absolute path', [{ name: '/tmp/absolute.txt', type: '0' as const, body: 'x' }]],
    ['a symbolic link', [{ name: 'link', type: '2' as const, link: '/etc/passwd' }]],
  ])('rejects an archive with %s and writes nothing', async (_name, entries) => {
    const target = join(root, 'target');
    await expect(extractStateArchive(handMadeTar(entries), target)).rejects.toBeInstanceOf(ArchiveRejectedError);
    await expect(readFile(join(root, 'escape.txt'))).rejects.toThrow();
  });

  it('does not follow a symbolic link already inside the state directory when packing', async () => {
    const source = join(root, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(join(root, 'outside.txt'), 'secret');
    await symlink(join(root, 'outside.txt'), join(source, 'leak'));
    await writeFile(join(source, 'kept.txt'), 'kept');

    const target = join(root, 'target');
    await extractStateArchive(await packStateArchive(source), target);
    expect(await readFile(join(target, 'kept.txt'), 'utf8')).toBe('kept');
    await expect(readFile(join(target, 'leak'), 'utf8')).rejects.toThrow();
  });
});
