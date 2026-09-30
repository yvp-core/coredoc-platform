import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateMapper } from '@coredoc/core';
import {
  runMapperValidate,
  runMapperStatus,
  runMapperDiff,
  runMapperDiscover,
  runMapperGenSdkMappings,
  runMapperPush,
  runMapperPull,
  printMapperPushResult,
} from './mapper.js';

function writeMapper(dir: string, contents: unknown): string {
  const file = path.join(dir, 'mapper.json');
  fs.writeFileSync(file, JSON.stringify(contents, null, 2));
  return file;
}

describe('runMapperValidate', () => {
  it('returns ok for a valid mapper', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-cmd-'));
    writeMapper(dir, {
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });
    const result = runMapperValidate({ mapperPath: path.join(dir, 'mapper.json') });
    expect(result.ok).toBe(true);
  });

  it('returns errors for an invalid mapper', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-cmd-'));
    writeMapper(dir, { $schemaVersion: 1, project: 'demo' });
    const result = runMapperValidate({ mapperPath: path.join(dir, 'mapper.json') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns a clear error when the file does not exist', () => {
    const result = runMapperValidate({ mapperPath: '/no/such/file.json' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/not found|ENOENT/i);
  });

  it('flags a schema-valid mapper whose sdkMappings targetService is an orphan', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-orphan-'));
    writeMapper(dir, {
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'core', repo: 'acme-core', aliases: ['core-service'] }],
      sdkMappings: [{ sdkPackage: '@x/y', sdkClass: 'C', sdkMethod: 'm', targetService: 'auth_sessions' }],
      pathRewriteRules: [],
      unresolvableServices: [],
    });
    const result = runMapperValidate({ mapperPath: path.join(dir, 'mapper.json') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('auth_sessions'))).toBe(true);
    }
  });

  it('flags a duplicate (repo, target) service identity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-dup-'));
    writeMapper(dir, {
      $schemaVersion: 2,
      project: 'demo',
      services: [
        { name: 'a', repo: 'mono', aliases: [], target: 'web' },
        { name: 'b', repo: 'mono', aliases: [], target: 'web' },
      ],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });
    const result = runMapperValidate({ mapperPath: path.join(dir, 'mapper.json') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('duplicate service identity'))).toBe(true);
    }
  });
});

describe('runMapperStatus', () => {
  it('returns exists=false when no mapper file is present', () => {
    const result = runMapperStatus({ mapperPath: '/no/file.json', mapperMetaPath: '/no/meta.json' });
    expect(result.exists).toBe(false);
  });

  it('returns counts and metadata when mapper exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-status-'));
    fs.writeFileSync(
      path.join(dir, 'mapper.json'),
      JSON.stringify({
        $schemaVersion: 1,
        project: 'demo',
        services: [{ name: 'a', repo: 'r', aliases: ['x'] }],
        sdkMappings: [
          {
            sdkPackage: '@p/s',
            sdkClass: 'C',
            sdkMethod: 'm',
            targetService: 'a',
            http: { method: 'GET', pathTemplate: '/x', pathParams: [] },
          },
        ],
        pathRewriteRules: [],
        unresolvableServices: ['redis'],
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'mapper.meta.json'),
      JSON.stringify({
        generatedAt: '2026-05-12T00:00:00Z',
        generatedBy: { model: 'm', iterations: 1 },
        inputsHash: 'sha256:x',
        baselineResolutionRate: 0.81,
        baselineEdgeIds: [],
        regenHistory: [],
      }),
    );

    const result = runMapperStatus({
      mapperPath: path.join(dir, 'mapper.json'),
      mapperMetaPath: path.join(dir, 'mapper.meta.json'),
    });
    expect(result.exists).toBe(true);
    if (!result.exists) throw new Error('unreachable');
    expect(result.counts.services).toBe(1);
    expect(result.counts.sdkMappings).toBe(1);
    expect(result.counts.aliases).toBe(1);
    expect(result.meta?.baselineResolutionRate).toBe(0.81);
  });

  it('throws on a mapper.json that fails schema validation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-status-invalid-'));
    fs.writeFileSync(path.join(dir, 'mapper.json'), JSON.stringify({ $schemaVersion: 1, project: 'x' }));
    expect(() =>
      runMapperStatus({
        mapperPath: path.join(dir, 'mapper.json'),
        mapperMetaPath: path.join(dir, 'mapper.meta.json'),
      }),
    ).toThrow(/not valid|mapper validate/i);
  });
});

describe('runMapperDiff', () => {
  it('returns added/removed/changed sets between two mappers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-diff-'));
    const currentPath = path.join(dir, 'mapper.json');
    const baselinePath = path.join(dir, 'mapper.bak.json');

    fs.writeFileSync(
      baselinePath,
      JSON.stringify({
        $schemaVersion: 1,
        project: 'demo',
        services: [{ name: 'a', repo: 'r', aliases: [] }],
        sdkMappings: [
          {
            sdkPackage: '@p',
            sdkClass: 'C',
            sdkMethod: 'm1',
            targetService: 'a',
            http: { method: 'GET', pathTemplate: '/x', pathParams: [] },
          },
        ],
        pathRewriteRules: [],
        unresolvableServices: [],
      }),
    );
    fs.writeFileSync(
      currentPath,
      JSON.stringify({
        $schemaVersion: 1,
        project: 'demo',
        services: [
          { name: 'a', repo: 'r', aliases: ['x'] },
          { name: 'b', repo: 'r2', aliases: [] },
        ],
        sdkMappings: [
          {
            sdkPackage: '@p',
            sdkClass: 'C',
            sdkMethod: 'm1',
            targetService: 'a',
            http: { method: 'POST', pathTemplate: '/x', pathParams: [] },
          },
        ],
        pathRewriteRules: [],
        unresolvableServices: [],
      }),
    );

    const result = runMapperDiff({ currentPath, baselinePath });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.servicesAdded).toEqual(['b']);
    expect(result.servicesRemoved).toEqual([]);
    expect(result.sdkMappingsChanged).toHaveLength(1);
  });

  it('reports missing baseline file as error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-diff-'));
    fs.writeFileSync(path.join(dir, 'mapper.json'), '{}');
    const result = runMapperDiff({
      currentPath: path.join(dir, 'mapper.json'),
      baselinePath: path.join(dir, 'missing.bak'),
    });
    expect(result.ok).toBe(false);
  });
});

describe('runMapperDiscover', () => {
  // Stand up a tmp tree mirroring coredoc-output/{projectId}/<repo>.json and
  // coredoc-parsers/{projectId}/. Tests can populate each repo's externalCalls
  // and verify what the discover command writes.
  function setup(): { root: string; outputDir: string; parserStorage: string; projectId: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-discover-'));
    const outputDir = path.join(root, 'coredoc-output');
    const parserStorage = path.join(root, 'coredoc-parsers');
    const projectId = 'demo';
    fs.mkdirSync(path.join(outputDir, projectId), { recursive: true });
    return { root, outputDir, parserStorage, projectId };
  }

  function writeRepo(outputDir: string, projectId: string, name: string, externalCalls: unknown[]): void {
    const file = path.join(outputDir, projectId, `${name}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        name,
        repoVersion: '1',
        nodes: [],
        files: [],
        functions: [],
        modules: [],
        dataModels: [],
        events: [],
        entrypoints: [],
        externalCalls,
        callEdges: [],
        handlesEdges: [],
        readsEdges: [],
        writesEdges: [],
        emitsEdges: [],
        sdkDefinitions: [],
      }),
    );
  }

  it('exact match: service `core` matches repo `core`', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'core', []);
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'core',
        method: 'x',
        targetDescriptor: { protocol: 'http', targetService: 'core' },
      },
    ]);
    const result = runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId },
    );
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]).toMatchObject({
      service: 'core',
      matchedRepo: 'core',
      matchType: 'exact',
    });
  });

  it('prefix match: discovers org prefix from sibling repos and matches service to prefixed repo', () => {
    // Two repos share the `acme-` prefix → discoverRepoPrefixes() picks it up;
    // then service `core` matches repo `acme-core` via prefix combination.
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'acme-core', []);
    writeRepo(outputDir, projectId, 'acme-billing', []);
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'core',
        method: 'x',
        targetDescriptor: { protocol: 'http', targetService: 'core' },
      },
    ]);
    const result = runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId },
    );
    expect(result.matched.find((m) => m.service === 'core')).toMatchObject({
      service: 'core',
      matchedRepo: 'acme-core',
      matchType: 'prefix',
    });
  });

  it('does not infer prefix from a single repo (no convention to discover)', () => {
    // Only one repo `gateway` (no `acme-` sibling) → no prefix discovered.
    // Service `core` also doesn't substring-match `gateway` → unmatched.
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'gateway', []);
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'core',
        method: 'x',
        targetDescriptor: { protocol: 'http', targetService: 'core' },
      },
    ]);
    const result = runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId },
    );
    expect(result.unmatched.find((u) => u.service === 'core')).toBeTruthy();
  });

  it('auto-marks known infrastructure as unresolvable (redis, kafka, etc.)', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'redis',
        method: 'get',
        targetDescriptor: { protocol: 'http', targetService: 'redis' },
      },
      {
        id: 'c2',
        callerId: 'f',
        serviceName: 'kafka',
        method: 'send',
        targetDescriptor: { protocol: 'http', targetService: 'kafka' },
      },
    ]);
    const result = runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId },
    );
    expect(result.unresolvableAuto).toEqual(expect.arrayContaining(['redis', 'kafka']));
    expect(result.matched).toHaveLength(0);
  });

  it('reports unmatched services with call counts so users can see what to fix', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'ghost-svc',
        method: 'x',
        targetDescriptor: { protocol: 'http', targetService: 'ghost-svc' },
      },
      {
        id: 'c2',
        callerId: 'f',
        serviceName: 'ghost-svc',
        method: 'y',
        targetDescriptor: { protocol: 'http', targetService: 'ghost-svc' },
      },
    ]);
    const result = runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId },
    );
    expect(result.unmatched).toEqual([expect.objectContaining({ service: 'ghost-svc', callCount: 2 })]);
    expect(result.matched).toHaveLength(0);
  });

  it('writes a valid mapper.json that passes the v1 schema validator', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'acme-core', []);
    writeRepo(outputDir, projectId, 'acme-other', []);
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'core',
        method: 'x',
        targetDescriptor: { protocol: 'http', targetService: 'core' },
      },
    ]);
    const result = runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId },
    );
    const written = JSON.parse(fs.readFileSync(result.mapperPath, 'utf-8'));
    expect(written.$schemaVersion).toBe(1);
    expect(written.services).toHaveLength(1);
    expect(written.services[0]).toMatchObject({ name: 'core', repo: 'acme-core' });
    // Schema check: the written file must round-trip cleanly through validateMapper.
    const v = validateMapper(written);
    expect(v.ok).toBe(true);
  });

  it('strips SDK-package prefixes when matching: `sdk-client.core` → core', () => {
    // Recent parsers emit serviceName like '<package>.<class>' but
    // targetService='<class>'. The discover command should use the bare
    // suffix for the canonical name and preserve the prefixed form as an alias.
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'acme-core', []);
    writeRepo(outputDir, projectId, 'acme-other', []);
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'sdk-client.core',
        method: 'x',
        // No targetService here so we exercise serviceName fallback;
        // 'sdk-client.core' should still strip down to 'core'.
      },
    ]);
    const result = runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId },
    );
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.matchedRepo).toBe('acme-core');
    const written = JSON.parse(fs.readFileSync(result.mapperPath, 'utf-8'));
    expect(written.services[0]).toMatchObject({
      name: 'core',
      repo: 'acme-core',
      aliases: ['sdk-client.core'],
    });
  });

  it('normalises camelCase ↔ kebab-case when auto-matching services to repos', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'sample-web', []);
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'sampleWeb',
        method: 'x',
        targetDescriptor: { protocol: 'http', targetService: 'sampleWeb' },
      },
    ]);
    const result = runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId },
    );
    expect(result.matched[0]).toMatchObject({
      service: 'sampleWeb',
      matchedRepo: 'sample-web',
      matchType: 'exact',
    });
  });

  it('trims trailing whitespace/newlines from serviceName', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'core', []);
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'core\n',
        method: 'x',
        targetDescriptor: { protocol: 'http', targetService: 'core\n' },
      },
    ]);
    const result = runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId },
    );
    // Should appear in matched as 'core', not as 'core\n'
    expect(result.matched.find((m) => m.service === 'core')).toBeTruthy();
  });

  it('ignores parsed sdkDefinitions and writes no sdkMappings (in-workspace SDKs resolve via moniker hop)', () => {
    const { outputDir, parserStorage, projectId } = setup();
    // A target repo carrying sdkDefinitions[] — the OLD discover turned these
    // into sdkMappings. The new discover must drop them: in-workspace SDK routes
    // are recovered from the SDK source's own parsed egress (spec §6, D3).
    const repoPath = path.join(outputDir, projectId, 'sdk-source.json');
    fs.writeFileSync(
      repoPath,
      JSON.stringify({
        name: 'sdk-source',
        repoVersion: '1',
        nodes: [],
        files: [],
        functions: [],
        modules: [],
        dataModels: [],
        events: [],
        entrypoints: [],
        externalCalls: [],
        callEdges: [],
        handlesEdges: [],
        readsEdges: [],
        writesEdges: [],
        emitsEdges: [],
        sdkDefinitions: [
          {
            id: 'sdk:Core:getCompany',
            packageName: '@org/sdk',
            className: 'Core',
            methodName: 'getCompany',
            targetService: 'core',
            protocol: 'http',
            httpDetails: { method: 'GET', pathTemplate: '/v1/companies/:id', pathParams: ['id'] },
          },
        ],
      }),
    );
    writeRepo(outputDir, projectId, 'caller', []);
    const result = runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId },
    );
    expect(result.sdkMappingsCount).toBe(0);

    const written = JSON.parse(fs.readFileSync(result.mapperPath, 'utf-8'));
    // The override file omits sdkMappings entirely; the optional schema accepts it.
    expect(written.sdkMappings).toBeUndefined();
    const v = validateMapper(written);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.mapper.sdkMappings).toEqual([]);
  });

  it('throws when the project id is not in the loaded config', () => {
    const { outputDir, parserStorage } = setup();
    expect(() =>
      runMapperDiscover(
        {
          resolvedOutputDir: outputDir,
          resolvedParserStorage: parserStorage,
          projects: [{ id: 'other' }],
        },
        { project: 'missing' },
      ),
    ).toThrow(/missing/);
  });

  // --- Phase 4: target-aware synthesis + non-clobbering merge (spec §4.6) ---

  /** Write a parsed repo whose files[] carry FileNode.target values (multi-target). */
  function writeMultiTargetRepo(
    outputDir: string,
    projectId: string,
    name: string,
    fileTargets: Record<string, string>, // fileId → target
    externalCalls: unknown[] = [],
    entrypoints: unknown[] = [],
  ): void {
    const files = Object.entries(fileTargets).map(([id, target]) => ({
      id,
      path: `${id}.ts`,
      extension: '.ts',
      language: 'ts',
      target,
    }));
    fs.writeFileSync(
      path.join(outputDir, projectId, `${name}.json`),
      JSON.stringify({
        name,
        repoVersion: '1',
        packages: [],
        files,
        functions: [],
        modules: [],
        dataModels: [],
        events: [],
        entrypoints,
        externalCalls,
        callEdges: [],
        handlesEdges: [],
        readsEdges: [],
        writesEdges: [],
        emitsEdges: [],
        sdkDefinitions: [],
      }),
    );
  }

  function discover(
    outputDir: string,
    parserStorage: string,
    projectId: string,
    overwrite = false,
  ): ReturnType<typeof runMapperDiscover> {
    return runMapperDiscover(
      {
        resolvedOutputDir: outputDir,
        resolvedParserStorage: parserStorage,
        projects: [{ id: projectId }],
      },
      { project: projectId, overwrite },
    );
  }

  it('target synthesis: proposes one service per distinct FileNode.target in a multi-target repo', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeMultiTargetRepo(outputDir, projectId, 'mono', { a: 'web', b: 'web', c: 'api' });
    const result = discover(outputDir, parserStorage, projectId);
    const written = JSON.parse(fs.readFileSync(result.mapperPath, 'utf-8'));
    const monoEntries = written.services.filter((s: { repo: string }) => s.repo === 'mono');
    expect(monoEntries).toHaveLength(2);
    expect(monoEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo: 'mono', target: 'api' }),
        expect.objectContaining({ repo: 'mono', target: 'web' }),
      ]),
    );
    // Distinct target names are globally unique here → bare target name.
    expect(written.services.find((s: { target?: string }) => s.target === 'web')?.name).toBe('web');
    expect(written.$schemaVersion).toBe(2); // a v2 field (target) is in use
  });

  it('name uniqueness: bare target name when globally unique, `<repo>-<target>` slug on collision', () => {
    const { outputDir, parserStorage, projectId } = setup();
    // Two repos both have a `web` target (collision) and `mono-a` also has a unique `worker`.
    writeMultiTargetRepo(outputDir, projectId, 'mono-a', { a: 'web', b: 'worker' });
    writeMultiTargetRepo(outputDir, projectId, 'mono-b', { c: 'web' });
    const result = discover(outputDir, parserStorage, projectId);
    const written = JSON.parse(fs.readFileSync(result.mapperPath, 'utf-8'));
    const byRepoTarget = (repo: string, target: string) =>
      written.services.find((s: { repo: string; target?: string }) => s.repo === repo && s.target === target);
    // `web` collides → both slugged
    expect(byRepoTarget('mono-a', 'web').name).toBe('mono-a-web');
    expect(byRepoTarget('mono-b', 'web').name).toBe('mono-b-web');
    // `worker` is unique → bare
    expect(byRepoTarget('mono-a', 'worker').name).toBe('worker');
  });

  it('merge (default): preserves hand-edited name/alias/httpPrefix and adds newly discovered services', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeMultiTargetRepo(outputDir, projectId, 'mono', { a: 'web', b: 'api' });
    // First run creates the mapper with bare `web`/`api` entries.
    const first = discover(outputDir, parserStorage, projectId);
    const firstWritten = JSON.parse(fs.readFileSync(first.mapperPath, 'utf-8'));
    // Hand-edit the (mono, web) entry: rename, add alias, set httpPrefix. Then drop
    // the (mono, api) entry so the second run must ADD it back as newly discovered.
    firstWritten.services = firstWritten.services
      .filter((s: { target?: string }) => s.target !== 'api')
      .map((s: { target?: string }) =>
        s.target === 'web' ? { ...s, name: 'frontend', aliases: ['ui'], httpPrefix: '/app' } : s,
      );
    fs.writeFileSync(first.mapperPath, JSON.stringify(firstWritten, null, 2) + '\n');

    const second = discover(outputDir, parserStorage, projectId);
    const written = JSON.parse(fs.readFileSync(second.mapperPath, 'utf-8'));
    const web = written.services.find((s: { target?: string }) => s.target === 'web');
    expect(web).toMatchObject({ name: 'frontend', aliases: ['ui'], httpPrefix: '/app', repo: 'mono', target: 'web' });
    // (mono, api) was removed by hand but is re-added as newly discovered.
    expect(written.services.find((s: { target?: string }) => s.target === 'api')).toBeTruthy();
  });

  it('merge: reports existing services whose (repo,target) is no longer discovered as stale, without deleting them', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeMultiTargetRepo(outputDir, projectId, 'mono', { a: 'web' });
    const first = discover(outputDir, parserStorage, projectId);
    const firstWritten = JSON.parse(fs.readFileSync(first.mapperPath, 'utf-8'));
    // Add a hand-authored service for a repo/target that discovery will never produce.
    firstWritten.services.push({ name: 'ghost', repo: 'unparsed-repo', aliases: [], target: 'legacy' });
    firstWritten.$schemaVersion = 2;
    fs.writeFileSync(first.mapperPath, JSON.stringify(firstWritten, null, 2) + '\n');

    const second = discover(outputDir, parserStorage, projectId);
    const written = JSON.parse(fs.readFileSync(second.mapperPath, 'utf-8'));
    // Not deleted — still in the file.
    expect(written.services.find((s: { name: string }) => s.name === 'ghost')).toBeTruthy();
    // Reported as stale.
    expect(second.staleServices).toEqual(
      expect.arrayContaining([expect.objectContaining({ repo: 'unparsed-repo', target: 'legacy' })]),
    );
  });

  it('--overwrite: clobbers hand-edits and rebuilds from discovery', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeMultiTargetRepo(outputDir, projectId, 'mono', { a: 'web', b: 'api' });
    const first = discover(outputDir, parserStorage, projectId);
    const firstWritten = JSON.parse(fs.readFileSync(first.mapperPath, 'utf-8'));
    firstWritten.services = firstWritten.services.map((s: { target?: string }) =>
      s.target === 'web' ? { ...s, name: 'frontend', aliases: ['ui'] } : s,
    );
    fs.writeFileSync(first.mapperPath, JSON.stringify(firstWritten, null, 2) + '\n');

    discover(outputDir, parserStorage, projectId, /* overwrite */ true);
    const written = JSON.parse(fs.readFileSync(first.mapperPath, 'utf-8'));
    const web = written.services.find((s: { target?: string }) => s.target === 'web');
    // Hand-edit gone — clobbered back to the discovered defaults.
    expect(web.name).toBe('web');
    expect(web.aliases).toEqual([]);
  });

  it('merge idempotence: a single-repo project discovered twice yields a byte-identical mapper.json', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'core', []);
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'core',
        method: 'x',
        targetDescriptor: { protocol: 'http', targetService: 'core' },
      },
    ]);
    const first = discover(outputDir, parserStorage, projectId);
    const after1 = fs.readFileSync(first.mapperPath, 'utf-8');
    discover(outputDir, parserStorage, projectId);
    const after2 = fs.readFileSync(first.mapperPath, 'utf-8');
    expect(after2).toBe(after1);
  });

  it('merge idempotence (target-bearing): a multi-target repo discovered twice yields a byte-identical mapper.json', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeMultiTargetRepo(outputDir, projectId, 'mono', { a: 'web', b: 'api' });
    const first = discover(outputDir, parserStorage, projectId);
    const after1 = fs.readFileSync(first.mapperPath, 'utf-8');
    discover(outputDir, parserStorage, projectId);
    const after2 = fs.readFileSync(first.mapperPath, 'utf-8');
    expect(after2).toBe(after1);
  });

  it("callBasedServices filter: a caller's externalCalls targeting a multi-target repo by bare name does not crash and does not create a whole-repo duplicate entry", () => {
    // Regression: writeMultiTargetRepo(..., externalCalls) previously had no test
    // exercising a non-empty externalCalls array where the *caller* is a separate
    // plain repo whose targetService names the multi-target repo. That call-based
    // match must be skipped from synthesis (targetsByRepo.has(matchedRepo)) so the
    // multi-target repo is represented ONLY by its per-target entries, never also
    // as a whole-repo `{ name: 'mono', repo: 'mono' }` entry.
    const { outputDir, parserStorage, projectId } = setup();
    writeMultiTargetRepo(outputDir, projectId, 'mono', { a: 'web', b: 'api' });
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'mono',
        method: 'x',
        targetDescriptor: { protocol: 'http', targetService: 'mono' },
      },
    ]);

    let result!: ReturnType<typeof discover>;
    expect(() => {
      result = discover(outputDir, parserStorage, projectId);
    }).not.toThrow();

    // The call-based match is still reported for visibility...
    expect(result.matched).toEqual(
      expect.arrayContaining([expect.objectContaining({ service: 'mono', matchedRepo: 'mono', matchType: 'exact' })]),
    );

    // ...but the written mapper carries only the two per-target entries for `mono` —
    // no whole-repo duplicate, and every `mono` entry has a `target`.
    const written = JSON.parse(fs.readFileSync(result.mapperPath, 'utf-8'));
    const monoEntries: Array<{ name: string; repo: string; target?: string }> = written.services.filter(
      (s: { repo: string }) => s.repo === 'mono',
    );
    expect(monoEntries).toHaveLength(2);
    expect(monoEntries.every((s) => s.target !== undefined)).toBe(true);
    expect(monoEntries.some((s) => s.name === 'mono')).toBe(false);
  });

  it('name uniqueness across the FULL final name space: a target-synthesised name colliding with a call-based name is disambiguated with a numeric suffix and reported', () => {
    // The <repo>-<target> slug fallback only dedupes WITHIN the target-name
    // proposal set — it never checks the call-based synthesis's own canonical
    // names. Here `acme-core` (plain repo) produces a call-based `core` entry,
    // and `foo` (multi-target repo) independently produces a target-based `core`
    // entry (its `core` target is globally unique among targets, so it gets the
    // bare name) — both land on `core` with no cross-check between the two
    // synthesis strategies.
    const { outputDir, parserStorage, projectId } = setup();
    writeRepo(outputDir, projectId, 'acme-core', []);
    writeMultiTargetRepo(outputDir, projectId, 'foo', { x: 'core' });
    writeRepo(outputDir, projectId, 'caller', [
      {
        id: 'c1',
        callerId: 'f',
        serviceName: 'core',
        method: 'x',
        targetDescriptor: { protocol: 'http', targetService: 'core' },
      },
    ]);

    const result = discover(outputDir, parserStorage, projectId);
    const written = JSON.parse(fs.readFileSync(result.mapperPath, 'utf-8'));

    // The call-based entry (synthesised first) keeps the bare name...
    const callBased = written.services.find((s: { repo: string }) => s.repo === 'acme-core');
    expect(callBased.name).toBe('core');
    // ...the target-based entry that would otherwise collide is disambiguated.
    const targetBased = written.services.find((s: { repo: string }) => s.repo === 'foo');
    expect(targetBased.name).toBe('core-2');
    expect(targetBased.target).toBe('core');

    // Every services[].name in the written file is unique under normalizeServiceName.
    const normalized = written.services.map((s: { name: string }) => s.name.trim().toLowerCase());
    expect(new Set(normalized).size).toBe(normalized.length);

    expect(result.renamedServices).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: 'core', to: 'core-2', repo: 'foo', target: 'core' })]),
    );
    expect(result.nameCollisions).toHaveLength(0);
  });

  it('name uniqueness: a collision between two EXISTING (hand-authored) entries is reported, not renamed', () => {
    const { outputDir, parserStorage, projectId } = setup();
    writeMultiTargetRepo(outputDir, projectId, 'mono', { a: 'web' });
    const first = discover(outputDir, parserStorage, projectId);
    const firstWritten = JSON.parse(fs.readFileSync(first.mapperPath, 'utf-8'));
    // Two hand-authored entries that already collide by name.
    firstWritten.services = [
      { name: 'dup', repo: 'repo-x', aliases: [] },
      { name: 'DUP', repo: 'repo-y', aliases: [] },
    ];
    fs.writeFileSync(first.mapperPath, JSON.stringify(firstWritten, null, 2) + '\n');

    const second = discover(outputDir, parserStorage, projectId);
    const written = JSON.parse(fs.readFileSync(second.mapperPath, 'utf-8'));

    // Neither existing entry is renamed.
    expect(written.services.find((s: { repo: string }) => s.repo === 'repo-x').name).toBe('dup');
    expect(written.services.find((s: { repo: string }) => s.repo === 'repo-y').name).toBe('DUP');
    expect(second.renamedServices).toHaveLength(0);
    expect(second.nameCollisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          a: expect.objectContaining({ repo: 'repo-x' }),
          b: expect.objectContaining({ repo: 'repo-y' }),
        }),
      ]),
    );
  });

  it('baseline measurement slices multi-target repos like push does — an intra-repo web→api edge is counted', () => {
    // A single multi-target repo where the `web` target issues an http egress to a
    // path served by the `api` target's entrypoint. Push slices the merged repo per
    // target and resolves this as a cross-slice edge; the discover baseline must
    // measure under the SAME (sliced) semantics, else it under-reports the edge that
    // push resolves (an unsliced repo drops it as an http same-service self-match).
    const { outputDir, parserStorage, projectId } = setup();
    writeMultiTargetRepo(
      outputDir,
      projectId,
      'mono',
      { web: 'web', api: 'api' }, // fileId → target; file paths become `web.ts` / `api.ts`
      // `web` target's egress (lives in web.ts) → GET /orders
      [
        {
          id: 'c1',
          versionedId: 'c1@1',
          callerId: 'webCaller',
          serviceName: '',
          method: 'getOrders',
          location: { filePath: 'web.ts', startLine: 1, endLine: 1 },
          targetDescriptor: { protocol: 'http', http: { method: 'GET', pathTemplate: '/orders' } },
        },
      ],
      // `api` target's entrypoint (lives in api.ts) → GET /orders
      [
        {
          id: 'ep1',
          versionedId: 'ep1@1',
          type: 'http',
          handlerId: 'apiHandler',
          location: { filePath: 'api.ts', startLine: 1, endLine: 1 },
          details: { type: 'http', method: 'GET', path: '/orders', fullPath: '/orders' },
        },
      ],
    );

    const result = discover(outputDir, parserStorage, projectId);

    // The single resolvable egress resolves against the sibling target's entrypoint,
    // so the captured baseline is a full 100% — the intra-repo edge is counted.
    expect(result.baselineResolutionRate).toBe(1);
    // And it lands in the persisted meta the same way push-time drift detection reads it.
    const meta = JSON.parse(fs.readFileSync(result.mapperMetaPath, 'utf-8'));
    expect(meta.baselineResolutionRate).toBe(1);
    expect(meta.baselineEdgeIds).toContain('c1::ep1');
  });
});

// ============================================================================
// runMapperPush
// ============================================================================

describe('runMapperPush', () => {
  const VALID_MAPPER = {
    $schemaVersion: 1,
    project: 'demo',
    services: [],
    sdkMappings: [],
    pathRewriteRules: [],
    unresolvableServices: [],
  };

  let originalFetch: typeof globalThis.fetch | undefined;
  let originalToken: string | undefined;
  let originalServerUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalToken = process.env.COREDOC_TOKEN;
    originalServerUrl = process.env.COREDOC_SERVER_URL;
    process.env.COREDOC_TOKEN = 'test-token';
    process.env.COREDOC_SERVER_URL = 'http://test.local';
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete (globalThis as Record<string, unknown>).fetch;
    if (originalToken === undefined) delete process.env.COREDOC_TOKEN;
    else process.env.COREDOC_TOKEN = originalToken;
    if (originalServerUrl === undefined) delete process.env.COREDOC_SERVER_URL;
    else process.env.COREDOC_SERVER_URL = originalServerUrl;
  });

  it('reads local mapper, validates, PUTs to server, returns server response', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-push-'));
    const filePath = path.join(dir, 'mapper.json');
    fs.writeFileSync(filePath, JSON.stringify(VALID_MAPPER));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        sha256: 'abc123',
        r2Key: 'ws-1/mapper.json',
        sizeBytes: 100,
        duplicate: false,
        resolution: { resolved: 5, total: 10, rate: 0.5, legacyEdges: 2, mapperSha: 'abc123' },
      }),
    });
    globalThis.fetch = fetchMock as never;

    const result = await runMapperPush({ workspaceId: 'ws-1', file: filePath });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://test.local/api/v1/workspaces/ws-1/mapper');
    expect((init as RequestInit).method).toBe('PUT');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer test-token');
    expect(result.sha256).toBe('abc123');
    expect(result.duplicate).toBe(false);
    expect((result.resolution as { resolved: number }).resolved).toBe(5);
  });

  it('duplicate mapper PUT with a null resolution prints an idempotent success, not a crash', async () => {
    // The server's no-op fast path legitimately returns resolution:null for a
    // duplicate mapper on a file-snapshot workspace — the previous non-null
    // contract made `'error' in r.resolution` throw at runtime here.
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(String(line)));
    try {
      printMapperPushResult({
        sha256: 'abc123def456',
        r2Key: 'ws-1/mapper/mapper.json',
        sizeBytes: 42,
        duplicate: true,
        resolution: null,
      });
    } finally {
      logSpy.mockRestore();
    }
    expect(logs.some((line) => line.includes('unchanged'))).toBe(true);
    expect(logs.some((line) => line.includes('Resolution: unchanged'))).toBe(true);
  });

  it('refuses to send when local mapper.json fails schema validation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-push-'));
    const filePath = path.join(dir, 'mapper.json');
    fs.writeFileSync(filePath, JSON.stringify({ not: 'a mapper' }));

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;

    await expect(runMapperPush({ workspaceId: 'ws-1', file: filePath })).rejects.toThrow(/schema/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on non-2xx server response with status + body in the message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-push-'));
    const filePath = path.join(dir, 'mapper.json');
    fs.writeFileSync(filePath, JSON.stringify(VALID_MAPPER));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"errors":[...]}',
    }) as never;

    await expect(runMapperPush({ workspaceId: 'ws-1', file: filePath })).rejects.toThrow(/422/);
  });

  it('treats a 504 job_still_running as a stored mapper whose publication continues in background', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-push-'));
    const filePath = path.join(dir, 'mapper.json');
    fs.writeFileSync(filePath, JSON.stringify(VALID_MAPPER));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 504,
      text: async () => '{"code":"job_still_running","jobId":"job-77","message":"Job is still running"}',
    }) as never;

    const result = await runMapperPush({ workspaceId: 'ws-1', file: filePath });
    expect(result).toEqual({ status: 'publishing', jobId: 'job-77' });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(String(line)));
    try {
      printMapperPushResult(result);
    } finally {
      logSpy.mockRestore();
    }
    expect(logs.some((line) => line.includes('job-77'))).toBe(true);
    expect(logs.some((line) => /background/i.test(line))).toBe(true);
  });

  it('still throws on a 504 that is not a structured job_still_running body', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-push-'));
    const filePath = path.join(dir, 'mapper.json');
    fs.writeFileSync(filePath, JSON.stringify(VALID_MAPPER));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 504,
      text: async () => 'Gateway Timeout',
    }) as never;

    await expect(runMapperPush({ workspaceId: 'ws-1', file: filePath })).rejects.toThrow(/504/);
  });

  it('still throws on a 500 carrying a different structured code', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-push-'));
    const filePath = path.join(dir, 'mapper.json');
    fs.writeFileSync(filePath, JSON.stringify(VALID_MAPPER));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '{"code":"job_internal_error","jobId":"job-9","message":"Job execution failed"}',
    }) as never;

    await expect(runMapperPush({ workspaceId: 'ws-1', file: filePath })).rejects.toThrow(/500/);
  });

  it('throws when no auth token is available', async () => {
    delete process.env.COREDOC_TOKEN;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-push-'));
    // Point the CLI home at the empty temp dir: on a developer machine ~/.coredoc holds real
    // login credentials, and the token lookup falls back to them (then makes a real fetch).
    const originalHome = process.env.COREDOC_HOME;
    process.env.COREDOC_HOME = dir;
    try {
      const filePath = path.join(dir, 'mapper.json');
      fs.writeFileSync(filePath, JSON.stringify(VALID_MAPPER));
      await expect(runMapperPush({ workspaceId: 'ws-1', file: filePath })).rejects.toThrow(/login/i);
    } finally {
      if (originalHome === undefined) delete process.env.COREDOC_HOME;
      else process.env.COREDOC_HOME = originalHome;
    }
  });
});

// ============================================================================
// runMapperPull
// ============================================================================

describe('runMapperPull', () => {
  const REMOTE_CONTENT = JSON.stringify({
    $schemaVersion: 1,
    project: 'demo',
    services: [{ name: 'orders', repo: 'orders-svc', aliases: [] }],
    sdkMappings: [],
    pathRewriteRules: [],
    unresolvableServices: [],
  });

  let originalFetch: typeof globalThis.fetch | undefined;
  let originalToken: string | undefined;
  let originalServerUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalToken = process.env.COREDOC_TOKEN;
    originalServerUrl = process.env.COREDOC_SERVER_URL;
    process.env.COREDOC_TOKEN = 'test-token';
    process.env.COREDOC_SERVER_URL = 'http://test.local';
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete (globalThis as Record<string, unknown>).fetch;
    if (originalToken === undefined) delete process.env.COREDOC_TOKEN;
    else process.env.COREDOC_TOKEN = originalToken;
    if (originalServerUrl === undefined) delete process.env.COREDOC_SERVER_URL;
    else process.env.COREDOC_SERVER_URL = originalServerUrl;
  });

  it('downloads from server and writes to output path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-pull-'));
    const out = path.join(dir, 'mapper.json');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ ETag: 'remote-sha' }),
      text: async () => REMOTE_CONTENT,
    }) as never;
    const result = await runMapperPull({ workspaceId: 'ws-1', out });
    expect(result.written).toBe(true);
    expect(fs.readFileSync(out, 'utf-8')).toBe(REMOTE_CONTENT);
  });

  it('refuses to overwrite a divergent local file without --force', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-pull-'));
    const out = path.join(dir, 'mapper.json');
    fs.writeFileSync(out, '{"local":"different"}');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ ETag: 'remote-sha' }),
      text: async () => REMOTE_CONTENT,
    }) as never;
    await expect(runMapperPull({ workspaceId: 'ws-1', out })).rejects.toThrow(/--force/);
  });

  it('overwrites a divergent local file when --force is passed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-pull-'));
    const out = path.join(dir, 'mapper.json');
    fs.writeFileSync(out, '{"local":"different"}');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ ETag: 'remote-sha' }),
      text: async () => REMOTE_CONTENT,
    }) as never;
    const result = await runMapperPull({ workspaceId: 'ws-1', out, force: true });
    expect(result.written).toBe(true);
    expect(fs.readFileSync(out, 'utf-8')).toBe(REMOTE_CONTENT);
  });

  it('is a no-op when local and remote content match', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-pull-'));
    const out = path.join(dir, 'mapper.json');
    fs.writeFileSync(out, REMOTE_CONTENT);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({}),
      text: async () => REMOTE_CONTENT,
    }) as never;
    const result = await runMapperPull({ workspaceId: 'ws-1', out });
    expect(result.written).toBe(false);
  });

  it('throws a clear error on 404 (no mapper uploaded yet)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-pull-'));
    const out = path.join(dir, 'mapper.json');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'No mapper for workspace ws-1',
    }) as never;
    await expect(runMapperPull({ workspaceId: 'ws-1', out })).rejects.toThrow(/no mapper/i);
  });
});

describe('runMapperGenSdkMappings', () => {
  const validMapper = {
    $schemaVersion: 1,
    project: 'demo',
    services: [],
    sdkMappings: [],
    pathRewriteRules: [],
    unresolvableServices: [],
  };

  it('throws when the project is missing from the config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-sdk-'));
    const mapperPath = writeMapper(dir, validMapper);
    await expect(runMapperGenSdkMappings({ projects: [] }, { project: 'demo', mapperPath })).rejects.toThrow(
      /Project 'demo' missing/,
    );
  });

  it('throws a helpful error when no repo is marked as an SDK source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-sdk-'));
    const mapperPath = writeMapper(dir, validMapper);
    await expect(
      runMapperGenSdkMappings(
        { projects: [{ id: 'demo', repos: [{ name: 'app', path: '/x' }] }] },
        { project: 'demo', mapperPath },
      ),
    ).rejects.toThrow(/No SDK source repos.*sdkSourcePackages/s);
  });

  it('fails fast when a marked SDK source repo has no node_modules (would wipe the table)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-sdk-'));
    const mapperPath = writeMapper(dir, validMapper);
    // repo.path points at an empty temp dir → no node_modules → preflight throws
    // BEFORE any parse, so the existing 350-row table is never wiped by a degraded run.
    const sdkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-src-'));
    await expect(
      runMapperGenSdkMappings(
        { projects: [{ id: 'demo', repos: [{ name: 'sdk', path: sdkDir, sdkSourcePackages: ['@x/sdk'] }] }] },
        { project: 'demo', mapperPath },
      ),
    ).rejects.toThrow(/no node_modules/);
  });
});
