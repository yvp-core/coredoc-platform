/**
 * dump-grammar.ts — print the CST a tree-sitter grammar ACTUALLY produces, from the exact
 * grammar build this repo loads.
 *
 * Step 0 of adding a language (docs/ADDING-A-LANGUAGE.md). Node type names, which child is a
 * named field, and whether a literal exposes its content as a child all vary between grammars
 * AND between builds of the same grammar. Guessing them does not fail loudly — it yields empty
 * strings and silently-wrong lookups:
 *
 *   - Rust's `string_literal` has no `string_content` child in this build, so the Python idiom
 *     `descendantsOfType('string_content')[0]?.text` returns '' for every Rust string
 *     (`rustStringValue` exists because of this).
 *   - Go's `interpreted_string_literal` has the same shape, AND a `method_declaration`'s name is
 *     a `field_identifier`, so `descendantsOfType('identifier')[0]` returns the RECEIVER variable
 *     rather than the method name.
 *
 * Both classes are invisible in a unit test written against the same wrong assumption. Run this
 * against a representative source file first and write the substrate from what it prints.
 *
 * Usage:
 *   npx tsx packages/profile-parser/scripts/dump-grammar.ts <language> <file>
 *   npx tsx packages/profile-parser/scripts/dump-grammar.ts <language> -        # read stdin
 *   npx tsx packages/profile-parser/scripts/dump-grammar.ts go samples/router.go --depth 12
 *   npx tsx packages/profile-parser/scripts/dump-grammar.ts go x.go --all       # anonymous nodes too
 *
 * <language> is a TreeSitterLoader key: typescript, tsx, python, rust, go, java, javascript,
 * ruby, swift.
 */
import { readFileSync } from 'node:fs';
import { TreeSitterLoader } from '../src/tree-sitter/tree-sitter-loader.js';

// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter node type is opaque here
type TsNode = any;

/**
 * The grammars `TreeSitterLoader` can load. Mirrors its own `SupportedLanguage`, which the
 * module keeps private — validating here turns a typo into a usage error naming the real
 * options, rather than a WASM load failure pointing at a missing file.
 */
const LANGUAGES = [
  'typescript',
  'tsx',
  'python',
  'rust',
  'go',
  'java',
  'javascript',
  'ruby',
  'swift',
  'kotlin',
  'zig',
  'csharp',
] as const;
type Language = (typeof LANGUAGES)[number];

function isSupported(v: string): v is Language {
  return (LANGUAGES as readonly string[]).includes(v);
}

/**
 * Fields probed on every node. tree-sitter exposes no "list this node's fields" API, so the
 * common ones are asked for by name — an unknown field simply returns null.
 */
const FIELDS = [
  'name',
  'receiver',
  'function',
  'arguments',
  'operand',
  'field',
  'type',
  'path',
  'value',
  'body',
  'parameters',
  'result',
  'type_parameters',
  'alias',
  'left',
  'right',
  'condition',
  'consequence',
  'alternative',
  'declarator',
  'key',
  'label',
  'object',
  'property',
  'argument',
  'operator',
  'pattern',
  'returns',
];

/** Node types whose VALUE a substrate reads out of source — the trap surface. */
const LITERAL_HINT = /string|literal|comment|raw|char|template/i;

function preview(text: string, max = 56): string {
  const flat = text.replace(/\n/g, '\\n');
  return JSON.stringify(flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`);
}

function fieldsOf(node: TsNode): string {
  const found: string[] = [];
  for (const f of FIELDS) {
    try {
      const child = node.childForFieldName?.(f);
      if (child) found.push(`${f}=${child.type}`);
    } catch {
      // Not a field of this node type.
    }
  }
  return found.length > 0 ? `   [${found.join(' ')}]` : '';
}

function dump(node: TsNode, maxDepth: number, all: boolean, depth = 0, out: string[] = []): string[] {
  if (!all && !node.isNamed) return out;
  out.push(`${'  '.repeat(depth)}${node.type}${node.isNamed ? '' : ' (anon)'} ${preview(node.text)}${fieldsOf(node)}`);
  if (depth >= maxDepth) return out;
  const count = all ? node.childCount : node.namedChildCount;
  for (let i = 0; i < count; i++) dump(all ? node.child(i) : node.namedChild(i), maxDepth, all, depth + 1, out);
  return out;
}

/**
 * The trap probe: for every literal-ish node type present, report whether it exposes named
 * children at all and whether a `*_content` child exists. A `namedChildCount` of 0 means `.text`
 * (delimiters included) is the ONLY way to read the value — write the language's `…StringValue`
 * helper before anything else reads a literal.
 */
function probeLiterals(root: TsNode): string[] {
  const seen = new Map<string, TsNode>();
  const walk = (n: TsNode): void => {
    if (n.isNamed && LITERAL_HINT.test(n.type) && !seen.has(n.type)) seen.set(n.type, n);
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
  };
  walk(root);
  if (seen.size === 0) return ['  (no literal-like nodes in this sample — add one and re-run)'];
  return [...seen.entries()].map(([type, n]) => {
    const children = [];
    for (let i = 0; i < n.namedChildCount; i++) children.push(n.namedChild(i).type);
    const contentChild = children.find((c) => /content/.test(c));
    const verdict = contentChild
      ? `exposes ${contentChild} — reading that child is safe`
      : 'NO content child — .text INCLUDES the delimiters, write a value helper';
    return `  ${type}: namedChildCount=${n.namedChildCount} children=[${children.join(', ')}]\n    → ${verdict}\n    text=${preview(n.text)}`;
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const depthArg = args.indexOf('--depth');
  const maxDepth = depthArg !== -1 ? Number(args[depthArg + 1]) : 10;
  const [language, file] = positional;

  if (!language || !file || !isSupported(language)) {
    console.error(
      'Usage: npx tsx packages/profile-parser/scripts/dump-grammar.ts <language> <file|-> [--depth N] [--all]',
    );
    console.error(`  <language>: ${LANGUAGES.join(' | ')}`);
    if (language && !isSupported(language)) console.error(`\nUnknown language '${language}'.`);
    process.exit(2);
  }

  const source = file === '-' ? readFileSync(0, 'utf-8') : readFileSync(file, 'utf-8');
  const parser = await TreeSitterLoader.getInstance().getParser(language);
  const root = parser.parse(source).rootNode;

  console.log(`=== ${language} CST (${file === '-' ? 'stdin' : file}) ===`);
  console.log(dump(root, Number.isFinite(maxDepth) ? maxDepth : 10, flags.has('--all')).join('\n'));
  console.log('\n=== literal probe (the silent-failure surface) ===');
  console.log(probeLiterals(root).join('\n'));
  if (root.descendantsOfType('ERROR').length > 0) {
    console.log('\nNOTE: the sample contains ERROR nodes — tree-sitter never throws on a parse');
    console.log('failure, it emits them. Check them before trusting the shapes above.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
