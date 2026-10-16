import { describe, expect, it } from 'vitest';
import { StableIdGenerator } from '@coredoc/core';
import { CodeGraph } from '../graph/graph-builder.js';
import { structuralToNodes } from './to-nodes.js';
import { parseTsStructural, type StructuralFile } from './ts-structural.js';

/** A StructuralFile with every collection empty; fixtures spread it and override what they test. */
const EMPTY_FILE: Omit<StructuralFile, 'path' | 'language'> = {
  classes: [],
  functions: [],
  interfaces: [],
  typeAliases: [],
  enums: [],
  variables: [],
  localBindings: [],
  imports: [],
  dynamicImports: [],
  calls: [],
  enumMemberRefs: [],
  classRefs: [],
  valueBindings: [],
  reExports: [],
};

const FILE: StructuralFile = {
  path: 'src/user.service.ts',
  language: 'typescript',
  ...EMPTY_FILE,
  classes: [
    {
      name: 'UserService',
      isExported: true,
      isAbstract: false,
      startLine: 2,
      endLine: 8,
      decorators: ['Injectable()'],
      ctorParams: [{ name: 'foo', type: 'Foo' }],
      extendsClass: { name: 'BaseService', typeArgs: [] },
      implementsNames: ['UserPort', 'Disposable'],
      properties: [],
      methods: [
        {
          name: 'getUser',
          isAsync: true,
          isStatic: false,
          visibility: 'public',
          params: [{ name: 'id', type: 'string', isOptional: false, isRest: false }],
          startLine: 4,
          endLine: 6,
          decorators: [],
        },
      ],
    },
  ],
  functions: [
    { name: 'helper', isAsync: false, isExported: true, params: [], startLine: 9, endLine: 11, decorators: [] },
  ],
  imports: [{ moduleSpecifier: './foo', names: [{ name: 'Foo' }], kind: 'named', isTypeOnly: false, startLine: 1 }],
  calls: [
    {
      receiver: 'this.foo',
      methodName: 'load',
      expressionText: 'this.foo.load',
      arguments: ['id'],
      isAwaited: false,
      startLine: 5,
      endLine: 5,
      enclosingKind: 'method',
      enclosingName: 'getUser',
      enclosingClass: 'UserService',
    },
  ],
};

describe('structuralToNodes', () => {
  it('mints canonical ids matching StableIdGenerator and writes nodes/edges', () => {
    const idGen = new StableIdGenerator('/repo', 'user-svc');
    const g = new CodeGraph();
    structuralToNodes(FILE, g, idGen, 'r:package:.');

    const expectedClassId = idGen.classId('src/user.service.ts', 'UserService');
    const expectedMethodId = idGen.methodId('src/user.service.ts', 'UserService', 'getUser');
    const expectedFnId = idGen.functionId('src/user.service.ts', 'helper');

    expect(g.classes.has(expectedClassId)).toBe(true);
    expect(g.functions.has(expectedMethodId)).toBe(true); // methods are FunctionNode kind:'method'
    expect(g.functions.has(expectedFnId)).toBe(true);
    expect(g.classes.get(expectedClassId)!.methods).toContain(expectedMethodId);
    // import edge present
    expect([...g.imports.values()][0].moduleSpecifier).toBe('./foo');
    // structural call edge: caller = getUser method id, unresolved (calleeExpression set)
    const call = [...g.calls.values()][0];
    expect(call.callerId).toBe(expectedMethodId);
    expect(call.calleeId).toBeUndefined();
    expect(call.calleeExpression).toBe('this.foo.load');
  });

  it('carries the declared heritage onto the class node, by name and unresolved', () => {
    // The names are what the source says; binding them to declaring nodes is a later pass
    // (`resolveHierarchyRefIdentity`), so nothing here may invent a resolvedId.
    const idGen = new StableIdGenerator('/repo', 'user-svc');
    const g = new CodeGraph();
    structuralToNodes(FILE, g, idGen, 'r:package:.');

    const cls = g.classes.get(idGen.classId('src/user.service.ts', 'UserService'))!;
    expect(cls.extends).toEqual({ name: 'BaseService' });
    expect(cls.implements).toEqual([{ name: 'UserPort' }, { name: 'Disposable' }]);
  });

  it('leaves heritage undefined on a class that declares none', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    const bare: StructuralFile = {
      path: 'src/bare.ts',
      language: 'typescript',
      ...EMPTY_FILE,
      classes: [
        {
          name: 'Bare',
          isExported: false,
          isAbstract: false,
          startLine: 1,
          endLine: 2,
          decorators: [],
          ctorParams: [],
          implementsNames: [],
          properties: [],
          methods: [],
        },
      ],
      functions: [],
      imports: [],
      calls: [],
    };
    structuralToNodes(bare, g, idGen, 'r:package:.');

    const cls = g.classes.get(idGen.classId('src/bare.ts', 'Bare'))!;
    expect(cls.extends).toBeUndefined();
    expect(cls.implements).toBeUndefined();
  });

  it('wires annotated returnType and param types onto function nodes, leaving unannotated as undefined', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    const FILE: StructuralFile = {
      path: 'src/rt.ts',
      language: 'typescript',
      ...EMPTY_FILE,
      classes: [],
      imports: [],
      calls: [],
      functions: [
        {
          name: 'typed',
          isAsync: false,
          isExported: true,
          params: [{ name: 'a', type: 'string', isOptional: false, isRest: false }],
          returnType: 'Promise<void>',
          startLine: 1,
          endLine: 1,
          decorators: [],
        },
        {
          name: 'untyped',
          isAsync: false,
          isExported: false,
          params: [{ name: 'x', isOptional: false, isRest: false }],
          startLine: 2,
          endLine: 2,
          decorators: [],
        },
      ],
    };
    structuralToNodes(FILE, g, idGen, 'r:package:.');
    const typed = g.functions.get(idGen.functionId('src/rt.ts', 'typed'))!;
    expect(typed.returnType).toEqual({ text: 'Promise<void>' });
    expect(typed.parameters[0].type).toEqual({ text: 'string' });
    const untyped = g.functions.get(idGen.functionId('src/rt.ts', 'untyped'))!;
    // Unannotated → undefined (honest): tree-sitter cannot infer types. We do NOT fake `any` — ts-morph
    // infers a real type here (e.g. `number`), so a fabricated `any` would be wrong, not parity. A later
    // SCIP/type-inference pass can fill these in.
    expect(untyped.returnType).toBeUndefined();
    expect(untyped.parameters[0].type).toBeUndefined();
  });

  it('wires documentation onto function, method, and class nodes', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    const FILE: StructuralFile = {
      path: 'src/doc.ts',
      language: 'typescript',
      ...EMPTY_FILE,
      imports: [],
      calls: [],
      functions: [
        {
          name: 'fn',
          isAsync: false,
          isExported: true,
          params: [],
          documentation: 'Fn doc.',
          startLine: 1,
          endLine: 1,
          decorators: [],
        },
      ],
      classes: [
        {
          name: 'C',
          isExported: true,
          isAbstract: false,
          startLine: 2,
          endLine: 5,
          decorators: [],
          documentation: 'Class doc.',
          ctorParams: [],
          implementsNames: [],
          properties: [],
          methods: [
            {
              name: 'm',
              isAsync: false,
              isStatic: false,
              visibility: 'public',
              params: [],
              documentation: 'Method doc.',
              startLine: 3,
              endLine: 4,
              decorators: [],
            },
          ],
        },
      ],
    };
    structuralToNodes(FILE, g, idGen, 'r:package:.');
    expect(g.functions.get(idGen.functionId('src/doc.ts', 'fn'))!.documentation).toBe('Fn doc.');
    expect(g.functions.get(idGen.methodId('src/doc.ts', 'C', 'm'))!.documentation).toBe('Method doc.');
    expect(g.classes.get(idGen.classId('src/doc.ts', 'C'))!.documentation).toBe('Class doc.');
  });

  it('emits InterfaceNode / TypeAliasNode / EnumNode / VariableNode with canonical ids', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    const FILE: StructuralFile = {
      path: 'src/sym.ts',
      language: 'typescript',
      ...EMPTY_FILE,
      classes: [],
      functions: [],
      imports: [],
      calls: [],
      interfaces: [
        {
          name: 'Cfg',
          isExported: true,
          extends: ['Base'],
          members: [{ name: 'id', kind: 'property', isOptional: false, isReadonly: true, startLine: 2, endLine: 2 }],
          startLine: 1,
          endLine: 3,
        },
      ],
      typeAliases: [
        { name: 'Handler', isExported: false, aliasedType: '(x: number) => void', startLine: 4, endLine: 4 },
      ],
      enums: [
        {
          name: 'Color',
          isExported: true,
          isConst: true,
          members: [{ name: 'Red', value: 'red' }, { name: 'Auto' }],
          startLine: 5,
          endLine: 8,
        },
      ],
      variables: [
        {
          name: 'TOKEN',
          isExported: true,
          declarationKind: 'const',
          type: 'string',
          initialValue: "'tok'",
          startLine: 9,
          endLine: 9,
        },
      ],
    };
    structuralToNodes(FILE, g, idGen, 'r:package:.');

    const iface = g.interfaces.get(idGen.interfaceId('src/sym.ts', 'Cfg'))!;
    expect(iface.kind).toBe('interface');
    expect(iface.extends).toEqual([{ name: 'Base' }]);
    expect(iface.members[0]).toMatchObject({ name: 'id', kind: 'property', isReadonly: true });

    const ta = g.typeAliases.get(idGen.typeAliasId('src/sym.ts', 'Handler'))!;
    expect(ta.kind).toBe('type-alias');
    expect(ta.aliasedType).toEqual({ text: '(x: number) => void' });

    const en = g.enums.get(idGen.enumId('src/sym.ts', 'Color'))!;
    expect(en.isConst).toBe(true);
    expect(en.members).toEqual([
      { name: 'Red', value: 'red' },
      { name: 'Auto', value: undefined },
    ]);

    const v = g.variables.get(idGen.variableId('src/sym.ts', 'TOKEN'))!;
    expect(v.declarationKind).toBe('const');
    expect(v.type).toEqual({ text: 'string' });
    expect(v.initialValue).toBe("'tok'");
  });

  it('attributes calls inside an arrow-fn const to that function node', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    const FILE: StructuralFile = {
      path: 'src/h.ts',
      language: 'typescript',
      ...EMPTY_FILE,
      classes: [],
      imports: [],
      functions: [
        { name: 'handle', isAsync: true, isExported: true, params: [], startLine: 1, endLine: 3, decorators: [] },
      ],
      calls: [
        {
          receiver: 'this.repositories',
          methodName: 'find',
          expressionText: 'this.repositories.x.find',
          arguments: [],
          isAwaited: true,
          startLine: 2,
          endLine: 2,
          enclosingKind: 'function',
          enclosingName: 'handle',
          enclosingClass: undefined,
        },
      ],
    };
    structuralToNodes(FILE, g, idGen, 'r:package:.');
    const fnId = idGen.functionId('src/h.ts', 'handle');
    expect(g.functions.has(fnId)).toBe(true);
    const call = [...g.calls.values()][0];
    expect(call.callerId).toBe(fnId);
  });

  it('promotes an anonymous call-arg callback to a spanning FunctionNode and resolves its inner call', async () => {
    // End-to-end carry-through: parse (resolveAnonCallbacks) → structuralToNodes. The promoted
    // callback must be a real FunctionNode whose span contains the inner call line (so the SCIP
    // path's enclosingNodeIdAt resolves it with no to-edges.ts change), and the structural edge's
    // callerId must equal functionId(file, syntheticName).
    const SRC = `
const router = makeRouter();
router.get('/x', (req, res) => {
  handleUser(req);
});
`;
    const file = await parseTsStructural('src/routes.ts', SRC, 'typescript', { resolveAnonCallbacks: true });
    const idGen = new StableIdGenerator('/repo', 'k');
    const g = new CodeGraph();
    structuralToNodes(file, g, idGen, 'r:package:.');

    const inner = file.calls.find((c) => c.methodName === 'handleUser')!;
    const syntheticName = inner.enclosingName!;
    expect(syntheticName).toContain('router.get');
    const fnId = idGen.functionId('src/routes.ts', syntheticName);

    // the promoted callback is a real function node whose span contains the inner call line
    const fnNode = g.functions.get(fnId)!;
    expect(fnNode).toBeTruthy();
    expect(fnNode.location.startLine).toBeLessThanOrEqual(inner.startLine);
    expect(fnNode.location.endLine).toBeGreaterThanOrEqual(inner.startLine);

    // the structural call edge resolves its caller to that node
    const edge = [...g.calls.values()].find((c) => c.calleeExpression === 'handleUser')!;
    expect(edge.callerId).toBe(fnId);
  });

  it('sources a construction at its enclosing function, and an import or module-scope construction at the file', () => {
    const idGen = new StableIdGenerator('/repo', 'class-refs');
    const g = new CodeGraph();
    const file: StructuralFile = {
      ...FILE,
      classRefs: [
        {
          className: 'Foo',
          refKind: 'construction',
          importedFrom: './foo',
          startLine: 10,
          enclosingKind: 'function',
          enclosingName: 'helper',
        },
        // Declared in this very file: identity is already proved, so the declaring file is set here.
        {
          className: 'UserService',
          refKind: 'construction',
          startLine: 10,
          enclosingKind: 'function',
          enclosingName: 'helper',
        },
        { className: 'Foo', refKind: 'import', importedFrom: './foo', startLine: 1, enclosingKind: 'module' },
        // Module-scope construction: no enclosing function, so the FILE is what constructs it.
        { className: 'Bar', refKind: 'construction', importedFrom: './bar', startLine: 12, enclosingKind: 'module' },
      ],
    };
    structuralToNodes(file, g, idGen, 'r:package:.');

    const refs = [...g.classRefs.values()];
    expect(refs.map((r) => `${r.refKind}:${r.className}`).sort()).toEqual([
      'construction:Bar',
      'construction:Foo',
      'construction:UserService',
      'import:Foo',
    ]);
    expect(refs.find((r) => r.className === 'Bar')).toMatchObject({
      sourceId: idGen.fileId('src/user.service.ts'),
      importedFrom: './bar',
      location: { filePath: 'src/user.service.ts', startLine: 12 },
    });
    expect(refs.find((r) => r.refKind === 'construction' && r.className === 'Foo')).toMatchObject({
      sourceId: idGen.functionId('src/user.service.ts', 'helper'),
      importedFrom: './foo',
      declaringFile: undefined,
      location: { filePath: 'src/user.service.ts', startLine: 10 },
    });
    expect(refs.find((r) => r.className === 'UserService')?.declaringFile).toBe('src/user.service.ts');
    expect(refs.find((r) => r.refKind === 'import')).toMatchObject({
      sourceId: idGen.fileId('src/user.service.ts'),
      declaringFile: undefined,
    });
  });

  it('derives versionedId from the source slice (content checksum), not name+location', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const source = ['', 'function f(a) {', '  return a;', '}', ''].join('\n'); // f spans lines 2-4
    const file: StructuralFile = {
      path: 'src/f.js',
      language: 'javascript',
      ...EMPTY_FILE,
      classes: [],
      imports: [],
      calls: [],
      functions: [
        {
          name: 'f',
          isAsync: false,
          isExported: false,
          params: [{ name: 'a', isOptional: false, isRest: false }],
          startLine: 2,
          endLine: 4,
          decorators: [],
        },
      ],
    };
    const g = new CodeGraph();
    structuralToNodes(file, g, idGen, 'r:package:.', source);
    const id = idGen.functionId('src/f.js', 'f');
    const node = g.functions.get(id)!;
    expect(node.sourceCode).toBe('function f(a) {\n  return a;\n}');
    // versionedId checksum is hash(sourceCode) — identical source ⇒ identical id, a real edit ⇒ new id.
    expect(node.versionedId).toBe(idGen.versionedId(id, node.sourceCode!));
    // and it is NOT the old name+location seed
    expect(node.versionedId).not.toBe(idGen.versionedId(id, 'f:2-4'));
  });
});
