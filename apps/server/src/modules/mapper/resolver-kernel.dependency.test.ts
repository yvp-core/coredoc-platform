import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(dirname(new URL(import.meta.url).pathname));
const ENTRYPOINT = resolve(SOURCE_ROOT, 'resolver-kernel.ts');
const FORBIDDEN_PREFIXES = ['@nestjs', '@prisma', '@aws-sdk', '@coredoc/server'];
const FORBIDDEN_LOCAL_MODULES = [
  'control-plane.service',
  'mapper.service',
  'prisma.service',
  'workspace-db-pool.service',
];

function imports(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) values.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return values;
}

function resolveLocalImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const raw = resolve(dirname(importer), specifier);
  const candidates = [raw, raw.replace(/\.js$/, '.ts'), resolve(raw, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && extname(candidate) === '.ts') ?? null;
}

describe('resolver kernel dependency boundary', () => {
  it('recursively excludes framework, live-service, and cloud orchestration imports', () => {
    expect(existsSync(ENTRYPOINT)).toBe(true);
    const pending = [ENTRYPOINT];
    const visited = new Set<string>();
    const violations: string[] = [];

    while (pending.length > 0) {
      const sourcePath = pending.pop() as string;
      if (visited.has(sourcePath)) continue;
      visited.add(sourcePath);
      for (const specifier of imports(sourcePath)) {
        if (FORBIDDEN_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))) {
          violations.push(`${sourcePath}: ${specifier}`);
        }
        if (FORBIDDEN_LOCAL_MODULES.some((name) => specifier.includes(name))) {
          violations.push(`${sourcePath}: ${specifier}`);
        }
        const local = resolveLocalImport(sourcePath, specifier);
        if (local) pending.push(local);
      }
    }

    expect(violations.sort()).toEqual([]);
  });
});
