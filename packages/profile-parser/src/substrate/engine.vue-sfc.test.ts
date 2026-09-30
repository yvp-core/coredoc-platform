/**
 * Acceptance for `components.vueSfc`: every scoped `.vue` file is one component, its script block
 * parses as ordinary TS (functions/calls/external calls at their TRUE lines in the SFC), and its
 * `<template>` tags become child edges — resolved through the script's imports, never fabricated.
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

const APP_VUE = `<template>
  <div class="app">
    <!-- <NeverRendered /> -->
    <RealtimeAvatarStack :users="users" />
    <base-button @click="refresh" />
    <span>plain html</span>
  </div>
</template>

<script setup lang="ts">
import RealtimeAvatarStack from './realtime-avatar-stack.vue';
import BaseButton from './BaseButton.vue';

function load(): number {
  return 1;
}

function refresh(): number {
  fetch('/api/refresh');
  return load();
}
</script>

<style scoped>
.app { display: grid; }
</style>
`;

const STACK_VUE = `<template>
  <ul>
    <li v-for="u in users" :key="u.id">
      <BaseButton />
    </li>
  </ul>
</template>

<script setup lang="ts">
import BaseButton from './BaseButton.vue';

function initials(name: string): string {
  return name.slice(0, 2);
}
</script>
`;

const BUTTON_VUE = `<template>
  <button class="btn"><slot /></button>
</template>

<script>
export default { name: 'BaseButton' };
</script>
`;

const FILES: Record<string, string> = {
  'src/App.vue': APP_VUE,
  'src/realtime-avatar-stack.vue': STACK_VUE,
  'src/BaseButton.vue': BUTTON_VUE,
  'src/main.ts': "import App from './App.vue';\nexport default App;\n",
};

const PROFILE: ExtractionProfile = {
  parserId: 'test-vue-sfc',
  substrate: { language: 'ts', include: ['**/*.ts', '**/*.tsx', '**/*.vue'], exclude: ['**/node_modules/**'] },
  components: {
    // One rule covering both surfaces (the React-repo-with-Vue-periphery shape): the emitted
    // framework must come from the file, not from the rule.
    framework: 'react',
    functional: true,
    functionalInExtensions: ['.tsx'],
    vueSfc: true,
    childComponents: 'jsx-walk',
    idResolution: 'import+tsconfig',
    imports: {},
    frameworkPrimitives: ['Transition', 'KeepAlive', 'Suspense'],
    childDedup: 'per-id',
  },
  externalCalls: [{ kind: 'http', bareCallee: 'fetch', url: { arg: 0, as: 'string-literal' }, serviceName: 'api' }],
};

async function parseFixture(): Promise<Awaited<ReturnType<typeof runProfile>>['repo']> {
  dir = mkdtempSync(join(tmpdir(), 'pp-vue-'));
  for (const [rel, source] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  const { repo } = await runProfile(PROFILE, dir, 'vue-test');
  return repo;
}

describe('components.vueSfc — Vue single-file components', () => {
  it('emits a File per .vue with functions and calls at their true SFC lines', async () => {
    const repo = await parseFixture();
    const vueFiles = repo.files.filter((f) => f.path.endsWith('.vue'));
    expect(vueFiles.map((f) => f.path).sort()).toEqual([
      'src/App.vue',
      'src/BaseButton.vue',
      'src/realtime-avatar-stack.vue',
    ]);
    expect(vueFiles.find((f) => f.path === 'src/App.vue')?.extension).toBe('.vue');
    expect(vueFiles.find((f) => f.path === 'src/App.vue')?.language).toBe('typescript');
    expect(vueFiles.find((f) => f.path === 'src/BaseButton.vue')?.language).toBe('javascript');

    // `function refresh` is on line 18 of App.vue — the SFC line, not a script-relative one.
    expect(APP_VUE.split('\n')[17]).toContain('function refresh');
    const refresh = repo.functions.find((f) => f.name === 'refresh' && f.location.filePath === 'src/App.vue');
    expect(refresh?.location.startLine).toBe(18);
    expect(repo.functions.some((f) => f.name === 'initials')).toBe(true);

    // Structural call edge from within the script block (cross-file resolution is
    // structural-only here: scip-typescript never indexes .vue).
    expect(repo.calls.some((c) => c.callerId === refresh?.id && c.calleeExpression === 'load')).toBe(true);
  });

  it('reads call shapes over the vue script block (no garbage CST from the SFC markup)', async () => {
    const repo = await parseFixture();
    const egress = (repo.externalCalls ?? []).filter((e) => e.location?.filePath === 'src/App.vue');
    expect(egress).toHaveLength(1);
    expect(egress[0].targetDescriptor?.http?.pathTemplate).toBe('/api/refresh');
    // `fetch('/api/refresh')` is on line 19 of App.vue.
    expect(APP_VUE.split('\n')[18]).toContain('fetch(');
    expect(egress[0].location?.startLine).toBe(19);
    // Markup is never mistaken for code: no function/class named after a template tag.
    expect(repo.functions.some((f) => f.name === 'div' || f.name === 'template')).toBe(false);
  });

  it('emits one component per .vue file, named after its PascalCase stem', async () => {
    const repo = await parseFixture();
    const byFile = new Map((repo.components ?? []).map((c) => [c.location.filePath, c]));
    expect([...byFile.keys()].sort()).toEqual(['src/App.vue', 'src/BaseButton.vue', 'src/realtime-avatar-stack.vue']);
    expect(byFile.get('src/realtime-avatar-stack.vue')?.name).toBe('RealtimeAvatarStack');
    expect(byFile.get('src/App.vue')?.name).toBe('App');
    expect(byFile.get('src/App.vue')?.framework).toBe('vue');
  });

  it('resolves PascalCase and kebab-case template tags to child component ids', async () => {
    const repo = await parseFixture();
    const components = repo.components ?? [];
    const idByFile = new Map(components.map((c) => [c.location.filePath, c.id]));
    const app = components.find((c) => c.location.filePath === 'src/App.vue');
    const children = (app?.childComponents ?? []).map((u) => [u.componentName, u.componentId ?? 'name-only']).sort();
    expect(children).toEqual([
      ['BaseButton', idByFile.get('src/BaseButton.vue')],
      ['RealtimeAvatarStack', idByFile.get('src/realtime-avatar-stack.vue')],
    ]);

    // Usage locations are the tag's real line in the SFC (template line 4 / 5).
    const byName = new Map((app?.childComponents ?? []).map((u) => [u.componentName, u.location?.startLine]));
    expect(byName.get('RealtimeAvatarStack')).toBe(4);
    expect(byName.get('BaseButton')).toBe(5);

    // Commented-out tags and plain HTML never become usages.
    expect((app?.childComponents ?? []).some((u) => u.componentName === 'NeverRendered')).toBe(false);

    const stack = components.find((c) => c.location.filePath === 'src/realtime-avatar-stack.vue');
    expect(stack?.childComponents?.map((u) => u.componentId)).toEqual([idByFile.get('src/BaseButton.vue')]);
    expect(components.find((c) => c.location.filePath === 'src/BaseButton.vue')?.childComponents).toEqual([]);

    // Never fabricate: every emitted childComponentId is a real component id.
    const ids = new Set(components.map((c) => c.id));
    for (const c of components) {
      for (const u of c.childComponents ?? []) if (u.componentId) expect(ids.has(u.componentId)).toBe(true);
    }
  });
});
