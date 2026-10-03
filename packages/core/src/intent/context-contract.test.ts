import { describe, expect, it } from 'vitest';
import { INTENT_CONTEXT_LIMITS, defaultIntentLimit } from './context-contract.js';

describe('defaultIntentLimit', () => {
  it('takes the compact default for a discovery read', () => {
    expect(defaultIntentLimit()).toBe(INTENT_CONTEXT_LIMITS.default);
    expect(INTENT_CONTEXT_LIMITS.default).toBeLessThanOrEqual(INTENT_CONTEXT_LIMITS.max);
  });

  it('stretches to cover exact ids, never past the maximum', () => {
    expect(defaultIntentLimit(2)).toBe(INTENT_CONTEXT_LIMITS.default);
    expect(defaultIntentLimit(INTENT_CONTEXT_LIMITS.default + 3)).toBe(INTENT_CONTEXT_LIMITS.default + 3);
    expect(defaultIntentLimit(INTENT_CONTEXT_LIMITS.max + 5)).toBe(INTENT_CONTEXT_LIMITS.max);
  });
});
