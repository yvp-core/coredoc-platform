import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readMapperMeta, writeMapperMeta, type MapperMeta } from './mapper-meta.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-meta-'));
}

const sampleMeta: MapperMeta = {
  generatedAt: '2026-05-20T12:00:00Z',
  generatedBy: { model: 'test', iterations: 1 },
  inputsHash: 'sha256:abc',
  baselineResolutionRate: 0.8,
  baselineEdgeIds: ['e1', 'e2'],
};

describe('mapper-meta', () => {
  it('round-trips a meta object via write+read', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'mapper.meta.json');
    writeMapperMeta(file, sampleMeta);
    const got = readMapperMeta(file);
    expect(got).toEqual(sampleMeta);
  });

  it('returns null when the file does not exist', () => {
    expect(readMapperMeta(path.join(tmpDir(), 'nope.json'))).toBeNull();
  });

  it('throws when meta is JSON-valid but structurally wrong', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'mapper.meta.json');
    fs.writeFileSync(file, JSON.stringify({ baselineResolutionRate: 'not a number' }));
    expect(() => readMapperMeta(file)).toThrow(/invalid structure/i);
  });

  it('throws when meta is missing required fields', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'mapper.meta.json');
    fs.writeFileSync(file, '{}');
    expect(() => readMapperMeta(file)).toThrow(/invalid structure/i);
  });
});
