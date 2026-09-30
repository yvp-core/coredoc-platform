/**
 * Tests for the test-file path predicate backing `analyze_change_impact`'s
 * affectedTests roll-up.
 */

import { describe, it, expect } from 'vitest';
import { isTestFilePath } from './test-file.js';

describe('isTestFilePath', () => {
  it.each([
    ['src/modules/booking/booking.service.spec.ts', true],
    ['src/modules/booking/booking.service.test.tsx', true],
    ['internal/calc/calc_test.go', true],
    ['lib/parser_spec.rb', true],
    ['tests/test_calculator.py', true],
    ['src/__tests__/helpers.ts', true],
    ['packages/api/e2e/login.ts', true],
    ['apps/web/specs/checkout.ts', true],
    // Production code that merely mentions the words must not be classified as a test.
    ['src/testing/harness.ts', false],
    ['src/latest.ts', false],
    ['src/contest.ts', false],
    ['src/modules/booking/booking.service.ts', false],
    ['', false],
  ])('classifies %j as test=%s', (filePath, expected) => {
    expect(isTestFilePath(filePath)).toBe(expected);
  });

  it('treats an undefined path as not a test', () => {
    expect(isTestFilePath(undefined)).toBe(false);
  });

  it('normalizes Windows separators', () => {
    expect(isTestFilePath('src\\__tests__\\helpers.ts')).toBe(true);
  });
});
