/**
 * Vue SFC `<template>` child-component tag scan.
 *
 * The template is markup, not code — there is no CST for it (no Vue grammar is loaded by design),
 * so child usages come from a text scan of the opening tags. This is deliberately a scan and not
 * an HTML parser: comments are stripped, then every `<Tag`/`<kebab-tag` occurrence between the
 * first `<template` and the last `</template>` is a candidate.
 *
 * A candidate is a child component when it is PascalCase, or when it is kebab-case and its
 * PascalCase form is a name the file could mean (a script import, or another `.vue` component in
 * scope) — the two spellings Vue itself accepts for the same component.
 */
import type { JsxTag } from '../interface.js';
import { pascalCase } from '../../facts/structural/vue-sfc.js';

/**
 * Standard HTML tags that can appear kebab-cased or would otherwise pass the shape test.
 * Single-word lowercase tags (`div`, `span`, …) are already rejected by the shape test.
 */
const HTML_TAGS = new Set(['font-face', 'color-profile', 'missing-glyph', 'annotation-xml']);

/**
 * Vue's built-in components (PascalCase, so the shape test alone can't reject them).
 * They belong to the framework, not the repo — never child-component usages. Ecosystem
 * primitives (NuxtPage, RouterView, …) are NOT hardcoded here; a profile declares those
 * via `components.frameworkPrimitives`.
 */
const VUE_BUILTINS = new Set(['Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense']);

const TEMPLATE_OPEN = /<template(\s[^>]*)?>/i;
const OPEN_TAG = /<([A-Za-z][\w.-]*)/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** Blank a span to whitespace, preserving newlines so offsets and line numbers survive. */
function blank(span: string): string {
  return span.replace(/[^\n]/g, ' ');
}

/**
 * Child-component tags rendered in the SFC's template.
 *
 * @param source raw `.vue` file text
 * @param knownNames PascalCase names a kebab-case tag may resolve to (script imports + `.vue`
 *   component names in scope)
 */
export function vueTemplateTags(source: string, knownNames: ReadonlySet<string>): JsxTag[] {
  const open = TEMPLATE_OPEN.exec(source);
  if (!open) return [];
  const end = source.lastIndexOf('</template>');
  const start = open.index + open[0].length;
  if (end <= start) return [];
  // Keep the original offsets so tag lines are the SFC's real lines.
  const region = blank(source.slice(0, start)) + source.slice(start, end).replace(HTML_COMMENT, (m) => blank(m));

  const tags: JsxTag[] = [];
  const seen = new Set<string>();
  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(region); m; m = OPEN_TAG.exec(region)) {
    const raw = m[1].split('.')[0];
    if (HTML_TAGS.has(raw.toLowerCase())) continue;
    if (VUE_BUILTINS.has(raw) || VUE_BUILTINS.has(pascalCase(raw))) continue;
    let name: string | undefined;
    if (/^[A-Z]/.test(raw)) name = raw;
    else if (raw.includes('-') && knownNames.has(pascalCase(raw))) name = pascalCase(raw);
    if (!name) continue;
    const line = region.slice(0, m.index).split('\n').length;
    const key = `${name}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push({ name, line });
  }
  return tags;
}
