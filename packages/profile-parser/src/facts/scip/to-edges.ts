import type { StableIdGenerator } from '@coredoc/core';
import type { CallEdge, ExternalCallEdge } from '@coredoc/core/types';
import type { CodeGraph } from '../graph/graph-builder.js';
import { isNoiseExternalPackage } from '../noise.js';
import { decodeRange, isDefinition, type LoadedScip, packageSymbolKey, parseMoniker } from './decode.js';

export interface ScipMappingHooks {
  /**
   * Resolve a SCIP symbol to an in-repo node id (its definition), or undefined if external. A
   * document-`local` symbol needs `ref`: the file it occurs in and the name the call site uses.
   */
  symbolToNodeId(symbol: string, ref?: { file: string; name?: string }): string | undefined;
  /** Resolve the enclosing in-repo function/method node id for a reference at (file, 1-based line). */
  enclosingNodeIdAt(relativePath: string, line: number): string | undefined;
}

/**
 * Method name = the final descriptor of a scip-typescript moniker. The tail can be
 * suffixed with `().` (methods), `.` (terms), `#` (types) and the name itself may be
 * backtick-wrapped — including ECMAScript private names like `` `#getLocationBeacons` ``.
 * Strip the trailing `()`/`.`/`#`/backtick scaffolding, then take the last identifier,
 * preserving a leading `#` private sigil so it can match the `#name` node.
 */
function methodNameFromMoniker(symbol: string): string {
  // Drop trailing call/suffix scaffolding: `()`, `.`, `#` (type→member separator),
  // backtick, whitespace.
  const trimmed = symbol.replace(/[`().#\s]+$/, '');
  // A private name keeps its `#` only when backtick-wrapped (`` `#name` ``); the bare
  // `Type#method` separator is scaffolding and must not bleed into the name.
  const wrapped = trimmed.match(/`(#?[A-Za-z_$][\w$]*)`$/);
  if (wrapped) return wrapped[1];
  const m = trimmed.match(/([A-Za-z_$][\w$]*)$/);
  return m?.[1] ?? symbol.slice(-32);
}

/**
 * Normalize a name for the verify-by-name comparison: drop a leading `#` private
 * sigil. ECMAScript private methods are stored as node name `#foo`, but the moniker
 * tail / call-expression tail extracts `foo` — so we compare with the sigil removed
 * on both sides (a real `this.#foo()` call must still resolve to the `#foo` node).
 */
function normalizeName(name: string): string {
  return name.startsWith('#') ? name.slice(1) : name;
}

/** Definition-map key: a document-`local` symbol (`local 12`) is only unique within its file. */
function localSymbolKey(symbol: string, file: string): string {
  return symbol.startsWith('local ') ? `${file}\0${symbol}` : symbol;
}

/**
 * Build the default symbol->definition-node and enclosing-node hooks from a CodeGraph
 * and the SCIP definition set. (The pipeline passes these; tests inject simpler ones.)
 */
export function buildMappingHooks(scip: LoadedScip, g: CodeGraph): ScipMappingHooks {
  // symbol -> {relativePath, line} of its Definition occurrence
  const defLoc = new Map<string, { file: string; line: number }>();
  // Cross-package fallback: workspace-package symbol key (packageName + descriptor suffix,
  // file-path-independent) -> the SOURCE definition location. A consumer in another workspace
  // package imports through the callee package's PUBLISHED declarations (`dist/x.d.ts`), so the
  // reference symbol's file part (`dist/`x.d.ts``) differs from the definition's (`src/`x.ts``)
  // and the exact `defLoc` lookup misses — but the suffix is identical, so this joins them. A key
  // seen at two DISTINCT locations is ambiguous (two files in one package export the same symbol
  // path); it is parked in `pkgDefAmbiguous` and never resolved, preserving precision.
  const pkgDefLoc = new Map<string, { file: string; line: number }>();
  const pkgDefAmbiguous = new Set<string>();
  for (const doc of scip.documents) {
    for (const occ of doc.occurrences) {
      if (isDefinition(occ.symbolRoles)) {
        const r = decodeRange(occ.range);
        const loc = { file: doc.relativePath, line: r.startLine + 1 };
        const symbolKey = localSymbolKey(occ.symbol, doc.relativePath);
        if (!defLoc.has(symbolKey)) defLoc.set(symbolKey, loc);
        const key = packageSymbolKey(occ.symbol);
        if (key && !pkgDefAmbiguous.has(key)) {
          const existing = pkgDefLoc.get(key);
          if (!existing) pkgDefLoc.set(key, loc);
          else if (existing.file !== loc.file || existing.line !== loc.line) {
            pkgDefAmbiguous.add(key);
            pkgDefLoc.delete(key);
          }
        }
      }
    }
  }
  // function nodes indexed by file for point-in-span enclosing resolution.
  // `name` is carried so symbolToNodeId can verify-by-name (precision): a symbol
  // resolves to a function only when a function with the *same name* contains its
  // definition line — so a local/param/`local N` won't masquerade as its enclosing fn.
  const fnsByFile = new Map<string, { id: string; name: string; start: number; end: number }[]>();
  for (const fn of g.functions.values()) {
    const arr = fnsByFile.get(fn.location.filePath) ?? [];
    arr.push({ id: fn.id, name: fn.name, start: fn.location.startLine, end: fn.location.endLine });
    fnsByFile.set(fn.location.filePath, arr);
  }
  return {
    symbolToNodeId(symbol, ref) {
      // A document-`local` symbol (scip-typescript's identity for a declaration inside a function
      // body) carries no name and is only unique per file. It maps to a function node only when that
      // node's own declaration is the definition (it starts on the definition line, or the next one
      // for `const f =\n  () => …`) and bears the name the call site uses — so a local variable or
      // parameter holding a function never resolves to whatever encloses it.
      if (symbol.startsWith('local ')) {
        if (!ref?.name) return undefined;
        const loc = defLoc.get(localSymbolKey(symbol, ref.file));
        if (!loc) return undefined;
        const name = normalizeName(ref.name);
        const cands = (fnsByFile.get(loc.file) ?? []).filter(
          (f) => normalizeName(f.name) === name && (f.start === loc.line || f.start === loc.line + 1),
        );
        return cands.length === 1 ? cands[0].id : undefined;
      }
      // Exact match first: same-package (and same-file) references carry the definition's own
      // symbol verbatim. Only when that misses do we try the cross-package suffix join — a
      // reference resolved through another workspace package's published `dist` declarations.
      const key = defLoc.has(symbol) ? undefined : packageSymbolKey(symbol);
      const loc = defLoc.get(symbol) ?? (key && !pkgDefAmbiguous.has(key) ? pkgDefLoc.get(key) : undefined);
      if (!loc) return undefined;
      // Verify-not-trust: a symbol maps to a function node only when a function in
      // the def file has the SAME name as the called symbol AND its span contains the
      // def line. This makes the resolved callee's name == the called name by
      // construction; a local var / param / `local N` finds no name match → undefined.
      const name = normalizeName(methodNameFromMoniker(symbol));
      const cands = (fnsByFile.get(loc.file) ?? []).filter(
        (f) => normalizeName(f.name) === name && f.start <= loc.line && loc.line <= f.end,
      );
      cands.sort((a, b) => b.start - a.start || a.end - b.end);
      return cands[0]?.id;
    },
    enclosingNodeIdAt(file, line) {
      const cands = (fnsByFile.get(file) ?? []).filter((f) => f.start <= line && line <= f.end);
      cands.sort((a, b) => b.start - a.start || a.end - b.end);
      return cands[0]?.id;
    },
  };
}

/**
 * Tag in-repo function/method nodes that are an SDK-source export with their own
 * SCIP package-moniker identity, so the cross-repo symbol hop can join a
 * consumer's ExternalCallEdge.moniker onto this definition. For every DEFINITION
 * occurrence whose symbol decodes to a real (non-local, non-noise) package
 * moniker, find the function whose name == the moniker tail and whose span
 * contains the definition line, and set `node.moniker`. Verify-by-name keeps a
 * local/param `local N` definition from masquerading as its enclosing function.
 */
export function tagExportedMonikers(scip: LoadedScip, g: CodeGraph): void {
  // function nodes indexed by file for point-in-span resolution.
  const fnsByFile = new Map<string, { id: string; name: string; start: number; end: number }[]>();
  for (const fn of g.functions.values()) {
    const arr = fnsByFile.get(fn.location.filePath) ?? [];
    arr.push({ id: fn.id, name: fn.name, start: fn.location.startLine, end: fn.location.endLine });
    fnsByFile.set(fn.location.filePath, arr);
  }
  for (const doc of scip.documents) {
    for (const occ of doc.occurrences) {
      if (!isDefinition(occ.symbolRoles)) continue;
      const mon = parseMoniker(occ.symbol);
      if ('local' in mon) continue;
      if (!mon.packageName || isNoiseExternalPackage(mon.packageName)) continue;
      const line = decodeRange(occ.range).startLine + 1;
      const name = normalizeName(methodNameFromMoniker(occ.symbol));
      const cands = (fnsByFile.get(doc.relativePath) ?? []).filter(
        (f) => normalizeName(f.name) === name && f.start <= line && line <= f.end,
      );
      cands.sort((a, b) => b.start - a.start || a.end - b.end);
      const target = cands[0];
      if (!target) continue;
      const node = g.functions.get(target.id);
      if (node && !node.moniker) node.moniker = { packageName: mon.packageName, descriptor: mon.descriptors };
    }
  }
}

export interface ScipToEdgesOptions {
  /**
   * package.json `name` of every package of THIS repo's workspace (the root manifest included).
   * A moniker in one of these names describes an in-repo symbol, never an egress — see the
   * own-package branch below.
   */
  workspacePackageNames?: readonly string[];
}

export function scipToEdges(
  scip: LoadedScip,
  g: CodeGraph,
  idGen: StableIdGenerator,
  hooks: ScipMappingHooks,
  opts: ScipToEdgesOptions = {},
): void {
  const ownPackages = new Set(opts.workspacePackageNames ?? []);
  // id → function-node name, for the belt-and-suspenders name-invariant assertion below.
  const fnNameById = new Map<string, string>();
  for (const fn of g.functions.values()) fnNameById.set(fn.id, fn.name);
  for (const doc of scip.documents) {
    for (const occ of doc.occurrences) {
      if (isDefinition(occ.symbolRoles)) continue; // references only
      const r = decodeRange(occ.range);
      const line = r.startLine + 1;
      const callerId = hooks.enclosingNodeIdAt(doc.relativePath, line);
      if (!callerId) continue; // reference not inside a known function (import line, type pos, etc.)

      // A local symbol has no name of its own; the call whose name token this occurrence covers does.
      const isLocal = occ.symbol.startsWith('local ');
      const calledName = isLocal
        ? g.unresolvedCallNameAt(doc.relativePath, line, r.startChar)
        : methodNameFromMoniker(occ.symbol);
      const calleeId = hooks.symbolToNodeId(occ.symbol, { file: doc.relativePath, name: calledName });
      const loc = `${doc.relativePath}:${line}`;
      if (calleeId) {
        if (calleeId === callerId) continue; // self / trivial
        // Belt-and-suspenders: the resolved callee's node name MUST equal the called
        // name. symbolToNodeId already guarantees this by construction;
        // this guard keeps the precision invariant even if a future hook regresses.
        const calleeName = fnNameById.get(calleeId);
        if (calleeName !== undefined && normalizeName(calleeName) !== normalizeName(calledName ?? '')) continue;
        // Collapse: upgrade the structural sibling in place if one exists; else add a fresh edge.
        // An aliased import (`import { a as b }; b()`) keeps its structural edge apart: that edge
        // names `b`, and the later name gate would refuse `b` → `a`; the fresh edge names `a`.
        const siteName = isLocal ? undefined : g.unresolvedCallNameAt(doc.relativePath, line, r.startChar);
        const aliased = siteName !== undefined && normalizeName(siteName) !== normalizeName(calledName ?? '');
        if (aliased || !g.resolveInternalCall(callerId, doc.relativePath, line, calleeId, r.startChar)) {
          if (isLocal) continue; // resolved through its call site, which is gone: nothing to mint
          const edge: CallEdge = {
            // Keyed on the raw symbol, unchanged by the calleeExpression fix below, so this
            // edge's identity stays stable across parses (artifact caching joins on it). One
            // exception, accepted as a one-time churn: an edge the engine RE-PARENTS onto an
            // inline handler re-mints its id from calleeExpression (engine.ts), so those ids
            // change once with this fix and then stay stable.
            id: idGen.callEdgeId(callerId, occ.symbol, loc),
            callerId,
            calleeId,
            // The moniker tail, not the moniker: a raw
            // `scip-typescript npm pkg 0.0.0 src/`f.tsx`/fn().` in calleeExpression is
            // unreadable in MCP/summary output.
            calleeExpression: methodNameFromMoniker(occ.symbol),
            isMethodCall: true,
            location: { filePath: doc.relativePath, startLine: line, endLine: line },
          };
          g.addCall(edge);
        }
      } else {
        const mon = parseMoniker(occ.symbol);
        if ('local' in mon) continue; // file-local symbol — leave the structural sibling as residue
        // Noise (empty package = TS stdlib like Array.map/Promise.then; @types/*; tslib/reflect-metadata):
        // not a real edge. Drop the structural sibling so it isn't counted or re-resolved by the overlay, and skip.
        if (isNoiseExternalPackage(mon.packageName)) {
          g.removeUnresolvedCallAt(callerId, doc.relativePath, line, r.startChar);
          continue;
        }
        // The moniker names one of this repo's OWN workspace packages, yet `symbolToNodeId` found
        // no function node for it: the symbol is an in-repo declaration that is not a function
        // body — an interface member, a type member, a property. It is not egress, so neither the
        // deletion nor the external edge below may fire: dropping the structural sibling AND
        // minting a self-referential "external service" destroyed every fact about the call site
        // (the engine discards own-package externals downstream, so the site vanished entirely).
        // Leave the unresolved structural sibling alive instead — honest residue, and the input a
        // later resolution tier (interface-dispatch binding) upgrades in place.
        if (ownPackages.has(mon.packageName)) continue;
        // Real external (service/IO) call — drop the structural unresolved sibling and emit the external edge.
        g.removeUnresolvedCallAt(callerId, doc.relativePath, line, r.startChar);
        const method = methodNameFromMoniker(occ.symbol);
        const extId = idGen.externalCallId(callerId, mon.packageName, method, loc);
        const edge: ExternalCallEdge = {
          id: extId,
          versionedId: idGen.versionedId(extId, occ.symbol),
          callerId,
          serviceName: mon.packageName,
          sdkName: mon.packageName,
          method,
          // Preserve the raw SCIP package moniker (package + descriptor tail, version
          // already excluded by parseMoniker's field split) so the cross-repo symbol
          // hop can join this call onto the SDK-source method definition.
          moniker: { packageName: mon.packageName, descriptor: mon.descriptors },
          location: { filePath: doc.relativePath, startLine: line, endLine: line },
        };
        g.addExternalCall(edge);
      }
    }
  }
}
