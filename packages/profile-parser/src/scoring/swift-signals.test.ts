import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { categoryScore } from './score-core.js';
import { swiftSourceSignals } from './swift-signals.js';
import type { SwiftProfile } from '../types/swift-profile.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', 'swift', '__fixtures__', 'mini-ios');

const profile: SwiftProfile = {
  parserId: 'ios-v1',
  substrate: { language: 'swift', include: ['**/*.swift'] },
  entities: { orm: 'realm', baseClasses: ['Object'] },
};

/** [S8 Scorer PASS for mobile] http:0 → not_applicable → PASS; entities scored against emitted. */
describe('[S8] swiftSourceSignals', () => {
  it('returns http:0 (mobile consumer) and an entities denominator from the Realm models on disk', () => {
    const signals = swiftSourceSignals(FIXTURE, profile);
    expect(signals.http).toBe(0);
    expect(signals.entities).toBeGreaterThanOrEqual(1); // BookingDB: Object
    expect(signals.queue).toBeUndefined(); // omitted → self-relative
    expect(signals.dbOperations).toBeUndefined();
  });

  it('scores http not_applicable→PASS and a fully-covered entities category PASS', () => {
    const signals = swiftSourceSignals(FIXTURE, profile);
    // http: source 0 → not_applicable → PASS
    const http = categoryScore('http', signals.http, 0);
    expect(http.status).toBe('not_applicable');
    expect(http.verdict).toBe('PASS');
    // entities: emitted meets the denominator → PASS
    const entities = categoryScore('entities', signals.entities, signals.entities);
    expect(entities.verdict).toBe('PASS');
  });

  it('does not count entities from profile-excluded Swift sources', () => {
    const scoped: SwiftProfile = {
      ...profile,
      substrate: { language: 'swift', include: ['**/*.swift'], exclude: ['Models.swift'] },
    };

    expect(swiftSourceSignals(FIXTURE, scoped).entities).toBe(0);
  });
});
