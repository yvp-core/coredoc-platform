import { NodeType } from '../types/graph.js';
import { VERSIONED_ANCHOR_NODE_TYPES } from './types.js';
import type {
  AnchorEnvelope,
  AnchorRecord,
  ParsedRepoGraphSnapshot,
  ResolvedMapping,
  ResolvedTarget,
} from './anchor-mapping-types.js';

const ANCHORABLE = new Set<string>(VERSIONED_ANCHOR_NODE_TYPES);

function targetOf(node: ParsedRepoGraphSnapshot['nodes'][number]): ResolvedTarget | undefined {
  const versionedId = node.properties.versionedId;
  if (!ANCHORABLE.has(node.type) || typeof versionedId !== 'string' || versionedId.length === 0) return undefined;
  const filePath = node.filePath ?? (node.type === NodeType.File ? String(node.properties.path ?? '') : '');
  if (!filePath) return undefined;
  return { nodeId: node.id, nodeType: node.type, capturedVersionedId: versionedId, filePath };
}

/** Source spelling is checked against graph ownership, never repaired by dropping qualifiers. */
function namedTargets(snapshot: ParsedRepoGraphSnapshot, path: string, name: string) {
  let matches = snapshot.nodes.filter((node) => node.filePath === path && node.name === name);
  const separator = name.lastIndexOf('.');
  if (matches.length === 0 && separator > 0) {
    const ownerName = name.slice(0, separator);
    const memberName = name.slice(separator + 1);
    const owners = new Set(
      snapshot.nodes
        .filter((node) => node.filePath === path && node.type === NodeType.Class && node.name === ownerName)
        .map((node) => node.id),
    );
    matches = snapshot.nodes.filter(
      (node) =>
        node.filePath === path &&
        node.name === memberName &&
        node.type === NodeType.Function &&
        node.properties.kind === 'method' &&
        typeof node.properties.classId === 'string' &&
        owners.has(node.properties.classId),
    );
  }
  if (matches.length === 2) {
    const fn = matches.find((node) => node.type === NodeType.Function && node.properties.kind === 'function');
    const component = matches.find(
      (node) =>
        node.type === NodeType.Component &&
        node.properties.framework === 'react' &&
        node.properties.componentType === 'functional',
    );
    // React's component and function projections describe one declaration; calls use the function.
    if (
      fn &&
      component &&
      typeof fn.startLine === 'number' &&
      fn.startLine > 0 &&
      fn.startLine === component.startLine &&
      typeof fn.properties.fileId === 'string' &&
      fn.properties.fileId === component.properties.fileId
    )
      return [fn];
  }
  return matches;
}

export interface EnvelopeResolution {
  graphVersionId: string;
  graphCommit: string | null;
  mappings: ResolvedMapping[];
  protectedPaths: string[];
}

export function resolveAnchorEnvelope(
  envelope: AnchorEnvelope,
  snapshot: ParsedRepoGraphSnapshot,
  anchors: readonly AnchorRecord[],
): EnvelopeResolution {
  const mappings: ResolvedMapping[] = [];
  const protectedPaths = new Set<string>();

  for (const binding of envelope.bindings) {
    const targets: ResolvedTarget[] = [];
    let failure: ResolvedMapping | undefined;
    for (const path of binding.files) {
      protectedPaths.add(path);
      const node = snapshot.nodes.find(
        (candidate) => candidate.type === NodeType.File && candidate.id === `${snapshot.repoHash}:file:${path}`,
      );
      const target = node ? targetOf(node) : undefined;
      if (!target) {
        failure = { itemId: binding.itemId, kind: 'unresolved', reason: 'target_unresolved' };
        break;
      }
      targets.push(target);
    }
    if (!failure) {
      for (const locator of binding.symbols) {
        const separator = locator.lastIndexOf('#');
        const path = locator.slice(0, separator);
        const name = locator.slice(separator + 1);
        protectedPaths.add(path);
        const matches = namedTargets(snapshot, path, name);
        if (matches.length !== 1) {
          failure = {
            itemId: binding.itemId,
            kind: 'unresolved',
            reason: matches.length === 0 ? 'target_unresolved' : 'target_ambiguous',
          };
          break;
        }
        const target = targetOf(matches[0] as ParsedRepoGraphSnapshot['nodes'][number]);
        if (!target) {
          failure = { itemId: binding.itemId, kind: 'unresolved', reason: 'target_unresolved' };
          break;
        }
        targets.push(target);
      }
    }

    const replacements = binding.replaceNodeIds.map((nodeId) =>
      anchors.find(
        (anchor) =>
          anchor.itemId === binding.itemId &&
          anchor.repoKey === snapshot.repoKey &&
          anchor.nodeId === nodeId &&
          anchor.source === 'ci',
      ),
    );
    if (!failure && replacements.some((anchor) => anchor === undefined)) {
      failure = { itemId: binding.itemId, kind: 'unresolved', reason: 'replacement_not_ci_anchor' };
    }
    for (const anchor of replacements) if (anchor) protectedPaths.add(anchor.filePath);

    if (failure) mappings.push(failure);
    else if (targets.length === 0) {
      mappings.push({
        itemId: binding.itemId,
        kind: 'no_implementation',
        targets: [],
        replaceNodeIds: binding.replaceNodeIds,
      });
    } else {
      mappings.push({ itemId: binding.itemId, kind: 'mapped', targets, replaceNodeIds: binding.replaceNodeIds });
    }
  }

  return {
    graphVersionId: snapshot.graphVersionId,
    graphCommit: snapshot.commit,
    mappings,
    protectedPaths: [...protectedPaths].sort(),
  };
}
