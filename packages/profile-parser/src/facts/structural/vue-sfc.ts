/**
 * Vue single-file-component (`.vue`) script-block extraction.
 *
 * A `.vue` file is not a language of its own: its `<script>` block IS TypeScript/JavaScript, so
 * no new tree-sitter grammar is introduced — the existing TS/JS grammar parses the script and the
 * `<template>` block is tag-scanned elsewhere (see substrate/frameworks/vue-template.ts).
 *
 * The extracted script keeps the FULL length of the original file, with everything outside the
 * script block blanked to spaces/newlines. Line AND column numbers of script content therefore
 * stay identical to the `.vue` file, which keeps every downstream location (structural nodes,
 * call sites, CST offsets) correct with zero downstream changes.
 *
 * This is a top-level block scan, not an HTML parser: it takes the FIRST `<script …>` block and
 * its first `</script>`, so a `</script>` inside a template string or a second `<script>` block
 * (the `<script setup>` + `<script>` pairing) is out of scope by design.
 */

export interface VueScriptBlock {
  /** Original-length source with everything outside the script block blanked. */
  script: string;
  language: 'typescript' | 'javascript';
}

const SCRIPT_OPEN = /<script(\s[^>]*)?>/i;
const CLOSE_TAG = '</script>';

/** Blank a span to whitespace, preserving newlines so line numbers survive. */
function blank(span: string): string {
  return span.replace(/[^\n]/g, ' ');
}

export function extractVueScript(source: string): VueScriptBlock {
  const open = SCRIPT_OPEN.exec(source);
  // No script block: a template/style-only SFC is still a valid component, so this is an
  // intentional empty (blanked) script rather than an error. Default language: typescript.
  if (!open) return { script: blank(source), language: 'typescript' };

  const contentStart = open.index + open[0].length;
  const closeIdx = source.indexOf(CLOSE_TAG, contentStart);
  const contentEnd = closeIdx === -1 ? source.length : closeIdx;
  const attrs = open[1] ?? '';
  const lang = /\blang\s*=\s*['"]?(ts|tsx|typescript)\b/i.test(attrs) ? 'typescript' : 'javascript';

  return {
    script:
      blank(source.slice(0, contentStart)) + source.slice(contentStart, contentEnd) + blank(source.slice(contentEnd)),
    language: lang,
  };
}

/** `realtime-avatar-stack` → `RealtimeAvatarStack`, `App` → `App`. */
export function pascalCase(name: string): string {
  return name
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** Component name of a `.vue` file: its PascalCase stem (`ui/base-button.vue` → `BaseButton`). */
export function vueComponentName(filePath: string): string {
  const stem = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\.vue$/, '');
  return pascalCase(stem);
}
