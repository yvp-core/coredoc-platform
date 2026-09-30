/**
 * Edge identity for value-position enum-member references.
 *
 * Field evidence: the id keyed only (source, enum, member), so one function
 * reading `Status.Locked` from TWO different modules produced ONE id and the
 * first-wins dedup in the graph builder silently dropped a real dependency.
 */
import { describe, expect, it } from 'vitest';
import { StableIdGenerator } from './id-generator.js';

describe('enumMemberRefEdgeId', () => {
  const idGen = new StableIdGenerator('demo-repo');
  const source = 'demo:function:src/a.ts:isLocked';

  it('gives same-named members imported from different modules distinct ids', () => {
    const fromA = idGen.enumMemberRefEdgeId(source, 'Status', 'Locked', './a');
    const fromB = idGen.enumMemberRefEdgeId(source, 'Status', 'Locked', './b');
    expect(fromA).not.toBe(fromB);
  });

  it('separates a same-file declaration from an import of the same name', () => {
    const sameFile = idGen.enumMemberRefEdgeId(source, 'Status', 'Locked');
    const imported = idGen.enumMemberRefEdgeId(source, 'Status', 'Locked', './a');
    expect(sameFile).not.toBe(imported);
  });

  it('keeps the same-file id byte-identical to the pre-module-identity key', () => {
    // Golden value captured before importedFrom entered the key: same-file ids must not churn.
    expect(idGen.enumMemberRefEdgeId(source, 'Status', 'Locked')).toBe('8498378fc4ef:enum-member-ref:4ad5637d');
  });

  it('is stable for a repeated (source, enum, member, module) tuple', () => {
    expect(idGen.enumMemberRefEdgeId(source, 'Status', 'Locked', './a')).toBe(
      idGen.enumMemberRefEdgeId(source, 'Status', 'Locked', './a'),
    );
  });
});
