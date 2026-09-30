import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readMapperMeta, writeMapperMeta, appendRegenHistory, type MapperMeta } from './mapper-meta.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-meta-'));
}

const sampleMeta: MapperMeta = {
  generatedAt: '2026-05-20T12:00:00Z',
  generatedBy: { model: 'test', iterations: 1 },
  inputsHash: 'sha256:abc',
  baselineResolutionRate: 0.8,
  baselineEdgeIds: ['e1', 'e2'],
  regenHistory: [],
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

  it('caps regenHistory at 20 entries, oldest dropped first', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'mapper.meta.json');
    let meta = sampleMeta;
    writeMapperMeta(file, meta);
    for (let i = 0; i < 25; i++) {
      meta = appendRegenHistory(meta, {
        at: `2026-05-${(i + 1).toString().padStart(2, '0')}T00:00:00Z`,
        rate: 0.5 + i * 0.01,
        trigger: 'manual',
        edgesAdded: 1,
        edgesRemoved: 0,
      });
    }
    writeMapperMeta(file, meta);
    const got = readMapperMeta(file);
    expect(got?.regenHistory).toHaveLength(20);
    expect(got?.regenHistory[0]?.at).toBe('2026-05-06T00:00:00Z');
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
