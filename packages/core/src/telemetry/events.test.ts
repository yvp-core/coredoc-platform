import { describe, it, expect } from 'vitest';
import { EventName, ErrorCode, StepName, SCHEMA_VERSION } from './events.js';

describe('EventName', () => {
  it('has snake_case string values', () => {
    expect(EventName.ParseCompleted).toBe('parse_completed');
  });

  it('has no duplicate values', () => {
    const values = Object.values(EventName);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('ErrorCode', () => {
  it('has snake_case string values', () => {
    expect(ErrorCode.WasmMissing).toBe('wasm_missing');
  });

  it('has no duplicate values', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('StepName', () => {
  it('has no duplicate values', () => {
    const values = Object.values(StepName);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('SCHEMA_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
