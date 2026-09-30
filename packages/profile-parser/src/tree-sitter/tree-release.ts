/**
 * Release the WASM-side tree-sitter tree that owns `root`.
 *
 * web-tree-sitter never garbage-collects trees (no FinalizationRegistry) and its Emscripten
 * heap is hard-capped at 2GB, so a parse-and-retain loop over a large repo aborts the process
 * with `Aborted()`. Every substrate that parses per file MUST free its trees once extraction
 * has finished and only plain data is retained.
 *
 * Takes the ROOT NODE rather than the `Tree` on purpose: the language CST helpers all return
 * `parser.parse(source).rootNode` and are called that way from dozens of tests, so reaching the
 * tree through `SyntaxNode.tree` frees them without changing a single signature.
 *
 * Safe to call with a node whose tree was already deleted, or with undefined.
 */
// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter node type is opaque here
export function releaseParsedTree(root: any): void {
  try {
    root?.tree?.delete();
  } catch {
    // Already deleted, or a detached node. Freeing is best-effort cleanup — never let it
    // take down a parse that has already produced its output.
  }
}

/** Release every tree in an iterable of `{ root }` records (the per-file shape every substrate uses). */
// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter node type is opaque here
export function releaseParsedTrees(files: Iterable<{ root: any }>): void {
  for (const file of files) releaseParsedTree(file.root);
}
