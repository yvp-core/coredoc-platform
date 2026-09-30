/**
 * Execution bounds for read-time derivation (spec §6.1).
 *
 * The contract is not "be fast": it is that a bound which trips is REPORTED.
 * A derivation that quietly returns a smaller area produces an applicability
 * answer that is wrong in the direction nobody can see — an item silently
 * missing from a feature's context reads exactly like an item that does not
 * apply. So every bound here is checked BEFORE the work it guards and recorded
 * when it stops the walk.
 */

import { IntentDerivationLimit } from './derivation-contract.js';

export interface DerivationBounds {
  /** Maximum distinct nodes an area may hold, summed across repositories. */
  nodeBudget: number;
  /**
   * Maximum graph queries one derivation request may issue — ALL of them, which
   * is the whole point of the name having no qualifier: the anchor-evidence
   * lookups (`meterEvidenceQueries`) as well as the traversal steps. Evidence
   * used to be invisible here, which made the bound a statement about the
   * smaller half of the work.
   *
   * ONE bound, deliberately, and v1.1-05 re-checked the decision rather than
   * inheriting it. A second traversal-only cap would have to be spent from the
   * same graph lease, so it could only ever make a request refuse work the total
   * bound still had room for — and the thing a caller must be told is that the
   * REQUEST was cut short, not which half of it ran out. The lever that made the
   * unscoped node read stop truncating was choosing better candidates
   * (`resolveNodeApplicability`'s relevance order and the caller-side repo
   * prune), not a tighter or looser number here: raising the number again is
   * what this comment exists to argue against.
   */
  queryBudget: number;
  /** Maximum containment levels walked below the seeds. */
  maxContainmentDepth: number;
  /** Maximum ids one traversal step may return. */
  maxStepNodes: number;
}

/**
 * Defaults, chosen against the spike fixture (SPIKE.md): a 1268-node closure
 * over 60 files costs 5 queries and ~90 ms, so a 5000-node envelope is roughly
 * 4× the measured shape of a large feature — wide enough that a normal feature
 * never trips it, narrow enough that a pathological seed (a whole monorepo
 * package) is refused with `truncated` instead of timing out inside the
 * per-query cache timeout.
 *
 * `queryBudget` is 400 rather than the traversal-only 40 it started as, because
 * it now also counts the anchor-evidence lookups it always should have: evidence
 * costs roughly one query per DISTINCT anchor plus one per repository, and the
 * context read hands derivation up to `INTENT_CONTEXT_READ_LIMITS.derivationItems`
 * (200) items. 400 keeps the ~5-query traversal shape the spike measured
 * comfortably inside the envelope on a realistically-anchored workspace, while
 * still bounding the total graph work of one request — which 40 never did,
 * because it could not see the larger half.
 */
export const DEFAULT_DERIVATION_BOUNDS: Readonly<DerivationBounds> = Object.freeze({
  nodeBudget: 5000,
  queryBudget: 400,
  maxContainmentDepth: 8,
  maxStepNodes: 5000,
});

export function resolveDerivationBounds(overrides: Partial<DerivationBounds> = {}): DerivationBounds {
  const bounds = { ...DEFAULT_DERIVATION_BOUNDS, ...overrides };
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Derivation bound ${name} must be a positive safe integer, got ${String(value)}`);
    }
  }
  return bounds;
}

/**
 * One request's shared budget.
 *
 * Shared, not per-feature: a context read that derives several features must
 * not be able to spend N × the query budget by asking for N features. The
 * accounting therefore lives on the request, and every consumer of it reports
 * the same `truncated`.
 */
export class DerivationBudget {
  private queries = 0;
  private nodes = 0;
  private readonly tripped = new Set<IntentDerivationLimit>();

  constructor(readonly bounds: DerivationBounds) {}

  /** Queries issued so far. */
  get queriesUsed(): number {
    return this.queries;
  }

  /** Nodes admitted into areas so far. */
  get nodesUsed(): number {
    return this.nodes;
  }

  get truncated(): boolean {
    return this.tripped.size > 0;
  }

  /** Every bound that stopped work, in a stable order. */
  get limits(): IntentDerivationLimit[] {
    return [...this.tripped].sort();
  }

  /**
   * Is there room for at least one more query?
   *
   * A PEEK: unlike {@link claimQuery} it records nothing, because a caller that
   * decides not to start a unit of work (the next feature area, say) must be
   * able to report the skip in its own words — and a peek that latched
   * `query_budget` would make "I chose not to start" indistinguishable from "a
   * query was refused".
   */
  hasQueryHeadroom(): boolean {
    return this.queries < this.bounds.queryBudget;
  }

  /**
   * Claim one query. Returns false when the budget is spent — the caller must
   * stop, not retry: a spent budget is a reported outcome, not an error.
   */
  claimQuery(): boolean {
    if (this.queries >= this.bounds.queryBudget) {
      this.tripped.add(IntentDerivationLimit.QueryBudget);
      return false;
    }
    this.queries += 1;
    return true;
  }

  /** Node headroom left, never negative. */
  remainingNodes(): number {
    return Math.max(0, this.bounds.nodeBudget - this.nodes);
  }

  /**
   * Admit up to `remainingNodes()` of `candidates` (which the caller has
   * already de-duplicated against what it holds). Returns the admitted slice;
   * anything dropped trips the node budget.
   */
  admitNodes(candidates: readonly string[]): string[] {
    const room = this.remainingNodes();
    if (candidates.length > room) {
      this.tripped.add(IntentDerivationLimit.NodeBudget);
      this.nodes += room;
      return candidates.slice(0, room);
    }
    this.nodes += candidates.length;
    return [...candidates];
  }

  /** Record a bound that the caller detected itself (a step cap, a depth cap). */
  recordLimit(limit: IntentDerivationLimit): void {
    this.tripped.add(limit);
  }

  /**
   * Per-step id cap.
   *
   * Deliberately the node headroom PLUS ONE: asking for exactly the headroom
   * cannot tell "the graph had this many" from "the graph had more", so a
   * node-budget trip would be reported as a step-limit trip and the response
   * would name the wrong bound. One extra id is what makes the node budget
   * observable at the place it actually binds.
   */
  stepLimit(): number {
    return Math.max(1, Math.min(this.bounds.maxStepNodes, this.remainingNodes() + 1));
  }
}
