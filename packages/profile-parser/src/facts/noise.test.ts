import { describe, expect, it } from 'vitest';
import { isBuiltinReceiverCall, isNoiseExternalPackage } from './noise.js';

describe('isBuiltinReceiverCall', () => {
  it('flags built-in global receivers', () => {
    expect(isBuiltinReceiverCall('console')).toBe(true);
    expect(isBuiltinReceiverCall('Math')).toBe(true);
    expect(isBuiltinReceiverCall('JSON')).toBe(true);
    expect(isBuiltinReceiverCall('process.env')).toBe(true); // root identifier is `process`
  });
  it('does not flag in-repo receivers or no receiver', () => {
    expect(isBuiltinReceiverCall('this.foo')).toBe(false);
    expect(isBuiltinReceiverCall('userService')).toBe(false);
    expect(isBuiltinReceiverCall(undefined)).toBe(false);
  });
});

describe('isNoiseExternalPackage', () => {
  it('drops empty, @types/*, and runtime helpers', () => {
    expect(isNoiseExternalPackage('')).toBe(true);
    expect(isNoiseExternalPackage('@types/node')).toBe(true);
    expect(isNoiseExternalPackage('tslib')).toBe(true);
    expect(isNoiseExternalPackage('reflect-metadata')).toBe(true);
  });
  it('keeps real service/IO packages', () => {
    expect(isNoiseExternalPackage('@mikro-orm/core')).toBe(false);
    expect(isNoiseExternalPackage('@nestjs/axios')).toBe(false);
    expect(isNoiseExternalPackage('stripe')).toBe(false);
  });
  it('honors an extra exclusion set', () => {
    expect(isNoiseExternalPackage('rxjs', new Set(['rxjs']))).toBe(true);
  });
});
