/**
 * `confineTo` accepts a LIST of repo-relative roots, not just one. A monorepo frontend that
 * spans several roots (e.g. posthog's `frontend/src/` + `products/`) must keep resolutions
 * landing in ANY listed root, while still rejecting everything outside all of them — a single
 * string would have forced the profile to either drop a root or abandon confinement entirely.
 * The single-string form stays supported (covered by the profiles that already use it).
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
  // Root #1 of the confinement list.
  'frontend/src/Alpha.vue': '<template><b /></template>\n',
  // Root #2 of the confinement list.
  'products/logs/Beta.vue': '<template><i /></template>\n',
  // Outside BOTH roots — must be rejected even though the file really exists.
  'vendor/ui/Gamma.vue': '<template><u /></template>\n',
  'frontend/src/App.vue': `<template>
  <Alpha />
  <Beta />
  <Gamma />
</template>
<script setup lang="ts">
import Alpha from '@/Alpha.vue';
import Beta from '@products/logs/Beta.vue';
import Gamma from '@vendor/ui/Gamma.vue';
</script>
`,
};

const PROFILE: ExtractionProfile = {
  parserId: 'test-confine-multi-root',
  substrate: { language: 'ts', include: ['**/*.ts', '**/*.vue'], exclude: ['**/node_modules/**'] },
  components: {
    framework: 'react',
    functional: true,
    functionalInExtensions: ['.tsx'],
    vueSfc: true,
    childComponents: 'jsx-walk',
    idResolution: 'import+tsconfig',
    imports: {
      aliases: { '@/*': 'frontend/src/', '@products/*': 'products/', '@vendor/*': 'vendor/' },
      confineTo: ['frontend/src/', 'products/'],
    },
    childDedup: 'per-id',
  },
};

describe('confineTo with multiple roots', () => {
  it('accepts resolutions under either root and rejects one outside both', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-confine-'));
    for (const [rel, source] of Object.entries(FILES)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source);
    }
    const { repo } = await runProfile(PROFILE, dir, 'confine-test');
    const app = repo.components?.find((c) => c.location.filePath === 'frontend/src/App.vue');
    const childIds = new Map((app?.childComponents ?? []).map((c) => [c.componentName, c.componentId]));

    expect(childIds.get('Alpha')).toContain('frontend/src/Alpha.vue');
    expect(childIds.get('Beta')).toContain('products/logs/Beta.vue');
    // Confined out: the resolver must not fabricate an id pointing at the vendor file.
    expect(childIds.get('Gamma') ?? '').not.toContain('vendor/ui/Gamma.vue');
  });
});
