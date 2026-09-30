import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NO_SOURCE_CODE_MESSAGE, noSourceCode } from './no-source-code.validator.js';

const payload = noSourceCode(z.unknown());

describe('noSourceCode refinement', () => {
  it('fails validation when payload has sourceCode at top level', () => {
    const result = payload.safeParse({ sourceCode: 'function foo() {}' });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0].message).toBe(NO_SOURCE_CODE_MESSAGE);
    expect(result.error?.issues[0].message).toContain('sourceCode');
  });

  it('fails validation when sourceCode is nested deep', () => {
    const result = payload.safeParse({ functions: [{ id: 'f', sourceCode: 'body' }] });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
  });

  it('passes validation on a clean payload', () => {
    expect(payload.safeParse({ functions: [{ id: 'f', name: 'foo' }] }).success).toBe(true);
  });

  it('passes validation on primitive values', () => {
    expect(payload.safeParse('not an object').success).toBe(true);
  });

  it('is the same message the push pipe throws', () => {
    expect(NO_SOURCE_CODE_MESSAGE).toBe('Payload must not contain sourceCode fields. Strip source code before push.');
  });
});
