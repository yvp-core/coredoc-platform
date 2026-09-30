import { describe, expect, it } from 'vitest';
import type { ReExport, StructuralFile, StructuralImport, ValueBinding } from '../structural/ts-structural.js';
import { buildRepoValueResolver, resolverFromStructuralFiles } from './resolver.js';

const bindings: ValueBinding[] = [
  { name: 'TOPIC', filePath: 'a.ts', kind: 'literal', literal: 'orders', isExported: true },
  {
    name: 'ROUTES',
    filePath: 'a.ts',
    kind: 'object',
    members: { users: '/users' },
    isExported: true,
  },
  {
    name: 'Topics',
    filePath: 'a.ts',
    kind: 'enum',
    members: { Sum: 'sum-all' },
    isExported: true,
  },
];

describe('buildRepoValueResolver (same-file)', () => {
  const resolver = buildRepoValueResolver(bindings, new Map());
  it('resolves bare identifier, member, and enum-member', () => {
    expect(resolver.resolve('TOPIC', 'a.ts')).toBe('orders');
    expect(resolver.resolve('ROUTES.users', 'a.ts')).toBe('/users');
    expect(resolver.resolve('Topics.Sum', 'a.ts')).toBe('sum-all');
  });
  it('passes through a literal and returns undefined for non-foldable', () => {
    expect(resolver.resolve("'/already'", 'a.ts')).toBe('/already');
    expect(resolver.resolve('getTopic("x")', 'a.ts')).toBeUndefined();
    expect(resolver.resolve('ROUTES.missing', 'a.ts')).toBeUndefined();
    expect(resolver.resolve('UNKNOWN', 'a.ts')).toBeUndefined();
  });
});

describe('buildRepoValueResolver (cross-file)', () => {
  it('resolves an imported const via relative module specifier', () => {
    const xbindings: ValueBinding[] = [
      {
        name: 'TOPIC',
        filePath: 'src/constants.ts',
        kind: 'literal',
        literal: 'orders',
        isExported: true,
      },
      {
        name: 'ROUTES',
        filePath: 'src/constants.ts',
        kind: 'object',
        members: { users: '/users' },
        isExported: true,
      },
    ];
    const imports = new Map<string, StructuralImport[]>([
      [
        'src/handlers/user.ts',
        [
          {
            moduleSpecifier: '../constants',
            names: [{ name: 'TOPIC' }, { name: 'ROUTES' }],
            kind: 'named',
            isTypeOnly: false,
            startLine: 1,
          },
        ],
      ],
    ]);
    const resolver = buildRepoValueResolver(xbindings, imports);
    expect(resolver.resolve('TOPIC', 'src/handlers/user.ts')).toBe('orders');
    expect(resolver.resolve('ROUTES.users', 'src/handlers/user.ts')).toBe('/users');
    // alias: import { TOPIC as T } -> resolving T finds TOPIC
    const aliased = new Map<string, StructuralImport[]>([
      [
        'src/h.ts',
        [
          {
            moduleSpecifier: './constants',
            names: [{ name: 'TOPIC', alias: 'T' }],
            kind: 'named',
            isTypeOnly: false,
            startLine: 1,
          },
        ],
      ],
    ]);
    const r2 = buildRepoValueResolver(
      [
        {
          name: 'TOPIC',
          filePath: 'src/constants.ts',
          kind: 'literal',
          literal: 'orders',
          isExported: true,
        },
      ],
      aliased,
    );
    expect(r2.resolve('T', 'src/h.ts')).toBe('orders');
  });
});

describe('buildRepoValueResolver (re-export chains)', () => {
  it('resolves a const imported through a named re-export (barrel)', () => {
    const bindings: ValueBinding[] = [
      {
        name: 'KAFKA_EVENT_STAGE',
        filePath: 'src/constants/kafka.const.ts',
        kind: 'object',
        members: { RECEIVED: 'r' },
        isExported: true,
      },
    ];
    const imports = new Map<string, StructuralImport[]>([
      [
        'src/h.ts',
        [
          {
            moduleSpecifier: './constants',
            names: [{ name: 'KAFKA_EVENT_STAGE' }],
            kind: 'named',
            isTypeOnly: false,
            startLine: 1,
          },
        ],
      ],
    ]);
    const reExports = new Map<string, ReExport[]>([
      [
        'src/constants/index.ts',
        [{ moduleSpecifier: './kafka.const', kind: 'named', names: [{ name: 'KAFKA_EVENT_STAGE' }] }],
      ],
    ]);
    const r = buildRepoValueResolver(bindings, imports, reExports);
    expect(r.resolve('KAFKA_EVENT_STAGE.RECEIVED', 'src/h.ts')).toBe('r');
  });

  it('resolves an aliased named re-export, mapping re-exported-name to source-name', () => {
    // Source file defines binding under the name `Foo`.
    const bindings: ValueBinding[] = [
      {
        name: 'Foo',
        filePath: 'src/constants/foo.const.ts',
        kind: 'object',
        members: { K: 'v' },
        isExported: true,
      },
    ];
    // Consumer imports the re-exported-as name `Bar` from the barrel.
    const imports = new Map<string, StructuralImport[]>([
      [
        'src/h.ts',
        [
          {
            moduleSpecifier: './constants',
            names: [{ name: 'Bar' }],
            kind: 'named',
            isTypeOnly: false,
            startLine: 1,
          },
        ],
      ],
    ]);
    // Barrel re-exports `Foo` from ./foo.const aliased to `Bar` ({ Foo as Bar }).
    const reExports = new Map<string, ReExport[]>([
      [
        'src/constants/index.ts',
        [{ moduleSpecifier: './foo.const', kind: 'named', names: [{ name: 'Foo', alias: 'Bar' }] }],
      ],
    ]);
    const r = buildRepoValueResolver(bindings, imports, reExports);
    // resolve('Bar', consumer) must follow alias Bar -> source Foo and return Foo's member.
    expect(r.resolve('Bar.K', 'src/h.ts')).toBe('v');
  });

  it('resolves through `export *` star re-export, with aliasing and cycle-safety', () => {
    const bindings: ValueBinding[] = [
      { name: 'TOPIC', filePath: 'src/c/topic.ts', kind: 'literal', literal: 'orders', isExported: true },
    ];
    const imports = new Map<string, StructuralImport[]>([
      [
        'src/h.ts',
        [
          {
            moduleSpecifier: './c',
            names: [{ name: 'TOPIC' }],
            kind: 'named',
            isTypeOnly: false,
            startLine: 1,
          },
        ],
      ],
    ]);
    const reExports = new Map<string, ReExport[]>([
      [
        'src/c/index.ts',
        [
          { moduleSpecifier: './topic', kind: 'star' },
          { moduleSpecifier: './index', kind: 'star' }, // self-ref → must not loop
        ],
      ],
    ]);
    const r = buildRepoValueResolver(bindings, imports, reExports);
    expect(r.resolve('TOPIC', 'src/h.ts')).toBe('orders');
  });
});

describe('resolverFromStructuralFiles', () => {
  it('builds a resolver from parsed structural files', () => {
    const files: StructuralFile[] = [
      {
        path: 'src/constants.ts',
        language: 'typescript',
        classes: [],
        functions: [],
        calls: [],
        imports: [],
        valueBindings: [
          {
            name: 'TOPIC',
            filePath: 'src/constants.ts',
            kind: 'literal',
            literal: 'orders',
            isExported: true,
          },
        ],
      },
      {
        path: 'src/h.ts',
        language: 'typescript',
        classes: [],
        functions: [],
        calls: [],
        valueBindings: [],
        imports: [
          {
            moduleSpecifier: './constants',
            names: [{ name: 'TOPIC' }],
            kind: 'named',
            isTypeOnly: false,
            startLine: 1,
          },
        ],
      },
    ];
    const resolver = resolverFromStructuralFiles(files);
    expect(resolver.resolve('TOPIC', 'src/h.ts')).toBe('orders');
  });

  it('resolves an explicit /index specifier (index-path matching)', () => {
    const files: StructuralFile[] = [
      {
        path: 'src/constants/index.ts',
        language: 'typescript',
        classes: [],
        functions: [],
        calls: [],
        imports: [],
        valueBindings: [
          {
            name: 'X',
            filePath: 'src/constants/index.ts',
            kind: 'literal',
            literal: 'value',
            isExported: true,
          },
        ],
      },
      {
        path: 'src/h.ts',
        language: 'typescript',
        classes: [],
        functions: [],
        calls: [],
        valueBindings: [],
        imports: [
          {
            moduleSpecifier: './constants/index',
            names: [{ name: 'X' }],
            kind: 'named',
            isTypeOnly: false,
            startLine: 1,
          },
        ],
      },
    ];
    const resolver = resolverFromStructuralFiles(files);
    expect(resolver.resolve('X', 'src/h.ts')).toBe('value');
  });

  it('follows a barrel re-export declared on a StructuralFile (threads reExports through)', () => {
    const files: StructuralFile[] = [
      // Source module: defines TOPIC.
      {
        path: 'src/constants/topic.const.ts',
        language: 'typescript',
        classes: [],
        functions: [],
        calls: [],
        imports: [],
        valueBindings: [
          {
            name: 'TOPIC',
            filePath: 'src/constants/topic.const.ts',
            kind: 'literal',
            literal: 'orders',
            isExported: true,
          },
        ],
      },
      // Barrel: re-exports TOPIC from ./topic.const, no own bindings.
      {
        path: 'src/constants/index.ts',
        language: 'typescript',
        classes: [],
        functions: [],
        calls: [],
        imports: [],
        valueBindings: [],
        reExports: [{ moduleSpecifier: './topic.const', kind: 'named', names: [{ name: 'TOPIC' }] }],
      },
      // Consumer: imports TOPIC through the barrel directory.
      {
        path: 'src/h.ts',
        language: 'typescript',
        classes: [],
        functions: [],
        calls: [],
        valueBindings: [],
        imports: [
          {
            moduleSpecifier: './constants',
            names: [{ name: 'TOPIC' }],
            kind: 'named',
            isTypeOnly: false,
            startLine: 1,
          },
        ],
      },
    ];
    const resolver = resolverFromStructuralFiles(files);
    // Only resolvable if reExports is wired through from the StructuralFile into the resolver.
    expect(resolver.resolve('TOPIC', 'src/h.ts')).toBe('orders');
  });

  it('tolerates files missing valueBindings (legacy fixtures)', () => {
    const files: StructuralFile[] = [
      {
        path: 'src/legacy.ts',
        language: 'typescript',
        classes: [],
        functions: [],
        calls: [],
        imports: [],
        // valueBindings intentionally omitted (optional field)
      },
    ];
    const resolver = resolverFromStructuralFiles(files);
    expect(resolver.resolve("'/lit'", 'src/legacy.ts')).toBe('/lit');
  });
});
