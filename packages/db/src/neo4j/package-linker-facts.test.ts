import { describe, it, expect, vi } from 'vitest';
import { Neo4jRepository } from './repository.js';
import type { Neo4jDriver } from './driver.js';
import type { ITransaction } from '../types.js';

/**
 * Package-linker projection parity (Neo4j).
 *
 * Same harness idea as repository.test.ts: no live instance, so a fake driver
 * records every Cypher query and returns canned rows. The assertions pin both
 * the projection semantics (which files and declarations survive) and the query
 * shape that keeps the reads on the per-label `id` index.
 */
class FakeDriver {
  calls: Array<{ query: string; params: Record<string, unknown> }> = [];
  responder: (query: string) => unknown[] = () => [];

  async withReadTransaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> {
    const tx: ITransaction = {
      run: async <R = unknown>(query: string, params: Record<string, unknown> = {}): Promise<R[]> => {
        this.calls.push({ query, params });
        return this.responder(query) as R[];
      },
    };
    return fn(tx);
  }
}

function makeRepo(): { repo: Neo4jRepository; driver: FakeDriver } {
  const driver = new FakeDriver();
  return { repo: new Neo4jRepository(driver as unknown as Neo4jDriver), driver };
}

const queryMatching = (driver: FakeDriver, needle: string) => driver.calls.find((c) => c.query.includes(needle))!;

describe('Neo4jRepository.getPackageLinkerFacts', () => {
  const HASH = 'abc123456789';
  const consumerFileId = `${HASH}:file:src/use-booking.ts`;
  const providerFileId = `${HASH}:file:src/enums.ts`;
  const unrelatedFileId = `${HASH}:file:src/unrelated.ts`;
  const bookingImport = {
    id: 'import-booking-types',
    moduleSpecifier: '@acme/acme-api-client',
    isTypeOnly: true,
    importKind: 'named',
    importedNames: [{ name: 'BookingTypes', alias: 'BookingKind' }],
  };

  it('projects package files and exported declarations through label-indexed reads', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query) => {
      if (query.includes('MATCH (f:File)')) {
        return [
          {
            id: consumerFileId,
            path: 'src/use-booking.ts',
            name: 'src/use-booking.ts',
            filePath: 'src/use-booking.ts',
            packageId: `${HASH}:package:consumer`,
            target: 'api',
            // Arrays of objects are stored JSON-encoded by flattenForNeo4j.
            packageImports: JSON.stringify([bookingImport]),
          },
          {
            id: providerFileId,
            path: 'src/enums.ts',
            name: 'src/enums.ts',
            filePath: 'src/enums.ts',
            packageId: `${HASH}:package:provider`,
            target: null,
            packageImports: null,
          },
          {
            id: unrelatedFileId,
            path: 'src/unrelated.ts',
            name: 'src/unrelated.ts',
            filePath: 'src/unrelated.ts',
            packageId: `${HASH}:package:consumer`,
            target: null,
            packageImports: null,
          },
        ];
      }
      return [
        { id: `${HASH}:enum:src/enums.ts:BookingTypes`, name: 'BookingTypes', fileId: providerFileId, kind: 'enum' },
        // Exported, but its file carries no packageId → not a package export.
        { id: `${HASH}:enum:src/other.ts:Orphan`, name: 'Orphan', fileId: `${HASH}:file:src/other.ts`, kind: 'enum' },
      ];
    };

    const facts = await repo.getPackageLinkerFacts([HASH]);

    // Importers and export sites only — a packaged file that is neither is dropped.
    expect(facts.files).toEqual([
      {
        id: consumerFileId,
        path: 'src/use-booking.ts',
        packageId: `${HASH}:package:consumer`,
        target: 'api',
        imports: [bookingImport],
      },
      {
        id: providerFileId,
        path: 'src/enums.ts',
        packageId: `${HASH}:package:provider`,
        imports: [],
      },
    ]);
    expect(facts.declarations).toEqual([
      {
        id: `${HASH}:enum:src/enums.ts:BookingTypes`,
        name: 'BookingTypes',
        fileId: providerFileId,
        kind: 'enum',
        isExported: true,
      },
    ]);

    // Every arm is labelled so the per-label `id` range index backs the repo
    // prefix filter; methods never reach the linker.
    const declarationQuery = queryMatching(driver, 'UNION ALL').query;
    for (const label of ['Class', 'Interface', 'TypeAlias', 'Enum', 'Function', 'Variable']) {
      expect(declarationQuery).toContain(`MATCH (d:${label})`);
    }
    expect(declarationQuery).toContain("AND d.kind = 'function'");
    expect(declarationQuery).toContain(`d.id STARTS WITH '${HASH}:'`);
    expect(declarationQuery).toContain('d.isExported = true');
    expect(queryMatching(driver, 'MATCH (f:File)').query).toContain('f.packageId IS NOT NULL');
  });

  it('skips a file whose packageImports blob is unparseable instead of failing the workspace', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query) =>
      query.includes('MATCH (f:File)')
        ? [
            {
              id: consumerFileId,
              path: 'src/use-booking.ts',
              name: 'src/use-booking.ts',
              filePath: 'src/use-booking.ts',
              packageId: `${HASH}:package:consumer`,
              target: null,
              packageImports: '{not json',
            },
          ]
        : [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const facts = await repo.getPackageLinkerFacts([HASH]);

    expect(facts).toEqual({ files: [], declarations: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid packageImports'));
    warn.mockRestore();
  });

  it('reads nothing when no repos are pinned', async () => {
    const { repo, driver } = makeRepo();
    expect(await repo.getPackageLinkerFacts([])).toEqual({ files: [], declarations: [] });
    expect(driver.calls).toHaveLength(0);
  });
});
