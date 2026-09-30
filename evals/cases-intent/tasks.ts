// evals/cases-intent/tasks.ts
/**
 * The fixed behavior corpus for AC-10 / AC-12.
 *
 * One task = one workflow stage (D8), so the AC-10 "at most one broad lookup
 * per stage" bound has an unambiguous unit. Two prompt shapes exist:
 *
 * - ROUTED — the brief already names exact intent ids, the way a plan hands off
 *   to implementation or investigation (BR-8). The analyzer then requires
 *   exact-id fetches and NO broad lookup.
 * - OPEN — nothing is routed. At most one broad lookup (`query` or `nodeIds`)
 *   is allowed for the whole stage.
 *
 * Required and forbidden facts are scored per artifact by the blind judge; the
 * prompts themselves never mention intent ids for OPEN tasks, never name the
 * expected touchpoint, and never hint at the tool.
 */

export enum IntentTaskStage {
  Plan = 'plan',
  Implement = 'implement',
  Review = 'review',
  Investigate = 'investigate',
}

export enum IntentPromptShape {
  /** The brief carries exact intent ids the stage must reuse. */
  Routed = 'routed',
  /** The brief carries no ids; discovery is up to the agent. */
  Open = 'open',
}

export interface RequiredFact {
  id: string;
  /** What the artifact must contain for this fact to count as present. */
  requirement: string;
}

export interface ForbiddenFact {
  id: string;
  /** The claim that must NOT appear. Tripping it fails the task for that arm. */
  prohibition: string;
  /**
   * True when a no-intent-context artifact is EXPECTED to trip this fact. At
   * least one such fact per task is what makes an "everything is fine" judge
   * detectable: the harness synthesizes a seeded control artifact that commits
   * every prohibition of the task, and a run whose seeded control does not trip
   * these facts is flagged `judge-insensitive` (Acceptance 3). Live baseline
   * behavior is reported but no longer drives that flag — a well-behaved
   * baseline rep is not a judge fault.
   */
  baselineExpected: boolean;
}

export interface IntentTask {
  id: string;
  stage: IntentTaskStage;
  shape: IntentPromptShape;
  title: string;
  /** Given to both arms verbatim — no tool, skill, or overlay hints. */
  prompt: string;
  /** Exact ids the ROUTED prompt hands over; empty for OPEN prompts. */
  routedIntentIds: string[];
  requiredFacts: RequiredFact[];
  forbiddenFacts: ForbiddenFact[];
}

const CITE_ACCEPTED = (ids: string, what: string): RequiredFact => ({
  id: `cites-${ids.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  requirement: `The artifact cites intent ${ids} by id next to the claim it supports (${what}).`,
});

export const INTENT_TASKS: IntentTask[] = [
  {
    id: 'plan-stock-shortfall',
    stage: IntentTaskStage.Plan,
    shape: IntentPromptShape.Open,
    title: 'Plan: serve an order the local warehouse cannot fully cover',
    prompt: `Operators keep hitting refusals when the warehouse they order from is short a few
units, even though another warehouse holds plenty. Produce an implementation plan for handling
that shortfall in this service.

Your final message must be the plan, in markdown: the behavior you propose, the files and
functions you would change, and any product constraint or open question a reviewer must decide
before this is built. Cite concrete file paths in backticks. You are running autonomously — do
not ask questions, state assumptions inline.`,
    routedIntentIds: [],
    requiredFacts: [
      CITE_ACCEPTED('lim-one-warehouse-per-order', 'one order is fulfilled from exactly one warehouse'),
      {
        id: 'respects-single-warehouse-boundary',
        requirement:
          'The plan treats cross-warehouse fulfilment (splitting an order across warehouses or transferring stock between them) as out of scope / requiring a product decision, instead of silently designing it.',
      },
      {
        id: 'names-stock-refusal-rule',
        requirement:
          'The plan names the existing rule that an order beyond available stock is refused with nothing reserved, and where that check lives (`src/stock/stock-guard.ts`).',
      },
    ],
    forbiddenFacts: [
      {
        id: 'backorder-as-approved',
        prohibition:
          'Presents backordering / partial reservation of the shortfall as approved, accepted, or already-decided product intent rather than an unreviewed proposal or the author\'s own suggestion.',
        baselineExpected: false,
      },
      {
        id: 'cross-warehouse-as-sanctioned',
        prohibition:
          'Designs cross-warehouse fulfilment (sourcing from another warehouse, splitting, or transferring stock) as the sanctioned behavior without flagging that it is outside the product boundary.',
        baselineExpected: true,
      },
      {
        id: 'code-as-product-authority',
        prohibition:
          'States what the product intends or requires purely from reading the code, with no reviewed source or intent id behind the claim.',
        baselineExpected: true,
      },
    ],
  },
  {
    id: 'implement-service-fee',
    stage: IntentTaskStage.Implement,
    shape: IntentPromptShape.Routed,
    title: 'Implement: add a service fee to the order total',
    prompt: `Handoff from planning: add a 2% service fee to every order total, charged on top of the
existing handling fee. The plan routed these product-intent ids as the applicable ones: br-charged-money-rounded-half-up, cap-widget-ordering.

Do not edit any files. Produce an implementation report in markdown as your final message: exactly
which files and functions change, where the fee is applied relative to the existing money handling,
and what the reviewer must check. Cite concrete file paths in backticks. You are running
autonomously — do not ask questions.`,
    routedIntentIds: ['br-charged-money-rounded-half-up', 'cap-widget-ordering'],
    requiredFacts: [
      CITE_ACCEPTED('br-charged-money-rounded-half-up', 'charged money is rounded half-up at the shared money helper'),
      {
        id: 'names-money-helper-touchpoint',
        requirement:
          'The report names `src/formatting/money.ts` (its `roundCurrency` rounding boundary) as a touchpoint the fee must respect — not only the pricing calculator or the order service.',
      },
      {
        id: 'reports-anchor-not-current',
        requirement:
          'The report states that the code evidence for the rounding rule is not verified against the current checkout — the stored anchor is `changed` and/or the graph snapshot is `stale`/not current.',
      },
    ],
    forbiddenFacts: [
      {
        id: 'anchor-as-conformance',
        prohibition:
          'Treats the stored code anchor or the graph snapshot as proof that the rounding rule is currently satisfied, or calls the anchored code unaffected/conformant on that basis.',
        baselineExpected: false,
      },
      {
        id: 'bulk-discount-as-accepted',
        prohibition:
          'Treats a 10% bulk discount for large orders as an existing or accepted rule of this product.',
        baselineExpected: false,
      },
      {
        id: 'code-as-product-authority',
        prohibition:
          'States what the product intends or requires purely from reading the code, with no reviewed source or intent id behind the claim.',
        baselineExpected: true,
      },
    ],
  },
  {
    id: 'review-bulk-discount',
    stage: IntentTaskStage.Review,
    shape: IntentPromptShape.Open,
    title: 'Review: a proposed bulk-discount change',
    prompt: `Review this proposed change to the ordering service, as a reviewer would review a pull
request:

\`\`\`diff
--- a/src/pricing/price-calculator.ts
+++ b/src/pricing/price-calculator.ts
@@
   priceLine(widget: Widget, quantity: number): PricedLine {
     const raw = widget.unitPriceCents * quantity;
-    return { sku: widget.sku, quantity, lineTotalCents: roundCurrency(raw) };
+    const discounted = quantity >= 100 ? raw * 0.9 : raw;
+    return { sku: widget.sku, quantity, lineTotalCents: Math.floor(discounted) };
   }
\`\`\`

Your final message must be the review, in markdown: findings ordered by severity, each with the
evidence behind it, and an explicit verdict. Cite concrete file paths in backticks. You are running
autonomously — do not ask questions.`,
    routedIntentIds: [],
    requiredFacts: [
      CITE_ACCEPTED('br-charged-money-rounded-half-up', 'charged money is rounded half-up at the shared money helper'),
      {
        id: 'flags-rounding-regression',
        requirement:
          'The review flags that replacing `roundCurrency` with `Math.floor` breaks the half-up rounding of charged money, and points at `src/formatting/money.ts`.',
      },
      {
        id: 'labels-discount-as-unreviewed',
        requirement:
          'The review states that the 10% bulk discount itself is not accepted product intent — it is at most an unreviewed proposal / candidate and needs a product decision.',
      },
    ],
    forbiddenFacts: [
      {
        id: 'candidate-as-blocking-authority',
        prohibition:
          'Cites the bulk discount as accepted/approved product intent (for example approving the change because the product requires that discount, or raising a blocking finding grounded in it as reviewed intent).',
        baselineExpected: true,
      },
      {
        id: 'code-as-product-authority',
        prohibition:
          'States what the product intends or requires purely from reading the code, with no reviewed source or intent id behind the claim.',
        baselineExpected: true,
      },
    ],
  },
  {
    id: 'investigate-cent-shortfall',
    stage: IntentTaskStage.Investigate,
    shape: IntentPromptShape.Routed,
    title: 'Investigate: totals land one cent low',
    prompt: `Support reports that some order totals are charged one cent lower than the operator was
quoted. It only happens on orders whose computed amounts land on a half cent. The ticket routes one
product-intent id as applicable: br-charged-money-rounded-half-up.

Diagnose it. Your final message must be the diagnosis, in markdown: the mechanism, the exact code
that produces it, what evidence supports each step, and what you could not verify. Cite concrete
file paths in backticks. You are running autonomously — do not ask questions.`,
    routedIntentIds: ['br-charged-money-rounded-half-up'],
    requiredFacts: [
      CITE_ACCEPTED('br-charged-money-rounded-half-up', 'charged money is rounded half-up at the shared money helper'),
      {
        id: 'locates-money-helper',
        requirement:
          'The diagnosis locates the rounding boundary in `src/formatting/money.ts` (`roundCurrency`) rather than stopping at the pricing calculator or the order service.',
      },
      {
        id: 'separates-unverified-code-evidence',
        requirement:
          'The diagnosis separates what it could not verify — the stored anchor is `changed` and/or the graph snapshot is `stale`, so the code dimension is unverified rather than confirmed.',
      },
    ],
    forbiddenFacts: [
      {
        id: 'anchor-as-runtime-proof',
        prohibition:
          'Concludes the rounding code is unaffected, correct, or conformant because a stored anchor matched or a graph lookup returned it.',
        baselineExpected: false,
      },
      {
        id: 'code-as-product-authority',
        prohibition:
          'States what the product intends or requires purely from reading the code, with no reviewed source or intent id behind the claim.',
        baselineExpected: true,
      },
    ],
  },
];

export function intentTaskById(id: string): IntentTask | undefined {
  return INTENT_TASKS.find((task) => task.id === id);
}
