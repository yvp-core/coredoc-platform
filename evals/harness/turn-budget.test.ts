import { describe, expect, it } from 'vitest';
import { turnBudgetFor } from './run.js';

/**
 * The per-case turn budget is the only knob standing between a synthesis-heavy case
 * and `error_max_turns`, so its tiers are pinned by name: a raised budget for the
 * declared synthesis-heavy cases, the exploratory budget for enumeration-heavy ones,
 * and the flat default for everything else (which must stay byte-identical).
 */
describe('turnBudgetFor', () => {
  it('gives the synthesis-heavy feature-implementation-plan case a raised budget', () => {
    // An earlier paid run's MCP arm DNF'd on this case at the exploratory cap while the run
    // that COMPLETED scored best in the matrix — the budget, not the case, was the
    // failure. The raise is bounded: 1.5-2x the exploratory budget it overrides.
    const fp = turnBudgetFor('feature-implementation-plan');
    const exploratory = turnBudgetFor('route-api-surface');

    expect(fp).toBeGreaterThanOrEqual(Math.ceil(exploratory * 1.5));
    expect(fp).toBeLessThanOrEqual(exploratory * 2);
  });

  it('leaves every other case on its existing budget', () => {
    // Exploratory tier unchanged...
    expect(turnBudgetFor('route-api-surface')).toBe(45);
    expect(turnBudgetFor('cross-repo-trace')).toBe(45);
    // ...and the flat default for non-exploratory cases.
    expect(turnBudgetFor('explain-repo')).toBe(60);
    expect(turnBudgetFor('blast-radius')).toBe(60);
  });
});
