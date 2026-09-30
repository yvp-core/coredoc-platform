import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Node } from 'web-tree-sitter';
import { TreeSitterLoader } from './tree-sitter-loader.js';

// A runtime upgrade can reject an entire language's binary before extraction starts.
// Exercise each shipped grammar through the production loader, without a compiler or network.
const samples = [
  ['typescript', 'export function run(x: number) { return x + 1; }', 'function_declaration'],
  ['tsx', 'export function View() { return <main>Hello</main>; }', 'function_declaration'],
  ['javascript', 'function run(x) { return x + 1; }', 'function_declaration'],
  ['python', 'def run(x):\n    return x + 1\n', 'function_definition'],
  ['rust', 'fn run(x: i32) -> i32 { x + 1 }', 'function_item'],
  ['go', 'package main\nfunc run(x int) int { return x + 1 }', 'function_declaration'],
  ['java', 'class Example { int run(int x) { return x + 1; } }', 'method_declaration'],
  ['ruby', 'class Example\n  def run(x)\n    x + 1\n  end\nend\n', 'method'],
  ['swift', 'class Example { func run(x: Int) -> Int { return x + 1 } }', 'function_declaration'],
  ['kotlin', 'class Example {\n fun run(x: Int): Int {\n return x + 1\n }\n}\n', 'function_declaration'],
  ['zig', 'pub fn run(x: i32) i32 { return x + 1; }', 'function_declaration'],
  ['csharp', 'class Example(IService service) { public string[] Items { get; set; } = []; }', 'class_declaration'],
] as const;

describe('published tree-sitter runtime and grammars', () => {
  it('parses escaped braces followed by nested interpolation in C#', async () => {
    const parser = await TreeSitterLoader.getInstance().getParser('csharp');
    const tree = parser.parse(`class Renderer {
      string Render() => $"{{{string.Join(", ", new[] { $"{Value()}" })}}}";
      string Verbatim() => $@"{{{string.Join(", ", new[] { "x" })}}}";
      int Value() => 1;
    }`);
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('invocation_expression').map((call: Node) => call.text)).toContain(
        'Value()',
      );
    } finally {
      tree.delete();
    }
  });
  it('loads the modern C# grammar even when a general grammar directory is configured', async () => {
    vi.resetModules();
    vi.stubEnv(
      'COREDOC_TREESITTER_WASM_DIR',
      join(dirname(createRequire(import.meta.url).resolve('@cursorless/tree-sitter-wasms/package.json')), 'out'),
    );
    try {
      const { TreeSitterLoader: Loader } = await import('./tree-sitter-loader.js');
      const parser = await Loader.getInstance().getParser('csharp');
      const tree = parser.parse(samples.find(([language]) => language === 'csharp')![1]);
      try {
        expect(tree.rootNode.hasError).toBe(false);
      } finally {
        tree.delete();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each(samples)('loads and parses %s', async (language, source, declaration) => {
    const parser = await TreeSitterLoader.getInstance().getParser(language);
    const tree = parser.parse(source);
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType(declaration)).not.toHaveLength(0);
    } finally {
      tree.delete();
    }
  });
});
