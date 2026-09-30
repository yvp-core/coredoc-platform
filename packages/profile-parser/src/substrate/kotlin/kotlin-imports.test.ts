import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { extractKotlinFileFacts, toKotlinFile, type KotlinFileFacts } from './kotlin-declarations.js';
import { buildKotlinImportEdges } from './kotlin-imports.js';
import { KotlinTypeIndex } from './kotlin-resolve.js';

const idGen = new StableIdGenerator('repo-key');

async function scope(files: Record<string, string>): Promise<KotlinFileFacts[]> {
  const out: KotlinFileFacts[] = [];
  for (const [relPath, source] of Object.entries(files)) {
    out.push(extractKotlinFileFacts(await toKotlinFile(relPath, source), idGen));
  }
  return out;
}

function edges(facts: KotlinFileFacts[]) {
  return buildKotlinImportEdges(facts, new KotlinTypeIndex(facts), idGen);
}

describe('Kotlin import edges', () => {
  it('resolves a class import to its emitting file and names it', async () => {
    const facts = await scope({
      'a/Thing.kt': 'package a.b\nclass Thing',
      'a/Use.kt': 'package a.c\nimport a.b.Thing\nclass Use',
    });
    const [edge] = edges(facts).filter((e) => e.sourceFileId === facts[1].fileId);
    expect(edge.moduleSpecifier).toBe('a.b.Thing');
    expect(edge.targetFileId).toBe(facts[0].fileId);
    expect(edge.importKind).toBe('named');
    expect(edge.isTypeOnly).toBe(false);
    expect(edge.importedNames).toEqual([{ name: 'Thing', resolvedId: facts[0].classes[0].id }]);
  });

  it('resolves a member import through its class prefix, and keeps the alias', async () => {
    const facts = await scope({
      'a/Thing.kt': 'package a.b\nclass Thing {\n  companion object {\n    fun make(): Int = 1\n  }\n}',
      'a/Use.kt': 'package a.c\nimport a.b.Thing.make as build\nclass Use',
    });
    const [edge] = edges(facts).filter((e) => e.sourceFileId === facts[1].fileId);
    expect(edge.targetFileId).toBe(facts[0].fileId);
    expect(edge.importedNames).toEqual([{ name: 'make', alias: 'build', resolvedId: facts[0].classes[0].id }]);
  });

  it('resolves a wildcard import of a single-file package as a namespace import, with no names', async () => {
    const facts = await scope({
      'a/Thing.kt': 'package a.b\nclass Thing',
      'a/Use.kt': 'package a.c\nimport a.b.*\nclass Use',
    });
    const [edge] = edges(facts).filter((e) => e.sourceFileId === facts[1].fileId);
    expect(edge.importKind).toBe('namespace');
    expect(edge.targetFileId).toBe(facts[0].fileId);
    expect(edge.importedNames).toBeUndefined();
  });

  it('ANTI: an unresolved import carries no importedNames and no targetFileId', async () => {
    const facts = await scope({
      'a/Use.kt': ['package a.c', 'import androidx.core.view.Thing', 'import java.util.List', 'class Use'].join('\n'),
    });
    for (const edge of edges(facts)) {
      expect(edge.targetFileId).toBeUndefined();
      expect(edge.importedNames).toBeUndefined();
    }
  });

  it('ANTI: a wildcard onto a package of two files resolves to neither', async () => {
    const facts = await scope({
      'a/Thing.kt': 'package a.b\nclass Thing',
      'a/Other.kt': 'package a.b\nclass Other',
      'a/Use.kt': 'package a.c\nimport a.b.*\nclass Use',
    });
    const [edge] = edges(facts).filter((e) => e.sourceFileId === facts[2].fileId);
    expect(edge.targetFileId).toBeUndefined();
    expect(edge.importedNames).toBeUndefined();
  });

  it('ANTI: an import of a duplicated FQCN resolves to no file', async () => {
    const facts = await scope({
      'main/Thing.kt': 'package a.b\nclass Thing',
      'flavor/Thing.kt': 'package a.b\nclass Thing',
      'a/Use.kt': 'package a.c\nimport a.b.Thing\nclass Use',
    });
    const [edge] = edges(facts).filter((e) => e.sourceFileId === facts[2].fileId);
    expect(edge.targetFileId).toBeUndefined();
    expect(edge.importedNames).toBeUndefined();
  });

  it('emits one edge per distinct path per file, with the stable id', async () => {
    const facts = await scope({
      'a/Use.kt': ['package a.c', 'import x.y.Thing', 'import x.y.Thing', 'import x.z.Other', 'class Use'].join('\n'),
    });
    const list = edges(facts);
    expect(list.map((e) => e.moduleSpecifier)).toEqual(['x.y.Thing', 'x.z.Other']);
    expect(list[0].id).toBe(idGen.importEdgeId(facts[0].fileId, 'x.y.Thing'));
    expect(new Set(list.map((e) => e.id)).size).toBe(list.length);
  });
});
