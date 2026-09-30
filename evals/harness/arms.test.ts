import { describe, expect, it } from 'vitest';
import { DEFAULT_ARMS, armFactorsFor, buildArmSystemPrompt, parseArmSelection } from './arms.js';

describe('eval arm factors', () => {
  it('keeps the default matrix unchanged and makes mcpOnly explicit', () => {
    expect(DEFAULT_ARMS).toEqual(['withoutMcp', 'withMcp']);
    expect(parseArmSelection(undefined)).toEqual(DEFAULT_ARMS);
    expect(parseArmSelection('mcpOnly')).toEqual(['mcpOnly']);
    expect(armFactorsFor('withMcp')).toEqual({ mcp: true, productGuide: true });
    expect(armFactorsFor('mcpOnly')).toEqual({ mcp: true, productGuide: false });
    expect(armFactorsFor('withoutMcp')).toEqual({ mcp: false, productGuide: false });
  });

  it('injects product guidance as a trusted delimited system block', () => {
    const result = buildArmSystemPrompt('base', armFactorsFor('withMcp'), 'USE COREDOC');
    expect(result).toContain('base');
    expect(result).toContain('<trusted-coredoc-product-guide>');
    expect(result).toContain('USE COREDOC');
    expect(result).toContain('</trusted-coredoc-product-guide>');
  });

  it('fails fast when the product arm has no guide and never leaks it to other arms', () => {
    expect(() => buildArmSystemPrompt('base', armFactorsFor('withMcp'), null)).toThrow(
      /requires the product guide/,
    );
    expect(buildArmSystemPrompt('base', armFactorsFor('mcpOnly'), 'SECRET')).toBe('base');
    expect(buildArmSystemPrompt('base', armFactorsFor('withoutMcp'), 'SECRET')).toBe('base');
  });
});
