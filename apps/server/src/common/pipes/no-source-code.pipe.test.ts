import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { NoSourceCodePipe } from './no-source-code.pipe.js';

describe('NoSourceCodePipe', () => {
  const pipe = new NoSourceCodePipe();

  it('throws BadRequestException when body contains sourceCode', () => {
    const body = { functions: [{ id: 'f', sourceCode: 'function foo() {}' }] };
    expect(() => pipe.transform(body)).toThrow(BadRequestException);
  });

  it('throws with a clear error message mentioning sourceCode', () => {
    const body = { sourceCode: 'x' };
    try {
      pipe.transform(body);
      throw new Error('Expected pipe to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toContain('sourceCode');
    }
  });

  it('returns the body unchanged when clean', () => {
    const body = { id: 'repo', functions: [{ id: 'f', name: 'foo' }] };
    const result = pipe.transform(body);
    expect(result).toBe(body);
  });

  it('returns primitives unchanged', () => {
    expect(pipe.transform('string')).toBe('string');
    expect(pipe.transform(42)).toBe(42);
    expect(pipe.transform(null)).toBe(null);
  });
});
