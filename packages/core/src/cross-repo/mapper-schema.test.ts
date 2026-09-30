import { describe, it, expect } from 'vitest';
import {
  MapperSchema,
  type Mapper,
  validateMapper,
  pickMapperSchemaVersion,
  checkMapperSemantics,
} from './mapper-schema.js';

describe('MapperSchema', () => {
  it('accepts a minimal valid mapper', () => {
    const minimal: Mapper = {
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    };
    expect(MapperSchema.parse(minimal)).toEqual(minimal);
  });

  it('rejects unknown $schemaVersion', () => {
    expect(() =>
      MapperSchema.parse({
        $schemaVersion: 3,
        project: 'demo',
        services: [],
        sdkMappings: [],
        pathRewriteRules: [],
        unresolvableServices: [],
      }),
    ).toThrow();
  });

  it('parses a v1 document into the v2 shape (target/httpPrefix absent)', () => {
    const parsed = MapperSchema.parse({
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'core', repo: 'acme-core', aliases: [] }],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });
    expect(parsed.$schemaVersion).toBe(1);
    expect(parsed.services[0]?.target).toBeUndefined();
    expect(parsed.services[0]?.httpPrefix).toBeUndefined();
  });

  it('accepts $schemaVersion 2 with per-service target and httpPrefix', () => {
    const parsed = MapperSchema.parse({
      $schemaVersion: 2,
      project: 'demo',
      services: [
        { name: 'ui', repo: 'monorepo', aliases: [], target: 'web', httpPrefix: '/app' },
        { name: 'api', repo: 'monorepo', aliases: [], target: 'server', httpPrefix: '/api' },
      ],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });
    expect(parsed.$schemaVersion).toBe(2);
    expect(parsed.services[0]?.target).toBe('web');
    expect(parsed.services[1]?.httpPrefix).toBe('/api');
  });

  it('requires services[].name and services[].repo', () => {
    expect(() =>
      MapperSchema.parse({
        $schemaVersion: 1,
        project: 'demo',
        services: [{ name: 'x' }],
        sdkMappings: [],
        pathRewriteRules: [],
        unresolvableServices: [],
      }),
    ).toThrow();
  });

  it('requires sdkMappings[].http when present to have method + pathTemplate', () => {
    expect(() =>
      MapperSchema.parse({
        $schemaVersion: 1,
        project: 'demo',
        services: [],
        pathRewriteRules: [],
        unresolvableServices: [],
        sdkMappings: [
          {
            sdkPackage: '@x/y',
            sdkClass: 'C',
            sdkMethod: 'm',
            targetService: 'svc',
            http: { method: 'GET' },
          },
        ],
      }),
    ).toThrow();
  });

  it('canonicalises pathTemplate parameter form to :name on parse', () => {
    const parsed = MapperSchema.parse({
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      pathRewriteRules: [],
      unresolvableServices: [],
      sdkMappings: [
        {
          sdkPackage: '@x/y',
          sdkClass: 'C',
          sdkMethod: 'm',
          targetService: 'svc',
          http: { method: 'GET', pathTemplate: '/v1/users/{userId}', pathParams: ['userId'] },
        },
      ],
    });
    expect(parsed.sdkMappings[0]?.http?.pathTemplate).toBe('/v1/users/:userId');
  });

  it('rejects pathRewriteRules with an invalid regex', () => {
    expect(() =>
      MapperSchema.parse({
        $schemaVersion: 1,
        project: 'demo',
        services: [],
        sdkMappings: [],
        unresolvableServices: [],
        pathRewriteRules: [{ match: '(unclosed', targetServiceFrom: 'x' }],
      }),
    ).toThrow();
  });

  it('rejects pathRewriteRules with nested quantifiers (ReDoS guard)', () => {
    // Classic catastrophic-backtracking shapes — must be rejected because the
    // resolver runs user-supplied regex against every external-call path on
    // every workspace resolution.
    for (const evil of ['(a+)+', '(.*)*', '(x*)+', '(?:foo+)+']) {
      expect(() =>
        MapperSchema.parse({
          $schemaVersion: 1,
          project: 'demo',
          services: [],
          sdkMappings: [],
          unresolvableServices: [],
          pathRewriteRules: [{ match: evil, targetServiceFrom: 'x' }],
        }),
      ).toThrow(/nested quantifiers/);
    }
  });

  it('rejects pathRewriteRules.match strings longer than the size cap', () => {
    const tooLong = 'a'.repeat(201);
    expect(() =>
      MapperSchema.parse({
        $schemaVersion: 1,
        project: 'demo',
        services: [],
        sdkMappings: [],
        unresolvableServices: [],
        pathRewriteRules: [{ match: tooLong, targetServiceFrom: 'x' }],
      }),
    ).toThrow(/200 chars/);
  });

  it('rejects more than 50 pathRewriteRules entries', () => {
    const rules = Array.from({ length: 51 }, (_, i) => ({ match: `^/x${i}/`, targetServiceFrom: 'x' }));
    expect(() =>
      MapperSchema.parse({
        $schemaVersion: 1,
        project: 'demo',
        services: [],
        sdkMappings: [],
        unresolvableServices: [],
        pathRewriteRules: rules,
      }),
    ).toThrow(/50 entries/);
  });

  it('rejects sdkMappings[].http with unknown keys (strict mode)', () => {
    expect(() =>
      MapperSchema.parse({
        $schemaVersion: 1,
        project: 'demo',
        services: [],
        pathRewriteRules: [],
        unresolvableServices: [],
        sdkMappings: [
          {
            sdkPackage: '@x/y',
            sdkClass: 'C',
            sdkMethod: 'm',
            targetService: 'svc',
            http: { method: 'GET', pathTemplate: '/x', pathParamas: ['typo'] },
          },
        ],
      }),
    ).toThrow();
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description names the literal ${name} syntax
  it('canonicalises ${name} template-literal syntax to :name on parse', () => {
    const parsed = MapperSchema.parse({
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      pathRewriteRules: [],
      unresolvableServices: [],
      sdkMappings: [
        {
          sdkPackage: '@x/y',
          sdkClass: 'C',
          sdkMethod: 'm',
          targetService: 'svc',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal ${...} path template under test
          http: { method: 'GET', pathTemplate: '/v1/users/${userId}', pathParams: ['userId'] },
        },
      ],
    });
    expect(parsed.sdkMappings[0]?.http?.pathTemplate).toBe('/v1/users/:userId');
  });

  it('accepts a mapper that omits sdkMappings (override-only file)', () => {
    const parsed = MapperSchema.parse({
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'shifts', repo: 'demo-shifts', aliases: [] }],
      pathRewriteRules: [],
      unresolvableServices: ['kafka', 'redis'],
    });
    // sdkMappings is optional in the JSON but always materialises as an array
    // after parse, so mapper-engine.ts's `for (const m of mapper.sdkMappings)`
    // never sees undefined.
    expect(parsed.sdkMappings).toEqual([]);
  });

  it('still accepts and preserves explicit sdkMappings (published-only SDK override)', () => {
    const parsed = MapperSchema.parse({
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      pathRewriteRules: [],
      unresolvableServices: [],
      sdkMappings: [
        {
          sdkPackage: '@vendor/published-only',
          sdkClass: 'svc',
          sdkMethod: 'm',
          targetService: 'svc',
          http: { method: 'GET', pathTemplate: '/v1/things/:id', pathParams: ['id'] },
        },
      ],
    });
    expect(parsed.sdkMappings).toHaveLength(1);
    expect(parsed.sdkMappings[0]?.sdkPackage).toBe('@vendor/published-only');
  });
});

describe('validateMapper', () => {
  it('returns ok=true and the parsed mapper for valid input', () => {
    const result = validateMapper({
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mapper.project).toBe('demo');
    }
  });

  it('returns ok=false with populated errors for invalid input', () => {
    const result = validateMapper({
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'x' }], // missing repo
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.path).toEqual(expect.arrayContaining(['services', 0, 'repo']));
      expect(typeof result.errors[0]?.message).toBe('string');
      expect(result.errors[0]?.message.length).toBeGreaterThan(0);
    }
  });
});

describe('pickMapperSchemaVersion', () => {
  it('keeps version 1 when no service uses a v2 field', () => {
    expect(pickMapperSchemaVersion([{}, {}])).toBe(1);
  });

  it('picks version 2 when any service carries target', () => {
    expect(pickMapperSchemaVersion([{}, { target: 'web' }])).toBe(2);
  });

  it('picks version 2 when any service carries httpPrefix', () => {
    expect(pickMapperSchemaVersion([{ httpPrefix: '/api' }])).toBe(2);
  });
});

describe('checkMapperSemantics', () => {
  function mapper(overrides: Partial<Mapper> = {}): Mapper {
    return MapperSchema.parse({
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
      ...overrides,
    });
  }

  it('passes a clean v1 mapper (no errors, no warnings)', () => {
    const report = checkMapperSemantics(mapper({ services: [{ name: 'core', repo: 'acme-core', aliases: [] }] }));
    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  it('flags an sdkMappings targetService that resolves through nothing (orphan)', () => {
    const report = checkMapperSemantics(
      mapper({
        services: [{ name: 'core', repo: 'acme-core', aliases: ['core-service'] }],
        sdkMappings: [{ sdkPackage: '@x/y', sdkClass: 'C', sdkMethod: 'm', targetService: 'auth_sessions' }],
      }),
    );
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.path).toEqual(['sdkMappings', 0, 'targetService']);
    expect(report.errors[0]?.message).toContain('auth_sessions');
  });

  it('resolves a targetService that only differs by case/whitespace from a declared name (matches the runtime resolver)', () => {
    const report = checkMapperSemantics(
      mapper({
        services: [{ name: 'auth-sessions', repo: 'acme-core', aliases: [] }],
        sdkMappings: [{ sdkPackage: '@x/y', sdkClass: 'C', sdkMethod: 'm', targetService: ' Auth-Sessions ' }],
      }),
    );
    expect(report.errors).toHaveLength(0);
  });

  it('still flags snake_case vs declared kebab-case as an orphan (no alias bridges them)', () => {
    const report = checkMapperSemantics(
      mapper({
        services: [{ name: 'auth-sessions', repo: 'acme-core', aliases: [] }],
        sdkMappings: [{ sdkPackage: '@x/y', sdkClass: 'C', sdkMethod: 'm', targetService: 'auth_sessions' }],
      }),
    );
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.path).toEqual(['sdkMappings', 0, 'targetService']);
    expect(report.errors[0]?.message).toContain('auth_sessions');
  });

  it('resolves a targetService through a name, alias, or unresolvableServices entry', () => {
    const report = checkMapperSemantics(
      mapper({
        services: [{ name: 'core', repo: 'acme-core', aliases: ['core-service'] }],
        unresolvableServices: ['kafka'],
        sdkMappings: [
          { sdkPackage: '@x/y', sdkClass: 'C', sdkMethod: 'a', targetService: 'core' },
          { sdkPackage: '@x/y', sdkClass: 'C', sdkMethod: 'b', targetService: 'core-service' },
          { sdkPackage: '@x/y', sdkClass: 'C', sdkMethod: 'c', targetService: 'kafka' },
        ],
      }),
    );
    expect(report.errors).toHaveLength(0);
  });

  it('errors on a duplicate (repo, target) service identity', () => {
    const report = checkMapperSemantics(
      MapperSchema.parse({
        $schemaVersion: 2,
        project: 'demo',
        services: [
          { name: 'a', repo: 'mono', aliases: [], target: 'web' },
          { name: 'b', repo: 'mono', aliases: [], target: 'web' },
        ],
        sdkMappings: [],
        pathRewriteRules: [],
        unresolvableServices: [],
      }),
    );
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.message).toContain('duplicate service identity');
  });

  it('errors on services[].name colliding under normalizeServiceName (different (repo,target) identities)', () => {
    const report = checkMapperSemantics(
      MapperSchema.parse({
        $schemaVersion: 2,
        project: 'demo',
        services: [
          { name: 'svc-a-b', repo: 'svc-a', aliases: [], target: 'b' },
          // Same normalized name, different (repo, target) identity — this is the
          // case (b) misses: no identity collision, but `buildServiceRepoMap`
          // still last-write-wins on the shared name.
          { name: ' Svc-A-B ', repo: 'svc-c', aliases: [], target: 'd' },
        ],
        sdkMappings: [],
        pathRewriteRules: [],
        unresolvableServices: [],
      }),
    );
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.path).toEqual(['services', 1, 'name']);
    expect(report.errors[0]?.message).toContain('duplicate service name');
    expect(report.errors[0]?.message).toContain('svc-a');
    expect(report.errors[0]?.message).toContain('svc-c');
  });

  it('treats two services on the same repo with distinct targets as unique', () => {
    const report = checkMapperSemantics(
      MapperSchema.parse({
        $schemaVersion: 2,
        project: 'demo',
        services: [
          { name: 'ui', repo: 'mono', aliases: [], target: 'web' },
          { name: 'api', repo: 'mono', aliases: [], target: 'server' },
        ],
        sdkMappings: [],
        pathRewriteRules: [],
        unresolvableServices: [],
      }),
    );
    expect(report.errors).toHaveLength(0);
  });

  it('warns when a service target is absent from the parsed output (stale target)', () => {
    const m = MapperSchema.parse({
      $schemaVersion: 2,
      project: 'demo',
      services: [{ name: 'api', repo: 'mono', aliases: [], target: 'server' }],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });
    const report = checkMapperSemantics(m, {
      targetsByRepo: { mono: new Set(['web', 'worker']) },
    });
    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]?.message).toContain('stale target');
  });

  it('warns on httpPrefix precedence when a repo has both config and per-service prefixes', () => {
    const m = MapperSchema.parse({
      $schemaVersion: 2,
      project: 'demo',
      services: [{ name: 'api', repo: 'mono', aliases: [], httpPrefix: '/api' }],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });
    const report = checkMapperSemantics(m, { repoHttpPrefixes: { mono: '/v1' } });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]?.message).toContain('overrides');
    expect(report.warnings[0]?.message).toContain('/api');
  });
});
