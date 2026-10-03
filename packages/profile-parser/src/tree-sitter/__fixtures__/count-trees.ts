/**
 * Test-only: count tree-sitter trees created and deleted during a run.
 *
 * Seam: every substrate gets its parser from the `TreeSitterLoader` singleton, so wrapping
 * `getParser` sees every tree a run creates and every `delete` it performs, whatever code path
 * parsed it. Callers restore the spy (`vi.restoreAllMocks()`).
 */
import { vi } from 'vitest';
import { TreeSitterLoader } from '../tree-sitter-loader.js';

/**
 * Count trees created and deleted for the duration of `run`, by wrapping the parser
 * the Ruby CST helpers ask the loader for. Returns the two counters plus the high-water
 * mark of LIVE trees (`created - released`), which is the number the 2GB cap actually
 * constrains — conservation alone cannot see a pass that holds every file's tree at once.
 */
export async function countTrees(
  run: () => Promise<void>,
): Promise<{ created: number; released: number; peakLive: number }> {
  const loader = TreeSitterLoader.getInstance();
  const realGetParser = loader.getParser.bind(loader);
  let created = 0;
  let released = 0;
  let peakLive = 0;
  // The loader memoises one Parser per grammar, so the same instance comes back on every call.
  // Patch it once and unpatch it after the run: re-wrapping would nest the counters, and leaving
  // the shadow in place would leak this run's counting into every later test in the process.
  const patched = new Set<object>();

  vi.spyOn(loader, 'getParser').mockImplementation(async (lang) => {
    const parser = await realGetParser(lang);
    if (patched.has(parser)) return parser;
    patched.add(parser);
    const realParse = parser.parse.bind(parser);
    // `parse` is non-writable on the parser prototype, so shadow it with an own
    // property instead of assigning.
    Object.defineProperty(parser, 'parse', {
      configurable: true,
      // biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter types are opaque here
      value: (...args: any[]) => {
        const tree = realParse(...args);
        if (!tree) return tree;
        created++;
        peakLive = Math.max(peakLive, created - released);
        const realDelete = tree.delete.bind(tree);
        Object.defineProperty(tree, 'delete', {
          configurable: true,
          value: () => {
            released++;
            realDelete();
          },
        });
        return tree;
      },
    });
    return parser;
  });

  try {
    await run();
  } finally {
    for (const parser of patched) Reflect.deleteProperty(parser, 'parse');
  }
  return { created, released, peakLive };
}
