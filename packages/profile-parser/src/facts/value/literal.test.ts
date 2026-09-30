import { describe, expect, it } from 'vitest';
import { isStringLiteral, unquoteLiteral } from './literal.js';

describe('literal', () => {
  it('detects string literals', () => {
    expect(isStringLiteral("'/users'")).toBe(true);
    expect(isStringLiteral('"x"')).toBe(true);
    expect(isStringLiteral('`x`')).toBe(true); // no interpolation
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${y}` is the test input (interpolated template), not a real placeholder
    expect(isStringLiteral('`x${y}`')).toBe(false); // interpolation → not a plain literal
    expect(isStringLiteral('ROUTES.users')).toBe(false);
    expect(isStringLiteral('TOPIC')).toBe(false);
  });
  it('unquotes', () => {
    expect(unquoteLiteral("'/users'")).toBe('/users');
    expect(unquoteLiteral('"x"')).toBe('x');
  });
});
