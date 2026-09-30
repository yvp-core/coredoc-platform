/**
 * Zig provider dispatch & zero-edit wiring — the same contract `rust.test.ts` pins for Rust:
 * the registry must route a `substrate.language: 'zig'` profile to THIS provider object, and
 * an empty repo must still produce a well-formed `ParsedRepo` (every collection an array, every
 * stat a real count) rather than a partially-populated object the push path then trips over.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MultiTargetProfile } from '../types/multi-profile.js';
import type { ZigProfile } from '../types/zig-profile.js';
// Barrel import runs the single wiring point (it is what registers every provider).
import { providerForExport, resolveProfileExport, zigProvider } from './index.js';

const zigProfile: ZigProfile = {
  parserId: 'test',
  repoType: 'backend',
  substrate: { language: 'zig', include: ['**/*.zig'] },
};

describe('zigProvider — dispatch & zero-edit wiring', () => {
  it('the registry dispatches a zig profile to zigProvider (positive, by substrate.language)', () => {
    const r = providerForExport(zigProfile);
    expect(r?.provider.language).toBe('zig');
    expect(r?.provider).toBe(zigProvider);
  });

  it('the production dispatch path (resolveProfileExport) resolves a single zig provider', () => {
    const r = resolveProfileExport(zigProfile);
    expect(r?.kind).toBe('single');
    if (r?.kind === 'single') expect(r.provider.language).toBe('zig');
  });

  it('resolves a zig target inside a MultiTargetProfile — the polyglot-monorepo path', () => {
    const multi: MultiTargetProfile = {
      parserId: 'test',
      repoType: 'monorepo',
      targets: [
        { name: 'web', substrate: { language: 'ts', include: ['apps/web/**/*.ts'] } },
        { name: 'engine', substrate: { language: 'zig', include: ['engine/**/*.zig'] } },
      ],
    };
    const r = resolveProfileExport(multi);
    expect(r?.kind).toBe('multi');
    if (r?.kind === 'multi') expect(r.targets.map((t) => t.provider.language)).toEqual(['ts', 'zig']);
  });

  it('rejects a profile for another language', () => {
    expect(zigProvider.isProfile({ parserId: 'x', substrate: { language: 'rust', include: [] } })).toBe(false);
    expect(zigProvider.isProfile(zigProfile)).toBe(true);
  });

  it('declares .zig discovery and NO scip prereq (there is no Zig semantic indexer wired)', () => {
    expect(zigProvider.discovery.extensions).toEqual(['.zig']);
    expect(zigProvider.discovery.scipPrereqs).toBeUndefined();
    // A spurious dangling-handler red flag would make an overall PASS impossible.
    expect(zigProvider.structuralChecks).toBeUndefined();
  });

  it('parse returns a valid, well-formed ParsedRepo for an empty repo', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'coredoc-zig-empty-'));
    try {
      const repo = await zigProvider.parse(zigProfile, { repoRoot, repoName: 'demo' });
      expect(typeof repo.id).toBe('string');
      expect(repo.id.length).toBeGreaterThan(0);
      expect(repo.type).toBe('backend');
      expect(repo.parserId).toBe('test');
      for (const key of [
        'packages',
        'files',
        'functions',
        'classes',
        'interfaces',
        'enums',
        'variables',
        'typeAliases',
        'entrypoints',
        'entities',
        'dbOperations',
        'calls',
        'imports',
        'externalCalls',
      ] as const) {
        expect(Array.isArray(repo[key])).toBe(true);
      }
      expect(repo.stats).toMatchObject({
        totalFiles: 0,
        parsedFiles: 0,
        skippedFiles: 0,
        totalFunctions: 0,
        totalClasses: 0,
        totalEntrypoints: 0,
        totalEntities: 0,
        totalCalls: 0,
        totalImports: 0,
        totalExternalCalls: 0,
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
