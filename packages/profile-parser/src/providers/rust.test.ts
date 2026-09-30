import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MultiTargetProfile } from '../types/multi-profile.js';
import type { RustProfile } from '../types/rust-profile.js';
// Barrel import runs the single wiring point (registers ts/js + ruby + swift + python + rust).
import { providerForExport, resolveProfileExport, rustProvider } from './index.js';

/** A minimal, valid Rust extraction profile — the dispatch input. */
const rustProfile: RustProfile = {
  parserId: 'test',
  repoType: 'backend',
  substrate: { language: 'rust', include: ['**/*.rs'] },
};

function writeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'coredoc-rs-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe('rustProvider — dispatch & zero-edit wiring', () => {
  it('the registry dispatches a rust profile to rustProvider (positive, by substrate.language)', () => {
    const r = providerForExport(rustProfile);
    expect(r?.provider.language).toBe('rust');
    // Observable: the SAME registered provider object the barrel exports.
    expect(r?.provider).toBe(rustProvider);
  });

  it('the production dispatch path (resolveProfileExport) resolves a single rust provider', () => {
    const r = resolveProfileExport(rustProfile);
    expect(r?.kind).toBe('single');
    if (r?.kind === 'single') expect(r.provider.language).toBe('rust');
  });

  it('resolves a rust target inside a MultiTargetProfile — the polyglot-monorepo path', () => {
    const multi: MultiTargetProfile = {
      parserId: 'test',
      repoType: 'monorepo',
      targets: [
        { name: 'web', substrate: { language: 'ts', include: ['apps/web/**/*.ts'] } },
        { name: 'core', substrate: { language: 'rust', include: ['src-tauri/**/*.rs'] } },
      ],
    };
    const r = resolveProfileExport(multi);
    expect(r?.kind).toBe('multi');
    if (r?.kind === 'multi') {
      expect(r.targets.map((t) => t.provider.language)).toEqual(['ts', 'rust']);
    }
  });

  it('declares .rs discovery without unrelated structural checks', () => {
    expect(rustProvider.discovery.extensions).toEqual(['.rs']);
    // A spurious dangling-handler red flag would make an overall PASS impossible.
    expect(rustProvider.structuralChecks).toBeUndefined();
  });

  it('parse returns a valid, well-formed ParsedRepo for an empty repo', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'coredoc-rs-empty-'));
    try {
      const repo = await rustProvider.parse(rustProfile, { repoRoot, repoName: 'demo' });
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
        'entrypoints',
        'entities',
        'dbOperations',
        'calls',
        'externalCalls',
      ] as const) {
        expect(Array.isArray(repo[key])).toBe(true);
      }
      expect(repo.stats.totalFunctions).toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('parse emits real crate Packages and FileNodes, and every file belongs to a crate', async () => {
    // Unlike the Python substrate (which hardcodes `packages: []` / `files: []`), the Rust one
    // must emit both — the multi-target scope-overlap guard and the scorecard's unclaimed-file
    // report read `files`, and with an empty array every `.rs` file reports as unclaimed.
    const repoRoot = writeRepo({
      'Cargo.toml': '[workspace]\nmembers = ["crates/core"]\n',
      'crates/core/Cargo.toml': '[package]\nname = "demo-core"\nversion = "1.2.3"\n',
      'crates/core/src/lib.rs': 'pub struct Repo;\nimpl Repo { pub fn new() -> Self { Repo } }\n',
    });
    try {
      const repo = await rustProvider.parse(rustProfile, { repoRoot, repoName: 'demo' });
      expect(repo.packages.map((p) => `${p.name}@${p.path}`)).toEqual(['demo-core@crates/core']);
      expect(repo.packages[0].language).toBe('rust');
      expect(repo.packages[0].version).toBe('1.2.3');
      expect(repo.files.map((f) => f.path)).toEqual(['crates/core/src/lib.rs']);
      expect(repo.files[0].language).toBe('rust');
      const packageIds = new Set(repo.packages.map((p) => p.id));
      expect(repo.files.every((f) => packageIds.has(f.packageId))).toBe(true);
      expect(repo.classes.map((c) => c.name)).toEqual(['Repo']);
      expect(repo.stats.totalFunctions).toBe(1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
