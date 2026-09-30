export * from './mapper-schema.js';
export * from './mapper-meta.js';
export * from './mapper-paths.js';
export * from './types.js';
export * from './descriptor-matcher.js';
export * from './moniker.js';
export type { SdkMethodNodeLike, SdkRepoLike } from './moniker-resolver.js';
export {
  structuralFallbackKey,
  methodNameFromNormalizedDescriptor,
  buildSdkSymbolIndex,
  matchSymbolHop,
} from './moniker-resolver.js';
export * from './chain-walker.js';
export {
  buildSdkMappingIndex,
  sdkMappingToDescriptor,
  type SdkMappingIndex,
} from './sdk-mapping-fallback.js';
export { linkWorkspace, type ParsedRepoLike } from './linker.js';
export {
  sliceParsedRepoByTarget,
  type TargetSlice,
  type ParsedRepoDataForLinking,
} from './target-slicer.js';
