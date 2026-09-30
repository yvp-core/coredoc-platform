/**
 * Read-time intent derivation (spec §6) — the graph moat.
 *
 * One entry point per direction:
 *
 * - {@link IntentDerivationService.deriveFeatureContext} — which items apply to
 *   a feature, and why.
 * - {@link IntentDerivationService.deriveNodeContext} — which items apply to a
 *   set of code nodes (the same computation, run backwards, under the same
 *   bounds).
 *
 * Both read the workspace's CURRENT graph snapshot through the existing
 * snapshot read path (`WorkspaceMcpContextService`), so intent sees exactly the
 * graph the hosted MCP tools see, leased for the callback and no longer.
 *
 * Three rules the implementation is organised around:
 *
 * 1. Nothing derived is stored (§4.9).
 * 2. Graph unavailability degrades, never errors (§6.3): attachment-based
 *    applicability keeps working and the response says what was lost.
 * 3. A bound that trips is reported (§6.1): `truncated` plus the named limits.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CodeAnchor } from '@coredoc/core';
import {
  type IGraphReadRepository,
  type IntentEvidenceResult,
  type ObservedCheckout,
  type RepoSnapshotEvidence,
  resolveIntentEvidence,
} from '@coredoc/db';
import { ControlPlaneService, type WorkspaceRepo } from '../../../database/control-plane.service.js';
import { WorkspaceMcpContextService } from '../../../mcp/workspace-mcp-context.service.js';
import { resolveFeatureApplicability, resolveNodeApplicability } from './applicability.js';
import { DerivationBudget, type DerivationBounds, resolveDerivationBounds } from './derivation-bounds.js';
import {
  type DerivableFeature,
  type DerivableIntentItem,
  type FeatureArea,
  type FeatureSeedRef,
  type IntentDerivationDegradation,
  type IntentDerivationResult,
  type IntentNodeDerivationResult,
  IntentGraphUnavailableCode,
  type ItemAnchorEvidence,
  type ItemApplicability,
} from './derivation-contract.js';
import { computeFeatureArea, resolveBatchTraversal, type BatchTraversalCapability } from './feature-area.js';
import { graphRemediation, graphUnavailableCode, isProgrammingError } from './graph-degradation.js';
import { assembleRepoProvenance, graphRepoHashByIntentKey } from './graph-provenance.js';

export interface DeriveFeatureContextRequest {
  feature: DerivableFeature;
  items: readonly DerivableIntentItem[];
  /**
   * Observed checkout per DURABLE repo key. Only a repo present here can be
   * reported `current`/`stale`; everything else is `unverified` (§6.3). The
   * caller never gets to assert freshness by omission.
   */
  observedCheckouts?: Readonly<Record<string, ObservedCheckout>>;
  bounds?: Partial<DerivationBounds>;
}

export interface DeriveNodeContextRequest {
  nodes: readonly FeatureSeedRef[];
  items: readonly DerivableIntentItem[];
  /** Candidate features whose areas may claim the queried nodes. */
  features: readonly DerivableFeature[];
  observedCheckouts?: Readonly<Record<string, ObservedCheckout>>;
  bounds?: Partial<DerivationBounds>;
}

/** What a successful graph lease produced, before it is shaped into a response. */
interface GraphDerivation {
  applicable: ItemApplicability[];
  area: FeatureArea | null;
  evidence: IntentEvidenceResult;
  repos: readonly WorkspaceRepo[];
  graphVersionId: string | null;
  degradation?: IntentDerivationDegradation;
  matchedFeatureIds?: string[];
  undeterminedFeatureIds?: string[];
}

/** Candidate features a scope suggestion names before it says "and others". */
const SUGGESTED_FEATURE_NAMES = 5;

/**
 * The one-sentence narrowing a truncated node read carries (§6.2).
 *
 * It names the highest-ranked features derivation never reached, because those
 * are precisely the scopes that would change the answer — a suggestion that only
 * said "narrow it" would leave the caller guessing which of several hundred
 * features to guess at.
 */
function scopeSuggestionFor(undeterminedFeatureIds: readonly string[]): string | undefined {
  if (undeterminedFeatureIds.length === 0) return undefined;
  const named = undeterminedFeatureIds.slice(0, SUGGESTED_FEATURE_NAMES);
  const trailer = undeterminedFeatureIds.length > named.length ? ', and others' : '';
  return (
    'The request budget ran out before every candidate feature was derived. ' +
    `Re-read with feature=<id> or domain=<id> to derive completely; not reached: ${named.join(', ')}${trailer}.`
  );
}

function toCodeAnchors(item: DerivableIntentItem): CodeAnchor[] {
  return item.anchors.map((anchor) => ({
    // `repo` is the identity an anchor addresses its repository by; here that
    // is the durable intent repo key, which is what `repoHashesByName` is
    // keyed on too. Same seam, different naming convention from the local CLI.
    repo: anchor.repoKey,
    nodeId: anchor.nodeId,
    nodeType: anchor.nodeType,
    capturedVersionedId: anchor.capturedVersionedId,
    rationale: '',
  }));
}

function toItemEvidence(evidence: IntentEvidenceResult): ItemAnchorEvidence[] {
  return evidence.items.map((item) => ({
    itemId: item.intentId,
    anchors: item.anchors,
    ...(item.itemStatus ? { unmapped: true as const } : {}),
  }));
}

function evidenceByRepoKey(evidence: IntentEvidenceResult): Map<string, RepoSnapshotEvidence> {
  return new Map(evidence.repos.map((repo) => [repo.repo, repo]));
}

/**
 * Charge the anchor-evidence lookups to the shared budget.
 *
 * `resolveIntentEvidence` issues one repo-overview query per repository and one
 * node lookup per distinct anchor — routinely MORE graph queries than the
 * traversal it precedes, and until now not one of them was counted. A budget
 * that measured only the smaller half was not a bound on the request's graph
 * work; it was a bound on part of it.
 *
 * The wrapper counts, it does not stop. Evidence is not optional (§6.4 requires
 * anchorStatus on every returned anchor, and §6.3 reserves absence for an
 * unreadable graph), so the only work a spent budget can cut is the traversal
 * that runs after it — which is exactly the optional half. The consequence is
 * deliberate and one-directional: a request whose evidence alone spends the
 * budget reports `truncated` with `query_budget`, and its anchor-derived
 * applicability really is cut short. Over-reporting truncation is the safe
 * error; under-reporting it is the failure `derivation-bounds.ts` exists to
 * prevent.
 */
function meterEvidenceQueries(repository: IGraphReadRepository, budget: DerivationBudget): IGraphReadRepository {
  // The scoped facade is frozen, and plain assignment cannot shadow a
  // non-writable inherited property — defineProperty installs own overrides
  // without ever mutating the facade itself.
  const metered: IGraphReadRepository = Object.create(repository);
  const override = <Name extends 'getRepoOverview' | 'getNodeWithProperties'>(name: Name) => {
    Object.defineProperty(metered, name, {
      value: (...args: Parameters<IGraphReadRepository[Name]>) => {
        budget.claimQuery();
        return (repository[name] as (...inner: Parameters<IGraphReadRepository[Name]>) => unknown)(...args);
      },
      enumerable: true,
    });
  };
  override('getRepoOverview');
  override('getNodeWithProperties');
  return metered;
}

@Injectable()
export class IntentDerivationService {
  private readonly logger = new Logger(IntentDerivationService.name);

  constructor(
    private readonly workspaceContext: WorkspaceMcpContextService,
    private readonly controlPlane: ControlPlaneService,
  ) {}

  async deriveFeatureContext(
    workspaceId: string,
    request: DeriveFeatureContextRequest,
  ): Promise<IntentDerivationResult> {
    const budget = new DerivationBudget(resolveDerivationBounds(request.bounds));
    const derived = await this.withGraph(
      workspaceId,
      budget,
      request.items,
      request.observedCheckouts,
      async (traversal, graphRepoHashByKey) => {
        // A readable snapshot without batched traversal still answers attachment
        // and inheritance — the applicability resolver takes `null` for exactly
        // this case rather than the caller returning an empty list.
        if (!traversal) {
          return {
            applicable: await resolveFeatureApplicability({
              feature: request.feature,
              items: request.items,
              area: null,
              traversal: null,
              budget,
            }),
            area: null,
          };
        }
        const area = await computeFeatureArea({
          traversal,
          feature: request.feature,
          graphRepoHashByKey,
          budget,
        });
        const applicable = await resolveFeatureApplicability({
          feature: request.feature,
          items: request.items,
          area,
          traversal,
          budget,
        });
        return { applicable, area };
      },
    );

    if (!derived.ok) {
      return this.degradedResult(workspaceId, request.feature, request.items, budget, derived.degradation);
    }
    return this.shapeResult(derived.value, budget);
  }

  async deriveNodeContext(workspaceId: string, request: DeriveNodeContextRequest): Promise<IntentNodeDerivationResult> {
    const budget = new DerivationBudget(resolveDerivationBounds(request.bounds));
    const derived = await this.withGraph(
      workspaceId,
      budget,
      request.items,
      request.observedCheckouts,
      async (traversal, graphRepoHashByKey) => {
        const resolved = await resolveNodeApplicability({
          nodes: request.nodes,
          items: request.items,
          features: request.features,
          graphRepoHashByKey,
          traversal,
          budget,
        });
        return {
          applicable: resolved.applicable,
          area: null,
          matchedFeatureIds: resolved.matchedFeatureIds,
          undeterminedFeatureIds: resolved.undeterminedFeatureIds,
        };
      },
    );

    if (!derived.ok) {
      const degraded = await this.degradedResult(workspaceId, null, request.items, budget, derived.degradation);
      return { ...degraded, matchedFeatureIds: [] };
    }
    const shaped = this.shapeResult(derived.value, budget);
    const suggestion = scopeSuggestionFor(derived.value.undeterminedFeatureIds ?? []);
    return {
      ...shaped,
      matchedFeatureIds: derived.value.matchedFeatureIds ?? [],
      ...(suggestion ? { scopeSuggestion: suggestion } : {}),
    };
  }

  /**
   * Lease the workspace graph, resolve anchor evidence, and run `derive`.
   *
   * The lease and the evidence resolution are here, once, because both
   * directions need exactly the same three things (a repository, the repo
   * identity map, and anchorStatus) and because a failure anywhere in that
   * sequence must produce the SAME honest degradation rather than one shape per
   * call site.
   */
  private async withGraph(
    workspaceId: string,
    budget: DerivationBudget,
    items: readonly DerivableIntentItem[],
    observedCheckouts: Readonly<Record<string, ObservedCheckout>> | undefined,
    derive: (
      traversal: BatchTraversalCapability | null,
      graphRepoHashByKey: ReadonlyMap<string, string>,
    ) => Promise<{
      applicable: ItemApplicability[];
      area: FeatureArea | null;
      matchedFeatureIds?: string[];
      undeterminedFeatureIds?: string[];
    }>,
  ): Promise<{ ok: true; value: GraphDerivation } | { ok: false; degradation: IntentDerivationDegradation }> {
    try {
      return await this.workspaceContext.withContextByWorkspaceId(workspaceId, async (context) => {
        const graphRepoHashByKey = graphRepoHashByIntentKey(context.repos);
        const traversal = resolveBatchTraversal(context.repository);
        try {
          const evidence = await resolveIntentEvidence({
            repository: meterEvidenceQueries(context.repository, budget),
            items: items.map((item) => ({ id: item.id, codeAnchors: toCodeAnchors(item) })),
            repoHashesByName: Object.fromEntries(graphRepoHashByKey),
            observedCheckouts: { ...(observedCheckouts ?? {}) },
          });
          const result = await derive(traversal, graphRepoHashByKey);
          return {
            ok: true as const,
            value: {
              ...result,
              evidence,
              repos: context.repos,
              graphVersionId: context.versionId,
              // A readable snapshot on a backend without batched traversal is
              // NOT an unavailable graph: evidence stands, only anchor-derived
              // applicability is gone. Saying so is the whole point of §6.3.
              ...(traversal
                ? {}
                : {
                    degradation: {
                      code: IntentGraphUnavailableCode.BatchTraversalUnsupported,
                      remediation: graphRemediation(IntentGraphUnavailableCode.BatchTraversalUnsupported),
                    },
                  }),
            },
          };
        } catch (error) {
          // A TYPED graph-plane failure (the cache evicting the snapshot
          // mid-read, say) keeps its own code; anything else that is not a
          // programming error is a query failure the caller can act on (retry /
          // inspect the snapshot), so it degrades. Logged with its cause either
          // way, because a degradation nobody can trace back to a cause is not
          // much better than a silent one.
          //
          // A PROGRAMMING error is rethrown. Catching everything here meant a
          // `TypeError` in this module reported itself as "the graph is
          // unavailable" — an honest-looking answer that hides the bug forever
          // and sends the reader to inspect a snapshot that is perfectly fine.
          if (isProgrammingError(error) && !graphUnavailableCode(error)) throw error;
          const code = graphUnavailableCode(error) ?? IntentGraphUnavailableCode.GraphQueryFailed;
          this.logger.error(`Intent derivation query failed for workspace ${workspaceId}`, error);
          return { ok: false as const, degradation: { code, remediation: graphRemediation(code) } };
        }
      });
    } catch (error) {
      const code = graphUnavailableCode(error);
      // Not a known graph-plane failure: a bug must surface as a bug, never as
      // a cheerful degradation that hides it forever.
      if (!code) throw error;
      return { ok: false, degradation: { code, remediation: graphRemediation(code) } };
    }
  }

  private shapeResult(derived: GraphDerivation, budget: DerivationBudget): IntentDerivationResult {
    const provenance = assembleRepoProvenance({
      repos: derived.repos,
      graphVersionId: derived.graphVersionId,
      evidenceByRepoKey: evidenceByRepoKey(derived.evidence),
    });
    return {
      applicable: derived.applicable,
      evidence: { available: true, items: toItemEvidence(derived.evidence), repos: provenance },
      ...(derived.area
        ? {
            area: {
              featureId: derived.area.featureId,
              repos: derived.area.slices.map((slice) => ({
                repoKey: slice.repoKey,
                nodeIds: [...slice.coreNodeIds].sort(),
                calledNodeIds: [...slice.calledNodeIds].sort(),
              })),
              unresolvedRepoKeys: [...derived.area.unresolvedRepoKeys],
            },
          }
        : {}),
      ...(derived.degradation ? { degradation: derived.degradation } : {}),
      truncated: budget.truncated,
      limits: budget.limits,
      queriesUsed: budget.queriesUsed,
    };
  }

  /**
   * The graph could not be read at all: intent still resolves by attachment.
   *
   * Provenance is still assembled from the control plane when it can be read,
   * so the response can name WHICH graph was unavailable — a degraded answer
   * that cannot identify the snapshot it failed on is not much better than an
   * error.
   */
  private async degradedResult(
    workspaceId: string,
    feature: DerivableFeature | null,
    items: readonly DerivableIntentItem[],
    budget: DerivationBudget,
    degradation: IntentDerivationDegradation,
  ): Promise<IntentDerivationResult> {
    const applicable = feature
      ? await resolveFeatureApplicability({ feature, items, area: null, traversal: null, budget })
      : [];
    let repos: WorkspaceRepo[] = [];
    try {
      repos = await this.controlPlane.listRepos(workspaceId);
    } catch (error) {
      this.logger.warn(`Intent derivation could not list repos for workspace ${workspaceId}`, error);
    }
    return {
      applicable,
      evidence: {
        available: false,
        repos: assembleRepoProvenance({ repos, graphVersionId: null }),
      },
      degradation,
      truncated: budget.truncated,
      limits: budget.limits,
      queriesUsed: budget.queriesUsed,
    };
  }
}
