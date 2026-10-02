import { swiftProvider } from '../../providers/swift.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkReferentialIntegrity } from '../../integrity/referential-integrity.js';
import { providerForExport } from '../../providers/index.js';
import type { SwiftProfile } from '../../types/swift-profile.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'mini-ios');

const profile: SwiftProfile = {
  parserId: 'acme-ios-swift-v1',
  repoType: 'mobile',
  substrate: { language: 'swift', include: ['**/*.swift'] },
  egress: { targetTypeProtocols: ['TargetType'] },
  entities: { orm: 'realm', baseClasses: ['Object'] },
  dbOperations: { entityTypealias: 'DBObject' },
  di: { containerAccessor: 'DI.shared' },
};

/** [S4] structural extraction + two-ID integrity, end-to-end against a fixture repo. */
describe('[S4/S5/S6/S7] swiftProvider.parse against a fixture repo', () => {
  it('extracts functions, entities, db-ops, egress, and Tier-B calls with canonical two-IDs', async () => {
    const repo = await swiftProvider.parse(profile, { repoRoot: FIXTURE, repoName: 'mini-ios', repoKey: 'mini-ios' });
    const repoHash = repo.id;
    expect(repo.type).toBe('mobile');
    expect(repo.parserVersion).toBe('1.2.1-swift');
    expect(repo.imports).toEqual([]);
    expect(repo.errors).toEqual([]);
    expect('httpPrefix' in repo).toBe(false);

    // structural floor: a FunctionNode per method
    expect(repo.functions.map((f) => f.name).sort()).toEqual(['fetchAll', 'start', 'stop', 'sync']);

    // entity (S6)
    expect(repo.entities.map((e) => e.name)).toEqual(['BookingDB']);

    // db-ops (S6): read (objects) + create (add) + transaction (safeWrite), performer-attributed
    const ops = repo.dbOperations.map((o) => `${o.operation}:${o.entityName}`);
    expect(ops).toContain('read:BookingDB');

    // egress (S5): the getProfiles call site
    expect(repo.externalCalls).toHaveLength(1);
    expect(repo.externalCalls[0].serviceName).toBe('');
    expect(repo.externalCalls[0].targetDescriptor?.http?.pathTemplate).toBe('/profiles');

    // Tier-B call (S7): Coordinator.start → DI.shared.bookingService.fetchAll → BookingService.fetchAll
    const call = repo.calls.find((c) => c.calleeExpression.includes('fetchAll'));
    expect(call?.provenance).toBe('di');

    // two-ID invariant: every node/edge id is repoHash-scoped; versionedId carries a checksum
    for (const n of [...repo.functions, ...repo.entities, ...repo.externalCalls]) {
      expect(n.id.startsWith(`${repoHash}:`)).toBe(true);
      expect(n.versionedId).toMatch(/@[a-f0-9]+$/);
      expect(n.versionedId.startsWith(n.id)).toBe(true);
    }

    // Structure joins are part of the real full-output path: every function must resolve to
    // the FileNode and (for methods) ClassNode minted by the same StableIdGenerator.
    const integrity = checkReferentialIntegrity(repo);
    expect(integrity.violations.map((v) => `${v.ref}:${v.count}`)).toEqual([]);
    expect(integrity.danglingRefs).toBe(0);
    expect(repo.functions.some((fn) => fn.classId !== undefined)).toBe(true);
    expect(repo.files.map((file) => file.path).sort()).toEqual([
      'Api.swift',
      'BookingService.swift',
      'Extensions.swift',
      'Models.swift',
    ]);
    expect(repo.stats.parsedFiles).toBe(repo.files.length);
  });

  it('versionedId flips when a function body changes but the stable id does not', async () => {
    const a = await swiftProvider.parse(profile, { repoRoot: FIXTURE, repoName: 'mini-ios', repoKey: 'mini-ios' });
    const b = await swiftProvider.parse(profile, { repoRoot: FIXTURE, repoName: 'mini-ios', repoKey: 'mini-ios' });
    // determinism: identical parse → identical versionedIds
    expect(a.functions.map((f) => f.versionedId).sort()).toEqual(b.functions.map((f) => f.versionedId).sort());
    // stable id ≠ versioned id (checksum present)
    for (const f of a.functions) expect(f.id).not.toBe(f.versionedId);
  });
});

/** [S2] a swift profile dispatches to the swift provider via the registry. */
describe('[S2] provider dispatch', () => {
  it('providerForExport routes substrate.language "swift" to the swift provider', () => {
    const resolved = providerForExport(profile);
    expect(resolved?.provider.language).toBe('swift');
    expect(resolved?.provider.discovery.extensions).toContain('.swift');
    expect(resolved?.provider.structuralChecks).toBeUndefined(); // omitted, like Ruby
  });
});

/** [S7] in-repo call resolution is measured over the enumerated Tier-B sites (BR-1/BR-2, LIM-6). */
describe('swiftProvider.parse — call-site measurement', () => {
  it('counts enumerated sites, the platform calls out of scope, and only shipped edges as resolved', async () => {
    const repo = await swiftProvider.parse(profile, { repoRoot: FIXTURE, repoName: 'mini-ios', repoKey: 'mini-ios' });
    const cr = repo.stats.callResolution;
    if (!cr) throw new Error('expected stats.callResolution');

    expect(cr.resolvedCalls).toBe(repo.calls.length); // every shipped edge is a counted site
    // The exact triple for `__fixtures__/mini-ios` (AC-1).
    expect(cr).toEqual({ callSites: 4, resolvedCalls: 1, outOfScopeCalls: 3 });
    // `realm.objects(Task.self)` is one of the counted-but-dropped sites: it is enumerated, it
    // ships no edge, and `objects` is declared by nothing here → out of scope, never a miss.
    expect(repo.calls.some((c) => c.calleeExpression === 'realm.objects')).toBe(false);
  });

  it('carries the db-op resolution record into ParseStats (BR-4)', async () => {
    const repo = await swiftProvider.parse(profile, { repoRoot: FIXTURE, repoName: 'mini-ios', repoKey: 'mini-ios' });
    const db = repo.stats.dbOpResolution;
    if (!db) throw new Error('expected stats.dbOpResolution');
    // The exact triple for `__fixtures__/mini-ios`: every enumerated op site resolves its entity.
    expect(db).toEqual({ dbOpSites: 3, boundDbOps: 3, outOfScopeDbOps: 0 });
    expect(db.boundDbOps).toBe(repo.dbOperations.filter((o) => o.entityId !== undefined).length);
  });
});
