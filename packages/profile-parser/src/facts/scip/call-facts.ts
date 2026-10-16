import type { CallEdge, CallResolutionStats, StableIdGenerator } from '@coredoc/core';
import type { TsNode } from '../../tree-sitter/tree-sitter-loader.js';
import { decodeRange, isDefinition } from './decode.js';
import { assertScipSources, type SourceCheckedScip } from './source-manifest.js';

/** Language substrates supply exact declaration/call tokens; ordinary references are not calls. */
export interface ScipCallFile {
  path: string;
  source: string;
  defaultPositionEncoding: 1 | 2;
  definitions: { line: number; start: number; end: number; id: string; name: string }[];
  calls: { line: number; start: number; end: number; name: string; edge: CallEdge }[];
}

/** How one language's CST maps onto `ScipCallFile` tokens. */
export interface ScipCallSpec {
  /** Function-definition node types: their `name` field is the definition token and they own calls. */
  definitions: string[];
  /** Call node type. */
  call: string;
  defaultPositionEncoding: 1 | 2;
  functionId(idGen: StableIdGenerator, relPath: string, node: TsNode): string;
  /** The invocation token of a call (an identifier/field_identifier, else skipped) and its call shape. */
  callee(call: TsNode): { token: TsNode | null | undefined; isMethodCall: boolean };
}

/** Only actual invocation tokens enter the SCIP call join; values/references do not. */
export function scipCallFacts(spec: ScipCallSpec) {
  const defTypes = new Set(spec.definitions);
  return (files: { relPath: string; source: string; root: TsNode }[], idGen: StableIdGenerator): ScipCallFile[] =>
    files.map((file) => {
      const definitions: ScipCallFile['definitions'] = [];
      const calls: ScipCallFile['calls'] = [];
      for (const def of file.root.descendantsOfType(spec.definitions) as TsNode[]) {
        const name = def.childForFieldName('name');
        if (name)
          definitions.push({
            line: name.startPosition.row,
            start: name.startPosition.column,
            end: name.endPosition.column,
            id: spec.functionId(idGen, file.relPath, def),
            name: name.text,
          });
      }
      for (const call of file.root.descendantsOfType(spec.call) as TsNode[]) {
        let owner = call.parent;
        while (owner && !defTypes.has(owner.type)) owner = owner.parent;
        if (!owner) continue;
        const { token, isMethodCall } = spec.callee(call);
        if (!token || !['identifier', 'field_identifier'].includes(token.type)) continue;
        const callerId = spec.functionId(idGen, file.relPath, owner);
        const line = call.startPosition.row + 1;
        const calleeExpression = call.text.split('\n')[0].slice(0, 120);
        calls.push({
          line: token.startPosition.row,
          start: token.startPosition.column,
          end: token.endPosition.column,
          name: token.text,
          edge: {
            id: idGen.callEdgeId(callerId, calleeExpression, `${file.relPath}:${line}`),
            callerId,
            calleeExpression,
            isMethodCall,
            location: { filePath: file.relPath, startLine: line, endLine: call.endPosition.row + 1 },
          },
        });
      }
      return {
        path: file.relPath,
        source: file.source,
        defaultPositionEncoding: spec.defaultPositionEncoding,
        definitions,
        calls,
      };
    });
}

/** Join compiler identities onto existing graph IDs, without importing any language grammar. */
export function mergeScipCallFacts(
  index: SourceCheckedScip,
  files: ScipCallFile[],
  basic: CallEdge[],
  stats: CallResolutionStats,
) {
  assertScipSources(index, files);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const names = new Set(files.flatMap((file) => file.definitions.map((def) => def.name)));
  const definitions = new Map<string, Set<string>>();
  const references: { symbol: string; site: ScipCallFile['calls'][number] }[] = [];
  const localKey = (symbol: string, file: string) => (symbol.startsWith('local ') ? `${file}\0${symbol}` : symbol);
  for (const doc of index.documents) {
    const file = byPath.get(doc.relativePath.replace(/^\.\//, ''));
    if (!file) continue;
    const encoding = doc.positionEncoding || file.defaultPositionEncoding;
    if (encoding !== 1 && encoding !== 2)
      throw new Error(`Unsupported compiler position encoding ${encoding} in ${doc.relativePath}.`);
    const lines = file.source.split('\n');
    const key = (line: number, start: number, end: number) => `${line}:${start}:${end}`;
    const defs = new Map(file.definitions.map((def) => [key(def.line, def.start, def.end), def]));
    const sites = new Map(file.calls.map((site) => [key(site.line, site.start, site.end), site]));
    for (const occurrence of doc.occurrences) {
      const range = decodeRange(occurrence.range);
      if (range.startLine !== range.endLine) continue;
      const line = lines[range.startLine];
      if (line === undefined) continue;
      // tree-sitter's JS binding uses UTF-16 columns; rust-analyzer/scip-go emit UTF-8 bytes.
      const column = (offset: number) => {
        if (encoding === 2) return offset <= line.length ? offset : -1;
        if (encoding !== 1) return -1;
        const bytes = Buffer.from(line);
        if (offset > bytes.length) return -1;
        const prefix = bytes.subarray(0, offset).toString('utf8');
        return Buffer.from(prefix).equals(bytes.subarray(0, offset)) ? prefix.length : -1;
      };
      const position = key(range.startLine, column(range.startChar), column(range.endChar));
      const symbol = localKey(occurrence.symbol, file.path);
      if (isDefinition(occurrence.symbolRoles)) {
        const def = defs.get(position);
        if (!def) continue;
        const ids = definitions.get(symbol) ?? new Set<string>();
        ids.add(def.id);
        definitions.set(symbol, ids);
      } else {
        const site = sites.get(position);
        if (site) references.push({ symbol, site });
      }
    }
  }
  const targets = new Map<string, { site: ScipCallFile['calls'][number]; ids: Set<string> }>();
  for (const { symbol, site } of references) {
    const ids = definitions.get(symbol);
    if (!ids || ids.size !== 1) continue;
    const target = targets.get(site.edge.id) ?? { site, ids: new Set<string>() };
    for (const id of ids) target.ids.add(id);
    targets.set(site.edge.id, target);
  }
  const calls = new Map(basic.map((edge) => [edge.id, edge]));
  let newlyInScope = 0;
  for (const { site, ids } of targets.values()) {
    if (ids.size !== 1) continue;
    const calleeId = [...ids][0];
    if (calleeId === site.edge.callerId) continue;
    if (!calls.has(site.edge.id) && !names.has(site.name)) newlyInScope++;
    // Compiler identity refines the target; the language's existing call shape stays authoritative.
    calls.set(site.edge.id, { ...(calls.get(site.edge.id) ?? site.edge), calleeId, provenance: 'scip' });
  }
  return {
    calls: [...calls.values()],
    stats: { ...stats, resolvedCalls: calls.size, outOfScopeCalls: Math.max(0, stats.outOfScopeCalls - newlyInScope) },
  };
}
