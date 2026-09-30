/**
 * Unified GRAPH STORAGE vocabulary — the single source of truth for the persisted
 * node/edge taxonomy and the backend-neutral graph node/edge shapes.
 *
 * This is distinct from the ID-encoding kinds in `id-generator.ts` (`NodeIdKind`/
 * `EdgeIdKind`, kebab-case segments baked into stable IDs). These `NodeType`/`EdgeType`
 * values are what the storage backends persist verbatim (the SQLite `nodes.type`/
 * `edges.type` columns, the Neo4j labels/relationship types). Both `@coredoc/db` and
 * `@coredoc/mcp` import these from here so the taxonomy is defined exactly once.
 */
import type { HopVia, ResolvedHop } from '../cross-repo/types.js';

/**
 * Node types supported in the graph (persisted as the `nodes.type` value).
 *
 * The string VALUES are byte-identical to what is persisted to SQLite / Neo4j /
 * serialized to JSON — do not change them. Callsites reference members
 * (`NodeType.Function`), never bare literals.
 */
export enum NodeType {
  Repository = 'repository',
  Package = 'package',
  File = 'file',
  Function = 'function',
  Class = 'class',
  Interface = 'interface',
  Entrypoint = 'entrypoint',
  Entity = 'entity',
  Component = 'component',
  Route = 'route',
  StateStore = 'state_store',
  TypeAlias = 'type_alias',
  Enum = 'enum',
  Variable = 'variable',
  ExternalCall = 'external_call',
}

/** Edge types supported in the graph (persisted as the `edges.type` value). */
export enum EdgeType {
  ContainsPackage = 'CONTAINS_PACKAGE',
  ContainsFile = 'CONTAINS_FILE',
  ContainsFunction = 'CONTAINS_FUNCTION',
  ContainsClass = 'CONTAINS_CLASS',
  ContainsInterface = 'CONTAINS_INTERFACE',
  ContainsTypeAlias = 'CONTAINS_TYPE_ALIAS',
  ContainsEnum = 'CONTAINS_ENUM',
  ContainsVariable = 'CONTAINS_VARIABLE',
  ContainsEntity = 'CONTAINS_ENTITY',
  ContainsComponent = 'CONTAINS_COMPONENT',
  HasMethod = 'HAS_METHOD',
  Calls = 'CALLS',
  Imports = 'IMPORTS',
  Extends = 'EXTENDS',
  ImplementsInterface = 'IMPLEMENTS_INTERFACE',
  UsesType = 'USES_TYPE',
  Handles = 'HANDLES',
  OperatesOn = 'OPERATES_ON',
  ContainsRoute = 'CONTAINS_ROUTE',
  RendersComponent = 'RENDERS_COMPONENT',
  UsesComponent = 'USES_COMPONENT',
  MakesExternalCall = 'MAKES_EXTERNAL_CALL',
  ReferencesVariable = 'REFERENCES_VARIABLE',
  ResolvesTo = 'RESOLVES_TO',
}

/**
 * Unified graph node for both backends.
 * Type-specific properties are stored in the `properties` JSON field.
 */
export interface GraphNode {
  /** Stable ID: {repoHash}:{type}:{path}:{name} */
  id: string;
  /** Node type */
  type: NodeType;
  /** Human-readable name */
  name: string;
  /** Type-specific properties as JSON */
  properties: Record<string, unknown>;
  /** AI-generated summary */
  summary?: string;
  /** Embedding vector */
  embedding?: number[];
  /** Repository ID this node belongs to */
  repoId?: string;
  /** Source file path */
  filePath?: string;
  /** Start line in source */
  startLine?: number;
  /** End line in source */
  endLine?: number;
}

/**
 * Unified graph edge for both backends.
 */
export interface GraphEdge {
  /** Edge ID (auto-generated or from source) */
  id: string;
  /** Source node ID */
  sourceId: string;
  /** Target node ID */
  targetId: string;
  /** Edge type */
  type: EdgeType;
  /** Confidence score (1.0 for parser facts, <1.0 for AI inferences) */
  confidence: number;
  /** Who created this edge */
  createdBy: 'parser' | 'ai' | 'human';
  /** Edge-specific properties as JSON */
  properties: Record<string, unknown>;
}

/**
 * A resolved cross-repo end-edge (RESOLVES_TO) with its stored multi-hop
 * provenance. `chain` is the per-hop trace persisted in the edge `properties`
 * by the unified linker — consumers walk it instead of issuing one query per hop.
 */
export interface ResolvesEdgeInfo {
  id: string;
  sourceId: string;
  targetId: string;
  confidence: number;
  via?: HopVia;
  chain?: ResolvedHop[];
  sourceRepoName?: string;
  targetRepoName?: string;
  confidenceLevel?: string;
}
