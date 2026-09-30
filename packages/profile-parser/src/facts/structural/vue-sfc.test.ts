import { describe, expect, it } from 'vitest';
import { parseTsStructural } from './ts-structural.js';
import { extractVueScript, pascalCase, vueComponentName } from './vue-sfc.js';

const SFC = `<template>
  <div class="stack">
    <base-avatar v-for="u in users" :key="u.id" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

function initials(name: string): string {
  return name.slice(0, 2);
}
</script>

<style scoped>
.stack { display: flex; }
</style>
`;

describe('extractVueScript', () => {
  it('keeps the original length and blanks everything outside the script block', () => {
    const { script } = extractVueScript(SFC);
    expect(script.length).toBe(SFC.length);
    expect(script.split('\n').length).toBe(SFC.split('\n').length);
    expect(script).toContain("import { computed } from 'vue';");
    expect(script).not.toContain('base-avatar');
    expect(script).not.toContain('display: flex');
  });

  it('preserves line AND column of script content', () => {
    const { script } = extractVueScript(SFC);
    const srcLines = SFC.split('\n');
    const outLines = script.split('\n');
    const fnLine = srcLines.findIndex((l) => l.includes('function initials'));
    expect(outLines[fnLine]).toBe(srcLines[fnLine]);
  });

  it('reads lang="ts" as typescript on <script setup>', () => {
    expect(extractVueScript(SFC).language).toBe('typescript');
    expect(extractVueScript('<script setup lang="tsx">const a = 1;</script>').language).toBe('typescript');
    expect(extractVueScript('<script lang="typescript">const a = 1;</script>').language).toBe('typescript');
  });

  it('reads a plain or non-ts <script> as javascript', () => {
    expect(extractVueScript('<script>export default {};</script>').language).toBe('javascript');
    expect(extractVueScript('<script setup>const a = 1;</script>').language).toBe('javascript');
    expect(extractVueScript("<script lang='jsx'>const a = 1;</script>").language).toBe('javascript');
  });

  it('yields an empty (blanked) script for a component-only SFC', () => {
    const src = '<template>\n  <div />\n</template>\n';
    const { script, language } = extractVueScript(src);
    expect(script.trim()).toBe('');
    expect(script.length).toBe(src.length);
    expect(language).toBe('typescript');
  });

  it('takes the first script block only', () => {
    const src = '<script setup lang="ts">\nconst a = 1;\n</script>\n<script>\nconst b = 2;\n</script>\n';
    const { script } = extractVueScript(src);
    expect(script).toContain('const a = 1;');
    expect(script).not.toContain('const b = 2;');
  });
});

describe('extractVueScript + parseTsStructural', () => {
  it('reports the TRUE line of a function inside the .vue file', async () => {
    const { script, language } = extractVueScript(SFC);
    const file = await parseTsStructural('src/RealtimeAvatarStack.vue', script, language);
    const fn = file.functions.find((f) => f.name === 'initials');
    // `function initials` sits on line 10 of the SFC (1-based).
    expect(SFC.split('\n')[9]).toContain('function initials');
    expect(fn?.startLine).toBe(10);
  });
});

describe('pascalCase / vueComponentName', () => {
  it('converts kebab and snake stems, leaving PascalCase untouched', () => {
    expect(pascalCase('realtime-avatar-stack')).toBe('RealtimeAvatarStack');
    expect(pascalCase('App')).toBe('App');
    expect(pascalCase('my_widget')).toBe('MyWidget');
    expect(vueComponentName('apps/www/components/realtime-avatar-stack.vue')).toBe('RealtimeAvatarStack');
    expect(vueComponentName('App.vue')).toBe('App');
  });
});
