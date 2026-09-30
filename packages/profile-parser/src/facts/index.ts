// Internal substrate-facts layer of @coredoc/profile-parser — the deterministic
// tree-sitter structural + SCIP facts. Higher-level extraction (entrypoints,
// entities, call classification) is the profile engine's job, driven off these
// facts; this module intentionally exposes only the facts.

export const PACKAGE_NAME = '@coredoc/profile-parser';

export { CodeGraph } from './graph/graph-builder.js';
export { buildBaseline, assemble } from './pipeline.js';
export type { BaselineResult, PipelineOptions, PipelineFlags } from './pipeline.js';
export { decodeRange, isDefinition, packageSymbolKey, parseMoniker, type LoadedScip } from './scip/decode.js';
export { scipToEdges, buildMappingHooks, tagExportedMonikers } from './scip/to-edges.js';
export type {
  StructuralFile,
  StructuralClass,
  StructuralCall,
  StructuralFunction,
  StructuralInterface,
  StructuralTypeAlias,
  StructuralEnum,
  StructuralVariable,
  StructuralLocalBinding,
} from './structural/ts-structural.js';
