import type { ExternalCallTarget } from '../types/output.js';
import type { ExternalCallLike } from './descriptor-matcher.js';
import { normalizeMonikerDescriptor } from './moniker.js';
import { HopVia, UnresolvedCode, type HopResult, type SdkSymbolEntry } from './types.js';

/**
 * Minimal shape of an SDK-source method node consumed by the symbol hop. An
 * SDK-source repo tags its exported method nodes with their SCIP moniker identity.
 * Kept structural here so @coredoc/core does not couple to the full FunctionNode at
 * the index boundary; the linker adapts FunctionNode -> SdkMethodNodeLike.
 */
export interface SdkMethodNodeLike {
  /** Stable node id of the SDK method definition. */
  id: string;
  /** Method name (the bare identifier, e.g. `dailySummaries`). */
  name: string;
  /** SCIP moniker identity tagged at parse time. Absent for untagged nodes. */
  moniker?: { packageName: string; descriptor: string };
  /**
   * The method's own parsed egress (the protocol hop the SDK method performs).
   * Carried onto the symbol entry so the chain walker can compose
   * consumer -> SDK method -> target entrypoint without a second lookup.
   * Populated at index-build time by joining the SDK repo's externalCalls on
   * callerId === methodNodeId, NOT a field on the node itself. The adapter layer
   * performs the join; here we accept it pre-joined.
   */
  egress?: ExternalCallTarget;
}

/** Minimal shape of an SDK-source repo consumed by the symbol-index builder. */
export interface SdkRepoLike {
  name: string;
  functions: SdkMethodNodeLike[];
}

/** Precise join key: packageName + '::' + normalizedDescriptor. */
function preciseKey(packageName: string, normalizedDescriptor: string): string {
  return `${packageName}::${normalizedDescriptor}`;
}

/**
 * Structural fallback key: packageName + method name. The `#m::`
 * infix keeps it in a disjoint namespace from precise keys so a descriptor that
 * happens to equal `#m::name` can never collide with a structural key.
 */
export function structuralFallbackKey(packageName: string, methodName: string): string {
  return `${packageName}::#m::${methodName}`;
}

/**
 * Extract the bare method name from a normalized descriptor. The normalized form is
 * `Class#member` (method), `Class` (type) or `term`; the method name is the segment
 * after the last `#`, or the whole string when there is no `#`. A backtick-wrapped
 * private name (`` `#refresh` ``) keeps its inner identifier.
 */
export function methodNameFromNormalizedDescriptor(normalized: string): string {
  const lastHash = normalized.lastIndexOf('#');
  const tail = lastHash === -1 ? normalized : normalized.slice(lastHash + 1);
  const wrapped = tail.match(/^`(#?[A-Za-z_$][\w$]*)`$/);
  return wrapped ? wrapped[1]! : tail;
}

/**
 * Build the SDK symbol index over SDK-source repos. Each tagged method node is
 * registered under its precise `(packageName, normalizedDescriptor)` key. A
 * structural `(packageName, methodName)` fallback key is also registered, but only
 * when that method name is unambiguous within the package — an ambiguous method
 * name (same name under two classes) registers no fallback so the hop stays
 * conservative rather than mis-hitting.
 *
 * `SdkMethodNodeLike.egress` is populated by the caller (the linker adapter) by
 * joining SDK-repo externalCalls on `callerId === methodNodeId` before calling this
 * function. This function does not perform the join — it accepts the pre-joined
 * shape and propagates `egress` onto `SdkSymbolEntry`.
 */
export function buildSdkSymbolIndex(sdkRepos: SdkRepoLike[]): Map<string, SdkSymbolEntry> {
  const index = new Map<string, SdkSymbolEntry>();
  // Count method-name occurrences per package to detect structural ambiguity.
  const fallbackCounts = new Map<string, number>();
  const fallbackEntry = new Map<string, SdkSymbolEntry>();

  for (const repo of sdkRepos) {
    for (const fn of repo.functions) {
      if (!fn.moniker) continue;
      const normalizedDescriptor = normalizeMonikerDescriptor(fn.moniker.descriptor);
      if (normalizedDescriptor === '') continue;
      const entry: SdkSymbolEntry = {
        packageName: fn.moniker.packageName,
        normalizedDescriptor,
        methodNodeId: fn.id,
        egress: fn.egress,
      };
      index.set(preciseKey(entry.packageName, normalizedDescriptor), entry);

      const methodName = methodNameFromNormalizedDescriptor(normalizedDescriptor);
      const fk = structuralFallbackKey(entry.packageName, methodName);
      fallbackCounts.set(fk, (fallbackCounts.get(fk) ?? 0) + 1);
      fallbackEntry.set(fk, entry);
    }
  }

  for (const [fk, count] of fallbackCounts) {
    if (count === 1) index.set(fk, fallbackEntry.get(fk)!);
  }

  return index;
}

/**
 * Symbol hop: join a consumer external call's SCIP moniker onto an SDK method node.
 * Tries the precise `(packageName, normalizedDescriptor)` key first; on a miss,
 * falls back to the structural `(packageName, methodName)` key.
 * Pure: `(call, sdkSymbolIndex) -> ResolvedHop | UnresolvedReason`.
 */
export function matchSymbolHop(call: ExternalCallLike, index: Map<string, SdkSymbolEntry>): HopResult {
  const moniker = call.moniker;
  if (!moniker) {
    return { sourceId: call.id, code: UnresolvedCode.NoMonikerMatch, detail: 'call carries no SCIP moniker' };
  }

  const normalizedDescriptor = normalizeMonikerDescriptor(moniker.descriptor);

  // Precise join — full confidence in the symbol identity.
  const precise = index.get(preciseKey(moniker.packageName, normalizedDescriptor));
  if (precise) {
    return {
      kind: 'symbol',
      sourceId: call.id,
      targetId: precise.methodNodeId,
      via: HopVia.Moniker,
      confidence: 1.0,
    };
  }

  // Structural fallback — same package + method name, descriptor skew too large for
  // the precise join (e.g. the class was renamed across .d.ts/source). Lower
  // confidence than the precise join.
  const methodName = methodNameFromNormalizedDescriptor(normalizedDescriptor);
  const structural = index.get(structuralFallbackKey(moniker.packageName, methodName));
  if (structural) {
    return {
      kind: 'symbol',
      sourceId: call.id,
      targetId: structural.methodNodeId,
      via: HopVia.Moniker,
      confidence: 0.85,
    };
  }

  return {
    sourceId: call.id,
    code: UnresolvedCode.NoMonikerMatch,
    detail: `${moniker.packageName}::${normalizedDescriptor}`,
  };
}
