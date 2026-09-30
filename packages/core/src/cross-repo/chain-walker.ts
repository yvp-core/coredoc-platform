/**
 * Chain walker — composes typed single-hops (symbol hop + protocol hop) into
 * end-to-end ResolvedChains, bucketing whatever it cannot resolve with a
 * structured reason. Pure; no I/O. The workspace linker (`linker.ts`) builds
 * the indexes and feeds calls here.
 *
 * Composition shapes:
 *   - direct protocol hop:    consumer ──http/messaging/ipc──▶ entrypoint    (1 hop)
 *   - symbol→protocol:        consumer ──moniker──▶ SDK method ──http/messaging/ipc──▶ entrypoint (2 hops)
 *   - call-edge→protocol:     same 2-hop shape, but the SDK method is named by the
 *     caller's intra-repo CALLS edge instead of a moniker (see `callEdgeHop`).
 * A gateway controller is both an entrypoint and a caller, so a UI→gateway
 * direct hop plus the gateway's own egress call (resolved independently as its
 * own direct hop) already yields the UI→gateway→downstream trace without a
 * dedicated branch here.
 *
 * Per-repo httpPrefix: `WorkspaceCfg.httpPrefixByRepo` is keyed by repo
 * name. For each protocol hop the chain-walker derives the target-repo hint
 * from `targetDescriptor.targetService` (direct http) or from the SDK symbol
 * entry's `packageName`-derived repo name (symbol→protocol), looks up that
 * repo's prefix from `httpPrefixByRepo`, and passes `{ httpPrefix, targetRepo }`
 * into `RepoCfg`. This prevents equal-path entrypoints in different services
 * from collapsing to ambiguous when the chain-walker already knows the target.
 */

import { ALL_HTTP_METHODS } from '../types/output.js';
import type { ExternalCallTarget } from '../types/output.js';
import type { EntrypointIndex, ExternalCallLike, RepoCfg, ServiceRepoMap } from './descriptor-matcher.js';
import { matchProtocolHop, resolveRepoByRoutePrefix } from './descriptor-matcher.js';
import { matchSymbolHop, methodNameFromNormalizedDescriptor } from './moniker-resolver.js';
import { type SdkMappingIndex, sdkMappingToDescriptor } from './sdk-mapping-fallback.js';
import {
  HopVia,
  UnresolvedCode,
  type HopResult,
  type ResolvedChain,
  type ResolvedHop,
  type SdkSymbolEntry,
  type UnresolvedReason,
  isResolved,
} from './types.js';

/**
 * Workspace-level config fed to the chain-walker.
 * Each repo may have its own gateway URL prefix. Keys are repo names
 * matching `EntrypointLike.repoName`; undefined means no prefix stripping for
 * that repo.
 */
export interface WorkspaceCfg {
  /**
   * Gateway URL prefix per repo, keyed by repoName (from coredoc.config.json).
   * Omitted or empty when no prefix stripping is needed for any repo in the
   * workspace.
   */
  httpPrefixByRepo?: Record<string, string | undefined>;
  /**
   * Service-hint → repo-name translation. A `targetDescriptor.targetService`
   * is a logical service hint, NOT a repo name, so it must be translated to the
   * owning repo before it scopes `matchHttp`. Built from `override.services[]`.
   * When undefined or the hint is undeclared, the protocol hop runs UNscoped.
   */
  serviceRepoMap?: ServiceRepoMap;
  /**
   * Declarative sdkMapping fallback index (moniker-independent). Built from
   * `override.sdkMappings`. Consulted ONLY as a last tier when the symbol hop
   * misses (no moniker / no package moniker — locally-defined clients and
   * node_modules-less consumers) and the call carried no usable descriptor of its
   * own. When undefined or empty, the fallback is a no-op. See
   * `sdk-mapping-fallback.ts`.
   */
  sdkMappingIndex?: SdkMappingIndex;
  /**
   * Intra-repo CALLS edges as `callEdgeKey(repoName, callerId) → callee node ids`.
   * Feeds the call-edge hop, which disambiguates an SDK call by the caller's DIRECT
   * edge to the SDK method node instead of guessing from a declared (package, method)
   * row. Absent (in-workspace SDK source not parsed, or an adapter that carries no
   * calls) means the hop never fires.
   *
   * Keyed by REPO + caller, not by caller alone: a node id embeds only a repo-NAME
   * hash (`id-generator.ts`), so two same-named repos in one workspace mint identical
   * ids and a flat map would silently merge their callers into one bucket — feeding
   * the call-edge hop callees the caller never had. Build the key with
   * {@link callEdgeKey} on both sides.
   */
  callTargetsByCaller?: ReadonlyMap<string, readonly string[]>;
}

/**
 * The single key builder for `WorkspaceCfg.callTargetsByCaller`. Both the producer
 * (`linker.ts`) and the call-edge hop route through it so the repo scope cannot skew.
 * NUL cannot appear in a repo name or a node id, so the two parts never blur (the same
 * separator the package-import storage key already uses).
 */
export function callEdgeKey(repoName: string, callerId: string): string {
  return `${repoName}\u0000${callerId}`;
}

/**
 * Build a synthetic ExternalCallLike for the SDK method's own egress so the
 * second (protocol) hop can run through the exact same matcher as a direct
 * call. The egress descriptor comes from the SDK-source repo's parsed egress
 * (recovered without an sdkDefinitions table).
 */
function egressAsCall(symbolHop: ResolvedHop, egress: ExternalCallTarget): ExternalCallLike {
  return {
    id: `${symbolHop.sourceId}::egress`,
    targetDescriptor: egress,
  };
}

/**
 * Translate a raw service HINT (`targetDescriptor.targetService`) into the real
 * repo name that owns its entrypoints. A hint is a logical service name
 * (e.g. `'calculations'`), NOT a repo name (e.g. `'demo-calculations'`); using the
 * untranslated hint to scope `matchHttp` would exclude the real entrypoint. When
 * the hint is undeclared in `override.services[]`, returns undefined so the caller
 * falls back to an unscoped match.
 */
function translateService(serviceHint: string | undefined, cfg: WorkspaceCfg): string | undefined {
  // Filtering is at REPO level: entrypoint index entries carry only `repoName`,
  // so a v2 `(repo, target)` service still scopes candidates by `repo` alone — this
  // keeps all-v1 mappers behavior-identical.
  // Target-level candidate scoping (repo AND target) is deferred until Phase-5
  // real-repo data justifies it (spec §4.3 note): hinted calls to sliced repos
  // currently fall through to the unscoped tier rather than being scoped to a
  // single target's slice.
  return cfg.serviceRepoMap?.toRepo(serviceHint);
}

/**
 * Derive the per-hop RepoCfg for a protocol hop by looking up the target repo's
 * prefix in `httpPrefixByRepo`. When `targetRepo` is known, restrict candidates
 * to that repo so equal-path entrypoints in different services do not collapse to
 * ambiguous.
 */
function hopCfg(targetRepo: string | undefined, cfg: WorkspaceCfg): RepoCfg {
  const httpPrefix = targetRepo !== undefined ? cfg.httpPrefixByRepo?.[targetRepo] : undefined;
  return { httpPrefix, targetRepo };
}

/**
 * Run a protocol hop with service→repo scoping plus an unscoped fallback,
 * then a final route-prefix→repo strip recovery for the gateway-prefix gap.
 *
 * 1. Translate the service hint to a repo name and run the hop scoped to it
 *    (disambiguates equal-path entrypoints across services). The scoped cfg
 *    also resolves the gateway `httpPrefix` for that repo. This is the DIRECT
 *    (unstripped) match — a service whose entrypoints carry the FULL prefix
 *    (`@Controller('/v2/management/calculations')`) resolves here and is never
 *    regressed by step 3.
 * 2. If the scoped hop fails to find a candidate (`no-entrypoint-match` — the hint
 *    was undeclared, or mis-scoped), retry UNscoped across all repos. A single
 *    global candidate then resolves; >1 reports `ambiguous`. The unscoped retry
 *    still applies any prefix from the original scope so an undeclared-but-prefixed
 *    caller is not silently dropped.
 * 3. STILL `no-entrypoint-match` for an HTTP call: the service hint did not name a
 *    repo, so the gateway prefix was never picked to strip. Resolve the target repo
 *    from the ROUTE's own leading prefix (longest-prefix wins over `httpPrefixByRepo`),
 *    then re-run the hop scoped to that repo with its prefix STRIPPED — so a fully
 *    prefixed SDK/gateway path matches a service whose entrypoints are at the bare
 *    (setGlobalPrefix-relative) path. An equal-length prefix tie reports `ambiguous`.
 *
 * `ambiguous` from the scoped hop is NOT retried — the scope already narrowed to
 * one repo and still tied, so broadening would only widen the ambiguity.
 */
function protocolHopWithFallback(
  call: ExternalCallLike,
  serviceHint: string | undefined,
  entrypointIndex: EntrypointIndex,
  cfg: WorkspaceCfg,
): HopResult {
  const targetRepo = translateService(serviceHint, cfg);
  const scopedCfg = hopCfg(targetRepo, cfg);
  // Step 1 — DIRECT (unstripped) scoped match.
  const scoped = matchProtocolHop(call, entrypointIndex, scopedCfg);
  if (isResolved(scoped) || scoped.code !== UnresolvedCode.NoEntrypointMatch) return scoped;
  // Step 2 — unscoped fallback: drop the repo filter (keep the prefix) and retry.
  const unscoped = matchProtocolHop(call, entrypointIndex, { httpPrefix: scopedCfg.httpPrefix });
  if (isResolved(unscoped) || unscoped.code !== UnresolvedCode.NoEntrypointMatch) return unscoped;
  // Step 3 — route-prefix→repo strip recovery (the gateway-prefix gap). Only HTTP
  // calls carry a path the route prefix can be derived from; others fall through.
  return prefixStripRecovery(call, entrypointIndex, cfg, unscoped);
}

/**
 * Final recovery tier for the gateway-prefix gap: when a service hint did not
 * translate to a repo, the caller path carries a full gateway prefix
 * (`/v3/management/assistant/x`) and the target service's entrypoints are at the
 * bare path (`/x`). Resolve the owning repo from the route's own leading prefix
 * against `httpPrefixByRepo` (longest-prefix wins), then re-run the hop scoped to
 * that repo with its prefix STRIPPED. Returns the original `miss` reason unchanged
 * when no route prefix matches; reports `ambiguous` on an equal-length prefix tie.
 */
function prefixStripRecovery(
  call: ExternalCallLike,
  entrypointIndex: EntrypointIndex,
  cfg: WorkspaceCfg,
  miss: HopResult,
): HopResult {
  const http = call.targetDescriptor?.protocol === 'http' ? call.targetDescriptor.http : undefined;
  const path = http?.pathTemplate;
  const byRepo = cfg.httpPrefixByRepo;
  if (!path || !byRepo) return miss;
  const resolved = resolveRepoByRoutePrefix(path, byRepo);
  if (resolved === undefined) return miss;
  if (resolved === 'ambiguous') {
    return { sourceId: call.id, code: UnresolvedCode.Ambiguous, detail: `route prefix matches >1 repo: ${path}` };
  }
  // Scope to the prefix-derived repo and strip its prefix so the bare remainder
  // matches the service's setGlobalPrefix-relative entrypoints.
  return matchProtocolHop(call, entrypointIndex, {
    targetRepo: resolved.repo,
    stripPrefix: resolved.prefix,
  });
}

/**
 * Declarative sdkMapping fallback tier (moniker-independent). When the symbol hop
 * misses for an SDK-mediated call, look the call's (sdk class/package, method) up
 * in the declared sdkMappings, synthesize the SDK method's route as an egress
 * descriptor, and run the SAME protocol hop a direct call uses. The route's
 * `targetService` is translated to its repo by the protocol hop's scope+fallback.
 *
 * Returns the resolved chain (one synthetic `symbol` hop carrying the override
 * provenance + the protocol hop) on success, or undefined when no row matches or
 * the synthesized route does not land an entrypoint — so the caller keeps its
 * existing unresolved bucketing for that case.
 */
function sdkMappingFallback(
  call: ExternalCallLike,
  entrypointIndex: EntrypointIndex,
  cfg: WorkspaceCfg,
): ResolvedChain | undefined {
  const index = cfg.sdkMappingIndex;
  if (!index) return undefined;
  const row = index.lookup(call);
  if (!row) return undefined;
  const egress = sdkMappingToDescriptor(row);
  const protoHop = protocolHopWithFallback(
    { id: `${call.id}::sdkMapping`, targetDescriptor: egress },
    egress.targetService,
    entrypointIndex,
    cfg,
  );
  if (!isResolved(protoHop)) return undefined;
  // Synthetic first hop records that the (class, method) → route step came from a
  // declared override row, not a SCIP moniker join, so provenance stays honest.
  const overrideHop: ResolvedHop = {
    kind: 'symbol',
    sourceId: call.id,
    targetId: `sdkMapping:${row.sdkClass}.${row.sdkMethod}`,
    via: HopVia.Override,
    confidence: 0.9,
  };
  return {
    sourceCallId: call.id,
    finalEntrypointId: protoHop.targetId,
    hops: [overrideHop, protoHop],
    confidence: overrideHop.confidence * protoHop.confidence,
  };
}

/**
 * SDK method nodes that carry an egress, keyed by node id — the join target of the
 * call-edge hop AND the egress lookup the moniker hop needs (the symbol index is
 * keyed by `packageName::normalizedDescriptor`, never by method node id). The symbol
 * index registers one entry object under several keys (precise + structural), so
 * first-wins per node id is order-independent. Built once per `walkChains` because
 * both consumers sit inside the per-call loop.
 */
function buildEgressNodeIndex(symbolIndex: Map<string, SdkSymbolEntry>): Map<string, SdkSymbolEntry> {
  const byNode = new Map<string, SdkSymbolEntry>();
  for (const entry of symbolIndex.values()) {
    if (!entry.egress) continue;
    if (!byNode.has(entry.methodNodeId)) byNode.set(entry.methodNodeId, entry);
  }
  return byNode;
}

/** HTTP verbs, lower-cased, as they appear in a raw egress's `method` field. */
const RAW_EGRESS_VERBS = new Set<string>(ALL_HTTP_METHODS.map((m) => m.toLowerCase()));

/**
 * POSITIVE raw-egress signal — the call itself proves it is a plain HTTP/messaging
 * egress rather than an SDK-mediated one, so the call-edge hop must abstain instead
 * of binding it to whatever single SDK method its enclosing function happens to call.
 *
 * Two proofs, either sufficient:
 *   - the call NAMES ITS OWN concrete transport address (an http `pathTemplate` or a
 *     messaging `destination`). The direct protocol hop already tried that address and
 *     missed; inheriting a sibling SDK method's route would mint a RESOLVES_TO to an
 *     entrypoint this call never reaches.
 *   - the call's `method` is an HTTP VERB (`post`, `put`, …) with no `dispatchMethod`.
 *     That is the shape of `client.post(url)` whose url did not statically resolve, so
 *     no descriptor was emitted — an SDK method is never named by a bare verb alone.
 *
 * Deliberately NOT `!call.sdkName`: `sdkName` is OPTIONAL on the `sdk` / `imported-sdk`
 * egress rules, so a profile that declares an SDK egress without one would silently
 * lose this whole tier — the "linker drops SDK-mediated edges" regression class. A
 * path-less http/grpc descriptor (registry SDK egress) is likewise not an address, so
 * it does not count as a raw-egress proof.
 */
function isRawEgress(call: ExternalCallLike): boolean {
  const descriptor = call.targetDescriptor;
  if (descriptor?.protocol === 'http' && descriptor.http?.pathTemplate) return true;
  if (descriptor?.protocol === 'messaging' && descriptor.messaging?.destination) return true;
  if (call.dispatchMethod) return false;
  const method = call.method?.trim().toLowerCase();
  return method !== undefined && RAW_EGRESS_VERBS.has(method);
}

/**
 * Call-edge hop — the structural disambiguator, ahead of the declarative fallback.
 *
 * In a workspace where the SDK source is parsed alongside its consumer (a monorepo,
 * or a published SDK repo in the same project), the calling method has a DIRECT
 * intra-repo CALLS edge to the exact SDK method node, and that node's own egress
 * already resolves to the right entrypoint. So when the moniker hop declines, the
 * caller's CALLS edges name the target the declarative (package, method) tier can
 * only guess at.
 *
 * Discipline: the candidate SDK method node must be UNIQUE *and* NAME-MATCHED. The
 * call's method name (`dispatchMethod ?? method`) is the only evidence tying this
 * call to one of its enclosing function's callees; without it the tier would bind on
 * co-residence alone — `grpcClient.fetchQuota()` in a function that also calls one
 * `postBar()` would inherit `postBar`'s route. So a call whose name matches no
 * candidate descriptor resolves to NOTHING, exactly as two matching candidates do.
 */
function callEdgeHop(
  call: ExternalCallLike,
  egressNodeIndex: Map<string, SdkSymbolEntry>,
  entrypointIndex: EntrypointIndex,
  cfg: WorkspaceCfg,
): ResolvedChain | undefined {
  // Abstain on a PROVEN raw egress BEFORE looking at the caller's callees. This tier
  // fires for every call the direct+moniker hops missed, so a raw HTTP/messaging
  // egress sitting in a function that also calls one SDK method would otherwise be
  // bound to that method's route. The abstention is keyed on the call's own
  // raw-egress evidence and ONLY on that — `sdkName` answers "who wrote the client",
  // `isRawEgress` answers "does the call name its own address", and a call that names
  // its own address is the strongest counter-evidence there is (the direct hop
  // already tried that address and missed). ANDing in `!call.sdkName` would let an
  // `@org/client` call carrying its own `/v1/foo` template inherit a sibling SDK
  // method's `/v2/bar` route. Conversely `isRawEgress` never fires on an SDK egress
  // that names no address, so a profile that declares one without an `sdkName` keeps
  // this tier (see `isRawEgress`).
  if (isRawEgress(call)) return undefined;

  // Both parts of the key are required: an unattributed call cannot be scoped to a
  // repo, and this tier does not guess across repos.
  const callees =
    call.callerId && call.sourceRepoName
      ? cfg.callTargetsByCaller?.get(callEdgeKey(call.sourceRepoName, call.callerId))
      : undefined;
  if (!callees || callees.length === 0) return undefined;

  const candidates = new Map<string, SdkSymbolEntry>();
  for (const calleeId of callees) {
    const entry = egressNodeIndex.get(calleeId);
    if (entry) candidates.set(entry.methodNodeId, entry);
  }
  if (candidates.size === 0) return undefined;

  const method = call.dispatchMethod ?? call.method;
  const wanted = method?.trim().toLowerCase();
  const named = wanted
    ? [...candidates.values()].filter(
        (e) => methodNameFromNormalizedDescriptor(e.normalizedDescriptor).toLowerCase() === wanted,
      )
    : [];
  // NAME evidence only. A nameless call, or one whose name matches no candidate,
  // abstains — see the tier doc: the name is what links this call to one callee.
  if (named.length !== 1) return undefined;
  const entry = named[0]!;

  const symbolHop: ResolvedHop = {
    kind: 'symbol',
    sourceId: call.id,
    targetId: entry.methodNodeId,
    via: HopVia.CallEdge,
    confidence: 0.9,
  };
  const egress = entry.egress!;
  const protoHop = protocolHopWithFallback(egressAsCall(symbolHop, egress), egress.targetService, entrypointIndex, cfg);
  if (!isResolved(protoHop)) return undefined;
  return {
    sourceCallId: call.id,
    finalEntrypointId: protoHop.targetId,
    hops: [symbolHop, protoHop],
    confidence: symbolHop.confidence * protoHop.confidence,
  };
}

/**
 * Recovery tiers for a call the moniker/protocol hops did not land, in precision
 * order: the structural call-edge hop first, the declarative sdkMapping row second.
 */
function recoverChain(
  call: ExternalCallLike,
  egressNodeIndex: Map<string, SdkSymbolEntry>,
  entrypointIndex: EntrypointIndex,
  cfg: WorkspaceCfg,
): ResolvedChain | undefined {
  return callEdgeHop(call, egressNodeIndex, entrypointIndex, cfg) ?? sdkMappingFallback(call, entrypointIndex, cfg);
}

/** Coerce an unresolved HopResult into a structured reason against the consumer call. */
function reasonFor(sourceId: string, hop: HopResult): UnresolvedReason {
  if (isResolved(hop)) {
    // Unreachable in practice; keep the type total rather than throwing on a
    // resolved hop that the caller mistakenly routed here.
    return { sourceId, code: UnresolvedCode.Ambiguous, detail: 'resolved hop routed to reasonFor' };
  }
  return { sourceId, code: hop.code, detail: hop.detail };
}

/**
 * Walk all consumer calls, composing symbol and protocol hops into end-to-end
 * `ResolvedChain`s, and bucketing failures as `UnresolvedReason`s.
 *
 * @param calls          Egress calls from all consumer repos in the workspace.
 * @param symbolIndex    SDK symbol index built by `buildSdkSymbolIndex`.
 * @param entrypointIndex  Workspace entrypoint index built by `buildEntrypointIndex`.
 * @param cfg            Workspace-level config including per-repo HTTP prefixes.
 */
export function walkChains(
  calls: ExternalCallLike[],
  symbolIndex: Map<string, SdkSymbolEntry>,
  entrypointIndex: EntrypointIndex,
  cfg: WorkspaceCfg,
): { chains: ResolvedChain[]; unresolved: UnresolvedReason[] } {
  const chains: ResolvedChain[] = [];
  const unresolved: UnresolvedReason[] = [];
  // Built unconditionally: it is one pass over an index already in memory, and the
  // moniker path below needs it per call regardless of whether the workspace carries
  // any CALLS edges. Building it lazily would restore an O(calls x symbolIndex) scan.
  const egressNodeIndex = buildEgressNodeIndex(symbolIndex);

  for (const call of calls) {
    // 1. Direct protocol hop against the workspace entrypoints.
    // Translate `targetDescriptor.targetService` (a service HINT) to its repo name
    // before scoping, then fall back to an unscoped match.
    const direct = protocolHopWithFallback(call, call.targetDescriptor?.targetService, entrypointIndex, cfg);
    if (isResolved(direct)) {
      chains.push({
        sourceCallId: call.id,
        finalEntrypointId: direct.targetId,
        hops: [direct],
        confidence: direct.confidence,
      });
      continue;
    }

    // 2. Symbol hop → protocol hop over the SDK method egress.
    if (call.moniker) {
      const symbolHop = matchSymbolHop(call, symbolIndex);
      if (isResolved(symbolHop)) {
        // Recover the SDK method's egress through the by-node index (the symbol
        // index itself is keyed by packageName::normalizedDescriptor, not by node id).
        const egress = egressNodeIndex.get(symbolHop.targetId)?.egress;
        if (egress) {
          // Translate the SDK egress's targetService hint to its repo, then run the
          // protocol hop with the same scope+fallback as a direct call.
          const protoHop = protocolHopWithFallback(
            egressAsCall(symbolHop, egress),
            egress.targetService,
            entrypointIndex,
            cfg,
          );
          if (isResolved(protoHop)) {
            chains.push({
              sourceCallId: call.id,
              finalEntrypointId: protoHop.targetId,
              hops: [symbolHop, protoHop],
              confidence: symbolHop.confidence * protoHop.confidence,
            });
            continue;
          }
          // Symbol hop landed but the SDK egress did not match a downstream
          // entrypoint — try the declarative sdkMapping fallback before bucketing.
          const fb = recoverChain(call, egressNodeIndex, entrypointIndex, cfg);
          if (fb) {
            chains.push(fb);
            continue;
          }
          unresolved.push(reasonFor(call.id, protoHop));
          continue;
        }

        // Symbol hop resolved but the SDK method has no captured egress to
        // chain through. Try the declarative sdkMapping fallback.
        const fbNoEgress = recoverChain(call, egressNodeIndex, entrypointIndex, cfg);
        if (fbNoEgress) {
          chains.push(fbNoEgress);
          continue;
        }
        unresolved.push({
          sourceId: call.id,
          code: UnresolvedCode.NoEntrypointMatch,
          detail: symbolHop.targetId,
        });
        continue;
      }
      // Symbol hop itself failed (no-moniker-match) — try the declarative
      // sdkMapping fallback (the dominant local-client / node_modules-less case),
      // then bucket the symbol-hop reason.
      const fbSymbolMiss = recoverChain(call, egressNodeIndex, entrypointIndex, cfg);
      if (fbSymbolMiss) {
        chains.push(fbSymbolMiss);
        continue;
      }
      unresolved.push(reasonFor(call.id, symbolHop));
      continue;
    }

    // 3. No moniker and no direct match. The symbol hop never ran (no moniker),
    // which is exactly the locally-defined-client case — try the declarative
    // sdkMapping fallback keyed on (sdk class/package, method) before bucketing.
    const fbNoMoniker = recoverChain(call, egressNodeIndex, entrypointIndex, cfg);
    if (fbNoMoniker) {
      chains.push(fbNoMoniker);
      continue;
    }
    unresolved.push(reasonFor(call.id, direct));
  }

  return { chains, unresolved };
}
