import { describe, expect, it } from 'vitest';
import { TreeSitterLoader } from './tree-sitter-loader.js';

/**
 * Ruby grammar support (P4 — Ruby/Rails substrate foundation). The Ruby grammar
 * ships in tree-sitter-wasms; this verifies the loader resolves + parses it, and
 * pins the CST node shapes the Grape route extractor will walk (call/command nodes
 * for `resource :x` / `get '/path'`).
 */
describe('TreeSitterLoader — Ruby', () => {
  it('parses Ruby source into a non-error CST', async () => {
    const parser = await TreeSitterLoader.getInstance().getParser('ruby');
    const tree = parser.parse('class Foo\n  def bar\n    1\n  end\nend\n');
    expect(tree.rootNode.type).toBe('program');
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('class').length).toBeGreaterThanOrEqual(1);
  });

  it('exposes Grape DSL calls (resource/get) as call/command nodes with method names + string args', async () => {
    const parser = await TreeSitterLoader.getInstance().getParser('ruby');
    const tree = parser.parse(
      "class Companies < Base\n  resource :companies do\n    get 'industry_types' do\n    end\n  end\nend\n",
    );
    // A method call with a block is a `call`/`command_call`/`command` node in tree-sitter-ruby.
    const calls = [
      ...tree.rootNode.descendantsOfType('call'),
      ...tree.rootNode.descendantsOfType('command'),
      ...tree.rootNode.descendantsOfType('command_call'),
      ...tree.rootNode.descendantsOfType('method_call'),
    ];
    const methodNames = calls.map((c) => c.childForFieldName('method')?.text ?? c.child(0)?.text);
    expect(methodNames).toContain('resource');
    expect(methodNames).toContain('get');
    // The route's string-literal path arg is reachable on the call.
    const getCall = calls.find((c) => (c.childForFieldName('method')?.text ?? c.child(0)?.text) === 'get');
    expect(getCall?.text).toContain("'industry_types'");
  });
});
