/**
 * Graph repository → ParsedRepoLike adapter
 *
 * Builds a workspace-wide `ParsedRepoLike[]` through the graph repository
 * abstraction, feeding `linkWorkspace` for live and snapshot resolution.
 *
 * Notes:
 *  - `httpPrefix` lives on the Postgres control plane (`WorkspaceRepo`), not
 *    in Turso. Callers (ResolverService) pass it in as a `Map<repoName,
 *    httpPrefix>` so the adapter doesn't have to do a second control-plane
 *    call. Without this, descriptor matching still works but loses the
 *    prefix-strip fallback that local CLI resolution uses.
 *  - Detail reads are batched by exact repo keys. Result IDs are mapped back to
 *    the verified pinned identities because detail rows omit `repoName`.
 *  - `ExternalCallInfo` carries protocol-specific fields flat (httpMethod,
 *    pathTemplate, messaging destination). We rebuild a structured `targetDescriptor`
 *    here so the linker sees the same shape as a parsed repo.
 */

import type {
  IGraphReadRepository,
  ExternalCallInfo,
  RepoSummary,
  FunctionInfo,
  PackageInfo,
  PackageLinkerFacts,
} from '@coredoc/db';
import type { HttpMethod, ExternalCallTarget, ParsedRepoLike } from '@coredoc/core';
import type {
  CallEdge,
  ClassNode,
  Entrypoint,
  EnumNode,
  ExternalCallEdge,
  FileNode,
  FunctionNode,
  ImportEdge,
  InterfaceNode,
  Package,
  TypeAliasNode,
  VariableNode,
} from '@coredoc/core/types';
import { compareCodeUnits } from '@coredoc/core/utils';

function rebuildTargetDescriptor(call: ExternalCallInfo): ExternalCallTarget | undefined {
  // Source of truth: the parser-emitted `targetService` (e.g. canonical
  // 'walle'), distinct from `serviceName` which may be the client class
  // ('sampleApiClient'). Falls back to `serviceName` for legacy rows that
  // pre-date the `targetService` property in external_call nodes.
  const targetService = call.targetService ?? call.serviceName;
  if (call.protocol === 'http' && call.httpMethod && call.pathTemplate) {
    return {
      protocol: 'http',
      targetService,
      http: {
        method: call.httpMethod as HttpMethod,
        pathTemplate: call.pathTemplate,
      },
    };
  }
  if (call.protocol === 'messaging' && call.messagingDestination) {
    const destination = call.messagingDestinationRef ?? call.messagingDestination;
    return {
      protocol: 'messaging',
      targetService,
      messaging: {
        system: call.messagingSystem ?? '',
        destination,
        ...(destination !== call.messagingDestination ? { destinationValue: call.messagingDestination } : {}),
      },
    };
  }
  if (call.protocol === 'ipc' && call.messagingDestination) {
    return {
      protocol: 'ipc',
      targetService,
      ipc: {
        channel: call.messagingDestination,
        direction: (call.ipcDirection ?? 'send') as NonNullable<ExternalCallTarget['ipc']>['direction'],
      },
    };
  }
  // gRPC / GraphQL / internal: pass through protocol + targetService only so
  // the matcher can report an explicit unsupported-protocol reason.
  return {
    protocol: call.protocol as ExternalCallTarget['protocol'],
    targetService,
  };
}

export interface PinnedResolverRepo {
  repoKey: string;
  repoName: string;
  httpPrefix: string | null;
}

export type PinnedResolverReadRepository = Pick<
  IGraphReadRepository,
  | 'listAllRepositories'
  | 'listEntrypoints'
  | 'getExternalCalls'
  | 'getMonikeredFunctions'
  | 'getInternalCallEdges'
  | 'getPackages'
  | 'getPackageLinkerFacts'
>;

function comparePinnedRepo(left: PinnedResolverRepo, right: PinnedResolverRepo): number {
  return compareCodeUnits(left.repoKey, right.repoKey) || compareCodeUnits(left.repoName, right.repoName);
}

function compareById(left: { id: string }, right: { id: string }): number {
  return compareCodeUnits(left.id, right.id);
}

function appendTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function functionNodeFromInfo(fn: FunctionInfo): FunctionNode {
  return {
    id: fn.id,
    versionedId: fn.versionedId ?? '',
    name: fn.name,
    kind: fn.kind,
    fileId: fn.fileId ?? '',
    location: { filePath: fn.filePath, startLine: fn.startLine, endLine: fn.endLine },
    isAsync: fn.isAsync,
    isGenerator: fn.isGenerator ?? false,
    parameters: [],
    ...(fn.isExported !== undefined ? { isExported: fn.isExported } : {}),
    ...(fn.classId ? { classId: fn.classId } : {}),
    ...(fn.visibility ? { visibility: fn.visibility } : {}),
    ...(fn.isStatic !== undefined ? { isStatic: fn.isStatic } : {}),
    ...(fn.isAbstract !== undefined ? { isAbstract: fn.isAbstract } : {}),
    ...(fn.complexity !== undefined ? { complexity: fn.complexity } : {}),
    ...(fn.documentation ? { documentation: fn.documentation } : {}),
    ...(fn.sourceCode ? { sourceCode: fn.sourceCode } : {}),
    ...(fn.moniker ? { moniker: fn.moniker } : {}),
  };
}

function assertUniquePinnedIdentities(repos: readonly PinnedResolverRepo[]): void {
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const repo of repos) {
    if (!repo.repoKey || !repo.repoName) throw new Error('Pinned repository identity requires repoKey and repoName');
    if (keys.has(repo.repoKey) || names.has(repo.repoName)) {
      throw new Error(`Duplicate pinned repository identity: ${repo.repoKey} (${repo.repoName})`);
    }
    keys.add(repo.repoKey);
    names.add(repo.repoName);
  }
}

function verifyPinnedIdentities(expected: readonly PinnedResolverRepo[], actual: readonly RepoSummary[]): void {
  const actualIdentities = new Set(actual.map((repo) => `${repo.hash}\0${repo.name}`));
  if (actual.length !== expected.length || actualIdentities.size !== actual.length) {
    throw new Error(
      `Pinned repository identity mismatch: expected ${expected.length} repositories, got ${actual.length}`,
    );
  }
  for (const repo of expected) {
    if (!actualIdentities.has(`${repo.repoKey}\0${repo.repoName}`)) {
      throw new Error(`Pinned repository identity mismatch for ${repo.repoKey} (${repo.repoName})`);
    }
  }
}

function ownerForNodeId(nodeId: string, repos: readonly PinnedResolverRepo[]): PinnedResolverRepo {
  const owners = repos.filter((repo) => nodeId.startsWith(`${repo.repoKey}:`));
  if (owners.length !== 1) {
    throw new Error(`Graph row ${nodeId} does not belong uniquely to the pinned repository set`);
  }
  return owners[0] as PinnedResolverRepo;
}

/**
 * Rebuild deterministic linker inputs from exactly the repository identities
 * pinned by a snapshot manifest. Missing, additional, or mismatched graph
 * identities fail before any detail row is accepted.
 */
export async function parsedReposFromRepository(
  repository: PinnedResolverReadRepository,
  pinnedRepos: readonly PinnedResolverRepo[],
  signal?: AbortSignal,
  prefetchedRepos?: readonly RepoSummary[],
): Promise<ParsedRepoLike[]> {
  signal?.throwIfAborted();
  if (pinnedRepos.length === 0) return [];
  assertUniquePinnedIdentities(pinnedRepos);
  const orderedRepos = [...pinnedRepos].sort(comparePinnedRepo);
  const repoNames = orderedRepos.map((repo) => repo.repoName);
  const graphRepos = prefetchedRepos ?? (await repository.listAllRepositories(repoNames));
  signal?.throwIfAborted();
  verifyPinnedIdentities(orderedRepos, graphRepos);

  const repoKeys = orderedRepos.map((repo) => repo.repoKey);
  const entrypoints = (await repository.listEntrypoints({}, repoKeys)).sort(compareById);
  signal?.throwIfAborted();
  const externalCalls = (await repository.getExternalCalls(repoKeys)).sort(compareById);
  signal?.throwIfAborted();
  const monikeredFunctions = (await repository.getMonikeredFunctions(repoKeys)).sort(compareById);
  signal?.throwIfAborted();
  // Call-edge hop evidence: intra-repo CALLS edges INTO the monikered SDK method
  // nodes. The callee set is exactly the join target the chain-walker's call-edge
  // hop can use, so the read stays bounded (never a whole-workspace CALLS scan)
  // and a snapshot whose backend omits the projection degrades to the pre-hop
  // behaviour instead of failing.
  const monikeredFunctionIds = monikeredFunctions.map((fn) => fn.id);
  const internalCallEdges =
    repository.getInternalCallEdges && monikeredFunctionIds.length > 0
      ? await repository.getInternalCallEdges(repoKeys, monikeredFunctionIds)
      : [];
  signal?.throwIfAborted();

  const functionsByRepoKey = new Map<string, Map<string, FunctionNode>>();
  for (const fn of monikeredFunctions) {
    const owner = ownerForNodeId(fn.id, orderedRepos);
    const functions = functionsByRepoKey.get(owner.repoKey) ?? new Map<string, FunctionNode>();
    functions.set(fn.id, functionNodeFromInfo(fn));
    functionsByRepoKey.set(owner.repoKey, functions);
  }

  // Only `callerId`/`calleeId` are read downstream (the chain-walker folds these
  // into its caller → callee map), so the remaining required CallEdge fields are
  // explicit stubs — the same shape-completion the entrypoint/externalCall
  // reconstructions above use.
  const callsByRepoKey = new Map<string, CallEdge[]>();
  for (const edge of [...internalCallEdges].sort(
    (left, right) => compareCodeUnits(left.callerId, right.callerId) || compareCodeUnits(left.calleeId, right.calleeId),
  )) {
    const owner = ownerForNodeId(edge.callerId, orderedRepos);
    appendTo(callsByRepoKey, owner.repoKey, {
      id: `${edge.callerId}->${edge.calleeId}`,
      callerId: edge.callerId,
      calleeId: edge.calleeId,
      calleeExpression: '',
      isMethodCall: false,
      location: { filePath: '', startLine: 0, endLine: 0 },
    });
  }

  const packagesByRepoKey = new Map<string, Package[]>();
  const filesByRepoKey = new Map<string, FileNode[]>();
  const importsByRepoKey = new Map<string, ImportEdge[]>();
  const classesByRepoKey = new Map<string, ClassNode[]>();
  const interfacesByRepoKey = new Map<string, InterfaceNode[]>();
  const typeAliasesByRepoKey = new Map<string, TypeAliasNode[]>();
  const enumsByRepoKey = new Map<string, EnumNode[]>();
  const variablesByRepoKey = new Map<string, VariableNode[]>();

  // Package-import links are cross-repo by definition, so a one-repo project
  // cannot produce one and avoids both projection reads entirely.
  if (orderedRepos.length > 1) {
    const storedPackages: PackageInfo[] = (await repository.getPackages(repoKeys)).sort((left, right) =>
      compareCodeUnits(left.id ?? '', right.id ?? ''),
    );
    signal?.throwIfAborted();
    const packageFacts: PackageLinkerFacts = await repository.getPackageLinkerFacts(repoKeys);
    signal?.throwIfAborted();

    // Data-quality faults degrade the affected row; ISOLATION faults still fail closed.
    // A read projection must not let one malformed row abort resolution for an entire
    // workspace (target-slicer states the same policy for push). Cross-repository
    // violations below are deliberately NOT in this bucket — those stay hard errors.
    const skipped: string[] = [];
    const packageOwnerById = new Map<string, PinnedResolverRepo>();
    for (const storedPackage of storedPackages) {
      if (!storedPackage.id) {
        skipped.push(`Package ${storedPackage.name}: missing id`);
        continue;
      }
      if (packageOwnerById.has(storedPackage.id)) {
        skipped.push(`Package ${storedPackage.id}: duplicate id`);
        continue;
      }
      const owner = ownerForNodeId(storedPackage.id, orderedRepos);
      if (storedPackage.repoId !== undefined && storedPackage.repoId !== owner.repoKey) {
        throw new Error(`Package linker Package ${storedPackage.id} has mismatched repoId`);
      }
      packageOwnerById.set(storedPackage.id, owner);
      appendTo(packagesByRepoKey, owner.repoKey, {
        id: storedPackage.id,
        name: storedPackage.name,
        path: storedPackage.path,
        ...(storedPackage.language ? { language: storedPackage.language } : {}),
        ...(storedPackage.description ? { description: storedPackage.description } : {}),
      });
    }

    const filesById = new Map<string, FileNode>();
    for (const storedFile of [...packageFacts.files].sort(compareById)) {
      if (filesById.has(storedFile.id)) {
        skipped.push(`File ${storedFile.id}: duplicate id`);
        continue;
      }
      const owner = ownerForNodeId(storedFile.id, orderedRepos);
      const packageOwner = packageOwnerById.get(storedFile.packageId);
      if (!packageOwner || packageOwner.repoKey !== owner.repoKey) {
        throw new Error(`Package linker File ${storedFile.id} references a Package outside its pinned repository`);
      }
      const file: FileNode = {
        id: storedFile.id,
        versionedId: '',
        path: storedFile.path,
        extension: '',
        packageId: storedFile.packageId,
        language: '',
        ...(storedFile.target ? { target: storedFile.target } : {}),
        contentHash: '',
      };
      filesById.set(file.id, file);
      appendTo(filesByRepoKey, owner.repoKey, file);
      for (const imported of storedFile.imports) {
        appendTo(importsByRepoKey, owner.repoKey, {
          id: imported.id,
          sourceFileId: storedFile.id,
          moduleSpecifier: imported.moduleSpecifier,
          isTypeOnly: imported.isTypeOnly,
          importKind: imported.importKind,
          importedNames: imported.importedNames.map(({ name, alias }) => ({
            name,
            ...(alias ? { alias } : {}),
          })),
        });
      }
    }

    for (const declaration of [...packageFacts.declarations].sort(compareById)) {
      const file = filesById.get(declaration.fileId);
      if (!file) {
        skipped.push(`declaration ${declaration.id}: references an unprojected File`);
        continue;
      }
      const owner = ownerForNodeId(declaration.id, orderedRepos);
      const fileOwner = ownerForNodeId(file.id, orderedRepos);
      if (owner.repoKey !== fileOwner.repoKey) {
        throw new Error(`Package linker declaration ${declaration.id} references a File in another repository`);
      }
      const base = {
        id: declaration.id,
        versionedId: '',
        name: declaration.name,
        fileId: declaration.fileId,
        isExported: true,
        location: { filePath: file.path, startLine: 0, endLine: 0 },
      };
      switch (declaration.kind) {
        case 'class':
          appendTo(classesByRepoKey, owner.repoKey, {
            ...base,
            kind: 'class',
            isAbstract: false,
            methods: [],
            constructor: undefined,
            properties: [],
          });
          break;
        case 'interface':
          appendTo(interfacesByRepoKey, owner.repoKey, { ...base, kind: 'interface', members: [] });
          break;
        case 'type_alias':
          appendTo(typeAliasesByRepoKey, owner.repoKey, {
            ...base,
            kind: 'type-alias',
            aliasedType: { text: '' },
          });
          break;
        case 'enum':
          appendTo(enumsByRepoKey, owner.repoKey, { ...base, kind: 'enum', isConst: false, members: [] });
          break;
        case 'function': {
          const functions = functionsByRepoKey.get(owner.repoKey) ?? new Map<string, FunctionNode>();
          const existing = functions.get(declaration.id);
          if (existing && existing.kind !== 'function') {
            skipped.push(`declaration ${declaration.id}: conflicts with a monikered method`);
            break;
          }
          functions.set(
            declaration.id,
            existing
              ? { ...existing, fileId: existing.fileId || declaration.fileId, isExported: true }
              : {
                  ...base,
                  kind: 'function',
                  isAsync: false,
                  isGenerator: false,
                  parameters: [],
                },
          );
          functionsByRepoKey.set(owner.repoKey, functions);
          break;
        }
        case 'variable':
          appendTo(variablesByRepoKey, owner.repoKey, { ...base, kind: 'variable', declarationKind: 'const' });
          break;
      }
    }

    if (skipped.length > 0) {
      console.warn(
        `[coredoc] package linker projection: skipped ${skipped.length} malformed row(s) — ` +
          `${skipped.slice(0, 5).join('; ')}${skipped.length > 5 ? ` (+${skipped.length - 5} more)` : ''}`,
      );
    }
  }

  const buckets = new Map<string, ParsedRepoLike>();
  for (const repo of orderedRepos) {
    const functions = [...(functionsByRepoKey.get(repo.repoKey)?.values() ?? [])].sort(compareById);
    buckets.set(repo.repoKey, {
      id: repo.repoKey,
      name: repo.repoName,
      httpPrefix: repo.httpPrefix ?? undefined,
      entrypoints: [],
      externalCalls: [],
      functions,
      calls: callsByRepoKey.get(repo.repoKey) ?? [],
      packages: packagesByRepoKey.get(repo.repoKey) ?? [],
      files: filesByRepoKey.get(repo.repoKey) ?? [],
      imports: importsByRepoKey.get(repo.repoKey) ?? [],
      classes: classesByRepoKey.get(repo.repoKey) ?? [],
      interfaces: interfacesByRepoKey.get(repo.repoKey) ?? [],
      typeAliases: typeAliasesByRepoKey.get(repo.repoKey) ?? [],
      enums: enumsByRepoKey.get(repo.repoKey) ?? [],
      variables: variablesByRepoKey.get(repo.repoKey) ?? [],
    });
  }

  for (const ep of entrypoints) {
    const owner = ownerForNodeId(ep.id, orderedRepos);
    const bucket = buckets.get(owner.repoKey) as ParsedRepoLike;

    let details: Entrypoint['details'];
    if (ep.type === 'http' && ep.method) {
      details = { type: 'http', method: ep.method, path: ep.path ?? '', fullPath: ep.fullPath ?? ep.path ?? '' };
    } else if (ep.type === 'queue') {
      details = {
        type: 'queue',
        system: ep.system ?? '',
        topic: ep.destination ?? ep.topic ?? '',
        topicValue: ep.destinationValue ?? ep.topicValue,
      };
    } else if (ep.type === 'event') {
      details = {
        type: 'event',
        eventName: ep.destination ?? ep.eventName ?? ep.topic ?? '',
        eventValue: ep.destinationValue,
        emitter: ep.system,
      };
    } else {
      details = { type: ep.type as 'cron', schedule: '' };
    }

    (bucket.entrypoints as Entrypoint[]).push({
      id: ep.id,
      versionedId: ep.versionedId ?? '',
      type: ep.type,
      handlerId: ep.handlerId,
      location: { filePath: ep.filePath, startLine: ep.startLine, endLine: ep.endLine ?? ep.startLine },
      details,
    });
  }

  for (const call of externalCalls) {
    const owner = ownerForNodeId(call.id, orderedRepos);
    const bucket = buckets.get(owner.repoKey) as ParsedRepoLike;
    (bucket.externalCalls as ExternalCallEdge[]).push({
      id: call.id,
      versionedId: '',
      callerId: call.callerId,
      serviceName: call.serviceName,
      sdkName: call.sdkName,
      method: call.method,
      targetDescriptor: rebuildTargetDescriptor(call),
      moniker: call.moniker,
      dispatchMethod: call.dispatchMethod,
      location: { filePath: call.filePath, startLine: call.startLine, endLine: call.startLine },
    });
  }

  signal?.throwIfAborted();
  return orderedRepos.map((repo) => buckets.get(repo.repoKey) as ParsedRepoLike);
}
