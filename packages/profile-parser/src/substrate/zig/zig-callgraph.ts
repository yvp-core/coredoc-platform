/**
 * Zig internal call graph — five syntactically-decidable resolution tiers (BR-11, BR-12).
 *
 * There is no semantic indexer for Zig, so this is precision-first in the Rust sense: a wrong
 * edge is worse than a missing one, because a reader cannot tell the two apart. Only these
 * shapes resolve, tried in this order, and every tier keys on FILE-QUALIFIED ids so two files'
 * same-named containers can never cross-link:
 *
 *   - `zig-local` — bare `f()` → the enclosing container's method, else a top-level function of
 *                   the same file, else a file-struct method.
 *   - `zig-self`  — `self.m()` / `Self.m()` / `@This().m()` → a method of the enclosing
 *                   container; `self` counts only when the caller's FIRST parameter is NAMED
 *                   `self` and typed as the receiver (the `self: *Self` idiom) — neither the
 *                   name nor the type alone.
 *   - `zig-type`  — `T.m()` / `T.Inner.m()` where `T` names a container declared in the current
 *                   file (directly, as the file-struct, or through a one-level `const` chain).
 *   - `zig-import`— `a.f()` / `a.T.m()` / `A.m()` through the file's binding table (BR-9),
 *                   following `pub const … = @import(…)` re-export hops.
 *   - `zig-field` — `self.<field>.m()` where the field's DECLARED type text resolves as a
 *                   container by the `zig-type` or `zig-import` rule.
 *
 * LEXICAL SCOPE gates all of them: a chain head that the CALLER binds — a parameter name or any
 * `variable_declaration` in its body, nested blocks included — is that local, so `zig-local`,
 * `zig-type` and `zig-import` drop it instead of reaching the file-level function, type or import
 * of the same name. And a file-struct's own basename is not a binding in its own file: an
 * `@import` under that name wins (RT2).
 *
 * DROPPED, never emitted as an unresolved row (LIM-B): every receiver that is a local variable,
 * a function pointer, an `anytype` parameter, a generic instance (`ArrayList(u8).init`), an
 * inferred `.init(…)`, a `@call`, a `usingnamespace` re-export, and anything whose head is an
 * external binding (`std`, `builtin`, a `.zon` dependency, a `@cInclude` header). Builtins and
 * calls inside `test` blocks never reach here — the declaration walk records neither.
 */
import type { CallEdge, CallProvenance, FunctionNode, StableIdGenerator } from '@coredoc/core';
import { FIELD_EXPRESSION, bareTypeText, memberChain, referencesSelf } from './zig-cst.js';
import type { ZigCallSite, ZigFileEntry, ZigFileFacts } from './zig-declarations.js';
import { type ZigImportIndex, resolveBinding } from './zig-imports.js';

/** One tier's attempt: its provenance paired with the callee it found, or nothing. */
function tier(provenance: CallProvenance, resolve: () => string | undefined): [CallProvenance, string] | undefined {
  const calleeId = resolve();
  return calleeId === undefined ? undefined : [provenance, calleeId];
}

/** A set of names a chain head may be shadowed by (the caller's locals, the file's imports). */
type Scope = ReadonlySet<string>;
const EMPTY_SCOPE: Scope = new Set<string>();

/** Per-repo lookup state the tiers share. */
interface Ctx {
  byPath: Map<string, ZigFileFacts>;
  fnById: Map<string, FunctionNode>;
  index: ZigImportIndex;
}

export interface ZigCallResolution {
  calls: CallEdge[];
  /** Call sites the declaration walk attributed to an emitted caller. */
  seen: number;
  /**
   * The `callResolution` denominator (LIM-6): the seen sites that carry a callee name. A
   * nameless site can be neither resolved nor classified out of scope, so — as on Swift and
   * Ruby — it is excluded rather than parked un-classifiable in the denominator. `seen` keeps
   * counting it: the Zig invariant suite pins that number.
   */
  callSites: number;
  /** Of those, the ones a tier resolved (and that survived id dedupe). */
  resolved: number;
  /** Provenance → count, for the resolution-rate record AC-4' prints. */
  byTier: Record<string, number>;
  /**
   * Of the seen sites, the UNBOUND ones whose bare callee name is declared by no function in
   * this repo (BR-1): no node could have been their target, so they are out of scope, not a
   * miss. Name-based on purpose — a `std` call sharing a name with an in-repo function stays
   * in scope and counts against the extractor.
   */
  outOfScope: number;
}

/**
 * Whether the call site's receiver `self` really IS the enclosing container's receiver (BR-12):
 * the caller's FIRST parameter must be NAMED `self` and typed as the receiver. A receiver-typed
 * first parameter under any other name leaves `self` an ordinary local, and typing the check on
 * the name alone would make every `self` in a free function a method receiver.
 */
function isSelfReceiver(site: ZigCallSite, ctx: Ctx): boolean {
  const owner = site.callerOwnerQualifiedName;
  const fn = ctx.fnById.get(site.callerId);
  if (!owner || !fn) return false;
  const first = fn.parameters[0];
  if (first?.name !== 'self') return false;
  return referencesSelf(first.type?.text, owner.slice(owner.lastIndexOf('.') + 1));
}

/** Whether a chain head denotes the enclosing container itself. */
function isSelfHead(head: string, site: ZigCallSite, ctx: Ctx): boolean {
  if (head === 'Self' || head === '@This()') return site.callerOwnerQualifiedName !== undefined;
  return head === 'self' && isSelfReceiver(site, ctx);
}

/**
 * The qualified name of a container `name` denotes in `facts` — declared directly, as the
 * file-struct, or through a one-level `const T = <identifier/field chain>` binding. One level
 * only: a chain of aliases is not followed, because each extra hop is one more place to be
 * confidently wrong.
 */
export function containerInFile(
  facts: ZigFileFacts,
  name: string,
  importedNames?: ReadonlySet<string>,
): string | undefined {
  const fileStruct = facts.index.fileStruct?.name;
  // RT2: the file-struct's basename is NOT a lexical binding inside its own file. `src/Client.zig`
  // that does `const Client = @import("net/Client.zig")` means the IMPORT by `Client.connect()`;
  // only `@This()` / `Self` (and BR-4's `${fileStruct}.${name}` qualification of nested
  // containers) reach the file-struct. Missing here hands the chain to the `zig-import` tier.
  if (name === fileStruct && importedNames?.has(name)) return undefined;
  if (facts.index.containers.has(name)) return name;
  // A file-struct's own declarations are qualified by its name (BR-4), so a bare `T` written
  // inside such a file is keyed as `File.T` in the binding map.
  const keys = fileStruct ? [name, `${fileStruct}.${name}`] : [name];
  for (const key of keys) {
    const value = facts.index.constBindings.get(key);
    const chain = value ? memberChain(value) : undefined;
    if (!chain) continue;
    const qualified = chain.join('.');
    if (facts.index.containers.has(qualified)) return qualified;
  }
  return undefined;
}

/**
 * `zig-local`: the enclosing container first, then the file's own top-level/file-struct fns.
 * A name the caller BINDS (a parameter, a local `const fn_ptr = …`) shadows all of them, so it
 * resolves to nothing rather than to the same-named file-level function.
 */
function resolveLocal(site: ZigCallSite, facts: ZigFileFacts, chain: string[], locals: Scope): string | undefined {
  if (chain.length !== 1) return undefined;
  const name = chain[0];
  if (locals.has(name)) return undefined;
  const owner = site.callerOwnerQualifiedName;
  const ownMethod = owner ? facts.index.containers.get(owner)?.methodsByName.get(name) : undefined;
  const fileStruct = facts.index.fileStruct?.name;
  return (
    ownMethod?.id ??
    facts.index.topLevelFunctions.get(name)?.id ??
    (fileStruct ? facts.index.containers.get(fileStruct)?.methodsByName.get(name)?.id : undefined)
  );
}

/** `zig-self`: a receiver-qualified method of the caller's OWN container. */
function resolveSelf(site: ZigCallSite, facts: ZigFileFacts, chain: string[], ctx: Ctx): string | undefined {
  if (chain.length !== 2 || !isSelfHead(chain[0], site, ctx)) return undefined;
  const owner = site.callerOwnerQualifiedName;
  return owner ? facts.index.containers.get(owner)?.methodsByName.get(chain[1])?.id : undefined;
}

/** `zig-type`: `T.m()` / `T.Inner.m()` against containers declared in the CURRENT file. */
function resolveType(facts: ZigFileFacts, chain: string[], locals: Scope, imported: Scope): string | undefined {
  if (chain.length < 2) return undefined;
  // A caller-bound head (`const Store = makeStore(); Store.put()`) names the local, not the
  // file's type of the same name.
  if (locals.has(chain[0])) return undefined;
  const base = containerInFile(facts, chain[0], imported);
  if (!base) return undefined;
  const qualified = [base, ...chain.slice(1, -1)].join('.');
  return facts.index.containers.get(qualified)?.methodsByName.get(chain[chain.length - 1])?.id;
}

/**
 * `zig-import`: walk the chain one segment at a time, hopping into another file whenever the
 * segment is a binding rather than a container. A segment that is neither ends the walk with
 * nothing — a partially-walked chain would resolve the wrong method.
 */
function resolveImportChain(ctx: Ctx, relPath: string, chain: string[], locals: Scope): string | undefined {
  if (chain.length < 2) return undefined;
  // A function-local `const util = @import("b.zig")` never entered the file table (BR-9), so a
  // head the caller binds must not fall through to the FILE's `util` — that is a wrong-file edge.
  if (locals.has(chain[0])) return undefined;
  const first = resolveBinding(ctx.index, relPath, chain[0]);
  if (!first) return undefined;

  let file = first.targetRelPath;
  let prefix = [...first.members];

  for (const segment of chain.slice(1, -1)) {
    const facts = ctx.byPath.get(file);
    if (!facts) return undefined;
    if (prefix.length > 0) {
      prefix.push(segment);
      continue;
    }
    if (facts.index.containers.has(segment)) {
      prefix = [segment];
      continue;
    }
    const hop = resolveBinding(ctx.index, file, segment);
    if (!hop) return undefined;
    file = hop.targetRelPath;
    prefix = [...hop.members];
  }

  const target = ctx.byPath.get(file);
  const last = chain[chain.length - 1];
  if (!target) return undefined;
  return prefix.length === 0
    ? target.index.topLevelFunctions.get(last)?.id
    : target.index.containers.get(prefix.join('.'))?.methodsByName.get(last)?.id;
}

/** `zig-field`: `self.<field>.m()` through the field's DECLARED type text. */
function resolveField(
  site: ZigCallSite,
  facts: ZigFileFacts,
  chain: string[],
  ctx: Ctx,
  relPath: string,
  imported: Scope,
): string | undefined {
  if (chain.length !== 3 || chain[0] !== 'self' || !isSelfReceiver(site, ctx)) return undefined;
  const owner = site.callerOwnerQualifiedName;
  const typeText = owner ? facts.index.containers.get(owner)?.propertyTypes.get(chain[1]) : undefined;
  if (!typeText) return undefined;

  const parts = bareTypeText(typeText).split('.');
  const method = chain[2];
  const base = containerInFile(facts, parts[0], imported);
  if (base) {
    const id = facts.index.containers.get([base, ...parts.slice(1)].join('.'))?.methodsByName.get(method)?.id;
    if (id) return id;
  }
  // The field's TYPE is written in file scope, never inside the caller: no local shadows it.
  return resolveImportChain(ctx, relPath, [...parts, method], EMPTY_SCOPE);
}

/**
 * Resolve every recorded call site to a `CallEdge`, dropping the unresolved ones (BR-11).
 * Edges are deduped by `callEdgeId`: two identical calls on one source line are one edge.
 */
export function resolveZigCalls(
  files: ReadonlyArray<ZigFileEntry>,
  index: ZigImportIndex,
  idGen: StableIdGenerator,
): ZigCallResolution {
  const ctx: Ctx = {
    byPath: new Map(files.map((f) => [f.relPath, f.facts])),
    fnById: new Map(files.flatMap((f) => f.facts.decls.functions.map((fn) => [fn.id, fn] as const))),
    index,
  };

  // BR-1's denominator side: every bare name this repo declares, method names included.
  const callableNames = new Set<string>();
  for (const fn of ctx.fnById.values()) callableNames.add(fn.name.split('.').pop() as string);

  const calls: CallEdge[] = [];
  const byId = new Set<string>();
  const byTier: Record<string, number> = {};
  let seen = 0;
  let callSites = 0;
  let outOfScope = 0;

  for (const { relPath, facts } of files) {
    const imported: Scope = new Set(index.byFile.get(relPath)?.keys() ?? []);
    for (const site of facts.callSites) {
      seen++;
      const chain = site.chain;
      // No callee name at all — neither resolvable nor classifiable, so it is out of the
      // `callSites` denominator (LIM-6) while `seen` still counts it.
      if (!chain || chain.length === 0) continue;
      callSites++;
      // Classification is pure observation: it never decides whether an edge is emitted.
      const unbound = (): void => {
        if (!callableNames.has(chain[chain.length - 1])) outOfScope++;
      };
      // An external head (`std`, a `.zon` dependency, a C header) names nothing in this repo.
      const head = index.byFile.get(relPath)?.get(chain[0]);
      if (head && !head.targetRelPath) {
        unbound();
        continue;
      }
      const locals: Scope = facts.localsByCaller.get(site.callerId) ?? EMPTY_SCOPE;

      // Tried in priority order, each tier evaluated only if the ones above it missed.
      const hit =
        tier('zig-local', () => resolveLocal(site, facts, chain, locals)) ??
        tier('zig-self', () => resolveSelf(site, facts, chain, ctx)) ??
        tier('zig-type', () => resolveType(facts, chain, locals, imported)) ??
        tier('zig-import', () => resolveImportChain(ctx, relPath, chain, locals)) ??
        tier('zig-field', () => resolveField(site, facts, chain, ctx, relPath, imported));
      if (!hit) {
        unbound();
        continue;
      }

      const calleeExpression = site.callee.text as string;
      const id = idGen.callEdgeId(site.callerId, calleeExpression, `${relPath}:${site.location.startLine}`);
      if (byId.has(id)) continue;
      byId.add(id);
      byTier[hit[0]] = (byTier[hit[0]] ?? 0) + 1;
      calls.push({
        id,
        callerId: site.callerId,
        calleeId: hit[1],
        provenance: hit[0],
        calleeExpression,
        isMethodCall: site.callee.type === FIELD_EXPRESSION,
        arguments: site.arguments,
        location: site.location,
      });
    }
  }
  return { calls, seen, callSites, resolved: calls.length, byTier, outOfScope };
}
