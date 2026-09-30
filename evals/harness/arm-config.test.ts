// evals/harness/arm-config.test.ts
import { describe, it, expect } from 'vitest';
import { armToRunConfig } from './arm-config.js';
import { ARMS } from './planning-types.js';

const ctx = { coredocPluginDir: '/plug/coredoc', superpowersPluginDir: '/plug/superpowers' };
const arm = (id: 'A' | 'B' | 'C' | 'D') => ARMS.find((a) => a.id === id)!;

describe('armToRunConfig', () => {
  it('A (plan, no mcp): withoutMcp, no plugins, no skills', () => {
    const c = armToRunConfig(arm('A'), ctx);
    expect(c.runAgentArm).toBe('withoutMcp');
    expect(c.pluginPaths).toBeUndefined();
    expect(c.skills).toBeUndefined();
    expect(c.systemPrompt).toMatch(/PLAN MODE/i);
  });

  it('B (superpowers, no mcp): superpowers plugin + brainstorming skill, withoutMcp', () => {
    const c = armToRunConfig(arm('B'), ctx);
    expect(c.runAgentArm).toBe('withoutMcp');
    expect(c.pluginPaths).toEqual(['/plug/superpowers']);
    expect(c.skills).toContain('superpowers:brainstorming');
  });

  it('C (plan, mcp): coredoc plugin + coredoc-mcp skill, withMcp', () => {
    const c = armToRunConfig(arm('C'), ctx);
    expect(c.runAgentArm).toBe('withMcp');
    expect(c.pluginPaths).toEqual(['/plug/coredoc']);
    expect(c.skills).toEqual(['coredoc-eval-skills:coredoc-mcp']);
    expect(c.systemPrompt).toMatch(/coredoc MCP/i);
  });

  it('D (superpowers, mcp): both plugins, both skills, withMcp', () => {
    const c = armToRunConfig(arm('D'), ctx);
    expect(c.runAgentArm).toBe('withMcp');
    expect(c.pluginPaths).toEqual(['/plug/superpowers', '/plug/coredoc']);
    expect(c.skills).toEqual([
      'superpowers:using-superpowers',
      'superpowers:brainstorming',
      'coredoc-eval-skills:coredoc-mcp',
    ]);
  });
});
