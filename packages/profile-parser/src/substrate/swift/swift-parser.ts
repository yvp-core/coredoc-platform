/**
 * Swift/iOS substrate — extracts the intra-repo
 * `entities`/`dbOperations`/`calls` facts from the generic Swift extractors. All extraction
 * is generic Swift; per-repo TUNING comes from an optional SwiftProfile (globs, ORM base
 * classes, the API-protocol names, the DI container accessor). The cross-repo linker reads
 * only the `ParsedRepoLike` subset — entities/db-ops/calls never affect cross-repo edges.
 *
 * Tier-B only: tree-sitter CST, no SCIP. Never throws on a missing semantic index (there is
 * none for Swift). Frontend concepts (SwiftUI components/routes/stateStores) and iOS
 * entrypoints are a deferred follow-up increment — `entrypoints` is empty here.
 */
import {
  type CallEdge,
  type CallResolutionStats,
  type ClassNode,
  type DbOperation,
  type DbOpResolutionStats,
  type EntityNode,
  type Entrypoint,
  type ExternalCallEdge,
  type FunctionNode,
  type Package,
  type StableIdGenerator,
} from '@coredoc/core';
import type { SwiftProfile } from '../../types.js';
import { makeFileScopeDiscoverer } from '../cst-kit/file-scope.js';
import { type SwiftFile, indexSwiftDefs, parseDiContainer, resolveSwiftCalls } from './swift-callgraph.js';
import { PROTOCOL_DECL, TYPE_CONTAINERS, type TsNode, declKind, typeName } from './swift-cst.js';
import { extractSwiftDbOps } from './swift-dbops.js';
import { extractSwiftEgress } from './swift-egress.js';
import { extractSwiftEntities } from './swift-entities.js';
import { toFileNodes } from '../file-nodes.js';
import type { Substrate } from '../parse-substrate.js';

interface SwiftClassFacts {
  name: string;
  relPath: string;
  nodes: TsNode[];
  protocol: boolean;
}

/** Whether a type declaration is visible outside its Swift module. */
function isExportedType(node: TsNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const modifiers = node.child(i);
    if (modifiers?.type !== 'modifiers') continue;
    for (let j = 0; j < modifiers.childCount; j++) {
      const modifier = modifiers.child(j);
      if (modifier && modifier.type !== 'attribute' && /\b(public|open)\b/.test(modifier.text as string)) return true;
    }
  }
  return false;
}

/**
 * Emit the method-bearing facet of every Swift type referenced by `FunctionNode.classId`.
 * Extensions in another file intentionally get a file-local class node: that is the same
 * Tier-B identity the function lane already mints without a semantic cross-file index.
 */
function extractSwiftClasses(files: SwiftFile[], functions: FunctionNode[], idGen: StableIdGenerator): ClassNode[] {
  const methodsByClass = new Map<string, string[]>();
  for (const fn of functions) {
    if (fn.kind !== 'method' || fn.classId === undefined) continue;
    const methods = methodsByClass.get(fn.classId) ?? [];
    methods.push(fn.id);
    methodsByClass.set(fn.classId, methods);
  }

  const factsById = new Map<string, SwiftClassFacts>();
  for (const { relPath, root } of files) {
    for (const containerType of TYPE_CONTAINERS) {
      for (const node of root.descendantsOfType(containerType) as TsNode[]) {
        const name = typeName(node);
        if (!name) continue;
        const id = idGen.classId(relPath, name);
        if (!methodsByClass.has(id)) continue;
        const facts = factsById.get(id);
        if (facts) {
          facts.nodes.push(node);
          facts.protocol = facts.protocol || node.type === PROTOCOL_DECL;
        } else {
          factsById.set(id, { name, relPath, nodes: [node], protocol: node.type === PROTOCOL_DECL });
        }
      }
    }
  }

  return [...factsById.entries()].map(([id, facts]) => {
    facts.nodes.sort((a, b) => a.startIndex - b.startIndex);
    const declaration = facts.nodes.find((node) => declKind(node) !== 'extension') ?? facts.nodes[0];
    const source = facts.nodes.map((node) => node.text as string).join('\n');
    return {
      id,
      versionedId: idGen.versionedId(id, source),
      name: facts.name,
      kind: 'class',
      fileId: idGen.fileId(facts.relPath),
      isExported: isExportedType(declaration),
      isAbstract: facts.protocol,
      methods: methodsByClass.get(id) ?? [],
      properties: [],
      constructor: undefined,
      location: {
        filePath: facts.relPath,
        startLine: declaration.startPosition.row + 1,
        endLine: declaration.endPosition.row + 1,
      },
    };
  });
}

/**
 * The scorer-facing source scope, derived by the same discovery policy as the parser.
 *
 * It takes `excludeDefaults` like every sibling substrate, but this one ships no built-in
 * exclusions, so there is nothing for the opt-out to remove until it does.
 */
export const discoverSwiftFileScope = makeFileScopeDiscoverer({
  extensions: ['.swift'],
  defaultInclude: ['**/*.swift'],
});

/**
 * The Swift substrate. Entity/db-op extraction runs when the profile declares `entities` (the ORM
 * base classes); egress + call graph always run. No SCIP: Tier-B only.
 */
export const swiftSubstrate: Substrate<SwiftProfile, SwiftFile> = {
  language: 'swift',
  parserVersion: '1.2.1-swift',
  grammar: 'swift',
  scope: (profile, root) =>
    discoverSwiftFileScope(root, profile.substrate.include ?? [], profile.substrate.exclude ?? []),

  async extract({ name, profile, idGen, files }) {
    // DI-accessor resolution runs only when the profile declares its container (no hardcoded default).
    const di = parseDiContainer(profile.di?.containerAccessor);
    const index = indexSwiftDefs(files, idGen, di?.root);

    // Egress — the cross-repo win.
    const externalCalls: ExternalCallEdge[] = extractSwiftEgress(files, idGen, {
      targetTypeProtocols: profile.egress?.targetTypeProtocols,
    });

    // Intra-repo data facts. Emit db-ops whenever entities are emitted (else the language-neutral
    // entities-but-0-dbops red flag would force a FAIL).
    let entities: EntityNode[] = [];
    let dbOperations: DbOperation[] = [];
    let dbOpResolution: DbOpResolutionStats | undefined;
    if (profile.entities) {
      const res = extractSwiftEntities(files, {
        idGen,
        baseClasses: profile.entities.baseClasses ?? ['Object'],
        orm: profile.entities.orm,
      });
      entities = res.entities;
      const dbRes = extractSwiftDbOps(files, res.entityIdByName, idGen, {
        opMap: profile.dbOperations?.opMap,
        entityTypealias: profile.dbOperations?.entityTypealias,
        receiverPattern: profile.dbOperations?.receiverPattern,
      });
      dbOperations = dbRes.dbOperations;
      dbOpResolution = dbRes.stats;
    }

    // Tier-B call graph (resolved, high-precision idioms only).
    const callResolution: CallResolutionStats = { callSites: 0, resolvedCalls: 0, outOfScopeCalls: 0 };
    const calls: CallEdge[] = resolveSwiftCalls(files, index, idGen, di, callResolution);

    const functions: FunctionNode[] = [...index.byId.values()];
    const rootPackageId = idGen.packageId('.');
    const packages: Package[] = [{ id: rootPackageId, name, path: '.' }];
    const fileNodes = toFileNodes(files, idGen, {
      language: 'swift',
      commentPrefix: '//',
      packageIdFor: () => rootPackageId,
    });
    const classes = extractSwiftClasses(files, functions, idGen);
    const entrypoints: Entrypoint[] = []; // deferred to the follow-up increment (step 10)

    return {
      type: 'mobile',
      packages,
      files: fileNodes,
      functions,
      classes,
      entrypoints,
      entities,
      dbOperations,
      calls,
      externalCalls,
      stats: { totalImports: 0, callResolution, dbOpResolution },
    };
  },
};
