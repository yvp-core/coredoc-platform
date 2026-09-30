import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Barrel import runs the single wiring point (registers ts/js + ruby + swift + python).
import { providerForExport, pythonProvider, resolveProfileExport } from './index.js';
import type { PythonProfile } from '../types/python-profile.js';

// A minimal, valid Python extraction profile — the S2 dispatch input.
const pythonProfile: PythonProfile = {
  parserId: 'test',
  repoType: 'backend',
  substrate: { language: 'python', include: ['**/*.py'] },
};

describe('pythonProvider — S2 dispatch & zero-edit', () => {
  it('the registry dispatches a python profile to pythonProvider (positive, by substrate.language)', () => {
    const r = providerForExport(pythonProfile);
    expect(r?.provider.language).toBe('python');
    // Observable: the SAME registered provider object the barrel exports.
    expect(r?.provider).toBe(pythonProvider);
  });

  it('the production dispatch path (resolveProfileExport) resolves a single python provider', () => {
    const r = resolveProfileExport(pythonProfile);
    expect(r?.kind).toBe('single');
    if (r?.kind === 'single') expect(r.provider.language).toBe('python');
  });

  it('pythonProvider.parse returns a valid empty-but-well-formed backend ParsedRepo', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'coredoc-py-'));
    const repo = await pythonProvider.parse(pythonProfile, { repoRoot, repoName: 'demo' });

    // id minted through the seeded StableIdGenerator.
    expect(typeof repo.id).toBe('string');
    expect(repo.id.length).toBeGreaterThan(0);
    expect(repo.type).toBe('backend');
    expect(repo.parserId).toBe('test');

    // Every collection is present (empty-but-valid this step).
    expect(Array.isArray(repo.entrypoints)).toBe(true);
    expect(Array.isArray(repo.externalCalls)).toBe(true);
    expect(Array.isArray(repo.functions)).toBe(true);
    expect(Array.isArray(repo.calls)).toBe(true);
    expect(Array.isArray(repo.entities)).toBe(true);
    expect(Array.isArray(repo.dbOperations)).toBe(true);

    // Real stats object, zeroed for the skeleton.
    expect(repo.stats.analysis).toEqual([
      { language: 'python', mode: 'basic', compilerReceiverTypes: false, fallback: false },
    ]);
    expect(repo.stats.totalFunctions).toBe(0);
    expect(repo.stats.totalEntrypoints).toBe(0);
  });
});
