/**
 * Edge identity for class references (construction + import sites).
 *
 * The tuple the id encodes is what the graph builder dedups on, so each part of it must be able to
 * keep two genuinely different dependencies apart: the same class constructed from two modules, and
 * the construction versus the import of one class inside the same file.
 */
import { describe, expect, it } from 'vitest';
import { StableIdGenerator } from './id-generator.js';

describe('classRefEdgeId', () => {
  const idGen = new StableIdGenerator('demo-repo');
  const fn = 'demo:function:src/a.ts:helper';
  const file = 'demo:file:src/a.ts';

  it('gives same-named classes imported from different modules distinct ids', () => {
    expect(idGen.classRefEdgeId(fn, 'Service', 'construction', './a')).not.toBe(
      idGen.classRefEdgeId(fn, 'Service', 'construction', './b'),
    );
  });

  it('separates a same-file declaration from an import of the same name', () => {
    expect(idGen.classRefEdgeId(fn, 'Service', 'construction')).not.toBe(
      idGen.classRefEdgeId(fn, 'Service', 'construction', './a'),
    );
  });

  it('separates the construction of a class from the import of it', () => {
    expect(idGen.classRefEdgeId(fn, 'Service', 'construction', './a')).not.toBe(
      idGen.classRefEdgeId(fn, 'Service', 'import', './a'),
    );
  });

  it('is stable for a repeated (source, class, refKind, module) tuple', () => {
    expect(idGen.classRefEdgeId(fn, 'Service', 'construction', './a')).toBe(
      idGen.classRefEdgeId(fn, 'Service', 'construction', './a'),
    );
  });

  it('holds the golden ids of each site shape', () => {
    // Pinned so an id-derivation change is a decision, not a silent graph churn.
    expect(idGen.classRefEdgeId(fn, 'UserService', 'construction')).toBe('8498378fc4ef:class-ref:7ea86252');
    expect(idGen.classRefEdgeId(fn, 'UserService', 'construction', './svc')).toBe('8498378fc4ef:class-ref:5c9c8b23');
    expect(idGen.classRefEdgeId(file, 'UserService', 'import', './svc')).toBe('8498378fc4ef:class-ref:5fd4ca26');
  });
});
