import { rubyProvider } from '../../providers/ruby.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClassNode, ParsedRepo } from '@coredoc/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkReferentialIntegrity } from '../../integrity/referential-integrity.js';
import type { RubyProfile } from '../../types/ruby-profile.js';
import { discoverRubyFiles } from './ruby-parser.js';

/**
 * Structure nodes of the Ruby substrate: a FileNode per parsed source, a ClassNode per
 * class/module definition, and parse statistics counted from what was actually emitted.
 * Runs on a fixture app, with no Ruby toolchain (Tier-B only).
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/structure-app');
const PROFILE: RubyProfile = { parserId: 'ruby-test', substrate: { language: 'ruby', include: [] } };

describe('ruby substrate structure nodes', () => {
  let repo: ParsedRepo;
  let classByName: Map<string, ClassNode>;

  beforeAll(async () => {
    repo = await rubyProvider.parse(
      { ...PROFILE, parserId: 'structure-app-v1' },
      { repoRoot: FIXTURE, repoName: 'structure-app', repoKey: 'structure-app' },
    );
    classByName = new Map(repo.classes.map((c) => [c.name, c]));
  }, 60_000);

  it('emits a file node for every path the substrate parsed', () => {
    const parsedPaths = discoverRubyFiles(FIXTURE, [], []);

    expect(new Set(repo.files.map((f) => f.path))).toEqual(new Set(parsedPaths));
    expect(repo.files.map((f) => f.path)).toContain('config/settings.rb'); // no def, no class
    expect(repo.files.map((f) => f.path)).toContain('lib/tasks/report.rake');
  });

  it('owns every file node with an emitted package', () => {
    const packageIds = new Set(repo.packages.map((p) => p.id));

    expect(packageIds.size).toBeGreaterThan(0);
    for (const file of repo.files) expect(packageIds.has(file.packageId)).toBe(true);
  });

  it('emits class nodes for class and module definitions with their line ranges', () => {
    expect([...classByName.keys()].sort()).toEqual(['Gadget', 'Sample', 'Util']);

    const gadget = classByName.get('Gadget') as ClassNode;
    expect(gadget.fileId).toBe(repo.files.find((f) => f.path === 'app/models/gadget.rb')?.id);
    expect(gadget.location.filePath).toBe('app/models/gadget.rb');
    expect(gadget.location.startLine).toBeLessThan(gadget.location.endLine);
    expect(gadget.extends).toEqual({ name: 'ApplicationRecord' });
    // A Ruby module cannot be instantiated — the class/module distinction the graph keeps.
    expect(classByName.get('Util')?.isAbstract).toBe(true);
    expect(gadget.isAbstract).toBe(false);
  });

  it('binds each method to its containing class, and every container reference resolves', () => {
    const classIds = new Set(repo.classes.map((c) => c.id));
    const gadget = classByName.get('Gadget') as ClassNode;
    const build = repo.functions.find((f) => f.name === 'build');
    const lookup = repo.functions.find((f) => f.name === 'lookup');

    expect(build?.classId).toBe(gadget.id);
    expect(lookup?.classId).toBe(gadget.id);
    expect(gadget.methods).toEqual(expect.arrayContaining([build?.id, lookup?.id]));
    for (const fn of repo.functions) {
      if (fn.classId !== undefined) expect(classIds.has(fn.classId)).toBe(true);
    }
  });

  it('leaves a file-scope def with no container reference', () => {
    const helper = repo.functions.find((f) => f.name === 'top_level_helper');
    const rakeTask = repo.functions.find((f) => f.name === 'report_totals');

    expect(helper?.classId).toBeUndefined();
    expect(rakeTask?.classId).toBeUndefined();
  });

  it('reports statistics counted from the emitted nodes', () => {
    expect(repo.stats.parsedFiles).toBe(repo.files.length);
    expect(repo.stats.totalFiles).toBe(discoverRubyFiles(FIXTURE, [], []).length);
    expect(repo.stats.skippedFiles).toBe(0);
    expect(repo.stats.totalClasses).toBe(repo.classes.length);
    expect(repo.stats.totalFunctions).toBe(repo.functions.length);
    expect(repo.stats.totalCalls).toBe(repo.calls.length);
    expect(repo.stats.totalClasses).toBeGreaterThan(0);
    expect(repo.errors ?? []).toEqual([]);
  });

  it('passes referential integrity', () => {
    const report = checkReferentialIntegrity(repo);

    expect(report.violations).toEqual([]);
    expect(report.danglingRefs).toBe(0);
  });
});
