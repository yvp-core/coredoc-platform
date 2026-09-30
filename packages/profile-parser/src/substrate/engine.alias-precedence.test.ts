/**
 * Alias precedence in import resolution (tsconfig `paths` semantics): a repo declaring BOTH
 * an exact key (`@ui`) and a wildcard key (`@ui/*`) must route subpath specifiers through the
 * wildcard — insertion-order first-match let the exact key swallow `@ui/Button` and join a
 * garbage path (`…/indexButton`). Exact keys (no `*`, no trailing `/`) match only exactly;
 * trailing-`/` keys keep their historical prefix behavior.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  // Exact-key target: the library barrel.
  'ui/src/index.vue': '<template><button /></template>\n',
  // Wildcard-key target: a subpath component.
  'ui/src/Button.vue': '<template><button class="b" /></template>\n',
  'src/App.vue': `<template>
  <Index />
  <Btn />
</template>
<script setup lang="ts">
import Index from '@ui';
import Btn from '@ui/Button.vue';
</script>
`,
  'src/main.ts': "import App from './App.vue';\nexport default App;\n",
};

const PROFILE: ExtractionProfile = {
  parserId: 'test-alias-precedence',
  substrate: { language: 'ts', include: ['**/*.ts', '**/*.vue'], exclude: ['**/node_modules/**'] },
  components: {
    framework: 'react',
    functional: true,
    functionalInExtensions: ['.tsx'],
    vueSfc: true,
    childComponents: 'jsx-walk',
    idResolution: 'import+tsconfig',
    // The exact key deliberately comes FIRST so insertion order alone would shadow the
    // wildcard for subpaths; length-sorted matching must pick `@ui/*` for `@ui/Button.vue`.
    imports: { aliases: { '@ui': 'ui/src/index', '@ui/*': 'ui/src/' } },
    childDedup: 'per-id',
  },
};

describe('import alias precedence', () => {
  it('routes subpaths through the wildcard key even when an exact key shadows it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-alias-'));
    for (const [rel, source] of Object.entries(FILES)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source);
    }
    const { repo } = await runProfile(PROFILE, dir, 'alias-test');
    const app = repo.components?.find((c) => c.location.filePath === 'src/App.vue');
    const childIds = new Map((app?.childComponents ?? []).map((c) => [c.componentName, c.componentId]));
    // `@ui/Button.vue` → wildcard → ui/src/Button.vue.
    expect(childIds.get('Btn')).toContain('ui/src/Button.vue');
    // Bare `@ui` → exact key → the barrel index.
    expect(childIds.get('Index')).toContain('ui/src/index.vue');
  });
});
