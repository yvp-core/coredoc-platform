import { describe, expect, it } from 'vitest';
import { Verdict } from '../score-verdict.js';
import { type CategoryScore, profileCompletion } from './score-core.js';

function required(verdict: Verdict): CategoryScore {
  return {
    category: 'http',
    source: 10,
    emitted: verdict === Verdict.PASS ? 8 : verdict === Verdict.PARTIAL ? 6 : 0,
    ratio: verdict === Verdict.PASS ? 0.8 : verdict === Verdict.PARTIAL ? 0.6 : 0,
    status: 'required',
    verdict,
  };
}

describe('profileCompletion', () => {
  it('passes only when every required category passes and no blocker exists', () => {
    expect(profileCompletion([required(Verdict.PASS)], [], [])).toBe('PASS');
  });

  it('allows explicit user acceptance only for PARTIAL coverage', () => {
    expect(profileCompletion([required(Verdict.PARTIAL)], [], [])).toBe('ACCEPTABLE_GAP');
  });

  it('blocks zero/low coverage failures', () => {
    expect(profileCompletion([required(Verdict.FAIL)], [], [])).toBe('BLOCKED');
  });

  it('blocks structural errors and consistency red flags even when coverage passes', () => {
    expect(profileCompletion([required(Verdict.PASS)], ['validate error'], [])).toBe('BLOCKED');
    expect(profileCompletion([required(Verdict.PASS)], [], ['invisible API surface'])).toBe('BLOCKED');
  });
});
