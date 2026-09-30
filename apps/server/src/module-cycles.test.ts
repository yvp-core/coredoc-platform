import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The structural gate for `apps/server/src/modules/*`: no two feature modules may
 * import each other. A bidirectional pair is what forced `forwardRef` wiring and
 * misfiled leaf files before the 2026-09 structure cleanup
 * (`.scratch/server-structure-cleanup/spec.md`, Track A); this test is the
 * committed form of that spec's `cycles2.py`.
 *
 * Fix a failure by moving the shared thing DOWN — a type or pure fold into
 * `libs/`, a provider both sides reach for into its own leaf module — never by
 * adding a `forwardRef`.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
// ponytail: matches every `from '...'` in the file, not only import/export statements.
// A relative specifier quoted inside a comment would be counted as an edge; none exists
// today, and over-counting only makes the gate stricter.
const SPECIFIER = /from\s+'(\.[^']+)'/g;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function moduleOf(relPath: string): string | null {
  const parts = relPath.split(sep);
  return parts[0] === 'modules' && parts.length > 2 ? parts[1] : null;
}

/** Cross-module edges among production (non-test) files, as `a->b` => witnesses. */
function crossModuleEdges(): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const file of tsFiles(join(SRC, 'modules'))) {
    const rel = relative(SRC, file);
    if (rel.includes('.test.') || rel.endsWith('.test-support.ts')) continue;
    const from = moduleOf(rel);
    if (!from) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(SPECIFIER)) {
      const target = normalize(join(dirname(rel), match[1]));
      const to = moduleOf(target);
      if (!to || to === from) continue;
      const key = `${from}->${to}`;
      edges.set(key, [...(edges.get(key) ?? []), `${rel} imports ${match[1]}`]);
    }
  }
  return edges;
}

describe('module structure', () => {
  it('has no bidirectional import pair among modules/*', () => {
    const edges = crossModuleEdges();
    const cycles = [...edges.keys()]
      .map((key) => key.split('->'))
      .filter(([a, b]) => a < b && edges.has(`${b}->${a}`))
      .map(([a, b]) => `${a} <-> ${b}: ${[...edges.get(`${a}->${b}`), ...edges.get(`${b}->${a}`)].join(' | ')}`);
    expect(cycles).toEqual([]);
  });

  it('uses forwardRef nowhere but the isolation test that unwraps one', () => {
    const files = [
      join(SRC, 'app.module.isolation.test.ts'),
      ...tsFiles(join(SRC, 'modules')),
      ...tsFiles(join(SRC, 'libs')),
    ];
    const offenders = files.filter((file) => {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line));
      return code.some((line) => line.includes('forwardRef'));
    });
    expect(offenders.map((file) => relative(SRC, file))).toEqual(['app.module.isolation.test.ts']);
  });
});
