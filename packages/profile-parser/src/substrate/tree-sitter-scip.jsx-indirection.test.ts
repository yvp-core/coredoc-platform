/**
 * JSX component resolution through ONE indirection hop — the two halves of the
 * measured supabase S4 gap (~74% of 22,671 child references were name-only stubs):
 *
 *  1. BARREL HOP (`resolveJsxTagByImport`): the shadcn idiom imports every component
 *     from a package barrel (`import { ChartContainer } from 'ui'`) whose index only
 *     re-exports. The specifier resolves to a file that declares nothing, so the old
 *     answer was `(index.ts, ChartContainer)` — never a real component id. The hop
 *     follows `export … from` to the declaring module (named first, honoring the alias
 *     direction; `export *` only on a UNIQUE match), bounded and cycle-safe.
 *
 *  2. COLLISION GUARD (`resolveJsxTagBySCIP`): the same audit found a MIS-resolution —
 *     `<ChartContainer/>` linked to `packages/ui/…/Menu.tsx:Group`. A confidently wrong
 *     edge is worse than a missing one, so a candidate must now be ATTESTED: same name,
 *     or the declaring file's DEFAULT export (the documented HOC-peel rename lane).
 *
 * The SCIP half drives the resolver with a hand-built index: the shape of the measured
 * failure (a def-bearing occurrence on the tag's line naming a DIFFERENT component) is
 * exactly reproducible that way, and does not depend on scip-typescript's mood.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBaseline } from '../facts/index.js';
import type { LoadedScip } from '../facts/index.js';
import type { ImportResolution } from '../types.js';
import { runProfile } from './run.js';
import { TreeSitterScipSubstrate } from './tree-sitter-scip.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const COMPONENT = (name: string) => `export function ${name}() {\n  return <div>${name}</div>;\n}\n`;

async function buildSubstrate(files: Record<string, string>): Promise<TreeSitterScipSubstrate> {
  dir = mkdtempSync(join(tmpdir(), 'pp-jsx-indirection-'));
  for (const [rel, source] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  const baseline = await buildBaseline({ repoRoot: dir, repoName: 'jsx-indirection' }, { runScip: false });
  return TreeSitterScipSubstrate.create(baseline, {
    repoRoot: dir,
    scope: { include: ['**/*.ts', '**/*.tsx'], exclude: ['**/node_modules/**'] },
  });
}

/** tsconfig-style alias config mapping the bare package name `ui` onto its source root. */
const UI_IMPORTS: ImportResolution = { aliases: { ui: 'packages/ui/src' } };

describe('resolveJsxTagByImport — barrel/re-export child-edge resolution', () => {
  it('follows a NAMED re-export chain to the declaring file', async () => {
    const sub = await buildSubstrate({
      'packages/ui/src/index.ts': "export * from './components/index';\n",
      'packages/ui/src/components/index.ts': "export { ChartContainer } from './chart';\n",
      'packages/ui/src/components/chart.tsx': COMPONENT('ChartContainer'),
      'apps/web/block.tsx':
        "import { ChartContainer } from 'ui';\nexport function Block() {\n  return <ChartContainer />;\n}\n",
    });

    expect(sub.resolveJsxTagByImport('apps/web/block.tsx', 'ChartContainer', UI_IMPORTS)).toEqual({
      filePath: 'packages/ui/src/components/chart.tsx',
      declaredName: 'ChartContainer',
    });
  });

  it('honors the ALIAS direction: the re-exported-as name maps to the source name', async () => {
    const sub = await buildSubstrate({
      'packages/ui/src/index.ts': "export { Chart as ChartContainer } from './chart';\n",
      'packages/ui/src/chart.tsx': COMPONENT('Chart'),
      'apps/web/block.tsx':
        "import { ChartContainer } from 'ui';\nexport function Block() {\n  return <ChartContainer />;\n}\n",
    });

    expect(sub.resolveJsxTagByImport('apps/web/block.tsx', 'ChartContainer', UI_IMPORTS)).toEqual({
      filePath: 'packages/ui/src/chart.tsx',
      declaredName: 'Chart',
    });
  });

  it('resolves a `export *` hop when exactly one star target declares the name', async () => {
    const sub = await buildSubstrate({
      'packages/ui/src/index.ts': "export * from './chart';\nexport * from './menu';\n",
      'packages/ui/src/chart.tsx': COMPONENT('ChartContainer'),
      'packages/ui/src/menu.tsx': COMPONENT('Group'),
      'apps/web/block.tsx':
        "import { ChartContainer } from 'ui';\nexport function Block() {\n  return <ChartContainer />;\n}\n",
    });

    expect(sub.resolveJsxTagByImport('apps/web/block.tsx', 'ChartContainer', UI_IMPORTS)).toEqual({
      filePath: 'packages/ui/src/chart.tsx',
      declaredName: 'ChartContainer',
    });
  });

  it('does NOT pick a winner when two star targets both declare the name (ambiguous → barrel)', async () => {
    const sub = await buildSubstrate({
      'packages/ui/src/index.ts': "export * from './chart';\nexport * from './chart-legacy';\n",
      'packages/ui/src/chart.tsx': COMPONENT('ChartContainer'),
      'packages/ui/src/chart-legacy.tsx': COMPONENT('ChartContainer'),
      'apps/web/block.tsx':
        "import { ChartContainer } from 'ui';\nexport function Block() {\n  return <ChartContainer />;\n}\n",
    });

    // Falls back to the pre-hop answer (the barrel), which the engine's validator rejects —
    // unresolved, never a coin flip between two same-named components.
    expect(sub.resolveJsxTagByImport('apps/web/block.tsx', 'ChartContainer', UI_IMPORTS)).toEqual({
      filePath: 'packages/ui/src/index.ts',
      declaredName: 'ChartContainer',
    });
  });

  it('terminates on a re-export cycle instead of looping', async () => {
    const sub = await buildSubstrate({
      'packages/ui/src/index.ts': "export * from './other';\n",
      'packages/ui/src/other.ts': "export * from './index';\n",
      'apps/web/block.tsx':
        "import { ChartContainer } from 'ui';\nexport function Block() {\n  return <ChartContainer />;\n}\n",
    });

    expect(sub.resolveJsxTagByImport('apps/web/block.tsx', 'ChartContainer', UI_IMPORTS)).toEqual({
      filePath: 'packages/ui/src/index.ts',
      declaredName: 'ChartContainer',
    });
  });

  it('stops at a forwardRef component — the shadcn declaration shape', async () => {
    // `const X = React.forwardRef(…)` is a value binding, not a StructuralFunction: the hop's
    // stop condition reads CST bindings, or it would walk straight past every shadcn component.
    const sub = await buildSubstrate({
      'packages/ui/src/index.ts': "export * from './chart';\n",
      'packages/ui/src/chart.tsx':
        'const ChartContainer = React.forwardRef((props, ref) => <div ref={ref} />);\nexport { ChartContainer };\n',
      'apps/web/block.tsx':
        "import { ChartContainer } from 'ui';\nexport function Block() {\n  return <ChartContainer />;\n}\n",
    });

    expect(sub.resolveJsxTagByImport('apps/web/block.tsx', 'ChartContainer', UI_IMPORTS)).toEqual({
      filePath: 'packages/ui/src/chart.tsx',
      declaredName: 'ChartContainer',
    });
  });

  it('leaves a direct (non-barrel) import untouched', async () => {
    const sub = await buildSubstrate({
      'packages/ui/src/chart.tsx': COMPONENT('ChartContainer'),
      'apps/web/block.tsx':
        "import { ChartContainer } from 'ui/chart';\nexport function Block() {\n  return <ChartContainer />;\n}\n",
    });

    expect(
      sub.resolveJsxTagByImport('apps/web/block.tsx', 'ChartContainer', { aliases: { 'ui/': 'packages/ui/src/' } }),
    ).toEqual({ filePath: 'packages/ui/src/chart.tsx', declaredName: 'ChartContainer' });
  });
});

describe('components — child render edges through a barrel (end to end)', () => {
  it('carries componentId onto a child tag imported from a package barrel', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-jsx-indirection-e2e-'));
    const files: Record<string, string> = {
      'packages/ui/src/index.ts': "export * from './chart';\n",
      'packages/ui/src/chart.tsx': COMPONENT('ChartContainer'),
      'apps/web/block.tsx':
        "import { ChartContainer } from 'ui';\nexport function Block() {\n  return <ChartContainer />;\n}\n",
    };
    for (const [rel, source] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source);
    }
    const { repo } = await runProfile(
      {
        parserId: 'test-jsx-barrel-children',
        substrate: { language: 'ts', include: ['**/*.ts', '**/*.tsx'], exclude: ['**/node_modules/**'] },
        components: { framework: 'react', functionalInExtensions: ['.tsx'], imports: UI_IMPORTS },
      },
      dir,
      'jsx-barrel-children',
    );

    const chart = (repo.components ?? []).find((c) => c.name === 'ChartContainer');
    const block = (repo.components ?? []).find((c) => c.name === 'Block');
    expect(chart).toBeDefined();
    expect(block?.childComponents).toEqual([
      expect.objectContaining({ componentName: 'ChartContainer', componentId: chart?.id }),
    ]);
  });
});

/** Hand-build the SCIP index the resolver reads: one reference occurrence per (file, line, symbol). */
function scipWithRefs(refs: { file: string; line: number; symbol: string }[]): LoadedScip {
  const byFile = new Map<string, { symbol: string; symbolRoles: number; range: number[] }[]>();
  for (const r of refs) {
    const arr = byFile.get(r.file) ?? [];
    // symbolRoles 0 = reference (not a definition); range = [line, startChar, endChar], 0-based.
    arr.push({ symbol: r.symbol, symbolRoles: 0, range: [r.line - 1, 0, 10] });
    byFile.set(r.file, arr);
  }
  return {
    projectRoot: '',
    documents: [...byFile].map(([relativePath, occurrences]) => ({ relativePath, occurrences })),
  };
}

const BLOCK = `import { ChartContainer } from 'ui';
export function Block() {
  return <ChartContainer />;
}
`;

describe('resolveJsxTagBySCIP — name-collision guard', () => {
  const FILES: Record<string, string> = {
    'packages/ui/src/menu.tsx': COMPONENT('Group'),
    'packages/ui/src/chart.tsx': COMPONENT('ChartContainer'),
    'apps/web/block.tsx': BLOCK,
  };

  async function resolve(symbol: string, files: Record<string, string> = FILES) {
    const sub = await buildSubstrate(files);
    // biome-ignore lint/suspicious/noExplicitAny: the test drives the resolver off a hand-built index.
    (sub as any).baseline.scip = scipWithRefs([{ file: 'apps/web/block.tsx', line: 3, symbol }]);
    const validIds = new Set(
      Object.keys(files)
        .filter((f) => f.endsWith('.tsx'))
        .flatMap((f) => {
          const name = /export function (\w+)/.exec(files[f])?.[1];
          return name ? [sub.idGen.componentId(f, name)] : [];
        }),
    );
    return sub.resolveJsxTagBySCIP('apps/web/block.tsx', 'ChartContainer', 3, (filePath, declaredName) =>
      validIds.has(sub.idGen.componentId(filePath, declaredName)),
    );
  }

  it('REGRESSION: refuses a differently-named component on the tag line (ChartContainer → Menu:Group)', async () => {
    // The measured supabase mis-resolution: a def-bearing occurrence on the tag's line whose
    // symbol names another REAL component. It satisfies the caller's validator, so only the
    // name attestation can stop it.
    expect(await resolve('scip-typescript npm ui 1.0.0 `packages/ui/src/menu.tsx`/Group.')).toBeUndefined();
  });

  it('resolves the same-named declaration (the ordinary case) unchanged', async () => {
    expect(await resolve('scip-typescript npm ui 1.0.0 `packages/ui/src/chart.tsx`/ChartContainer.')).toEqual({
      filePath: 'packages/ui/src/chart.tsx',
      declaredName: 'ChartContainer',
    });
  });

  it('keeps the DEFAULT-export rename lane (the local name may differ from the declared one)', async () => {
    const files: Record<string, string> = {
      'packages/ui/src/chart.tsx': `${COMPONENT('ChartRoot')}export default ChartRoot;\n`,
      'apps/web/block.tsx': BLOCK,
    };
    expect(await resolve('scip-typescript npm ui 1.0.0 `packages/ui/src/chart.tsx`/ChartRoot.', files)).toEqual({
      filePath: 'packages/ui/src/chart.tsx',
      declaredName: 'ChartRoot',
    });
  });
});
