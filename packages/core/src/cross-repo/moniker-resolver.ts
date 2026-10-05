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
  /**
   * Typed class properties of the repo (`_core: Core` on the client class), used to map
   * the member segment a consumer calls through (`client.core.getX()`) to the SDK class
   * that owns the method. Optional — without it only class-name owners match.
   */
  memberTypes?: ReadonlyArray<{ name: string; typeName: string }>;
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
 * Owner key: packageName + lower-cased owner + method name, where the owner is either
 * the SDK class (`Core`) or a client member segment typed as that class (`core`,
 * `_core: Core`). A consumer that only knows the member it called through
 * (`client.core.getX()` → descriptor `core#getX`) joins here; the `#c::` infix keeps
 * the namespace disjoint from the precise and structural keys.
 */
export function ownerKey(packageName: string, owner: string, methodName: string): string {
  return `${packageName}::#c::${owner.toLowerCase()}::${methodName}`;
}

/** An egress the protocol hop can route on: a concrete HTTP path or messaging destination. */
function routableEgressKey(egress: ExternalCallTarget | undefined): string | undefined {
  if (egress?.http?.pathTemplate)
    return `http ${egress.http.method} ${egress.http.pathTemplate} ${egress.targetService ?? ''}`;
  const dest = egress?.messaging?.destinationValue ?? egress?.messaging?.destination;
  return dest ? `msg ${egress?.messaging?.system ?? ''} ${dest}` : undefined;
}

/**
 * The one entry a fallback key may stand for. A single candidate wins outright. Among
 * several, only those with a routable egress can complete the chain (a same-named
 * wrapper that merely delegates cannot), so the key resolves when exactly one does —
 * or when all routable candidates send the call to the same place (one method
 * duplicated across a legacy and a current client), picking the lowest id for a
 * deterministic edge. Anything else stays ambiguous and registers nothing.
 */
function soleCandidate(entries: ReadonlySet<SdkSymbolEntry>): SdkSymbolEntry | undefined {
  if (entries.size === 1) return [...entries][0];
  const routable = [...entries].filter((e) => routableEgressKey(e.egress) !== undefined);
  if (routable.length === 0) return undefined;
  if (new Set(routable.map((e) => routableEgressKey(e.egress))).size !== 1) return undefined;
  return routable.reduce((a, b) => (b.methodNodeId < a.methodNodeId ? b : a));
}

/** The owner segment of a normalized `Owner#member` descriptor, or undefined. */
function ownerOfNormalizedDescriptor(normalized: string): string | undefined {
  const lastHash = normalized.lastIndexOf('#');
  if (lastHash <= 0) return undefined;
  const owner = normalized.slice(0, lastHash);
  return owner.slice(owner.lastIndexOf('#') + 1) || undefined;
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
  // Method-name candidates per package, to detect structural ambiguity.
  const fallbackCandidates = new Map<string, Set<SdkSymbolEntry>>();

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
      fallbackCandidates.set(fk, (fallbackCandidates.get(fk) ?? new Set()).add(entry));
    }
  }

  for (const [fk, entries] of fallbackCandidates) {
    const chosen = soleCandidate(entries);
    if (chosen) index.set(fk, chosen);
  }

  // Owner keys: each tagged `Class#method` under its class, plus under every member
  // segment whose declared type is that class. Like the structural tier, a key that
  // two different methods claim (a segment typed as two classes, a segment named like
  // another class) registers nothing.
  const ownerCandidates = new Map<string, Set<SdkSymbolEntry>>();
  const addOwner = (key: string, entry: SdkSymbolEntry) => {
    const set = ownerCandidates.get(key) ?? new Set<SdkSymbolEntry>();
    set.add(entry);
    ownerCandidates.set(key, set);
  };
  for (const repo of sdkRepos) {
    const byClass = new Map<string, SdkSymbolEntry[]>();
    for (const fn of repo.functions) {
      if (!fn.moniker) continue;
      const entry = index.get(preciseKey(fn.moniker.packageName, normalizeMonikerDescriptor(fn.moniker.descriptor)));
      const cls = entry && ownerOfNormalizedDescriptor(entry.normalizedDescriptor);
      if (!entry || !cls) continue;
      const method = methodNameFromNormalizedDescriptor(entry.normalizedDescriptor);
      addOwner(ownerKey(entry.packageName, cls, method), entry);
      byClass.set(cls, [...(byClass.get(cls) ?? []), entry]);
    }
    for (const member of repo.memberTypes ?? []) {
      const segment = member.name.replace(/^_+/, ''); // `_core` backs the `core` getter
      for (const entry of byClass.get(member.typeName) ?? []) {
        const method = methodNameFromNormalizedDescriptor(entry.normalizedDescriptor);
        addOwner(ownerKey(entry.packageName, segment, method), entry);
      }
    }
  }
  for (const [key, entries] of ownerCandidates) {
    const chosen = soleCandidate(entries);
    if (chosen) index.set(key, chosen);
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

  const methodName = methodNameFromNormalizedDescriptor(normalizedDescriptor);

  // Owner join — the consumer names the member it called through (`core#getX`) or the
  // class with a different case; the package + owner + method still pin one method.
  const owner = ownerOfNormalizedDescriptor(normalizedDescriptor);
  const byOwner = owner ? index.get(ownerKey(moniker.packageName, owner, methodName)) : undefined;
  if (byOwner) {
    return {
      kind: 'symbol',
      sourceId: call.id,
      targetId: byOwner.methodNodeId,
      via: HopVia.Moniker,
      confidence: 0.95,
    };
  }

  // Structural fallback — same package + method name, descriptor skew too large for
  // the precise join (e.g. the class was renamed across .d.ts/source). Lower
  // confidence than the precise join.
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
