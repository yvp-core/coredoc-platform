import type { ExternalCallTarget } from '../types/output.js';

export enum HopVia {
  Moniker = 'moniker',
  /** Symbol hop landed through an intra-repo CALLS edge from the caller to the SDK method node. */
  CallEdge = 'call-edge',
  Http = 'http',
  Messaging = 'messaging',
  Ipc = 'ipc',
  Override = 'override',
}

export enum UnresolvedCode {
  NoMonikerMatch = 'no-moniker-match',
  NoPath = 'no-path',
  NoEntrypointMatch = 'no-entrypoint-match',
  Ambiguous = 'ambiguous',
  NoDestination = 'no-destination',
  NoMessagingMatch = 'no-messaging-match',
  UnsupportedProtocol = 'unsupported-protocol',
}

export interface ResolvedHop {
  kind: 'symbol' | 'protocol';
  sourceId: string;
  targetId: string;
  via: HopVia;
  confidence: number;
}
export interface UnresolvedReason {
  sourceId: string;
  code: UnresolvedCode;
  detail?: string;
}
export type HopResult = ResolvedHop | UnresolvedReason;
export function isResolved(r: HopResult): r is ResolvedHop {
  return 'targetId' in r;
}

export interface SdkSymbolEntry {
  packageName: string;
  normalizedDescriptor: string;
  methodNodeId: string;
  egress?: ExternalCallTarget;
}
export interface ResolvedChain {
  sourceCallId: string;
  finalEntrypointId: string;
  hops: ResolvedHop[];
  confidence: number;
}
export interface LinkEdge {
  id: string;
  sourceId: string;
  targetId: string;
  confidence: number;
  properties: Record<string, unknown>;
}

export type PackageImportTargetKind = 'class' | 'interface' | 'type_alias' | 'enum' | 'function' | 'variable';

/**
 * Deterministic cross-repo dependency from an importing File to one exported
 * top-level declaration. Kept separate from protocol LinkEdges so HTTP/SDK
 * resolution metrics and external-call reconciliation retain their meaning.
 */
export interface PackageImportLinkEdge extends LinkEdge {
  confidence: 1;
  createdBy: 'cross-repo-linker';
  properties: {
    relation: 'package-import';
    usage: 'import';
    via: string;
    packageName: string;
    moduleSpecifier: string;
    importedName: string;
    importedAlias?: string;
    isTypeOnly: boolean;
    importKind: 'named' | 'default' | 'namespace' | 'side-effect';
    sourceRepoId: string;
    sourceRepoName: string;
    sourceFilePath: string;
    targetRepoId: string;
    targetRepoName: string;
    targetPackageId: string;
    targetFileId: string;
    targetFilePath: string;
    targetKind: PackageImportTargetKind;
    confidenceLevel: 'exact';
  };
}
export interface LinkResult {
  edges: LinkEdge[];
  /** Package-import links derived only when ParsedRepo package facts are available. */
  packageImportEdges?: PackageImportLinkEdge[];
  unresolved: UnresolvedReason[];
  metrics: { total: number; resolved: number; unresolvableExcluded: number; rate: number };
}
