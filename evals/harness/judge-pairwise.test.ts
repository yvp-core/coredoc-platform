import { describe, it, expect } from 'vitest';
import { buildPairwisePrompt, parsePairwiseVerdict } from './judge-pairwise.js';

describe('buildPairwisePrompt', () => {
  it('blinds coredoc tool names and embeds both specs', () => {
    const p = buildPairwisePrompt('do X', 'use mcp__coredoc-eval__find_callers here', 'plain spec B');
    expect(p).not.toMatch(/mcp__coredoc-eval__/);
    expect(p).toMatch(/Spec A/);
    expect(p).toMatch(/Spec B/);
  });

  it('contains multi-repo and DO NOT RE-DERIVE language', () => {
    const p = buildPairwisePrompt('do X', 'spec A content', 'spec B content');
    expect(p).toMatch(/32 repositories/);
    expect(p).toMatch(/DO NOT RE-DERIVE/i);
  });

  it('embeds grounding hints when provided', () => {
    const p = buildPairwisePrompt('t', 'a', 'b', {
      a: { present: 10, total: 12, absent: ['Foo.bar', 'baz.ts'] },
    });
    expect(p).toMatch(/10\/12/);
    expect(p).toMatch(/Foo\.bar/);
    expect(p).toMatch(/baz\.ts/);
  });

  it('shows (none) for empty absent list', () => {
    const p = buildPairwisePrompt('t', 'a', 'b', {
      a: { present: 5, total: 5, absent: [] },
    });
    expect(p).toMatch(/\(none\)/);
  });

  it('omits per-spec grounding block when no hints provided', () => {
    const p = buildPairwisePrompt('t', 'a', 'b');
    // The [Spec A on-disk check] label block should not appear when no hints are given.
    expect(p).not.toMatch(/\[Spec A on-disk check\]/);
    expect(p).not.toMatch(/\[Spec B on-disk check\]/);
  });

  it('includes Expected scope block and repo names when expectedRepos provided', () => {
    const p = buildPairwisePrompt('t', 'a', 'b', undefined, ['api-server', 'billing-service']);
    expect(p).toContain('Expected scope');
    expect(p).toContain('api-server');
  });

  it('does not include Expected scope block when no expectedRepos', () => {
    const p = buildPairwisePrompt('t', 'a', 'b');
    expect(p).not.toContain('Expected scope');
  });
});

describe('parsePairwiseVerdict', () => {
  it('parses fenced JSON', () => {
    const r = parsePairwiseVerdict('```json\n{"winner":"A","reason":"grounded"}\n```');
    expect(r.winner).toBe('A');
    expect(r.reason).toBe('grounded');
  });
  it('parses an explicit tie', () => {
    expect(parsePairwiseVerdict('{"winner":"tie","reason":"even"}').winner).toBe('tie');
  });
  it('flags unparseable output as invalid, never a silent tie', () => {
    expect(parsePairwiseVerdict('garbage').winner).toBe('invalid');
  });
  it('flags a non-A/B/tie winner value as invalid', () => {
    expect(parsePairwiseVerdict('{"winner":"Spec A"}').winner).toBe('invalid');
    expect(parsePairwiseVerdict('{"reason":"no winner key"}').winner).toBe('invalid');
  });
});
