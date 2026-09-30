import { describe, it, expect } from 'vitest';
import type { FunctionInfo, IGraphReadRepository } from '@coredoc/db';
import {
  ambiguousFunctionNote,
  findEntityByName,
  findFunctionByName,
  findTypeByName,
  implementedInterfaceMethods,
  parseFunctionName,
} from './function-name.js';

describe('parseFunctionName', () => {
  it('returns input unchanged for bare names', () => {
    expect(parseFunctionName('myFn')).toEqual({
      lookupName: 'myFn',
      requestedClassName: undefined,
    });
  });

  it('preserves the indexed overload identity including qualified parameter types', () => {
    const name = 'Example.Service.Send(Example.Message)';
    expect(parseFunctionName(name)).toEqual({ lookupName: name, requestedClassName: undefined });
  });

  it('splits Class.method into lookupName=method, className=Class', () => {
    expect(parseFunctionName('TemplatesService.analyzeRestDaySourceApplication')).toEqual({
      lookupName: 'analyzeRestDaySourceApplication',
      requestedClassName: 'TemplatesService',
    });
  });

  it('keeps the qualifier for nested forms like Outer.Inner.method', () => {
    expect(parseFunctionName('Outer.Inner.method')).toEqual({
      lookupName: 'method',
      requestedClassName: 'Outer.Inner',
    });
  });

  it('treats trailing or leading dots as not a qualifier', () => {
    expect(parseFunctionName('.method')).toEqual({
      lookupName: '.method',
      requestedClassName: undefined,
    });
    expect(parseFunctionName('method.')).toEqual({
      lookupName: 'method.',
      requestedClassName: undefined,
    });
  });

  it('does not split file-path-like inputs', () => {
    // Without this guard `src/foo.ts` would split into lookupName=ts, which
    // would silently misroute analyze_change_impact and trace tools that
    // accept either function names or paths.
    expect(parseFunctionName('src/modules/foo.service.ts')).toEqual({
      lookupName: 'src/modules/foo.service.ts',
      requestedClassName: undefined,
    });
    expect(parseFunctionName('packages\\mcp\\src\\server.ts')).toEqual({
      lookupName: 'packages\\mcp\\src\\server.ts',
      requestedClassName: undefined,
    });
  });

  it('does not split inputs with whitespace (e.g. "POST /foo")', () => {
    expect(parseFunctionName('POST /v1/users')).toEqual({
      lookupName: 'POST /v1/users',
      requestedClassName: undefined,
    });
    expect(parseFunctionName('Foo.bar baz')).toEqual({
      lookupName: 'Foo.bar baz',
      requestedClassName: undefined,
    });
  });
});

describe('canonical-name resolution', () => {
  const names = [
    'Shop.Assets.EFAssetRepository`1.FindBySlugAsync(Guid,string)',
    'Shop.Assets.EFAssetRepository`1.FindBySlugAsync(Guid,string).$lambda1()',
    'Shop.Assets.IAssetRepository.FindBySlugAsync(Guid,string)',
    'Shop.Assets.IAssetRepository.FindBySlugAsyncCore(Guid)',
  ];
  const repository = {
    findFunction: async (name: string) => (names.includes(name) ? { id: name, name } : null),
    findCode: async ({ pattern }: { pattern: string }) => {
      const needle = pattern.replaceAll('*', '').toLowerCase();
      return names
        .filter((name) => name.toLowerCase().includes(needle))
        .map((name) => ({ id: name, name, filePath: 'a.cs' }));
    },
    findEntity: async () => null,
    listEntities: async () => [{ name: 'Shop.Domain.Product' }, { name: 'Shop.Domain.ProductEmbedding' }],
  } as unknown as IGraphReadRepository;

  it('resolves a unique signature-bearing method, never a nested lambda, and reports ambiguity', async () => {
    expect((await findFunctionByName(repository, 'EFAssetRepository`1.FindBySlugAsync', []))?.name).toBe(names[0]);
    expect((await findFunctionByName(repository, 'IAssetRepository.FindBySlugAsync', []))?.name).toBe(names[2]);
    expect(await findFunctionByName(repository, 'FindBySlugAsync', [])).toBeNull();
    expect(await ambiguousFunctionNote(repository, 'FindBySlugAsync', [])).toContain('matches 2 functions');
    expect(await findFunctionByName(repository, 'Missing', [])).toBeNull();
    expect(await ambiguousFunctionNote(repository, 'Missing', [])).toBeUndefined();
  });

  it('resolves through the hinted file when the candidate window is full', async () => {
    const crowded = Array.from({ length: 50 }, (_, i) => ({
      id: `n${i}`,
      type: 'function',
      name: `Shop.T${i}.GetAsync(Guid)`,
      filePath: `src/T${i}.cs`,
    }));
    const target = {
      id: 'hit',
      type: 'function',
      name: 'Shop.Orders.OrderService.GetAsync(Guid)',
      filePath: 'src/Orders/OrderService.cs',
    };
    const busy = {
      findFunction: async (name: string, _hashes: string[], fileHint?: string) =>
        name === target.name && (!fileHint || target.filePath.includes(fileHint)) ? target : null,
      findCode: async () => crowded,
      listSymbolsInFile: async (path: string) => (target.filePath.endsWith(path) ? [target] : []),
    } as unknown as IGraphReadRepository;

    expect((await findFunctionByName(busy, 'GetAsync', [], 'Orders/OrderService.cs'))?.id).toBe('hit');
    expect(await findFunctionByName(busy, 'GetAsync', [])).toBeNull();
    expect(await ambiguousFunctionNote(busy, 'GetAsync', [])).toContain('or a fileHint');
    expect(await ambiguousFunctionNote(busy, 'GetAsync', [], 'src/')).not.toContain('fileHint');
  });

  it('resolves a short entity name only when exactly one qualified entity ends with it', async () => {
    expect((await findEntityByName(repository, 'Product', []))?.name).toBe('Shop.Domain.Product');
    expect(await findEntityByName(repository, 'Domain', [])).toBeNull();
  });
});

describe('type and interface resolution', () => {
  const nodes = [
    { id: 'c1', type: 'class', name: 'Shop.Domain.Product' },
    { id: 'c2', type: 'class', name: 'Shop.App.CrudService`1' },
    { id: 'c3', type: 'class', name: 'Shop.A.Order' },
    { id: 'c4', type: 'class', name: 'Shop.B.Order' },
    { id: 'i1', type: 'interface', name: 'Shop.App.ICrudService`1' },
    { id: 'f1', type: 'function', name: 'Shop.App.ICrudService`1.DeleteAsync(T,CancellationToken)' },
    { id: 'f2', type: 'function', name: 'Shop.App.CrudService`1.DeleteAsync(T,CancellationToken)' },
    { id: 'f3', type: 'function', name: 'Shop.App.Other.DeleteAsync(T,CancellationToken)' },
  ];
  const repository = {
    findClass: async (name: string) => nodes.find((n) => n.type === 'class' && n.name === name) ?? null,
    findInterface: async (name: string) => nodes.find((n) => n.type === 'interface' && n.name === name) ?? null,
    findCode: async ({ pattern, types }: { pattern: string; types: string[] }) => {
      const needle = pattern.replaceAll('*', '').toLowerCase();
      return nodes.filter((n) => types.includes(n.type) && n.name.toLowerCase().includes(needle));
    },
    getInterfaceImplementations: async (id: string) => (id === 'i1' ? [{ name: 'Shop.App.CrudService`1' }] : []),
  } as unknown as IGraphReadRepository;

  it('resolves a short or generic type name only when one qualified declaration matches', async () => {
    expect((await findTypeByName(repository, 'Product', 'class', []))?.id).toBe('c1');
    expect((await findTypeByName(repository, 'CrudService', 'class', []))?.id).toBe('c2');
    expect(await findTypeByName(repository, 'Order', 'class', [])).toBeNull();
    expect(await findTypeByName(repository, 'Product', 'class', [], false)).toBeNull();
  });

  it('refuses a short type name when the candidate window is full', async () => {
    const crowded = {
      ...repository,
      findClass: async () => null,
      findCode: async () => Array.from({ length: 50 }, (_, i) => ({ id: `x${i}`, type: 'class', name: `N${i}.Other` })),
    } as unknown as IGraphReadRepository;
    expect(await findTypeByName(crowded, 'Product', 'class', [])).toBeNull();
  });

  it('maps an implementation method to the interface methods its class implements', async () => {
    const fn = { id: 'f2', name: nodes[6]!.name, className: 'Shop.App.CrudService`1' } as FunctionInfo;
    expect(await implementedInterfaceMethods(repository, fn, [])).toEqual(['f1']);
    const unrelated = { id: 'f3', name: nodes[7]!.name, className: 'Shop.App.Other' } as FunctionInfo;
    expect(await implementedInterfaceMethods(repository, unrelated, [])).toEqual([]);
  });
});
