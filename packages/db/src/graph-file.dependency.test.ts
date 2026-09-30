import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(dirname(new URL(import.meta.url).pathname));
const ENTRYPOINT = resolve(SOURCE_ROOT, 'graph-file.ts');
const FORBIDDEN_PREFIXES = ['@nestjs', '@prisma', '@aws-sdk', '@coredoc/server'];

function imports(source: string): string[] {
  const parsed = ts.createSourceFile(ENTRYPOINT, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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

describe('graph-file package boundary', () => {
  it('does not depend on cloud orchestration or the process-wide backend factory', () => {
    const source = readFileSync(ENTRYPOINT, 'utf8');
    const specifiers = imports(source);
    expect(
      specifiers.filter((specifier) =>
        FORBIDDEN_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)),
      ),
    ).toEqual([]);
    expect(specifiers).not.toContain('./backend-factory.js');
  });
});
