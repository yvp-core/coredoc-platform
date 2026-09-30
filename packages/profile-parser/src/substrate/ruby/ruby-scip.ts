/**
 * Tier-A Ruby call graph from a scip-ruby (Sorbet) SCIP index.
 *
 * Reuses the language-neutral SCIP decode (`facts/scip/decode.ts`) and mirrors the
 * TypeScript `buildMappingHooks`/`scipToEdges` pattern, but resolves against the Ruby
 * def index (`RubyDefIndex.byId`) instead of a `CodeGraph`. The result is `CallEdge[]`
 * on the SAME canonical `methodId`s as the Tier-B path, tagged provenance `'scip'`.
 *
 * Resolution is location-authoritative + name-verified, identical in spirit to TS:
 *   - callee: a method-call reference's symbol → its DEFINITION occurrence `{file,line}`
 *     → the Ruby def node whose span contains that line AND whose name == the moniker
 *     tail. The name check makes ivar reads / locals / mismatched defs resolve to
 *     `undefined` (verify-not-trust), so the emitted callee name == the called name by
 *     construction.
 *   - caller: the def node whose span contains the reference line.
 *
 * Internal calls only — gem/SDK (external) Ruby edges are out of scope here (egress is
 * handled by ruby-egress; cross-repo SDK edges by the linker).
 */
import type { CallEdge, StableIdGenerator } from '@coredoc/core';
import { decodeRange, isDefinition, type LoadedScip, parseMoniker } from '../../facts/scip/decode.js';
import type { ScipMappingHooks } from '../../facts/scip/to-edges.js';
import type { RubyDefIndex } from './ruby-callgraph.js';

const normPath = (p: string): string => p.replace(/^\.\//, '');
/** Compare names with the singleton `self.` prefix removed on both sides (node names carry it). */
const normalizeName = (n: string): string => n.replace(/^self\./, '');

/**
 * The final method descriptor of a scip-ruby moniker. Ruby SCIP uses `#` as the
 * universal descriptor separator (namespace AND method): `A#B#name().`. The name may be
 * backtick-wrapped to carry Ruby sigils — `` `pred?` ``, `` `bang!` ``, `` `name=` `` — and
 * singleton receivers appear as `` `<Class:X>`#name(). ``. Returns the bare name (sigils
 * preserved); an ivar term descriptor (`` `@x`. ``) returns `@x`, which never name-matches
 * a def and is therefore correctly rejected by the hooks.
 */
export function rubyMethodNameFromMoniker(symbol: string): string {
  const mon = parseMoniker(symbol);
  const desc = 'local' in mon ? mon.local : mon.descriptors;
  // Drop the trailing method/term scaffolding: `()` then an optional terminator `.`.
  const stripped = desc.replace(/\(\)\.?$/, '').replace(/\.$/, '');
  // Last segment after a top-level `#` (ignoring `#` inside backtick-wrapped names).
  let depth = 0;
  let seg = '';
  for (const ch of stripped) {
    if (ch === '`') {
      depth ^= 1;
      seg += ch;
    } else if (ch === '#' && depth === 0) {
      seg = '';
    } else {
      seg += ch;
    }
  }
  return seg.replace(/^`(.*)`$/, '$1');
}

interface FnLite {
  id: string;
  name: string;
  start: number;
  end: number;
}

/** Pick the deepest (innermost) span; ties broken by the shortest span. */
function deepest(cands: FnLite[]): FnLite | undefined {
  cands.sort((a, b) => b.start - a.start || a.end - b.end);
  return cands[0];
}

/**
 * Build the symbol→def-node and enclosing-node hooks from a scip-ruby index and the Ruby
 * def index. Mirror of `facts/scip/to-edges.ts:buildMappingHooks`, over `index.byId`.
 */
export function buildRubyMappingHooks(scip: LoadedScip, index: RubyDefIndex): ScipMappingHooks {
  // symbol → {file,line} of its first DEFINITION occurrence (authoritative callee location).
  const defLoc = new Map<string, { file: string; line: number }>();
  for (const doc of scip.documents) {
    for (const o of doc.occurrences) {
      if (!isDefinition(o.symbolRoles)) continue;
      if (defLoc.has(o.symbol)) continue;
      defLoc.set(o.symbol, { file: normPath(doc.relativePath), line: decodeRange(o.range).startLine + 1 });
    }
  }
  // def nodes indexed by file for point-in-span resolution.
  const fnsByFile = new Map<string, FnLite[]>();
  for (const fn of index.byId.values()) {
    const key = normPath(fn.location.filePath);
    const arr = fnsByFile.get(key) ?? [];
    arr.push({ id: fn.id, name: fn.name, start: fn.location.startLine, end: fn.location.endLine });
    fnsByFile.set(key, arr);
  }
  return {
    symbolToNodeId(symbol) {
      const loc = defLoc.get(symbol);
      if (!loc) return undefined;
      const name = normalizeName(rubyMethodNameFromMoniker(symbol));
      const cands = (fnsByFile.get(loc.file) ?? []).filter(
        (f) => normalizeName(f.name) === name && f.start <= loc.line && loc.line <= f.end,
      );
      return deepest(cands)?.id;
    },
    enclosingNodeIdAt(file, line) {
      return deepest((fnsByFile.get(normPath(file)) ?? []).filter((f) => f.start <= line && line <= f.end))?.id;
    },
  };
}

/**
 * Turn scip-ruby reference occurrences into internal `CallEdge`s (provenance `'scip'`).
 * One edge per resolved call site (deduped by edge id); self/trivial and unresolved
 * references are skipped.
 */
export function scipRubyToCallEdges(scip: LoadedScip, hooks: ScipMappingHooks, idGen: StableIdGenerator): CallEdge[] {
  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const doc of scip.documents) {
    const file = normPath(doc.relativePath);
    for (const o of doc.occurrences) {
      if (isDefinition(o.symbolRoles)) continue; // references only
      const line = decodeRange(o.range).startLine + 1;
      const callerId = hooks.enclosingNodeIdAt(file, line);
      if (!callerId) continue; // reference not inside a known def
      const calleeId = hooks.symbolToNodeId(o.symbol);
      if (!calleeId || calleeId === callerId) continue; // external / unresolved / self-trivial
      const loc = `${file}:${line}`;
      const id = idGen.callEdgeId(callerId, o.symbol, loc);
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({
        id,
        callerId,
        calleeId,
        calleeExpression: o.symbol,
        isMethodCall: true,
        provenance: 'scip',
        location: { filePath: file, startLine: line, endLine: line },
      });
    }
  }
  return edges;
}

/**
 * Union Tier-A (scip, authoritative) with Tier-B edges for the (caller,callee) pairs scip
 * didn't resolve. scip wins on every pair it covers; Tier-B supplements the rest — the
 * Rails-magic sends (mailers, AR scopes, concern methods) that untyped Sorbet can't resolve.
 * Both inputs are already self-edge-free and precision-gated, so the union adds recall at no
 * precision cost. Edge identity is the (callerId, calleeId) pair; Tier-A's per-site edges for
 * a covered pair shadow all Tier-B edges for that same pair.
 */
export function unionRubyCalls(scipEdges: CallEdge[], tierBEdges: CallEdge[]): CallEdge[] {
  const pairKey = (e: CallEdge): string => `${e.callerId}>${e.calleeId}`;
  const scipPairs = new Set(scipEdges.map(pairKey));
  return [...scipEdges, ...tierBEdges.filter((e) => !scipPairs.has(pairKey(e)))];
}
