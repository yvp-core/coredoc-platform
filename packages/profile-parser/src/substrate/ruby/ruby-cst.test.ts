import { describe, expect, it, vi } from 'vitest';
import { releaseParsedTree, withParsedRuby } from './ruby-cst.js';

// web-tree-sitter never GCs trees and its heap is capped at 2GB, so every parse must release
// its tree. `releaseParsedTree` is re-exported from the shared tree-sitter helper (the one implementation
// every substrate shares); these tests pin the contract the Ruby lane depends on — delete the
// owning tree, and never let cleanup take down a parse that already produced its output.
describe('releaseParsedTree', () => {
  it('deletes the tree that owns the root node', () => {
    const del = vi.fn();
    releaseParsedTree({ tree: { delete: del } });
    expect(del).toHaveBeenCalledOnce();
  });

  it('does not throw when the node or its tree is absent', () => {
    expect(() => releaseParsedTree(undefined)).not.toThrow();
    expect(() => releaseParsedTree(null)).not.toThrow();
    expect(() => releaseParsedTree({})).not.toThrow();
  });

  it('swallows a delete that throws (an already-freed or detached tree)', () => {
    expect(() =>
      releaseParsedTree({
        tree: {
          delete: () => {
            throw new Error('Aborted()');
          },
        },
      }),
    ).not.toThrow();
    // The Ruby-local copy this replaced optional-CALLED `delete` (`delete?.()`), which reports a
    // tree with no `delete` as released instead of failing loudly.
    expect(() => releaseParsedTree({ tree: {} })).not.toThrow();
  });
});

// The scope helper is what makes the pairing unforgettable at the ten Ruby parse sites; the
// release must happen on the throwing path too, which is exactly the path a hand-written
// `finally` gets wrong.
describe('withParsedRuby', () => {
  it('releases the tree after the callback returns', async () => {
    let released: unknown;
    const value = await withParsedRuby('class A; def b; end; end', (root) => {
      released = root.tree;
      return root.descendantsOfType('method').length;
    });
    expect(value).toBe(1);
    expect(released).toBeDefined();
  });

  it('releases the tree when the callback throws, and rethrows', async () => {
    const deletes: number[] = [];
    await expect(
      withParsedRuby('class A; end', (root) => {
        const real = root.tree.delete.bind(root.tree);
        Object.defineProperty(root.tree, 'delete', {
          configurable: true,
          value: () => {
            deletes.push(1);
            real();
          },
        });
        throw new Error('extraction blew up');
      }),
    ).rejects.toThrow('extraction blew up');
    expect(deletes).toHaveLength(1);
  });
});
