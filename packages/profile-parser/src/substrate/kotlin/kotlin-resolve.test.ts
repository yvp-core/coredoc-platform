import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { extractKotlinFileFacts, toKotlinFile, type KotlinFileFacts } from './kotlin-declarations.js';
import { KotlinTypeIndex, MAX_SUPERTYPE_HOPS } from './kotlin-resolve.js';

const idGen = new StableIdGenerator('repo-key');

async function facts(relPath: string, source: string): Promise<KotlinFileFacts> {
  return extractKotlinFileFacts(await toKotlinFile(relPath, source), idGen);
}

async function indexOf(files: Record<string, string>): Promise<{
  index: KotlinTypeIndex;
  byPath: Record<string, KotlinFileFacts>;
}> {
  const all: KotlinFileFacts[] = [];
  const byPath: Record<string, KotlinFileFacts> = {};
  for (const [path, source] of Object.entries(files)) {
    const f = await facts(path, source);
    all.push(f);
    byPath[path] = f;
  }
  return { index: new KotlinTypeIndex(all), byPath };
}

describe('ordered name resolution', () => {
  it('prefers a class declared in the same file over every other tier', async () => {
    const { index, byPath } = await indexOf({
      'a/Local.kt': ['package a', 'import x.y.Repo', 'class Repo', 'class User'].join('\n'),
      'x/Other.kt': 'package x.y\nclass Repo',
    });
    const hit = index.resolve('Repo', byPath['a/Local.kt']);
    expect(hit.status).toBe('resolved');
    expect(hit.status === 'resolved' && hit.decl.fqcn).toBe('a.Repo');
  });

  it('uses an explicit import before the same package', async () => {
    const { index, byPath } = await indexOf({
      'a/User.kt': ['package a', 'import x.y.Repo', 'class User'].join('\n'),
      'a/Repo.kt': 'package a\nclass Repo',
      'x/Repo.kt': 'package x.y\nclass Repo',
    });
    const hit = index.resolve('Repo', byPath['a/User.kt']);
    expect(hit.status === 'resolved' && hit.decl.fqcn).toBe('x.y.Repo');
  });

  it('ANTI: an explicit import of a type this repo does NOT declare is external, not the namesake below it', async () => {
    const { index, byPath } = await indexOf({
      'app/Use.kt': ['package app', 'import vendor.Client', 'class Use'].join('\n'),
      'internal/Client.kt': 'package internal\nclass Client',
    });
    // An explicit import names the ONE FQCN this file means. Falling through to the unique
    // simple name (or the same package) binds the vendor's type to an unrelated in-repo class.
    expect(index.resolve('Client', byPath['app/Use.kt'])).toEqual({ status: 'external' });
  });

  // TWIN: a wildcard says only which packages to search, so one that does not match keeps looking.
  it('keeps searching past a wildcard import that matches nothing', async () => {
    const { index, byPath } = await indexOf({
      'app/Use.kt': ['package app', 'import vendor.*', 'class Use'].join('\n'),
      'app/Client.kt': 'package app\nclass Client',
    });
    const hit = index.resolve('Client', byPath['app/Use.kt']);
    expect(hit.status === 'resolved' && hit.decl.fqcn).toBe('app.Client');
  });

  it('uses a wildcard import', async () => {
    const { index, byPath } = await indexOf({
      'a/User.kt': ['package a', 'import x.y.*', 'class User'].join('\n'),
      'x/Repo.kt': 'package x.y\nclass Repo',
    });
    expect(index.resolve('Repo', byPath['a/User.kt'])).toMatchObject({ status: 'resolved' });
  });

  it('falls back to the same package, then to a unique simple name', async () => {
    const { index, byPath } = await indexOf({
      'a/User.kt': 'package a\nclass User',
      'a/Repo.kt': 'package a\nclass Repo',
      'z/Far.kt': 'package z\nclass Far',
    });
    expect(index.resolve('Repo', byPath['a/User.kt'])).toMatchObject({ status: 'resolved' });
    const far = index.resolve('Far', byPath['a/User.kt']);
    expect(far.status === 'resolved' && far.decl.fqcn).toBe('z.Far');
  });

  it('ANTI: an unknown name is external, never a guess', async () => {
    const { index, byPath } = await indexOf({ 'a/User.kt': 'package a\nclass User' });
    expect(index.resolve('AppCompatActivity', byPath['a/User.kt'])).toEqual({ status: 'external' });
  });

  it('ANTI: a simple name declared in two unrelated packages does not resolve by the last tier', async () => {
    const { index, byPath } = await indexOf({
      'a/User.kt': 'package a\nclass User',
      'y/Repo.kt': 'package y\nclass Repo',
      'z/Repo.kt': 'package z\nclass Repo',
    });
    expect(index.resolve('Repo', byPath['a/User.kt'])).toEqual({ status: 'external' });
  });
});

describe('duplicate FQCN — both nodes, no resolution', () => {
  const dup = {
    'app/src/main/Repo.kt': 'package a\nclass Repo { fun get() {} }',
    'app/src/flavor/Repo.kt': 'package a\nclass Repo { fun get() {} }',
    'app/src/main/User.kt': 'package a\nclass User',
  };

  it('reports a duplicated FQCN as ambiguous rather than picking a flavour', async () => {
    const { index, byPath } = await indexOf(dup);
    expect(index.isDuplicate('a.Repo')).toBe(true);
    expect(index.resolve('Repo', byPath['app/src/main/User.kt'])).toEqual({
      status: 'ambiguous',
      fqcn: 'a.Repo',
    });
    expect(index.byFullyQualifiedName('a.Repo')).toBeUndefined();
  });

  it('both declarations still exist — the ids are path-keyed', async () => {
    const { byPath } = await indexOf(dup);
    const a = byPath['app/src/main/Repo.kt'].classes[0].id;
    const b = byPath['app/src/flavor/Repo.kt'].classes[0].id;
    expect(a).not.toBe(b);
  });

  it('ANTI: one file declaring an FQCN once is not ambiguous', async () => {
    const { index } = await indexOf({ 'a/Repo.kt': 'package a\nclass Repo' });
    expect(index.isDuplicate('a.Repo')).toBe(false);
  });
});

describe('supertype walks are bounded and cycle-safe', () => {
  it('walks the chain through resolved repo classes', async () => {
    const { index } = await indexOf({
      'a/Base.kt': 'package a\nabstract class Base : AppCompatActivity() { fun onCreate() {} }',
      'a/Mid.kt': 'package a\nabstract class Mid : Base()',
      'a/Leaf.kt': 'package a\nclass Leaf : Mid()',
    });
    const leaf = index.byFullyQualifiedName('a.Leaf');
    expect(index.supertypeChain(leaf!).map((d) => d.fqcn)).toEqual(['a.Leaf', 'a.Mid', 'a.Base']);
    // The framework base is external: its NAME is reachable, its node is not.
    expect(index.supertypeNames(leaf!)).toEqual(['Mid', 'Base', 'AppCompatActivity']);
  });

  it('ANTI: a cycle terminates instead of looping', async () => {
    const { index } = await indexOf({
      'a/A.kt': 'package a\nclass A : B()',
      'a/B.kt': 'package a\nclass B : A()',
    });
    const a = index.byFullyQualifiedName('a.A');
    expect(index.supertypeChain(a!).map((d) => d.fqcn)).toEqual(['a.A', 'a.B']);
  });

  it('ANTI: a chain longer than the bound is truncated, not followed forever', async () => {
    const files: Record<string, string> = {};
    const depth = MAX_SUPERTYPE_HOPS + 4;
    for (let i = 0; i < depth; i++) {
      files[`a/C${i}.kt`] = `package a\nclass C${i}${i + 1 < depth ? ` : C${i + 1}()` : ''}`;
    }
    const { index } = await indexOf(files);
    const chain = index.supertypeChain(index.byFullyQualifiedName('a.C0')!);
    expect(chain).toHaveLength(MAX_SUPERTYPE_HOPS + 1);
  });

  it('findMethod walks own members, then superclasses, then the companion', async () => {
    const { index } = await indexOf({
      'a/Base.kt': 'package a\nabstract class Base {\n  fun inherited() {}\n}',
      'a/Impl.kt': [
        'package a',
        'class Impl : Base() {',
        '  fun own() {}',
        '  companion object {',
        '    fun made() {}',
        '  }',
        '}',
      ].join('\n'),
    });
    const impl = index.byFullyQualifiedName('a.Impl')!;
    expect(index.findMethod(impl, 'own')).toBeDefined();
    expect(index.findMethod(impl, 'inherited')).toBe(
      index.byFullyQualifiedName('a.Base')?.methodsByName.get('inherited'),
    );
    expect(index.findMethod(impl, 'made')).toBeDefined();
  });

  it('ANTI: a method nobody declares resolves to nothing', async () => {
    const { index } = await indexOf({ 'a/Impl.kt': 'package a\nclass Impl { fun own() {} }' });
    expect(index.findMethod(index.byFullyQualifiedName('a.Impl')!, 'missing')).toBeUndefined();
  });
});

describe('sole implementation (the iface-impl tier)', () => {
  it('returns the single in-scope implementation of an interface', async () => {
    const { index } = await indexOf({
      'a/Repo.kt': 'package a\ninterface Repo { fun get() }',
      'a/Impl.kt': 'package a\nclass Impl : Repo { override fun get() {} }',
    });
    const iface = index.byFullyQualifiedName('a.Repo')!;
    expect(index.soleImplementation(iface)?.fqcn).toBe('a.Impl');
  });

  it('ANTI: two implementations abstain rather than pick one', async () => {
    const { index } = await indexOf({
      'a/Repo.kt': 'package a\ninterface Repo { fun get() }',
      'a/One.kt': 'package a\nclass One : Repo { override fun get() {} }',
      'a/Two.kt': 'package a\nclass Two : Repo { override fun get() {} }',
    });
    expect(index.soleImplementation(index.byFullyQualifiedName('a.Repo')!)).toBeUndefined();
  });

  it('ANTI: an interface with no implementation, and a class, both abstain', async () => {
    const { index } = await indexOf({
      'a/Repo.kt': 'package a\ninterface Repo { fun get() }',
      'a/Impl.kt': 'package a\nclass Impl { fun get() {} }',
    });
    expect(index.soleImplementation(index.byFullyQualifiedName('a.Repo')!)).toBeUndefined();
    expect(index.soleImplementation(index.byFullyQualifiedName('a.Impl')!)).toBeUndefined();
  });
});
