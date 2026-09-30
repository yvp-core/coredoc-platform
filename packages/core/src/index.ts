/**
 * @coredoc/core
 *
 * Core types, utilities, and ID generation for coredoc-parser.
 */

// Types
export * from './types/index.js';

// Coverage sentences shared by the CLI integrity report and the MCP coverage surfaces.
export * from './coverage-text.js';

// ID Generation
export {
  StableIdGenerator,
  generateRepoHash,
  createIdGenerator,
  IdGeneratorManager,
  idGeneratorManager,
  type NodeIdKind,
  type EdgeIdKind,
  type ParsedId,
} from './id-generator.js';

// Filesystem Utilities
export * from './utils/index.js';

// Cross-Repo (mapper schema, etc.)
// Named re-exports to avoid ambiguity with overlapping names in utils/types.
export * from './cross-repo/mapper-schema.js';
export * from './cross-repo/mapper-meta.js';
export * from './cross-repo/mapper-paths.js';
// Workspace linker. Re-exported from linker.ts; avoids callers
// having to reach into the cross-repo sub-path.
export { linkWorkspace, type ParsedRepoLike } from './cross-repo/linker.js';

// Push-time target slicing: split a merged multi-target ParsedRepo into one
// ParsedRepoLike per profile target so the linker resolves intra-repo ui→backend edges.
export {
  sliceParsedRepoByTarget,
  type TargetSlice,
  type ParsedRepoDataForLinking,
} from './cross-repo/target-slicer.js';

// Declarative sdkMapping fallback (moniker-independent cross-repo recovery).
export {
  buildSdkMappingIndex,
  sdkMappingToDescriptor,
  type SdkMappingIndex,
} from './cross-repo/sdk-mapping-fallback.js';

// Cross-repo linking types and protocol-hop matcher, re-exported with
// explicit named re-exports (`buildEntrypointIndex`, `EntrypointIndex`,
// `normalizePath`) for callers of `@coredoc/core`.
export type {
  ResolvedHop,
  UnresolvedReason,
  HopResult,
  SdkSymbolEntry,
  ResolvedChain,
  LinkEdge,
  LinkResult,
} from './cross-repo/types.js';
export { HopVia, UnresolvedCode, isResolved } from './cross-repo/types.js';
export type {
  EntrypointLike,
  ExternalCallLike,
  RepoCfg,
} from './cross-repo/descriptor-matcher.js';
export {
  normalizePath,
  normalizeServiceName,
  buildEntrypointIndex,
  matchProtocolHop,
} from './cross-repo/descriptor-matcher.js';
export type { EntrypointIndex } from './cross-repo/descriptor-matcher.js';

// Product-intent overlay (.coredoc/intent.json) — durable, outside ParsedRepo.
export * from './intent/index.js';

// Version
export const VERSION = '1.0.0';
