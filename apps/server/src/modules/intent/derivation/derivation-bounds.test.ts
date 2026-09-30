/**
 * Pure bound accounting — no graph, no DI.
 *
 * The property under test throughout: a bound that binds is RECORDED. A budget
 * that quietly returns less is the one failure mode §6.1 exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_DERIVATION_BOUNDS, DerivationBudget, resolveDerivationBounds } from './derivation-bounds.js';
import { IntentDerivationLimit } from './derivation-contract.js';

describe('resolveDerivationBounds', () => {
  it('fills every bound from the defaults', () => {
    expect(resolveDerivationBounds()).toEqual(DEFAULT_DERIVATION_BOUNDS);
  });

  it('applies overrides one at a time', () => {
    expect(resolveDerivationBounds({ nodeBudget: 10 })).toEqual({ ...DEFAULT_DERIVATION_BOUNDS, nodeBudget: 10 });
  });

  it('refuses a bound that cannot bound anything', () => {
    expect(() => resolveDerivationBounds({ queryBudget: 0 })).toThrow(/queryBudget/);
    expect(() => resolveDerivationBounds({ nodeBudget: -1 })).toThrow(/nodeBudget/);
    expect(() => resolveDerivationBounds({ maxStepNodes: 1.5 })).toThrow(/maxStepNodes/);
  });
});

describe('DerivationBudget', () => {
  it('starts untruncated with no limits', () => {
    const budget = new DerivationBudget(resolveDerivationBounds());

    expect(budget.truncated).toBe(false);
    expect(budget.limits).toEqual([]);
    expect(budget.queriesUsed).toBe(0);
  });

  it('hands out exactly the query budget, then reports the trip', () => {
    const budget = new DerivationBudget(resolveDerivationBounds({ queryBudget: 2 }));

    expect(budget.claimQuery()).toBe(true);
    expect(budget.claimQuery()).toBe(true);
    expect(budget.claimQuery()).toBe(false);
    expect(budget.queriesUsed).toBe(2);
    expect(budget.limits).toEqual([IntentDerivationLimit.QueryBudget]);
  });

  it('admits nodes up to the budget and records the overflow', () => {
    const budget = new DerivationBudget(resolveDerivationBounds({ nodeBudget: 3 }));

    expect(budget.admitNodes(['a', 'b'])).toEqual(['a', 'b']);
    expect(budget.truncated).toBe(false);
    expect(budget.admitNodes(['c', 'd', 'e'])).toEqual(['c']);
    expect(budget.limits).toEqual([IntentDerivationLimit.NodeBudget]);
    expect(budget.nodesUsed).toBe(3);
    expect(budget.admitNodes(['f'])).toEqual([]);
  });

  it('asks for one more id than the headroom so a node-budget trip is observable', () => {
    const budget = new DerivationBudget(resolveDerivationBounds({ nodeBudget: 4, maxStepNodes: 100 }));
    budget.admitNodes(['a']);

    // Three slots left: a step that asks for exactly three cannot tell a
    // complete answer from a clipped one.
    expect(budget.stepLimit()).toBe(4);
  });

  it('never asks for zero ids, even with no headroom left', () => {
    const budget = new DerivationBudget(resolveDerivationBounds({ nodeBudget: 1 }));
    budget.admitNodes(['a']);

    expect(budget.remainingNodes()).toBe(0);
    expect(budget.stepLimit()).toBe(1);
  });

  it('clamps a step to the per-step cap when the node headroom is larger', () => {
    const budget = new DerivationBudget(resolveDerivationBounds({ nodeBudget: 1000, maxStepNodes: 7 }));

    expect(budget.stepLimit()).toBe(7);
  });

  it('reports every distinct limit that tripped, in a stable order', () => {
    const budget = new DerivationBudget(resolveDerivationBounds({ nodeBudget: 1, queryBudget: 1 }));
    budget.admitNodes(['a', 'b']);
    budget.claimQuery();
    budget.claimQuery();
    budget.recordLimit(IntentDerivationLimit.StepLimit);
    budget.recordLimit(IntentDerivationLimit.StepLimit);

    expect(budget.limits).toEqual([
      IntentDerivationLimit.NodeBudget,
      IntentDerivationLimit.QueryBudget,
      IntentDerivationLimit.StepLimit,
    ]);
  });
});
