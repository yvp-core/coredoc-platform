/**
 * The two bounds of the CALLERS direction, over a stub traversal.
 *
 * `intent-derivation.service.test.ts` asserts what this direction MEANS against
 * a real Ladybug fixture; what a fixture cannot show is what the read was asked
 * for, so the cap on the callee set — one query whose cost grows with the ids
 * handed to it — is asserted here, on the arguments the traversal received.
 */
import { describe, expect, it } from 'vitest';
import { DerivationBudget, DEFAULT_DERIVATION_BOUNDS } from './derivation-bounds.js';
import { IntentDerivationLimit } from './derivation-contract.js';
import type { BatchTraversalCapability } from './feature-area.js';
import { resolveNodeApplicability } from './applicability.js';

const REPO_KEY = 'github.com/acme/orders-api';
const HASH = 'abc123abc123';

function traversalStub(calleeIdsSeen: string[][]): BatchTraversalCapability {
  return {
    expandOutboundNodeIds: async () => ({ nodeIds: [], truncated: false }),
    selectReachedNodeIds: async () => ({ nodeIds: [], truncated: false }),
    getInternalCallEdges: async (_repoHashes: string[], calleeIds: string[]) => {
      calleeIdsSeen.push([...calleeIds]);
      return [];
    },
  } as unknown as BatchTraversalCapability;
}

describe('callers direction: the callee set is capped by the step limit', () => {
  it('hands the traversal at most `stepLimit()` callee ids and reports the cut', async () => {
    const seen: string[][] = [];
    // `stepLimit()` is `min(maxStepNodes, nodeHeadroom + 1)` — pin the smaller.
    const budget = new DerivationBudget({ ...DEFAULT_DERIVATION_BOUNDS, maxStepNodes: 3 });
    const nodes = Array.from({ length: 10 }, (_, index) => ({
      repoKey: REPO_KEY,
      nodeId: `${HASH}:function:src/a.ts:fn${index}`,
    }));

    await resolveNodeApplicability({
      nodes,
      items: [
        {
          id: 'br-1',
          attachment: { domainId: 'd', featureId: null },
          anchors: [
            {
              repoKey: REPO_KEY,
              nodeId: `${HASH}:class:src/b.ts:Service`,
              nodeType: 'class',
              capturedVersionedId: 'v1',
            },
          ],
        },
      ],
      features: [],
      graphRepoHashByKey: new Map([[REPO_KEY, HASH]]),
      traversal: traversalStub(seen),
      budget,
    } as unknown as Parameters<typeof resolveNodeApplicability>[0]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(3);
    expect(budget.limits).toContain(IntentDerivationLimit.StepLimit);
  });

  it('reports no step-limit cut when every queried node fits', async () => {
    const seen: string[][] = [];
    const budget = new DerivationBudget({ ...DEFAULT_DERIVATION_BOUNDS, maxStepNodes: 10 });

    await resolveNodeApplicability({
      nodes: [{ repoKey: REPO_KEY, nodeId: `${HASH}:function:src/a.ts:fn0` }],
      items: [
        {
          id: 'br-1',
          attachment: { domainId: 'd', featureId: null },
          anchors: [
            {
              repoKey: REPO_KEY,
              nodeId: `${HASH}:class:src/b.ts:Service`,
              nodeType: 'class',
              capturedVersionedId: 'v1',
            },
          ],
        },
      ],
      features: [],
      graphRepoHashByKey: new Map([[REPO_KEY, HASH]]),
      traversal: traversalStub(seen),
      budget,
    } as unknown as Parameters<typeof resolveNodeApplicability>[0]);

    expect(seen[0]).toHaveLength(1);
    expect(budget.limits).not.toContain(IntentDerivationLimit.StepLimit);
  });
});
