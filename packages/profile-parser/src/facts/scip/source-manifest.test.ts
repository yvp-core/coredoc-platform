import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create, toBinary } from '@bufbuild/protobuf';
import { IndexSchema } from '@scip-code/scip';
import { afterEach, expect, it, vi } from 'vitest';
import { mergeScipCallFacts } from './call-facts.js';
import { copyOptionalScip, optionalAnalysis } from './index-host.js';
import { copyIndexSource } from './source-copy.js';
import { assertScipSources, cachedOptionalScip, loadOptionalScip, publishOptionalScip } from './source-manifest.js';

const roots: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync), readFileSync: vi.fn(fs.readFileSync) };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(renameSync).mockReset().mockImplementation(realFs.renameSync);
  vi.mocked(readFileSync).mockReset().mockImplementation(realFs.readFileSync);
});
const source = 'def run(): return make().perform()\n';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scip-manifest-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'main.py'), source);
  const snapshot = copyIndexSource(repo, join(root, 'work'), ['main.py']);
  const index = join(root, 'raw.scip');
  writeFileSync(
    index,
    toBinary(
      IndexSchema,
      create(IndexSchema, {
        documents: [
          { relativePath: 'main.py', occurrences: [{ range: [0, 4, 7], symbol: 'local 0', symbolRoles: 1 }] },
        ],
      }),
    ),
  );
  const target = join(root, 'result.scip');
  return { repo, snapshot, index, target };
}

function competingPublication() {
  const first = fixture();
  const second = fixture();
  // Identical inputs can produce distinct index bytes (e.g. the compiler's temporary project root).
  writeFileSync(
    second.index,
    toBinary(
      IndexSchema,
      create(IndexSchema, {
        metadata: { projectRoot: 'file:///second' },
        documents: [{ relativePath: 'main.py', occurrences: [] }],
      }),
    ),
  );
  return { first, second, publishSecond: () => publishOptionalScip(second.index, first.target, second.snapshot) };
}

it('keeps one complete cached index and preserves it when a replacement fails', () => {
  const { first, second } = competingPublication();
  const cacheDir = join(first.repo, 'cache');
  mkdirSync(cacheDir);
  const cache = join(cacheDir, 'latest.scip-cache');
  publishOptionalScip(first.index, cache, first.snapshot, 'inputs-and-tools-v1');
  expect(loadOptionalScip(cachedOptionalScip(cache, 'inputs-and-tools-v1')!).sourceHashes).toEqual(
    first.snapshot.sourceHashes,
  );
  expect(cachedOptionalScip(cache, 'different-inputs')).toBeUndefined();
  const previous = readFileSync(cache);
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw new Error('interrupted publication');
  });
  expect(() => publishOptionalScip(second.index, cache, second.snapshot, 'v2')).toThrow('interrupted publication');
  expect(readFileSync(cache)).toEqual(previous);
  publishOptionalScip(second.index, cache, second.snapshot, 'v2');
  expect(loadOptionalScip(cache).projectRoot).toBe('file:///second');
  expect(readdirSync(cacheDir)).toEqual(['latest.scip-cache']);
  const desktop = join(first.repo, 'desktop.scip');
  copyOptionalScip(cache, desktop);
  expect(loadOptionalScip(desktop).projectRoot).toBe('file:///second');
  writeFileSync(cache, 'interrupted or corrupt');
  expect(cachedOptionalScip(cache, 'v2')).toBeUndefined();
});

it('keeps the index readable before, during and after overlapping publications', () => {
  const { first, publishSecond } = competingPublication();
  const observed: string[] = [];
  const read = () => {
    try {
      observed.push(loadOptionalScip(first.target).projectRoot);
    } catch (error) {
      observed.push((error as Error).message);
    }
  };
  let interleaved = false;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    realFs.renameSync(from, to);
    // Model process B running after A exposes its index but before A returns from rename.
    if (to === first.target && !interleaved) {
      interleaved = true;
      read();
      publishSecond();
      read();
    }
  });
  publishOptionalScip(first.index, first.target, first.snapshot);
  read();
  expect(interleaved).toBe(true);
  expect(observed).toEqual(['', 'file:///second', 'file:///second']);
});

it.each([
  'load',
  'copy',
] as const)('pins %s to one generation while another process publishes a replacement', (operation) => {
  const { first, publishSecond } = competingPublication();
  publishOptionalScip(first.index, first.target, first.snapshot);
  let interleaved = false;
  vi.mocked(readFileSync).mockImplementation((...args) => {
    const bytes = realFs.readFileSync(...args);
    if (String(args[0]).endsWith('.sources.json') && !interleaved) {
      interleaved = true;
      publishSecond();
    }
    return bytes;
  });
  const captured = join(first.repo, 'desktop.scip');
  if (operation === 'copy') copyOptionalScip(first.target, captured);
  expect(loadOptionalScip(operation === 'copy' ? captured : first.target).projectRoot).toBe('');
  expect(interleaved).toBe(true);
  expect(loadOptionalScip(first.target).projectRoot).toBe('file:///second');
});

it('binds copied source bytes and the exact index; rejects swapped indexes and missing manifests', () => {
  const { index, target, snapshot } = fixture();
  publishOptionalScip(index, target, snapshot);
  expect(() => assertScipSources(loadOptionalScip(target), [{ path: 'main.py', source }])).not.toThrow();
  const original = readFileSync(target);
  writeFileSync(target, Buffer.concat([original, Buffer.from([0])]));
  expect(() => loadOptionalScip(target)).toThrow('manifest is missing');
  writeFileSync(target, original);
  rmSync(`${target}.${createHash('sha256').update(original).digest('hex')}.sources.json`);
  expect(() => loadOptionalScip(target)).toThrow('manifest is missing');
});

it('accepts legacy manifests only when they describe the captured index bytes', () => {
  const { index, snapshot } = fixture();
  const manifest = {
    indexSha256: createHash('sha256').update(readFileSync(index)).digest('hex'),
    sources: snapshot.sourceHashes,
  };
  writeFileSync(`${index}.sources.json`, JSON.stringify(manifest));
  expect(() => assertScipSources(loadOptionalScip(index), [{ path: 'main.py', source }])).not.toThrow();
  writeFileSync(index, Buffer.concat([readFileSync(index), Buffer.from([0])]));
  expect(() => loadOptionalScip(index)).toThrow('do not match');
});

it('keeps the last published pair readable if a replacement fails before committing', () => {
  const { first, publishSecond } = competingPublication();
  publishOptionalScip(first.index, first.target, first.snapshot);
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (to === first.target) throw new Error('interrupted publication');
    realFs.renameSync(from, to);
  });
  expect(publishSecond).toThrow('interrupted publication');
  expect(loadOptionalScip(first.target).projectRoot).toBe('');
});

it('rejects inputs rewritten by a build before publishing compiler evidence', () => {
  const { index, target, snapshot } = fixture();
  writeFileSync(join(snapshot.root, 'main.py'), source.replace('perform', 'another'));
  expect(() => publishOptionalScip(index, target, snapshot)).toThrow('changed during indexing: main.py');
});

it.each([false, true])('rejects stale positional joins when snapshotIsNewer=%s', async (snapshotIsNewer) => {
  const { index, target, snapshot } = fixture();
  publishOptionalScip(index, target, snapshot);
  const indexed = loadOptionalScip(target);
  const edited = source.replace('perform', 'another'); // Same byte positions, different callee.
  const parsed = snapshotIsNewer ? source : edited;
  if (snapshotIsNewer) indexed.sourceHashes['main.py'] = hash(edited);
  const file = { path: 'main.py', source: parsed, defaultPositionEncoding: 2 as const, definitions: [], calls: [] };
  const consume = () => mergeScipCallFacts(indexed, [file], [], { callSites: 2, resolvedCalls: 0, outOfScopeCalls: 2 });
  const prepare = async () => ({ ok: true, scipPath: target });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(await optionalAnalysis('python', undefined, prepare, consume)).toMatchObject({
    analysis: { mode: 'basic', fallback: true },
  });
  await expect(optionalAnalysis('python', { fallback: false }, prepare, consume)).rejects.toThrow(
    'differs from parsed source: main.py',
  );
});

it('requires all target documents, while permitting extra documents and files without calls', () => {
  const files = Array.from({ length: 40 }, (_, i) => ({ path: `crate${i}/lib.rs`, source: 'const VALUE: u8 = 1;' }));
  const index = {
    projectRoot: '',
    sourceHashes: Object.fromEntries(files.map((file) => [file.path, hash(file.source)])),
    documents: [{ relativePath: files[0].path, occurrences: [] }],
  };
  expect(() => assertScipSources(index, files)).toThrow('covers 1/40 target files');
  // A deliberately scoped profile is measured against its own files, not the whole compiler workspace.
  expect(() => assertScipSources(index, files.slice(0, 1))).not.toThrow();
  index.documents = files.map((file) => ({ relativePath: file.path, occurrences: [] }));
  index.documents.push({ relativePath: 'dependency/lib.rs', occurrences: [] });
  expect(() => assertScipSources(index, files)).not.toThrow();
});
