import type { GraphNode } from '../types/graph.js';

export interface AnchorBinding {
  itemId: string;
  files: string[];
  symbols: string[];
  replaceNodeIds: string[];
}

export interface AnchorEnvelope {
  schemaVersion: 1;
  headSha: string;
  bindings: AnchorBinding[];
}

export interface AnchorRecord {
  itemId: string;
  repoKey: string;
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
  filePath: string;
  source: 'ci' | 'manual';
  disabledAt?: string;
  disabledBy?: string;
}

export interface ResolvedTarget {
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
  filePath: string;
}

export type ResolvedMapping =
  | { itemId: string; kind: 'mapped'; targets: ResolvedTarget[]; replaceNodeIds: string[] }
  | { itemId: string; kind: 'no_implementation'; targets: []; replaceNodeIds: string[] }
  | {
      itemId: string;
      kind: 'unresolved';
      reason: 'target_unresolved' | 'target_ambiguous' | 'replacement_not_ci_anchor';
    };

export interface ParsedRepoGraphSnapshot {
  graphVersionId: string;
  commit: string | null;
  repoKey: string;
  repoHash: string;
  nodes: readonly GraphNode[];
}
