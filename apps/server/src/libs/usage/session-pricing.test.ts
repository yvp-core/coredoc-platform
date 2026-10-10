import { describe, expect, it } from 'vitest';
import { PRICE_MAP_BASIS, PRICE_MAP_VERSION, estimateSessionCostUsd } from './session-pricing.js';

describe('session pricing', () => {
  it('pins the public standard-global price-map basis', () => {
    expect(PRICE_MAP_VERSION).toBe('2026-09-23');
    expect(PRICE_MAP_BASIS).toBe('standard-global-public-api-5m-cache-writes');
  });

  it('prices the genuine Codex fixture without double-charging cached or reasoning tokens', () => {
    expect(
      estimateSessionCostUsd('codex', 'gpt-5.6-sol', {
        input: 23_868,
        output: 108,
        cacheRead: 19_968,
        cacheCreation: 0,
        reasoning: 39,
      }),
    ).toBeCloseTo(0.032724, 9);
  });

  it('prices Claude input and both cache categories separately', () => {
    expect(
      estimateSessionCostUsd('claude-code', 'claude-sonnet-4-6', {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheCreation: 1_000_000,
        reasoning: 999_999,
      }),
    ).toBeCloseTo(22.05, 9);
  });

  it('returns null for unknown exact models and inconsistent OpenAI cache subsets', () => {
    const usage = { input: 10, output: 2, cacheRead: 0, cacheCreation: 0, reasoning: 0 };
    expect(estimateSessionCostUsd('codex', 'gpt-5.6', usage)).toBeNull();
    expect(estimateSessionCostUsd('claude-code', 'gpt-5.6-sol', usage)).toBeNull();
    expect(
      estimateSessionCostUsd('codex', 'gpt-5.6-sol', {
        input: 10,
        output: 2,
        cacheRead: 9,
        cacheCreation: 2,
        reasoning: 0,
      }),
    ).toBeNull();
  });

  it('refuses malformed reasoning totals and ambiguous long-context aggregate pricing', () => {
    expect(
      estimateSessionCostUsd('codex', 'gpt-5.6-sol', {
        input: 272_000,
        output: 10,
        cacheRead: 0,
        cacheCreation: 0,
        reasoning: 10,
      }),
    ).not.toBeNull();
    expect(
      estimateSessionCostUsd('codex', 'gpt-5.6-sol', {
        input: 272_001,
        output: 10,
        cacheRead: 0,
        cacheCreation: 0,
        reasoning: 10,
      }),
    ).toBeNull();
    expect(
      estimateSessionCostUsd('codex', 'gpt-5.6-sol', {
        input: 10,
        output: 9,
        cacheRead: 0,
        cacheCreation: 0,
        reasoning: 10,
      }),
    ).toBeNull();
  });

  it('prices the new model catalog with positive costs', () => {
    const usage = { input: 10_000, output: 1_000, cacheRead: 500, cacheCreation: 200, reasoning: 100 };
    expect(estimateSessionCostUsd('claude-code', 'claude-fable-5', usage)).toBeGreaterThan(0);
    expect(estimateSessionCostUsd('claude-code', 'claude-opus-5', usage)).toBeGreaterThan(0);
    expect(estimateSessionCostUsd('claude-code', 'claude-opus-5[1m]', usage)).toBeGreaterThan(0);
    expect(estimateSessionCostUsd('codex', 'gpt-5.6-luna', usage)).toBeGreaterThan(0);
  });

  it('prices claude-opus-5[1m] identically to claude-opus-5 for the same usage', () => {
    const usage = { input: 50_000, output: 5_000, cacheRead: 2_000, cacheCreation: 1_000, reasoning: 500 };
    expect(estimateSessionCostUsd('claude-code', 'claude-opus-5[1m]', usage)).toBeCloseTo(
      estimateSessionCostUsd('claude-code', 'claude-opus-5', usage) as number,
      9,
    );
  });

  it('reports whether a provider/model pair has a known price', () => {
    const none = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 };
    expect(estimateSessionCostUsd('codex', 'gpt-5.6-sol', none)).not.toBeNull();
    expect(estimateSessionCostUsd('claude-code', 'claude-sonnet-4-6', none)).not.toBeNull();
    expect(estimateSessionCostUsd('claude-code', 'claude-fable-5', none)).not.toBeNull();
    expect(estimateSessionCostUsd('claude-code', 'claude-opus-5', none)).not.toBeNull();
    expect(estimateSessionCostUsd('claude-code', 'claude-opus-5[1m]', none)).not.toBeNull();
    expect(estimateSessionCostUsd('codex', 'gpt-5.6-luna', none)).not.toBeNull();
    expect(estimateSessionCostUsd('codex', 'gpt-6-sol', none)).not.toBeNull();
    expect(estimateSessionCostUsd('codex', 'gpt-6-luna', none)).not.toBeNull();
    expect(estimateSessionCostUsd('claude-code', 'claude-opus-5-5', none)).not.toBeNull();
    expect(estimateSessionCostUsd('claude-code', 'claude-opus-5-5[1m]', none)).not.toBeNull();
    expect(estimateSessionCostUsd('codex', 'gpt-invented-9000', none)).toBeNull();
  });
});
