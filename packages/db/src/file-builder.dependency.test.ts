import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(dirname(new URL(import.meta.url).pathname));
const ENTRYPOINT = resolve(SOURCE_ROOT, 'file-builder.ts');
const FORBIDDEN_PACKAGE_PREFIXES = ['@nestjs', '@prisma', '@aws-sdk', '@coredoc/server'];

function moduleSpecifiers(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function resolveLocalImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const raw = resolve(dirname(importer), specifier);
  const candidates = [raw, raw.replace(/\.js$/, '.ts'), resolve(raw, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && extname(candidate) === '.ts') ?? null;
}

describe('file-builder C6 dependency boundary', () => {
  it('has no import path to server orchestration or cloud/control-plane packages', () => {
    expect(existsSync(ENTRYPOINT)).toBe(true);
    const pending = [ENTRYPOINT];
    const visited = new Set<string>();
    const violations: string[] = [];

    while (pending.length > 0) {
      const sourcePath = pending.pop() as string;
      if (visited.has(sourcePath)) continue;
      visited.add(sourcePath);
      for (const specifier of moduleSpecifiers(sourcePath)) {
        if (FORBIDDEN_PACKAGE_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))) {
          violations.push(`${sourcePath}: ${specifier}`);
        }
        const local = resolveLocalImport(sourcePath, specifier);
        if (!local) continue;
        if (!local.startsWith(`${SOURCE_ROOT}/`))
          violations.push(`${sourcePath}: ${specifier} escapes packages/db/src`);
        else pending.push(local);
      }
    }

    expect(violations.sort()).toEqual([]);
  });
});
