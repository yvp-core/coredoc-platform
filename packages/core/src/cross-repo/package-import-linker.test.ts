import { describe, expect, it } from 'vitest';
import type { ParsedRepoLike } from './linker.js';
import { linkWorkspace } from './linker.js';

function packageRepo(overrides: Record<string, unknown>): ParsedRepoLike {
  return {
    id: 'repo',
    name: 'repo',
    entrypoints: [],
    externalCalls: [],
    ...overrides,
  } as unknown as ParsedRepoLike;
}

describe('linkWorkspace package imports', () => {
  it('links an external named import to the unique exported declaration without changing protocol metrics', () => {
    const consumer = packageRepo({
      id: 'consumer-id',
      name: 'consumer',
      packages: [{ id: 'consumer-pkg', name: '@acme/consumer', path: '.' }],
      files: [
        {
          id: 'consumer-file',
          versionedId: 'consumer-file@1',
          path: 'src/use-booking.ts',
          extension: '.ts',
          packageId: 'consumer-pkg',
          language: 'typescript',
          contentHash: 'consumer-hash',
        },
      ],
      imports: [
        {
          id: 'consumer-import',
          sourceFileId: 'consumer-file',
          moduleSpecifier: '@acme/acme-api-client',
          isTypeOnly: true,
          importKind: 'named',
          importedNames: [{ name: 'BookingTypes', alias: 'BookingKind' }],
        },
      ],
    });
    const provider = packageRepo({
      id: 'provider-id',
      name: 'acme-packages',
      packages: [{ id: 'provider-pkg', name: '@acme/acme-api-client', path: 'packages/acme-api-client' }],
      files: [
        {
          id: 'provider-file',
          versionedId: 'provider-file@1',
          path: 'packages/acme-api-client/src/lib/booking/dto/enums.ts',
          extension: '.ts',
          packageId: 'provider-pkg',
          language: 'typescript',
          contentHash: 'provider-hash',
        },
      ],
      enums: [
        {
          id: 'provider-enum',
          versionedId: 'provider-enum@1',
          name: 'BookingTypes',
          kind: 'enum',
          fileId: 'provider-file',
          isExported: true,
          isConst: false,
          members: [],
          location: {
            filePath: 'packages/acme-api-client/src/lib/booking/dto/enums.ts',
            startLine: 1,
            endLine: 3,
          },
        },
      ],
    });

    const result = linkWorkspace([consumer, provider]);

    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.metrics).toEqual({ total: 0, resolved: 0, unresolvableExcluded: 0, rate: 0 });
    expect(result.packageImportEdges).toEqual([
      expect.objectContaining({
        sourceId: 'consumer-file',
        targetId: 'provider-enum',
        confidence: 1,
        createdBy: 'cross-repo-linker',
        properties: expect.objectContaining({
          relation: 'package-import',
          packageName: '@acme/acme-api-client',
          moduleSpecifier: '@acme/acme-api-client',
          importedName: 'BookingTypes',
          importedAlias: 'BookingKind',
          isTypeOnly: true,
          sourceRepoName: 'consumer',
          targetRepoName: 'acme-packages',
          targetFileId: 'provider-file',
          targetKind: 'enum',
          confidenceLevel: 'exact',
        }),
      }),
    ]);
  });

  it('uses the longest valid package prefix for subpath imports', () => {
    const consumer = packageRepo({
      id: 'consumer-id',
      name: 'consumer',
      files: [
        {
          id: 'consumer-file',
          path: 'src/use.ts',
          packageId: 'consumer-pkg',
        },
      ],
      imports: [
        {
          id: 'consumer-import',
          sourceFileId: 'consumer-file',
          moduleSpecifier: '@acme/api-client/internal/status',
          isTypeOnly: false,
          importKind: 'named',
          importedNames: [{ name: 'Status' }],
        },
      ],
    });
    const shorter = packageRepo({
      id: 'short-id',
      name: 'short',
      packages: [{ id: 'short-pkg', name: '@acme/api-client', path: '.' }],
      files: [{ id: 'short-file', path: 'status.ts', packageId: 'short-pkg' }],
      enums: [{ id: 'short-status', name: 'Status', fileId: 'short-file', isExported: true }],
    });
    const longer = packageRepo({
      id: 'long-id',
      name: 'long',
      packages: [{ id: 'long-pkg', name: '@acme/api-client/internal', path: '.' }],
      files: [{ id: 'long-file', path: 'status.ts', packageId: 'long-pkg' }],
      enums: [{ id: 'long-status', name: 'Status', fileId: 'long-file', isExported: true }],
    });

    const result = linkWorkspace([consumer, shorter, longer]);

    expect(result.packageImportEdges?.map((edge) => edge.targetId)).toEqual(['long-status']);
  });

  it('fails closed for duplicate exported declarations and skips same-repo imports', () => {
    const duplicateConsumer = packageRepo({
      id: 'consumer-id',
      name: 'consumer',
      files: [{ id: 'consumer-file', path: 'src/use.ts', packageId: 'consumer-pkg' }],
      imports: [
        {
          id: 'consumer-import',
          sourceFileId: 'consumer-file',
          moduleSpecifier: '@acme/types',
          isTypeOnly: false,
          importKind: 'named',
          importedNames: [{ name: 'Status' }],
        },
      ],
    });
    const ambiguousProvider = packageRepo({
      id: 'provider-id',
      name: 'provider',
      packages: [{ id: 'provider-pkg', name: '@acme/types', path: '.' }],
      files: [
        { id: 'provider-a', path: 'a.ts', packageId: 'provider-pkg' },
        { id: 'provider-b', path: 'b.ts', packageId: 'provider-pkg' },
      ],
      enums: [
        { id: 'status-a', name: 'Status', fileId: 'provider-a', isExported: true },
        { id: 'status-b', name: 'Status', fileId: 'provider-b', isExported: true },
      ],
    });
    const selfImport = packageRepo({
      id: 'self-id',
      name: 'self',
      packages: [{ id: 'self-pkg', name: '@acme/self', path: '.' }],
      files: [
        { id: 'self-use', path: 'use.ts', packageId: 'self-pkg' },
        { id: 'self-status-file', path: 'status.ts', packageId: 'self-pkg' },
      ],
      imports: [
        {
          id: 'self-import',
          sourceFileId: 'self-use',
          moduleSpecifier: '@acme/self',
          isTypeOnly: false,
          importKind: 'named',
          importedNames: [{ name: 'Status' }],
        },
      ],
      enums: [{ id: 'self-status', name: 'Status', fileId: 'self-status-file', isExported: true }],
    });

    const result = linkWorkspace([duplicateConsumer, ambiguousProvider, selfImport]);

    expect(result.packageImportEdges).toEqual([]);
  });

  it.each(['default', 'namespace'] as const)('does not link a %s binding as a named export', (importKind) => {
    const consumer = packageRepo({
      id: 'consumer-id',
      name: 'consumer',
      files: [{ id: 'consumer-file', path: 'src/use.ts', packageId: 'consumer-pkg' }],
      imports: [
        {
          id: 'consumer-import',
          sourceFileId: 'consumer-file',
          moduleSpecifier: '@acme/client',
          isTypeOnly: false,
          importKind,
          importedNames: [{ name: 'Client' }],
        },
      ],
    });
    const provider = packageRepo({
      id: 'provider-id',
      name: 'provider',
      packages: [{ id: 'provider-pkg', name: '@acme/client', path: '.' }],
      files: [{ id: 'provider-file', path: 'client.ts', packageId: 'provider-pkg' }],
      classes: [{ id: 'named-client', name: 'Client', fileId: 'provider-file', isExported: true }],
    });

    const result = linkWorkspace([consumer, provider]);

    expect(result.packageImportEdges).toEqual([]);
  });

  it('deduplicates package-import edges by their persisted storage identity', () => {
    const imports = [
      {
        id: 'z-subpath-import',
        sourceFileId: 'consumer-file',
        moduleSpecifier: '@acme/types/status',
        isTypeOnly: false,
        importKind: 'named' as const,
        importedNames: [{ name: 'Status' }],
      },
      {
        id: 'a-root-import',
        sourceFileId: 'consumer-file',
        moduleSpecifier: '@acme/types',
        isTypeOnly: false,
        importKind: 'named' as const,
        importedNames: [{ name: 'Status' }],
      },
    ];
    const consumer = packageRepo({
      id: 'consumer-id',
      name: 'consumer',
      files: [{ id: 'consumer-file', path: 'src/use.ts', packageId: 'consumer-pkg' }],
      imports,
    });
    const provider = packageRepo({
      id: 'provider-id',
      name: 'provider',
      packages: [{ id: 'provider-pkg', name: '@acme/types', path: '.' }],
      files: [{ id: 'provider-file', path: 'status.ts', packageId: 'provider-pkg' }],
      enums: [{ id: 'provider-status', name: 'Status', fileId: 'provider-file', isExported: true }],
    });

    const forward = linkWorkspace([consumer, provider]).packageImportEdges;
    const reversed = linkWorkspace([{ ...consumer, imports: [...imports].reverse() }, provider]).packageImportEdges;

    expect(forward).toEqual(reversed);
    expect(forward).toEqual([
      expect.objectContaining({
        id: 'resolve:package-import:a-root-import:Status:provider-status',
        sourceId: 'consumer-file',
        targetId: 'provider-status',
        properties: expect.objectContaining({ moduleSpecifier: '@acme/types' }),
      }),
    ]);
  });
});
