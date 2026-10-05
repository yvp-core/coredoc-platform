/**
 * Workspace linker — the single substrate-native cross-repo resolution pass.
 * Runs at push/link-time where cross-repo context lives.
 *
 * Builds the two hop indexes (entrypoint index for the protocol hop, SDK
 * symbol index for the moniker hop), walks every external call into a
 * ResolvedChain, and emits one RESOLVES_TO end-edge per resolved chain with the
 * full per-hop provenance carried in `properties.chain` (end-edge, not per-hop
 * edges). Unresolved calls are bucketed with a structured reason, never silently
 * dropped.
 */

import type {
  CallEdge,
  ClassNode,
  Entrypoint,
  EnumNode,
  EventEntrypointDetails,
  ExternalCallEdge,
  FileNode,
  FunctionNode,
  HttpEntrypointDetails,
  ImportEdge,
  InterfaceNode,
  Package,
  QueueEntrypointDetails,
  TypeAliasNode,
  VariableNode,
} from '../types/output.js';
import {
  buildEntrypointIndex,
  buildServiceRepoMap,
  type EntrypointLike,
  type ExternalCallLike,
} from './descriptor-matcher.js';
import type { Mapper } from './mapper-schema.js';
import { buildSdkSymbolIndex, type SdkMethodNodeLike } from './moniker-resolver.js';
import { buildSdkMappingIndex } from './sdk-mapping-fallback.js';
import { callEdgeKey, walkChains } from './chain-walker.js';
import {
  HopVia,
  type LinkEdge,
  type LinkResult,
  type PackageImportLinkEdge,
  type PackageImportTargetKind,
  type ResolvedHop,
} from './types.js';
import { compareCodeUnits } from '../utils/deterministic-order.js';

export interface ParsedRepoLike {
  id: string;
  name: string;
  /** Original repository name when `name` is a mapper-defined target-slice service name. */
  repositoryName?: string;
  entrypoints: Entrypoint[];
  externalCalls: ExternalCallEdge[];
  /**
   * Exported function/method nodes. SDK-source repos carry `.moniker` on tagged
   * nodes. The linker performs the egress join: it builds `SdkMethodNodeLike`
   * objects by joining externalCalls on `callerId === functionNodeId`, attaching the
   * matched egress `targetDescriptor` as `.egress` before passing to
   * `buildSdkSymbolIndex`. Optional — repos without SDK methods omit this.
   */
  functions?: FunctionNode[];
  /**
   * Intra-repo CALLS edges, used only by the chain-walker's call-edge hop (a caller's
   * direct edge to an in-workspace SDK method node disambiguates its egress). Optional
   * — a repo without calls behaves exactly as before.
   */
  calls?: CallEdge[];
  /** Optional existing ParsedRepo facts used only by package-import linking. */
  packages?: Package[];
  files?: FileNode[];
  imports?: ImportEdge[];
  classes?: ClassNode[];
  interfaces?: InterfaceNode[];
  typeAliases?: TypeAliasNode[];
  enums?: EnumNode[];
  variables?: VariableNode[];
  type?: string;
  /** Gateway URL prefix from RepoConfig.httpPrefix, propagated into the entrypoint index. */
  httpPrefix?: string;
}

/** Map an Entrypoint into the Phase-2 EntrypointLike (repoName + protocol details + prefix). */
function toEntrypointLike(repo: ParsedRepoLike, ep: Entrypoint): EntrypointLike | undefined {
  if (ep.type === 'http') {
    const d = ep.details as HttpEntrypointDetails;
    return {
      id: ep.id,
      repoName: repo.name,
      type: 'http',
      http: { method: d.method, path: d.path, fullPath: d.fullPath },
    };
  }
  if (ep.type === 'queue') {
    const d = ep.details as QueueEntrypointDetails;
    return {
      id: ep.id,
      repoName: repo.name,
      type: 'queue',
      system: d.system,
      destination: d.topic,
      destinationValue: d.topicValue,
    };
  }
  if (ep.type === 'event') {
    const d = ep.details as EventEntrypointDetails;
    return {
      id: ep.id,
      repoName: repo.name,
      type: 'event',
      system: d.emitter,
      destination: d.eventName,
      destinationValue: d.eventValue,
    };
  }
  return undefined;
}

function confidenceLevel(score: number): 'exact' | 'inferred' {
  return score >= 1.0 ? 'exact' : 'inferred';
}

/** Final hop's via — the mechanism that landed the end-edge — for quick filtering. */
function chainVia(hops: ResolvedHop[]): string {
  return hops.map((h) => h.via).join('+');
}

interface PackageDeclaration {
  id: string;
  name: string;
  fileId: string;
  kind: PackageImportTargetKind;
}

interface PackageCandidate {
  packageId: string;
  packageName: string;
  repoId: string;
  repoName: string;
  filesById: Map<string, FileNode>;
  declarationsByName: Map<string, Map<string, PackageDeclaration>>;
}

function packageCandidateKey(repoId: string, packageId: string): string {
  return `${repoId}\u0000${packageId}`;
}

function isPackageSpecifier(moduleSpecifier: string, packageName: string): boolean {
  return moduleSpecifier === packageName || moduleSpecifier.startsWith(`${packageName}/`);
}

function exportedDeclarations(repo: ParsedRepoLike): PackageDeclaration[] {
  const declarations: PackageDeclaration[] = [];
  for (const node of repo.classes ?? []) {
    if (node.isExported) declarations.push({ id: node.id, name: node.name, fileId: node.fileId, kind: 'class' });
  }
  for (const node of repo.interfaces ?? []) {
    if (node.isExported) declarations.push({ id: node.id, name: node.name, fileId: node.fileId, kind: 'interface' });
  }
  for (const node of repo.typeAliases ?? []) {
    if (node.isExported) declarations.push({ id: node.id, name: node.name, fileId: node.fileId, kind: 'type_alias' });
  }
  for (const node of repo.enums ?? []) {
    if (node.isExported) declarations.push({ id: node.id, name: node.name, fileId: node.fileId, kind: 'enum' });
  }
  for (const node of repo.functions ?? []) {
    if (node.kind === 'function' && node.isExported) {
      declarations.push({ id: node.id, name: node.name, fileId: node.fileId, kind: 'function' });
    }
  }
  for (const node of repo.variables ?? []) {
    if (node.isExported) declarations.push({ id: node.id, name: node.name, fileId: node.fileId, kind: 'variable' });
  }
  return declarations;
}

function linkPackageImports(repos: ParsedRepoLike[]): PackageImportLinkEdge[] {
  const candidatesByKey = new Map<string, PackageCandidate>();

  // Target slices can repeat one workspace Package. Merge those slices by the
  // real repo/package ids before ambiguity checks so slicing cannot manufacture
  // duplicate package declarations.
  for (const repo of repos) {
    const repoName = repo.repositoryName ?? repo.name;
    const packagesById = new Map((repo.packages ?? []).map((pkg) => [pkg.id, pkg]));
    const filesById = new Map((repo.files ?? []).map((file) => [file.id, file]));
    for (const pkg of packagesById.values()) {
      const key = packageCandidateKey(repo.id, pkg.id);
      const existing = candidatesByKey.get(key);
      if (existing) {
        for (const [fileId, file] of filesById) {
          if (file.packageId === pkg.id) existing.filesById.set(fileId, file);
        }
        continue;
      }
      candidatesByKey.set(key, {
        packageId: pkg.id,
        packageName: pkg.name,
        repoId: repo.id,
        repoName,
        filesById: new Map([...filesById].filter(([, file]) => file.packageId === pkg.id)),
        declarationsByName: new Map(),
      });
    }

    for (const declaration of exportedDeclarations(repo)) {
      const file = filesById.get(declaration.fileId);
      if (!file) continue;
      const candidate = candidatesByKey.get(packageCandidateKey(repo.id, file.packageId));
      if (!candidate) continue;
      candidate.filesById.set(file.id, file);
      let declarations = candidate.declarationsByName.get(declaration.name);
      if (!declarations) {
        declarations = new Map();
        candidate.declarationsByName.set(declaration.name, declarations);
      }
      declarations.set(declaration.id, declaration);
    }
  }

  const candidates = [...candidatesByKey.values()];
  const edges = new Map<string, PackageImportLinkEdge>();
  for (const sourceRepo of repos) {
    const sourceRepoName = sourceRepo.repositoryName ?? sourceRepo.name;
    const sourceFiles = new Map((sourceRepo.files ?? []).map((file) => [file.id, file]));
    for (const imported of sourceRepo.imports ?? []) {
      if (
        imported.targetFileId !== undefined ||
        imported.importKind !== 'named' ||
        !imported.importedNames ||
        imported.importedNames.length === 0
      ) {
        continue;
      }
      const sourceFile = sourceFiles.get(imported.sourceFileId);
      if (!sourceFile) continue;
      const moduleSpecifier = imported.moduleSpecifier.trim();
      const matching = candidates.filter((candidate) => isPackageSpecifier(moduleSpecifier, candidate.packageName));
      if (matching.length === 0) continue;
      const longest = Math.max(...matching.map((candidate) => candidate.packageName.length));
      const best = matching.filter((candidate) => candidate.packageName.length === longest);

      for (const importedName of imported.importedNames) {
        const matchesByDeclarationId = new Map<
          string,
          { declaration: PackageDeclaration; targetPackage: PackageCandidate }
        >();
        for (const candidate of best) {
          for (const declaration of candidate.declarationsByName.get(importedName.name)?.values() ?? []) {
            matchesByDeclarationId.set(declaration.id, { declaration, targetPackage: candidate });
          }
        }
        if (matchesByDeclarationId.size !== 1) continue;
        const { declaration, targetPackage } = matchesByDeclarationId.values().next().value as {
          declaration: PackageDeclaration;
          targetPackage: PackageCandidate;
        };
        if (targetPackage.repoId === sourceRepo.id) continue;
        const targetFile = targetPackage.filesById.get(declaration.fileId);
        if (!targetFile) continue;
        const id = `resolve:package-import:${imported.id}:${importedName.name}:${declaration.id}`;
        const edge: PackageImportLinkEdge = {
          id,
          sourceId: sourceFile.id,
          targetId: declaration.id,
          confidence: 1,
          createdBy: 'cross-repo-linker',
          properties: {
            relation: 'package-import',
            usage: 'import',
            via: importedName.alias ?? importedName.name,
            packageName: targetPackage.packageName,
            moduleSpecifier: imported.moduleSpecifier,
            importedName: importedName.name,
            ...(importedName.alias ? { importedAlias: importedName.alias } : {}),
            isTypeOnly: imported.isTypeOnly,
            importKind: imported.importKind,
            sourceRepoId: sourceRepo.id,
            sourceRepoName,
            sourceFilePath: sourceFile.path,
            targetRepoId: targetPackage.repoId,
            targetRepoName: targetPackage.repoName,
            targetPackageId: targetPackage.packageId,
            targetFileId: targetFile.id,
            targetFilePath: targetFile.path,
            targetKind: declaration.kind,
            confidenceLevel: 'exact',
          },
        };
        const storageKey = `${sourceFile.id}\u0000${declaration.id}`;
        const existing = edges.get(storageKey);
        if (!existing || compareCodeUnits(edge.id, existing.id) < 0) edges.set(storageKey, edge);
      }
    }
  }

  return [...edges.values()].sort((left, right) => compareCodeUnits(left.id, right.id));
}

export function linkWorkspace(repos: ParsedRepoLike[], override?: Mapper): LinkResult {
  // 1. Entrypoint index across the whole workspace (protocol hop targets).
  const entrypointLikes: EntrypointLike[] = [];
  for (const repo of repos) {
    for (const ep of repo.entrypoints) {
      const like = toEntrypointLike(repo, ep);
      if (like) entrypointLikes.push(like);
    }
  }
  const entrypointIndex = buildEntrypointIndex(entrypointLikes);

  // pathRewriteRules: when a call carries no `targetService`, derive one from
  // its HTTP path via the declared regex rules. The captured named group is the
  // extracted service hint, which then translates to a repo through serviceRepoMap.
  // Compiled once; bounded by MAX_PATH_REWRITE_RULES + MAX_REGEX_LENGTH in the schema.
  const pathRewriteRules = (override?.pathRewriteRules ?? []).map((rule) => ({
    re: new RegExp(rule.match),
    group: rule.targetServiceFrom,
  }));
  const serviceFromPath = (pathTemplate: string | undefined): string | undefined => {
    if (!pathTemplate) return undefined;
    // Relative SDK paths (`v2/management/…`) match the same rules as absolute ones.
    const path = pathTemplate.startsWith('/') ? pathTemplate : `/${pathTemplate}`;
    for (const { re, group } of pathRewriteRules) {
      const captured = path.match(re)?.groups?.[group];
      if (captured) return captured;
    }
    return undefined;
  };

  // 2. SDK symbol index (moniker hop targets), built from SDK-source repos.
  // Join each repo's externalCalls to its functions on callerId === functionNodeId,
  // attaching the matched egress targetDescriptor onto the SdkMethodNodeLike.
  // Only repos with functions[] are SDK-source candidates.
  const sdkRepos = repos
    .filter((r) => r.functions && r.functions.length > 0)
    .map((r) => {
      // Build a callerId → targetDescriptor map for the R4 egress join.
      const egressByCallerId = new Map<string, ExternalCallEdge['targetDescriptor']>();
      for (const ec of r.externalCalls) {
        if (ec.targetDescriptor && !egressByCallerId.has(ec.callerId)) {
          // The SDK method's egress gets the same path-derived service hint a direct
          // call gets below, so the symbol hop scopes it exactly like a direct call.
          const d = ec.targetDescriptor;
          const derived = d.targetService ? undefined : serviceFromPath(d.http?.pathTemplate);
          egressByCallerId.set(ec.callerId, derived ? { ...d, targetService: derived } : d);
        }
      }
      const functions: SdkMethodNodeLike[] = (r.functions ?? []).map((fn) => ({
        id: fn.id,
        name: fn.name,
        moniker: fn.moniker,
        egress: egressByCallerId.get(fn.id),
      }));
      // Typed class properties (`_core: Core`) map a consumer's member segment to its class.
      const memberTypes = (r.classes ?? []).flatMap((c) =>
        (c.properties ?? []).flatMap((p) => {
          const typeName = p.type?.structure?.kind === 'reference' ? p.type.structure.name : undefined;
          return typeName ? [{ name: p.name, typeName }] : [];
        }),
      );
      return { name: r.name, functions, memberTypes };
    });
  const symbolIndex = buildSdkSymbolIndex(sdkRepos);

  // 3. Flatten calls, stamping sourceRepoName + the raw moniker.
  // Honest metrics: identify calls whose service is declared unresolvable and
  // exclude them from both the edge set and the rate denominator. The count of
  // excluded calls is surfaced as `unresolvableExcluded` so the rate is honest.
  const unresolvableSet = new Set((override?.unresolvableServices ?? []).map((s) => s.trim().toLowerCase()));

  // Messaging publishers often use a transport literal such as `kafka` as their
  // serviceName, which can also appear in `unresolvableServices`. A descriptor with
  // a concrete destination is resolvable regardless of that service literal, so
  // detect it from the address-bearing shape before applying the exclusion.
  const carriesResolvableMessagingAddress = (ec: ExternalCallEdge): boolean => {
    const d = ec.targetDescriptor;
    if (d?.protocol === 'messaging') {
      return Boolean(d.messaging && (d.messaging.destinationValue ?? d.messaging.destination));
    }
    if (d?.protocol === 'ipc') return Boolean(d.ipc?.channel);
    return false;
  };

  const calls: ExternalCallLike[] = [];
  const callRepoName = new Map<string, string>();
  let unresolvableExcluded = 0;
  let total = 0;
  for (const repo of repos) {
    for (const ec of repo.externalCalls) {
      total += 1;
      const svc = (ec.targetDescriptor?.targetService ?? ec.serviceName ?? '').trim().toLowerCase();
      if (svc && unresolvableSet.has(svc) && !carriesResolvableMessagingAddress(ec)) {
        unresolvableExcluded += 1;
        continue; // skip — excluded from resolution and from the denominator
      }
      callRepoName.set(ec.id, repo.name);

      // Fill an absent targetService hint from pathRewriteRules so the walker's
      // service→repo translation has something to translate. Only synthesize when the
      // descriptor lacks its own targetService — never override a parser-supplied hint.
      let targetDescriptor = ec.targetDescriptor;
      if (targetDescriptor && !targetDescriptor.targetService) {
        const derived = serviceFromPath(targetDescriptor.http?.pathTemplate);
        if (derived) targetDescriptor = { ...targetDescriptor, targetService: derived };
      }

      calls.push({
        id: ec.id,
        callerId: ec.callerId,
        serviceName: ec.serviceName,
        sdkName: ec.sdkName,
        method: ec.method,
        dispatchMethod: ec.dispatchMethod,
        sourceRepoName: repo.name,
        targetDescriptor,
        moniker: ec.moniker,
      } as ExternalCallLike);
    }
  }

  // Workspace cfg fed to the walker:
  //  - httpPrefixByRepo: each repo's gateway prefix (from RepoConfig.httpPrefix).
  //    The entrypoint index is NOT prefix-aware on its own — `matchHttp` only tries
  //    the prefix-joined caller path when the walker passes `httpPrefix` in the
  //    per-hop RepoCfg, so an unprefixed UI caller matches a prefixed gateway
  //    entrypoint only when this map is populated and threaded through.
  //  - serviceRepoMap: translates a `targetService` HINT into the repo that owns
  //    its entrypoints before that hint scopes `matchHttp`.
  const httpPrefixByRepo: Record<string, string | undefined> = {};
  for (const repo of repos) {
    if (repo.httpPrefix) httpPrefixByRepo[repo.name] = repo.httpPrefix;
  }
  const serviceRepoMap = buildServiceRepoMap(override?.services ?? []);
  // Declarative sdkMapping fallback: moniker-independent recovery for SDK
  // calls the symbol hop misses (locally-defined clients + node_modules-less
  // consumers). Empty when the override declares no rows — then a no-op tier.
  const sdkMappingIndex = buildSdkMappingIndex(override?.sdkMappings ?? []);
  // Call-edge hop evidence: (repo, callerId) → callee node ids. NOT flat by callerId:
  // a node id embeds only a repo-NAME hash (`id-generator.ts`, which documents that
  // ids are unique within ONE graph database), so two same-named repos in a workspace
  // mint identical caller ids and a flat map would hand the hop callees the caller
  // never had. Scoping by the owning repo name is loss-free — the target-slicer
  // buckets a CALLS edge and an external call by the SAME `targetOf(callerId, ...)`,
  // so a caller and its egress always land in one slice. Left undefined when no repo
  // carries calls, keeping the hop a no-op for adapters that omit them.
  let callTargetsByCaller: Map<string, string[]> | undefined;
  for (const repo of repos) {
    for (const call of repo.calls ?? []) {
      if (!call.calleeId) continue;
      callTargetsByCaller ??= new Map();
      const key = callEdgeKey(repo.name, call.callerId);
      const callees = callTargetsByCaller.get(key);
      if (callees) callees.push(call.calleeId);
      else callTargetsByCaller.set(key, [call.calleeId]);
    }
  }
  const { chains, unresolved } = walkChains(calls, symbolIndex, entrypointIndex, {
    httpPrefixByRepo,
    serviceRepoMap,
    sdkMappingIndex,
    callTargetsByCaller,
  });

  // entrypoint id → owning repo name, to stamp targetRepoName on each edge.
  const epRepoName = new Map<string, string>();
  for (const repo of repos) {
    for (const ep of repo.entrypoints) epRepoName.set(ep.id, repo.name);
  }

  const edges: LinkEdge[] = chains
    // Self-edge policy (spec §4.5, amended in Phase 3):
    //  - HTTP (and any non-messaging) self-match (source repo === target repo): DROP. An
    //    http egress that resolves to its OWN repo's entrypoint is almost always a
    //    spurious unscoped match (a call with no service hint whose path collides with
    //    one of the caller's own routes); the cross-repo graph models inter-service
    //    edges only.
    //  - Messaging/IPC self-loop: KEEP. A service that publishes and consumes the
    //    same address is a legitimate transport edge. The discriminator is the last
    //    hop's `via`.
    .filter((chain) => {
      const isSelf = callRepoName.get(chain.sourceCallId) === epRepoName.get(chain.finalEntrypointId);
      if (!isSelf) return true;
      const via = chain.hops[chain.hops.length - 1]?.via;
      return via === HopVia.Messaging || via === HopVia.Ipc;
    })
    .map((chain) => ({
      id: `resolve:${chain.sourceCallId}:${chain.finalEntrypointId}`,
      sourceId: chain.sourceCallId,
      targetId: chain.finalEntrypointId,
      confidence: chain.confidence,
      properties: {
        chain: chain.hops,
        via: chainVia(chain.hops),
        sourceRepoName: callRepoName.get(chain.sourceCallId) ?? '',
        targetRepoName: epRepoName.get(chain.finalEntrypointId) ?? '',
        confidenceLevel: confidenceLevel(chain.confidence),
      },
    }));

  const denominator = total - unresolvableExcluded;
  const rate = denominator <= 0 ? 0 : edges.length / denominator;
  const packageImportEdges = linkPackageImports(repos);

  return {
    edges,
    packageImportEdges,
    unresolved,
    metrics: { total, resolved: edges.length, unresolvableExcluded, rate },
  };
}
