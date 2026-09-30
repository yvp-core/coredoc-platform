/**
 * Transformer Tests - mergeSummaries with repositorySummary,
 * containment edges for type_alias/enum/variable, and USES_TYPE edges.
 */

import { describe, it, expect } from 'vitest';
import { calleeNameTail, normalizeMetadataForParsedRepo, transformParsedRepo } from './transformer.js';
import type {
  ClassNode,
  ComponentNode,
  EntityNode,
  Entrypoint,
  EmbeddingsOutput,
  EnumNode,
  ExternalCallEdge,
  FunctionNode,
  InterfaceNode,
  ParsedRepo,
  SummaryOutput,
  TypeAliasNode,
  TypeInfo,
} from '@coredoc/core/types';

const REPO_ID = 'h0:repo:test';
const FILE_ID = 'h0:file:src/a.ts';
const LOC = { filePath: 'src/a.ts', startLine: 1, endLine: 2 };
const ref = (name: string): TypeInfo => ({ text: name, structure: { kind: 'reference', name } });

function ta(id: string, name: string, aliased?: TypeInfo): TypeAliasNode {
  return {
    id,
    versionedId: `${id}@v`,
    kind: 'type-alias',
    name,
    fileId: FILE_ID,
    isExported: true,
    aliasedType: aliased ?? { text: 'string', structure: { kind: 'primitive', name: 'string' } },
    location: LOC,
  };
}

function iface(id: string, name: string, members: InterfaceNode['members'] = []): InterfaceNode {
  return {
    id,
    versionedId: `${id}@v`,
    kind: 'interface',
    name,
    fileId: FILE_ID,
    isExported: true,
    members,
    location: LOC,
  };
}

function cls(id: string, name: string, props: ClassNode['properties'] = []): ClassNode {
  return {
    id,
    versionedId: `${id}@v`,
    kind: 'class',
    name,
    fileId: FILE_ID,
    isExported: true,
    isAbstract: false,
    methods: [],
    properties: props,
    location: LOC,
  };
}

function enumNode(id: string, name: string, filePath: string): EnumNode {
  return {
    id,
    versionedId: `${id}@v`,
    kind: 'enum',
    name,
    fileId: `h0:file:${filePath}`,
    isExported: true,
    isConst: false,
    members: [{ name: 'Open' }, { name: 'Locked' }],
    location: { filePath, startLine: 1, endLine: 2 },
  };
}

function fn(
  id: string,
  name: string,
  opts: { params?: { name: string; type: TypeInfo }[]; returnType?: TypeInfo } = {},
): FunctionNode {
  return {
    id,
    versionedId: `${id}@v`,
    kind: 'function',
    name,
    fileId: FILE_ID,
    isAsync: false,
    isGenerator: false,
    parameters: (opts.params ?? []).map((p) => ({ name: p.name, type: p.type, isOptional: false, isRest: false })),
    returnType: opts.returnType,
    isExported: true,
    location: LOC,
  };
}

function createMinimalParsedRepo(overrides: Partial<ParsedRepo> = {}): ParsedRepo {
  return {
    id: REPO_ID,
    name: 'test-repo',
    path: '/test',
    type: 'backend',
    parsedAt: '2025-01-01T00:00:00Z',
    parserVersion: '1.0.0',
    parserId: 'test-parser',
    packages: [],
    files: [],
    functions: [],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    ...overrides,
  };
}

describe('transformEntrypoint', () => {
  it('persists both the queue topic token and its resolved runtime value', () => {
    const entrypoint: Entrypoint = {
      id: 'queue-entrypoint',
      versionedId: 'queue-entrypoint@v',
      type: 'queue',
      handlerId: 'h0:fn:consume',
      location: LOC,
      details: {
        type: 'queue',
        system: 'kafka',
        topic: 'Topics.USER_CREATED',
        topicValue: 'user.created',
      },
    };

    const result = transformParsedRepo(createMinimalParsedRepo({ entrypoints: [entrypoint] }));
    const node = result.nodes.find((candidate) => candidate.id === entrypoint.id);

    expect(node?.properties).toMatchObject({
      topic: 'Topics.USER_CREATED',
      topicValue: 'user.created',
      messagingSystem: 'kafka',
      messagingDestination: 'user.created',
      messagingDestinationRef: 'Topics.USER_CREATED',
    });
  });

  it('persists event emitter plus token/value as a generic messaging address', () => {
    const entrypoint: Entrypoint = {
      id: 'event-entrypoint',
      versionedId: 'event-entrypoint@v',
      type: 'event',
      handlerId: 'h0:fn:consume',
      location: LOC,
      details: {
        type: 'event',
        emitter: 'celery',
        eventName: 'Events.USER_CREATED',
        eventValue: 'user.created',
      },
    };

    const result = transformParsedRepo(createMinimalParsedRepo({ entrypoints: [entrypoint] }));
    const node = result.nodes.find((candidate) => candidate.id === entrypoint.id);
    expect(node?.properties).toMatchObject({
      emitter: 'celery',
      eventName: 'Events.USER_CREATED',
      eventValue: 'user.created',
      messagingSystem: 'celery',
      messagingDestination: 'user.created',
      messagingDestinationRef: 'Events.USER_CREATED',
    });
  });

  // Entrypoint nodes store their id in `name`, which leaked
  // `<repoHash>:entrypoint:queue:<hash>` into every renderer that treats `name`
  // as text. The destination was on the node the whole time.
  it('names a messaging entrypoint by broker + destination, not by its node id', () => {
    const queue: Entrypoint = {
      id: 'queue-entrypoint',
      versionedId: 'queue-entrypoint@v',
      type: 'queue',
      handlerId: 'h0:fn:consume',
      location: LOC,
      details: { type: 'queue', system: 'kafka', topic: 'Topics.USER_CREATED', topicValue: 'user.created' },
    };
    const event: Entrypoint = {
      id: 'event-entrypoint',
      versionedId: 'event-entrypoint@v',
      type: 'event',
      handlerId: 'h0:fn:consume',
      location: LOC,
      details: { type: 'event', emitter: 'celery', eventName: 'Events.USER_CREATED' },
    };

    const result = transformParsedRepo(createMinimalParsedRepo({ entrypoints: [queue, event] }));

    expect(result.nodes.find((candidate) => candidate.id === queue.id)?.name).toBe('kafka:user.created');
    // No resolved value → the source token is still a name a human recognises.
    expect(result.nodes.find((candidate) => candidate.id === event.id)?.name).toBe('celery:Events.USER_CREATED');
  });

  it('keeps the node id as name when the destination is unresolved', () => {
    const queue: Entrypoint = {
      id: 'queue-entrypoint',
      versionedId: 'queue-entrypoint@v',
      type: 'queue',
      handlerId: 'h0:fn:consume',
      location: LOC,
      details: { type: 'queue', system: 'kafka', topic: '' },
    };

    const result = transformParsedRepo(createMinimalParsedRepo({ entrypoints: [queue] }));

    expect(result.nodes.find((candidate) => candidate.id === queue.id)?.name).toBe('queue-entrypoint');
  });

  // The class name is a mobile entrypoint's ONLY address — an agent filtering
  // `pathPattern: 'MainActivity'` has nothing else to match on, so it has to be
  // a stored property.
  it('persists a mobile entrypoint platform, trigger, class name and manifest facts', () => {
    const mobile: Entrypoint = {
      id: 'mobile-entrypoint',
      versionedId: 'mobile-entrypoint@v',
      type: 'mobile',
      handlerId: 'h0:fn:onCreate',
      location: LOC,
      details: {
        type: 'mobile',
        platform: 'android',
        trigger: 'deep-link',
        className: 'MainActivity',
        actions: ['android.intent.action.VIEW'],
        uriPatterns: ['example://app/home'],
        exported: true,
      },
    };

    const result = transformParsedRepo(createMinimalParsedRepo({ entrypoints: [mobile] }));

    expect(result.nodes.find((candidate) => candidate.id === mobile.id)?.properties).toMatchObject({
      entrypointType: 'mobile',
      platform: 'android',
      trigger: 'deep-link',
      className: 'MainActivity',
      actions: ['android.intent.action.VIEW'],
      uriPatterns: ['example://app/home'],
      exported: true,
    });
  });

  it('omits the optional mobile manifest facts when the parser did not find them', () => {
    const mobile: Entrypoint = {
      id: 'mobile-entrypoint',
      versionedId: 'mobile-entrypoint@v',
      type: 'mobile',
      handlerId: 'h0:fn:onReceive',
      location: LOC,
      details: { type: 'mobile', platform: 'android', trigger: 'broadcast', className: 'SyncReceiver' },
    };

    const properties = transformParsedRepo(createMinimalParsedRepo({ entrypoints: [mobile] })).nodes.find(
      (candidate) => candidate.id === mobile.id,
    )?.properties;

    expect(properties).toMatchObject({ className: 'SyncReceiver' });
    expect(properties).not.toHaveProperty('actions');
    expect(properties).not.toHaveProperty('uriPatterns');
    expect(properties).not.toHaveProperty('exported');
  });

  it('leaves a non-messaging entrypoint name untouched', () => {
    const http: Entrypoint = {
      id: 'http-entrypoint',
      versionedId: 'http-entrypoint@v',
      type: 'http',
      handlerId: 'h0:fn:handle',
      location: LOC,
      details: { type: 'http', method: 'GET', path: '/users', fullPath: '/api/users' },
    };

    const result = transformParsedRepo(createMinimalParsedRepo({ entrypoints: [http] }));

    expect(result.nodes.find((candidate) => candidate.id === http.id)?.name).toBe('http-entrypoint');
  });
});

describe('transformComponent', () => {
  function component(overrides: Partial<ComponentNode> = {}): ComponentNode {
    return {
      id: 'h0:component:MainActivity',
      versionedId: 'h0:component:MainActivity@v',
      kind: 'component',
      name: 'MainActivity',
      fileId: FILE_ID,
      framework: 'android',
      componentType: 'class',
      location: LOC,
      ...overrides,
    };
  }

  // The layout a screen renders lives in a separate XML file; dropping it in the
  // transformer loses the only link between the component and its markup.
  it('persists the template file a component renders', () => {
    const comp = component({ templateFile: 'app/src/main/res/layout/activity_main.xml' });

    const result = transformParsedRepo(createMinimalParsedRepo({ components: [comp] }));

    expect(result.nodes.find((candidate) => candidate.id === comp.id)?.properties).toMatchObject({
      templateFile: 'app/src/main/res/layout/activity_main.xml',
    });
  });

  it('leaves templateFile unset for an inline-markup component', () => {
    const comp = component();

    const result = transformParsedRepo(createMinimalParsedRepo({ components: [comp] }));

    expect(result.nodes.find((candidate) => candidate.id === comp.id)?.properties.templateFile).toBeUndefined();
  });
});

describe('mergeSummaries - repositorySummary', () => {
  it('should populate repository node with repositorySummary fields', () => {
    const repo = createMinimalParsedRepo();
    const summaryOutput: SummaryOutput = {
      repoId: repo.id,
      generatedAt: '2025-01-01T00:00:00Z',
      model: 'test-model',
      summaries: [],
      stats: {
        totalFunctions: 0,
        summarized: 0,
        skippedCached: 0,
        failedSummarization: 0,
        processingTimeMs: 100,
      },
      repositorySummary: {
        overview: 'A test backend service that handles user management.',
        dataModel: 'Users, Roles, and Permissions with many-to-many relationships.',
        externalIntegrations: ['PostgreSQL', 'Redis', 'Stripe API'],
        generatedAt: '2025-01-01T12:00:00Z',
      },
    };

    const result = transformParsedRepo(repo, summaryOutput);

    const repoNode = result.nodes.find((n) => n.type === 'repository');
    expect(repoNode).toBeDefined();
    expect(repoNode!.summary).toBe('A test backend service that handles user management.');
    expect(repoNode!.properties.dataModel).toBe('Users, Roles, and Permissions with many-to-many relationships.');
    expect(repoNode!.properties.externalIntegrations).toBe(JSON.stringify(['PostgreSQL', 'Redis', 'Stripe API']));
    expect(repoNode!.properties.summaryGeneratedAt).toBe('2025-01-01T12:00:00Z');
  });

  it('should not modify repository node when repositorySummary is absent', () => {
    const repo = createMinimalParsedRepo();
    const summaryOutput: SummaryOutput = {
      repoId: repo.id,
      generatedAt: '2025-01-01T00:00:00Z',
      model: 'test-model',
      summaries: [],
      stats: {
        totalFunctions: 0,
        summarized: 0,
        skippedCached: 0,
        failedSummarization: 0,
        processingTimeMs: 100,
      },
    };

    const result = transformParsedRepo(repo, summaryOutput);

    const repoNode = result.nodes.find((n) => n.type === 'repository');
    expect(repoNode).toBeDefined();
    expect(repoNode!.summary).toBeUndefined();
    expect(repoNode!.properties.dataModel).toBeUndefined();
  });

  it('should work when summaryOutput is null', () => {
    const repo = createMinimalParsedRepo();
    const result = transformParsedRepo(repo, null);

    const repoNode = result.nodes.find((n) => n.type === 'repository');
    expect(repoNode).toBeDefined();
    expect(repoNode!.summary).toBeUndefined();
  });

  it('propagates the git link (git.remoteUrl) onto the repository node, undefined when absent', () => {
    const withRemote = createMinimalParsedRepo({
      git: {
        commitHash: 'abc',
        commitShortHash: 'abc',
        branch: 'main',
        isDirty: false,
        remoteUrl: 'git@github.com:acme/api.git',
      },
    });
    const withoutRemote = createMinimalParsedRepo();

    const repoNode = transformParsedRepo(withRemote).nodes.find((n) => n.type === 'repository');
    expect(repoNode!.properties.gitRemoteUrl).toBe('git@github.com:acme/api.git');

    const bareNode = transformParsedRepo(withoutRemote).nodes.find((n) => n.type === 'repository');
    expect(bareNode!.properties.gitRemoteUrl).toBeUndefined();
  });

  // The parse point the graph is read against later. Carried beside the remote
  // rather than derived at read time: it is a fact about THIS snapshot, and a
  // snapshot that never recorded one must publish nothing rather than a stub.
  it('propagates the parsed commit (git.commitHash) onto the repository node, undefined when absent', () => {
    const withGit = createMinimalParsedRepo({
      git: {
        commitHash: 'deadbeefcafe',
        commitShortHash: 'deadbee',
        branch: 'main',
        isDirty: false,
      },
    });
    const withoutGit = createMinimalParsedRepo();

    const repoNode = transformParsedRepo(withGit).nodes.find((n) => n.type === 'repository');
    expect(repoNode!.properties.gitCommitHash).toBe('deadbeefcafe');

    const bareNode = transformParsedRepo(withoutGit).nodes.find((n) => n.type === 'repository');
    expect(bareNode!.properties.gitCommitHash).toBeUndefined();
  });

  // Absence of measurement must stay distinguishable from a measured zero, so a
  // parse that recorded nothing writes no key at all (spec LIM-3/LIM-8).
  it('preserves analysis mode and compiler capabilities in repository properties without raw diagnostics', () => {
    const analysis = [{ language: 'csharp', mode: 'basic', compilerReceiverTypes: false, fallback: true }];
    const measured = createMinimalParsedRepo({
      stats: {
        analysis: analysis.map((record) => ({ ...record, diagnostic: 'raw compiler output' })),
      } as ParsedRepo['stats'],
    });
    const repoNode = transformParsedRepo(measured).nodes.find((node) => node.type === 'repository');
    expect(JSON.parse(repoNode!.properties.analysis as string)).toEqual(analysis);
    const old = transformParsedRepo(createMinimalParsedRepo()).nodes.find((node) => node.type === 'repository');
    expect(old!.properties).not.toHaveProperty('analysis');
  });
  it('propagates the call-resolution record onto the repository node, writing no key when absent', () => {
    const measured = createMinimalParsedRepo({
      stats: { callResolution: { callSites: 12, resolvedCalls: 7, outOfScopeCalls: 3 } } as ParsedRepo['stats'],
    });
    const unmeasured = createMinimalParsedRepo({ stats: {} as ParsedRepo['stats'] });

    const repoNode = transformParsedRepo(measured).nodes.find((n) => n.type === 'repository');
    expect(repoNode!.properties.callSites).toBe(12);
    expect(repoNode!.properties.resolvedCalls).toBe(7);
    expect(repoNode!.properties.outOfScopeCalls).toBe(3);

    const bareNode = transformParsedRepo(unmeasured).nodes.find((n) => n.type === 'repository');
    expect(Object.hasOwn(bareNode!.properties, 'callSites')).toBe(false);
    expect(Object.hasOwn(bareNode!.properties, 'resolvedCalls')).toBe(false);
    expect(Object.hasOwn(bareNode!.properties, 'outOfScopeCalls')).toBe(false);
  });

  it('propagates the db-op-resolution record onto the repository node, writing no key when absent', () => {
    const measured = createMinimalParsedRepo({
      stats: { dbOpResolution: { dbOpSites: 9, boundDbOps: 5, outOfScopeDbOps: 2 } } as ParsedRepo['stats'],
    });
    const unmeasured = createMinimalParsedRepo({ stats: {} as ParsedRepo['stats'] });

    const repoNode = transformParsedRepo(measured).nodes.find((n) => n.type === 'repository');
    expect(repoNode!.properties.dbOpSites).toBe(9);
    expect(repoNode!.properties.boundDbOps).toBe(5);
    expect(repoNode!.properties.outOfScopeDbOps).toBe(2);

    const bareNode = transformParsedRepo(unmeasured).nodes.find((n) => n.type === 'repository');
    expect(Object.hasOwn(bareNode!.properties, 'dbOpSites')).toBe(false);
    expect(Object.hasOwn(bareNode!.properties, 'boundDbOps')).toBe(false);
    expect(Object.hasOwn(bareNode!.properties, 'outOfScopeDbOps')).toBe(false);
  });
});

describe('metadata version ownership', () => {
  const functionNode = fn('h0:function:a:run', 'run');

  it('skips a summary generated for an older function version without mutating the artifact', () => {
    const repo = createMinimalParsedRepo({ functions: [functionNode] });
    const summaryOutput = {
      repoId: repo.id,
      repoName: repo.name,
      generatedAt: '2025-01-01T00:00:00Z',
      summarizerVersion: '1',
      summaries: [
        {
          functionId: functionNode.id,
          versionedId: `${functionNode.id}@old`,
          detailed_summary: 'Old implementation',
          purpose: 'Old purpose',
          business_logic: [],
          side_effects: [],
          data_handling: '',
          confidence_level: 'high',
          unknowns: [],
          generatedAt: '2025-01-01T00:00:00Z',
        },
      ],
      stats: {
        totalFunctions: 1,
        summarized: 1,
        skippedCached: 0,
        failedSummarization: 0,
        processingTimeMs: 1,
      },
    } satisfies SummaryOutput;

    const normalized = normalizeMetadataForParsedRepo(repo, summaryOutput, null);
    const functionGraphNode = transformParsedRepo(repo, summaryOutput).nodes.find(
      (candidate) => candidate.id === functionNode.id,
    );

    expect(normalized.summaryOutput?.summaries).toEqual([]);
    expect(normalized.dropped).toEqual({
      summaries: 1,
      functionEmbeddings: 0,
      endpointEmbeddings: 0,
      total: 1,
    });
    expect(summaryOutput.summaries).toHaveLength(1);
    expect(functionGraphNode?.summary).toBeUndefined();
  });

  it('skips stale function and endpoint embeddings without mutating the artifact', () => {
    const endpoint = {
      id: 'h0:endpoint:a:get',
      versionedId: 'h0:endpoint:a:get@new',
      type: 'http',
      handlerId: functionNode.id,
      location: LOC,
      details: { type: 'http', method: 'GET', path: '/items' },
    } satisfies Entrypoint;
    const repo = createMinimalParsedRepo({ functions: [functionNode], entrypoints: [endpoint] });
    const embeddingsOutput = {
      repoId: repo.id,
      repoName: repo.name,
      generatedAt: '2025-01-01T00:00:00Z',
      provider: 'ollama',
      model: 'test',
      dimensions: 2,
      inputStrategy: 'source',
      functions: [
        {
          functionId: functionNode.id,
          versionedId: `${functionNode.id}@old`,
          name: functionNode.name,
          filePath: functionNode.location.filePath,
          inputChecksum: 'old',
          inputText: 'old body',
          embedding: [0.1, 0.2],
          generatedAt: '2025-01-01T00:00:00Z',
        },
      ],
      endpoints: [
        {
          endpointId: endpoint.id,
          versionedId: `${endpoint.id}@old`,
          type: 'http',
          path: '/items',
          handlerId: functionNode.id,
          inputChecksum: 'old-endpoint',
          inputText: 'old endpoint',
          embedding: [0.3, 0.4],
          generatedAt: '2025-01-01T00:00:00Z',
        },
      ],
      stats: {
        totalFunctions: 1,
        totalEndpoints: 1,
        functionsEmbedded: 1,
        endpointsEmbedded: 1,
        functionsSkipped: 0,
        endpointsSkipped: 0,
        failed: 0,
        processingTimeMs: 1,
      },
    } satisfies EmbeddingsOutput;

    const normalized = normalizeMetadataForParsedRepo(repo, null, embeddingsOutput);
    const functionGraphNode = transformParsedRepo(repo, null, embeddingsOutput).nodes.find(
      (candidate) => candidate.id === functionNode.id,
    );

    expect(normalized.embeddingsOutput?.functions).toEqual([]);
    expect(normalized.embeddingsOutput?.endpoints).toEqual([]);
    expect(normalized.dropped).toEqual({
      summaries: 0,
      functionEmbeddings: 1,
      endpointEmbeddings: 1,
      total: 2,
    });
    expect(embeddingsOutput.functions).toHaveLength(1);
    expect(embeddingsOutput.endpoints).toHaveLength(1);
    expect(functionGraphNode?.embedding).toBeUndefined();
  });

  it('merges metadata when the stable and versioned identities both match', () => {
    const repo = createMinimalParsedRepo({ functions: [functionNode] });
    const summaryOutput = {
      repoId: repo.id,
      repoName: repo.name,
      generatedAt: '2025-01-01T00:00:00Z',
      summarizerVersion: '1',
      summaries: [
        {
          functionId: functionNode.id,
          versionedId: functionNode.versionedId,
          detailed_summary: 'Current implementation',
          purpose: 'Current purpose',
          business_logic: [],
          side_effects: [],
          data_handling: '',
          confidence_level: 'high',
          unknowns: [],
          generatedAt: '2025-01-01T00:00:00Z',
        },
      ],
      stats: {
        totalFunctions: 1,
        summarized: 1,
        skippedCached: 0,
        failedSummarization: 0,
        processingTimeMs: 1,
      },
    } satisfies SummaryOutput;

    const node = transformParsedRepo(repo, summaryOutput).nodes.find((candidate) => candidate.id === functionNode.id);
    expect(node?.summary).toBe('Current implementation');
  });
});

describe('containment edges for previously-orphan node kinds', () => {
  it('emits CONTAINS_TYPE_ALIAS from file to type alias', () => {
    const repo = createMinimalParsedRepo({ typeAliases: [ta('h0:type_alias:a:T', 'T')] });
    const result = transformParsedRepo(repo);
    const edge = result.edges.find((e) => e.type === 'CONTAINS_TYPE_ALIAS');
    expect(edge).toBeDefined();
    expect(edge!.sourceId).toBe(FILE_ID);
    expect(edge!.targetId).toBe('h0:type_alias:a:T');
  });

  it('emits CONTAINS_ENUM from file to enum', () => {
    const repo = createMinimalParsedRepo({
      enums: [
        {
          id: 'h0:enum:a:Color',
          versionedId: 'h0:enum:a:Color@v',
          kind: 'enum',
          name: 'Color',
          fileId: FILE_ID,
          isExported: true,
          isConst: false,
          members: [],
          location: LOC,
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const edge = result.edges.find((e) => e.type === 'CONTAINS_ENUM');
    expect(edge).toBeDefined();
    expect(edge!.sourceId).toBe(FILE_ID);
  });

  it('emits CONTAINS_VARIABLE from file to variable', () => {
    const repo = createMinimalParsedRepo({
      variables: [
        {
          id: 'h0:variable:a:CONFIG',
          versionedId: 'h0:variable:a:CONFIG@v',
          kind: 'variable',
          name: 'CONFIG',
          fileId: FILE_ID,
          isExported: true,
          declarationKind: 'const',
          location: LOC,
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const edge = result.edges.find((e) => e.type === 'CONTAINS_VARIABLE');
    expect(edge).toBeDefined();
    expect(edge!.sourceId).toBe(FILE_ID);
  });
});

describe('class/interface/type_alias graph nodes carry shape data', () => {
  it('class node carries property list with name/type/visibility', () => {
    const propA = {
      id: 'h0:property:a:User:id',
      name: 'id',
      classId: 'h0:class:a:User',
      visibility: 'public' as const,
      isStatic: false,
      isReadonly: false,
      isOptional: false,
      type: { text: 'string', structure: { kind: 'primitive' as const, name: 'string' } },
      location: { filePath: 'src/a.ts', startLine: 5, endLine: 5 },
    };
    const repo = createMinimalParsedRepo({ classes: [cls('h0:class:a:User', 'User', [propA])] });
    const result = transformParsedRepo(repo);
    const node = result.nodes.find((n) => n.type === 'class' && n.name === 'User');
    expect(node).toBeDefined();
    const properties = node!.properties.properties_ as Array<Record<string, unknown>>;
    expect(properties).toHaveLength(1);
    expect(properties[0]).toMatchObject({ name: 'id', visibility: 'public', typeText: 'string' });
  });

  it('interface node carries member list with name/kind/typeText', () => {
    const repo = createMinimalParsedRepo({
      interfaces: [
        iface('h0:interface:a:Config', 'Config', [
          {
            name: 'apiKey',
            kind: 'property',
            isOptional: false,
            isReadonly: false,
            type: { text: 'string' },
            location: LOC,
          },
        ]),
      ],
    });
    const result = transformParsedRepo(repo);
    const node = result.nodes.find((n) => n.type === 'interface' && n.name === 'Config');
    expect(node).toBeDefined();
    const members = node!.properties.members as Array<Record<string, unknown>>;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ name: 'apiKey', kind: 'property', typeText: 'string' });
  });

  it('type alias node carries aliasedTypeText', () => {
    const repo = createMinimalParsedRepo({
      typeAliases: [ta('h0:type_alias:a:UserId', 'UserId', { text: 'string' })],
    });
    const result = transformParsedRepo(repo);
    const node = result.nodes.find((n) => n.type === 'type_alias' && n.name === 'UserId');
    expect(node).toBeDefined();
    expect(node!.properties.aliasedTypeText).toBe('string');
  });
});

describe('USES_TYPE edges', () => {
  it('emits one edge per function parameter typed as a known type alias', () => {
    const repo = createMinimalParsedRepo({
      typeAliases: [ta('h0:type_alias:a:UserId', 'UserId')],
      functions: [fn('h0:function:a:getUser', 'getUser', { params: [{ name: 'id', type: ref('UserId') }] })],
    });
    const result = transformParsedRepo(repo);
    const usesType = result.edges.filter((e) => e.type === 'USES_TYPE');
    expect(usesType).toHaveLength(1);
    expect(usesType[0]).toMatchObject({
      sourceId: 'h0:function:a:getUser',
      targetId: 'h0:type_alias:a:UserId',
      properties: { usage: 'parameter', via: 'id', targetKind: 'type_alias' },
    });
  });

  it('emits an edge for function return type pointing at an interface', () => {
    const repo = createMinimalParsedRepo({
      interfaces: [iface('h0:interface:a:Config', 'Config')],
      functions: [fn('h0:function:a:loadConfig', 'loadConfig', { returnType: ref('Config') })],
    });
    const result = transformParsedRepo(repo);
    const edge = result.edges.find((e) => e.type === 'USES_TYPE' && (e.properties.usage as string) === 'return');
    expect(edge).toBeDefined();
    expect(edge!.targetId).toBe('h0:interface:a:Config');
  });

  it('emits one edge per constructor param typed as a known class (DI pattern)', () => {
    // Regression: NestJS/Angular/Inversify/hand-rolled DI all express
    // dependencies as constructor params. Without this edge, find_dependents
    // returns empty for the injected class even when N consumers exist —
    // exactly the find_dependents={"name":"SampleAuthedApi"} → 0 results
    // gap seen in the 2026-05-12 eval run.
    const repo = createMinimalParsedRepo({
      classes: [
        cls('h0:class:a:SampleAuthedApi', 'SampleAuthedApi'),
        {
          id: 'h0:class:a:BookingService',
          versionedId: 'h0:class:a:BookingService@v',
          kind: 'class',
          name: 'BookingService',
          fileId: FILE_ID,
          isExported: true,
          isAbstract: false,
          methods: [],
          properties: [],
          constructor: {
            id: 'h0:method:a:BookingService.constructor',
            classId: 'h0:class:a:BookingService',
            parameters: [{ name: 'sampleApi', type: ref('SampleAuthedApi'), isOptional: false, isRest: false }],
            visibility: 'public',
            location: LOC,
          },
          location: LOC,
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const edge = result.edges.find(
      (e) => e.type === 'USES_TYPE' && (e.properties.usage as string) === 'constructor-param',
    );
    expect(edge).toBeDefined();
    expect(edge).toMatchObject({
      sourceId: 'h0:class:a:BookingService',
      targetId: 'h0:class:a:SampleAuthedApi',
      properties: { usage: 'constructor-param', via: 'sampleApi' },
    });
  });

  it('emits an edge for class property typed as another type alias', () => {
    const repo = createMinimalParsedRepo({
      typeAliases: [ta('h0:type_alias:a:UserId', 'UserId')],
      classes: [
        cls('h0:class:a:User', 'User', [
          {
            id: 'h0:property:a:User:id',
            name: 'id',
            classId: 'h0:class:a:User',
            visibility: 'public',
            isStatic: false,
            isReadonly: false,
            isOptional: false,
            type: ref('UserId'),
            location: LOC,
          },
        ]),
      ],
    });
    const result = transformParsedRepo(repo);
    const edge = result.edges.find((e) => e.type === 'USES_TYPE' && (e.properties.usage as string) === 'property');
    expect(edge).toBeDefined();
    expect(edge).toMatchObject({
      sourceId: 'h0:class:a:User',
      targetId: 'h0:type_alias:a:UserId',
      properties: { usage: 'property', via: 'id' },
    });
  });

  it('emits an edge from a type alias to the type it aliases', () => {
    const repo = createMinimalParsedRepo({
      typeAliases: [ta('h0:type_alias:a:Base', 'Base'), ta('h0:type_alias:a:Derived', 'Derived', ref('Base'))],
    });
    const result = transformParsedRepo(repo);
    const edge = result.edges.find((e) => e.type === 'USES_TYPE' && e.sourceId === 'h0:type_alias:a:Derived');
    expect(edge).toBeDefined();
    expect(edge!.targetId).toBe('h0:type_alias:a:Base');
    expect(edge!.properties.usage).toBe('aliased');
  });

  it('marks ambiguous edges and emits one edge per candidate when the name resolves to multiple types', () => {
    const repo = createMinimalParsedRepo({
      typeAliases: [ta('h0:type_alias:a:X', 'X')],
      interfaces: [iface('h0:interface:a:X', 'X')],
      functions: [fn('h0:function:a:f', 'f', { params: [{ name: 'p', type: ref('X') }] })],
    });
    const result = transformParsedRepo(repo);
    const edges = result.edges.filter((e) => e.type === 'USES_TYPE');
    expect(edges).toHaveLength(2);
    for (const e of edges) {
      expect(e.properties.ambiguous).toBe(true);
      expect(e.confidence).toBe(0.5);
    }
  });

  it('does not emit USES_TYPE for primitive parameter types', () => {
    const repo = createMinimalParsedRepo({
      functions: [
        fn('h0:function:a:f', 'f', {
          params: [{ name: 'p', type: { text: 'string', structure: { kind: 'primitive', name: 'string' } } }],
        }),
      ],
    });
    const result = transformParsedRepo(repo);
    expect(result.edges.filter((e) => e.type === 'USES_TYPE')).toHaveLength(0);
  });

  it('falls back to text parsing when structure is absent (real parser path)', () => {
    // The base parser emits TypeInfo as `{ text }` only — no structure. The
    // text-fallback in collectTypeReferences makes USES_TYPE work on real
    // parsed output, not just hand-built structured TypeInfo from tests.
    const repo = createMinimalParsedRepo({
      typeAliases: [ta('h0:type_alias:a:UserId', 'UserId')],
      interfaces: [iface('h0:interface:a:Config', 'Config')],
      functions: [
        fn('h0:function:a:getUser', 'getUser', {
          params: [{ name: 'id', type: { text: 'UserId' } }],
          returnType: { text: 'Promise<Config | null>' },
        }),
      ],
    });
    const result = transformParsedRepo(repo);
    const edges = result.edges.filter((e) => e.type === 'USES_TYPE');
    // One for the parameter, one for the return type. Promise/null are
    // candidates that drop out at index lookup (not in the in-repo type index).
    expect(edges.length).toBeGreaterThanOrEqual(2);
    expect(
      edges.find((e) => e.targetId === 'h0:type_alias:a:UserId' && e.properties.usage === 'parameter'),
    ).toBeDefined();
    expect(edges.find((e) => e.targetId === 'h0:interface:a:Config' && e.properties.usage === 'return')).toBeDefined();
  });

  it('text fallback filters TS built-in non-type globals', () => {
    // Make sure tokens like 'Date', 'Error', 'JSON' don't get treated as repo
    // type references just because they're capitalized.
    const repo = createMinimalParsedRepo({
      typeAliases: [ta('h0:type_alias:a:Error', 'Error')], // intentionally clashes
      functions: [fn('h0:function:a:f', 'f', { returnType: { text: 'Date | Error | JSON' } })],
    });
    const result = transformParsedRepo(repo);
    // 'Error' is in TYPE_TEXT_NON_REFS, so the in-repo Error alias gets no edge
    // from text fallback. (If structure were present and named Error, it would.)
    const edges = result.edges.filter((e) => e.type === 'USES_TYPE');
    expect(edges).toHaveLength(0);
  });

  it('dedupes union-of-same-type so we do not emit duplicate edges', () => {
    const repo = createMinimalParsedRepo({
      interfaces: [iface('h0:interface:a:T', 'T')],
      functions: [
        fn('h0:function:a:f', 'f', {
          params: [
            {
              name: 'p',
              type: {
                text: 'T | T',
                structure: { kind: 'union', types: [ref('T'), ref('T')] },
              },
            },
          ],
        }),
      ],
    });
    const result = transformParsedRepo(repo);
    expect(result.edges.filter((e) => e.type === 'USES_TYPE')).toHaveLength(1);
  });

  it('distinguishes a value-position enum-member consumer from a type-position one', () => {
    const statusEnum: EnumNode = {
      id: 'h0:enum:a:Status',
      versionedId: 'h0:enum:a:Status@v',
      kind: 'enum',
      name: 'Status',
      fileId: FILE_ID,
      isExported: true,
      isConst: false,
      members: [{ name: 'Open' }, { name: 'Locked' }],
      location: LOC,
    };
    const repo = createMinimalParsedRepo({
      enums: [statusEnum],
      functions: [
        fn('h0:function:a:describeStatus', 'describeStatus', { params: [{ name: 's', type: ref('Status') }] }),
        fn('h0:function:a:isLocked', 'isLocked', {}),
      ],
      enumMemberReferences: [
        {
          id: 'h0:enum-member-ref:1',
          sourceId: 'h0:function:a:isLocked',
          enumName: 'Status',
          member: 'Locked',
          location: LOC,
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const toStatus = result.edges.filter((e) => e.type === 'USES_TYPE' && e.targetId === 'h0:enum:a:Status');
    expect(toStatus).toHaveLength(2);

    const typeLevel = toStatus.find((e) => e.sourceId === 'h0:function:a:describeStatus');
    expect(typeLevel!.properties.useKind).toBeUndefined();
    expect(typeLevel!.properties.member).toBeUndefined();

    const valueLevel = toStatus.find((e) => e.sourceId === 'h0:function:a:isLocked');
    expect(valueLevel).toMatchObject({
      properties: { usage: 'member-access', useKind: 'value', member: 'Locked', targetKind: 'enum' },
    });
    expect(valueLevel!.confidence).toBe(1.0);
  });

  it('keeps one edge per member and ignores a same-named non-enum declaration', () => {
    const repo = createMinimalParsedRepo({
      // A class shares the enum's name: a member reference is about the ENUM only.
      classes: [cls('h0:class:a:Status', 'Status')],
      enums: [
        {
          id: 'h0:enum:a:Status',
          versionedId: 'h0:enum:a:Status@v',
          kind: 'enum',
          name: 'Status',
          fileId: FILE_ID,
          isExported: true,
          isConst: false,
          members: [{ name: 'Open' }, { name: 'Locked' }],
          location: LOC,
        },
      ],
      functions: [fn('h0:function:a:isLocked', 'isLocked', {})],
      enumMemberReferences: [
        {
          id: 'h0:enum-member-ref:1',
          sourceId: 'h0:function:a:isLocked',
          enumName: 'Status',
          member: 'Locked',
          location: LOC,
        },
        {
          id: 'h0:enum-member-ref:2',
          sourceId: 'h0:function:a:isLocked',
          enumName: 'Status',
          member: 'Open',
          location: LOC,
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const memberEdges = result.edges.filter((e) => e.properties.usage === 'member-access');
    expect(memberEdges.map((e) => e.properties.member).sort()).toEqual(['Locked', 'Open']);
    expect(memberEdges.every((e) => e.targetId === 'h0:enum:a:Status')).toBe(true);
    expect(memberEdges.every((e) => e.properties.ambiguous === false)).toBe(true);
  });

  it('links an imported member reference to the enum declared by the imported module', () => {
    const repo = createMinimalParsedRepo({
      enums: [enumNode('h0:enum:src/status.ts:Status', 'Status', 'src/status.ts')],
      functions: [fn('h0:function:src/a.ts:isLocked', 'isLocked', {})],
      enumMemberReferences: [
        {
          id: 'h0:enum-member-ref:1',
          sourceId: 'h0:function:src/a.ts:isLocked',
          enumName: 'Status',
          importedFrom: './status',
          member: 'Locked',
          location: LOC,
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const memberEdges = result.edges.filter((e) => e.properties.usage === 'member-access');
    expect(memberEdges).toHaveLength(1);
    expect(memberEdges[0].targetId).toBe('h0:enum:src/status.ts:Status');
    expect(memberEdges[0].properties.ambiguous).toBe(false);
  });

  it('drops a member reference whose imported module is not the enum declaration site', () => {
    // `Status` is imported from ./classes (a class there, never extracted as an enum) while an
    // unrelated enum of the same name lives elsewhere: linking them would fabricate a dependency.
    const repo = createMinimalParsedRepo({
      enums: [enumNode('h0:enum:src/other.ts:Status', 'Status', 'src/other.ts')],
      functions: [fn('h0:function:src/a.ts:isLocked', 'isLocked', {})],
      enumMemberReferences: [
        {
          id: 'h0:enum-member-ref:1',
          sourceId: 'h0:function:src/a.ts:isLocked',
          enumName: 'Status',
          importedFrom: './classes',
          member: 'Locked',
          location: LOC,
        },
      ],
    });
    const result = transformParsedRepo(repo);
    expect(result.edges.filter((e) => e.properties.usage === 'member-access')).toHaveLength(0);
  });

  it('marks a member reference from an unresolvable specifier as ambiguous', () => {
    // A bare package specifier names no repo file, so identity cannot be checked. The edge is kept
    // (dropping it would hide real consumers of re-exported enums) but flagged as the weaker match.
    const repo = createMinimalParsedRepo({
      enums: [enumNode('h0:enum:src/status.ts:Status', 'Status', 'src/status.ts')],
      functions: [fn('h0:function:src/a.ts:isLocked', 'isLocked', {})],
      enumMemberReferences: [
        {
          id: 'h0:enum-member-ref:1',
          sourceId: 'h0:function:src/a.ts:isLocked',
          enumName: 'Status',
          importedFrom: '@vendor/status',
          member: 'Locked',
          location: LOC,
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const memberEdges = result.edges.filter((e) => e.properties.usage === 'member-access');
    expect(memberEdges).toHaveLength(1);
    expect(memberEdges[0].targetId).toBe('h0:enum:src/status.ts:Status');
    expect(memberEdges[0].properties.ambiguous).toBe(true);
    expect(memberEdges[0].confidence).toBe(0.5);
  });

  it('keeps two edges when one function reads the same member name from two modules', () => {
    const repo = createMinimalParsedRepo({
      enums: [
        enumNode('h0:enum:src/a.ts:Status', 'Status', 'src/a.ts'),
        enumNode('h0:enum:src/b.ts:Status', 'Status', 'src/b.ts'),
      ],
      functions: [fn('h0:function:src/c.ts:isEitherLocked', 'isEitherLocked', {})],
      enumMemberReferences: [
        {
          id: 'h0:enum-member-ref:1',
          sourceId: 'h0:function:src/c.ts:isEitherLocked',
          enumName: 'Status',
          importedFrom: './a',
          member: 'Locked',
          location: { filePath: 'src/c.ts', startLine: 2, endLine: 2 },
        },
        {
          id: 'h0:enum-member-ref:2',
          sourceId: 'h0:function:src/c.ts:isEitherLocked',
          enumName: 'Status',
          importedFrom: './b',
          member: 'Locked',
          location: { filePath: 'src/c.ts', startLine: 3, endLine: 3 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const memberEdges = result.edges.filter((e) => e.properties.usage === 'member-access');
    expect(memberEdges.map((e) => e.targetId).sort()).toEqual(['h0:enum:src/a.ts:Status', 'h0:enum:src/b.ts:Status']);
    expect(new Set(memberEdges.map((e) => e.id)).size).toBe(2);
  });

  it('links a barrel-imported member reference through the resolved declaring file', () => {
    // The site names the barrel (`./index`), the parser resolved the identity to the declaration
    // (`src/a.ts`): the resolved file is what identity is matched on, so the consumer is kept and
    // is a full-confidence match, not a name guess.
    const repo = createMinimalParsedRepo({
      enums: [enumNode('h0:enum:src/a.ts:Status', 'Status', 'src/a.ts')],
      functions: [fn('h0:function:src/c.ts:isBarrelLocked', 'isBarrelLocked', {})],
      enumMemberReferences: [
        {
          id: 'h0:enum-member-ref:1',
          sourceId: 'h0:function:src/c.ts:isBarrelLocked',
          enumName: 'Status',
          importedFrom: './index',
          declaringFile: 'src/a.ts',
          member: 'Locked',
          location: { filePath: 'src/c.ts', startLine: 2, endLine: 2 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const memberEdges = result.edges.filter((e) => e.properties.usage === 'member-access');
    expect(memberEdges).toHaveLength(1);
    expect(memberEdges[0].targetId).toBe('h0:enum:src/a.ts:Status');
    expect(memberEdges[0].properties.ambiguous).toBe(false);
    expect(memberEdges[0].confidence).toBe(1.0);
  });

  it('drops a reference whose resolved declaring file holds no enum of that name', () => {
    // A resolved identity is authoritative: a same-named enum in another file is a different
    // symbol, so nothing is linked rather than the nearest name match.
    const repo = createMinimalParsedRepo({
      enums: [enumNode('h0:enum:src/other.ts:Status', 'Status', 'src/other.ts')],
      functions: [fn('h0:function:src/c.ts:isBarrelLocked', 'isBarrelLocked', {})],
      enumMemberReferences: [
        {
          id: 'h0:enum-member-ref:1',
          sourceId: 'h0:function:src/c.ts:isBarrelLocked',
          enumName: 'Status',
          importedFrom: './index',
          declaringFile: 'src/a.ts',
          member: 'Locked',
          location: { filePath: 'src/c.ts', startLine: 2, endLine: 2 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    expect(result.edges.filter((e) => e.properties.usage === 'member-access')).toHaveLength(0);
  });
});

describe('class reference edges (construction / import)', () => {
  /** A class node declared in a named file, so declaring-file identity can be checked. */
  const classIn = (filePath: string, name: string): ClassNode => ({
    ...cls(`h0:class:${filePath}:${name}`, name),
    fileId: `h0:file:${filePath}`,
    location: { filePath, startLine: 1, endLine: 9 },
  });

  it('emits a construction edge to the class declared by the imported module', () => {
    const repo = createMinimalParsedRepo({
      classes: [classIn('src/service.ts', 'UserService')],
      functions: [fn('h0:function:src/a.ts:build', 'build', {})],
      classReferences: [
        {
          id: 'h0:class-ref:1',
          sourceId: 'h0:function:src/a.ts:build',
          refKind: 'construction',
          className: 'UserService',
          importedFrom: './service',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 4, endLine: 4 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const edges = result.edges.filter((e) => e.properties.usage === 'construction');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceId: 'h0:function:src/a.ts:build',
      targetId: 'h0:class:src/service.ts:UserService',
      type: 'USES_TYPE',
      confidence: 1.0,
      properties: { useKind: 'value', targetKind: 'class', ambiguous: false },
    });
  });

  it('keeps a class candidate that a same-named enum or interface would otherwise shadow', () => {
    // Regression: class entries carried no declaring file, so the identity filter dropped every
    // verified class reference and only same-named non-class declarations survived the name match.
    const repo = createMinimalParsedRepo({
      classes: [classIn('src/service.ts', 'UserService')],
      interfaces: [
        {
          ...iface('h0:interface:src/other.ts:UserService', 'UserService'),
          location: { filePath: 'src/other.ts', startLine: 1, endLine: 2 },
        },
      ],
      functions: [fn('h0:function:src/a.ts:build', 'build', {})],
      classReferences: [
        {
          id: 'h0:class-ref:1',
          sourceId: 'h0:function:src/a.ts:build',
          refKind: 'construction',
          className: 'UserService',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 4, endLine: 4 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const edges = result.edges.filter((e) => e.properties.usage === 'construction');
    expect(edges.map((e) => e.targetId)).toEqual(['h0:class:src/service.ts:UserService']);
  });

  it('marks a construction reference from an unresolvable specifier as ambiguous', () => {
    const repo = createMinimalParsedRepo({
      classes: [classIn('src/service.ts', 'UserService')],
      functions: [fn('h0:function:src/a.ts:build', 'build', {})],
      classReferences: [
        {
          id: 'h0:class-ref:1',
          sourceId: 'h0:function:src/a.ts:build',
          refKind: 'construction',
          className: 'UserService',
          importedFrom: '@vendor/users',
          location: { filePath: 'src/a.ts', startLine: 4, endLine: 4 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const edges = result.edges.filter((e) => e.properties.usage === 'construction');
    expect(edges).toHaveLength(1);
    expect(edges[0].properties.ambiguous).toBe(true);
    expect(edges[0].confidence).toBe(0.5);
  });

  it('emits an import edge from the importing file when that file does not construct the class', () => {
    const repo = createMinimalParsedRepo({
      classes: [classIn('src/service.ts', 'UserService')],
      classReferences: [
        {
          id: 'h0:class-ref:1',
          sourceId: 'h0:file:src/a.ts',
          refKind: 'import',
          className: 'UserService',
          importedFrom: './service',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 1, endLine: 1 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const edges = result.edges.filter((e) => e.properties.usage === 'import');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceId: 'h0:file:src/a.ts',
      targetId: 'h0:class:src/service.ts:UserService',
      properties: { targetKind: 'class', ambiguous: false },
    });
    // An import is neither a value- nor a type-position use on its own.
    expect(edges[0].properties.useKind).toBeUndefined();
  });

  it('suppresses the import edge when the same file also constructs the class', () => {
    // Two rows, one dependency: the construction is the stronger fact and subsumes the import.
    const repo = createMinimalParsedRepo({
      classes: [classIn('src/service.ts', 'UserService')],
      functions: [fn('h0:function:src/a.ts:build', 'build', {})],
      classReferences: [
        {
          id: 'h0:class-ref:1',
          sourceId: 'h0:function:src/a.ts:build',
          refKind: 'construction',
          className: 'UserService',
          importedFrom: './service',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 4, endLine: 4 },
        },
        {
          id: 'h0:class-ref:2',
          sourceId: 'h0:file:src/a.ts',
          refKind: 'import',
          className: 'UserService',
          importedFrom: './service',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 1, endLine: 1 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    expect(result.edges.filter((e) => e.properties.usage === 'import')).toHaveLength(0);
    expect(result.edges.filter((e) => e.properties.usage === 'construction')).toHaveLength(1);
  });

  it('keeps an import edge from a file that constructs a DIFFERENT class', () => {
    const repo = createMinimalParsedRepo({
      classes: [classIn('src/service.ts', 'UserService'), classIn('src/other.ts', 'Other')],
      functions: [fn('h0:function:src/a.ts:build', 'build', {})],
      classReferences: [
        {
          id: 'h0:class-ref:1',
          sourceId: 'h0:function:src/a.ts:build',
          refKind: 'construction',
          className: 'Other',
          declaringFile: 'src/other.ts',
          location: { filePath: 'src/a.ts', startLine: 4, endLine: 4 },
        },
        {
          id: 'h0:class-ref:2',
          sourceId: 'h0:file:src/a.ts',
          refKind: 'import',
          className: 'UserService',
          importedFrom: './service',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 1, endLine: 1 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    expect(result.edges.filter((e) => e.properties.usage === 'import')).toHaveLength(1);
  });

  it('emits a construction edge sourced at the FILE for a module-scope construction', () => {
    // `export const client = new UserService()` has no enclosing function; the module constructs it.
    const repo = createMinimalParsedRepo({
      classes: [classIn('src/service.ts', 'UserService')],
      classReferences: [
        {
          id: 'h0:class-ref:1',
          sourceId: 'h0:file:src/a.ts',
          refKind: 'construction',
          className: 'UserService',
          importedFrom: './service',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 3, endLine: 3 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const edges = result.edges.filter((e) => e.properties.usage === 'construction');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceId: 'h0:file:src/a.ts',
      targetId: 'h0:class:src/service.ts:UserService',
      confidence: 1.0,
      properties: { useKind: 'value', ambiguous: false },
    });
  });

  it('lets a module-scope construction subsume that file’s import row', () => {
    // Both rows are sourced at the same FILE node: without the subsumption the one dependency
    // would be counted twice, once as a construction and once as an import.
    const repo = createMinimalParsedRepo({
      classes: [classIn('src/service.ts', 'UserService')],
      classReferences: [
        {
          id: 'h0:class-ref:1',
          sourceId: 'h0:file:src/a.ts',
          refKind: 'construction',
          className: 'UserService',
          importedFrom: './service',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 3, endLine: 3 },
        },
        {
          id: 'h0:class-ref:2',
          sourceId: 'h0:file:src/a.ts',
          refKind: 'import',
          className: 'UserService',
          importedFrom: './service',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 1, endLine: 1 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    expect(result.edges.filter((e) => e.properties.usage === 'import')).toHaveLength(0);
    expect(result.edges.filter((e) => e.properties.usage === 'construction')).toHaveLength(1);
  });

  it('carries the import’s local alias onto the edge as `via`', () => {
    const repo = createMinimalParsedRepo({
      classes: [classIn('src/service.ts', 'UserService')],
      classReferences: [
        {
          id: 'h0:class-ref:1',
          sourceId: 'h0:file:src/a.ts',
          refKind: 'import',
          className: 'UserService',
          localName: 'Svc',
          importedFrom: './service',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 1, endLine: 1 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const edges = result.edges.filter((e) => e.properties.usage === 'import');
    expect(edges).toHaveLength(1);
    expect(edges[0].properties.via).toBe('Svc');
  });

  it('never links a construction or import reference to a same-named enum', () => {
    const repo = createMinimalParsedRepo({
      enums: [enumNode('h0:enum:src/service.ts:UserService', 'UserService', 'src/service.ts')],
      functions: [fn('h0:function:src/a.ts:build', 'build', {})],
      classReferences: [
        {
          id: 'h0:class-ref:1',
          sourceId: 'h0:function:src/a.ts:build',
          refKind: 'construction',
          className: 'UserService',
          declaringFile: 'src/service.ts',
          location: { filePath: 'src/a.ts', startLine: 4, endLine: 4 },
        },
      ],
    });
    const result = transformParsedRepo(repo);
    expect(result.edges.filter((e) => e.properties.usage === 'construction')).toHaveLength(0);
  });
});

describe('EXTENDS / IMPLEMENTS_INTERFACE edges', () => {
  const base = cls('h0:class:a:Base', 'Base');
  const port = iface('h0:interface:a:Port', 'Port');

  it('emits EXTENDS and IMPLEMENTS_INTERFACE for heritage bound to a declaring node', () => {
    const worker = { ...cls('h0:class:a:Worker', 'Worker'), extends: { name: 'Base', resolvedId: base.id } };
    worker.implements = [{ name: 'Port', resolvedId: port.id }];
    const result = transformParsedRepo(createMinimalParsedRepo({ classes: [base, worker], interfaces: [port] }));

    const extendsEdge = result.edges.find((e) => e.type === 'EXTENDS');
    expect(extendsEdge).toMatchObject({ sourceId: worker.id, targetId: base.id, confidence: 1.0 });
    const implEdge = result.edges.find((e) => e.type === 'IMPLEMENTS_INTERFACE');
    expect(implEdge).toMatchObject({ sourceId: worker.id, targetId: port.id, confidence: 1.0 });
    // The by-name fallback is for UNBOUND heritage only — a bound clause must not be counted twice
    // (`explain` sums a class's usages and its extensions).
    expect(
      result.edges.filter(
        (e) => e.type === 'USES_TYPE' && ['extends', 'implements'].includes(e.properties.usage as string),
      ),
    ).toHaveLength(0);
  });

  it('emits EXTENDS for a bound interface extends clause, one edge per entry', () => {
    const a = iface('h0:interface:a:A', 'A');
    const b = iface('h0:interface:a:B', 'B');
    const c = { ...iface('h0:interface:a:C', 'C'), extends: [{ name: 'A', resolvedId: a.id }, { name: 'B' }] };
    const result = transformParsedRepo(createMinimalParsedRepo({ interfaces: [a, b, c] }));

    const extendsEdges = result.edges.filter((e) => e.type === 'EXTENDS');
    expect(extendsEdges).toHaveLength(1);
    expect(extendsEdges[0]).toMatchObject({ sourceId: c.id, targetId: a.id });
    // The unbound entry keeps the by-name usage so the dependency still shows.
    const byName = result.edges.find((e) => e.type === 'USES_TYPE' && e.sourceId === c.id);
    expect(byName).toMatchObject({ targetId: b.id, properties: { usage: 'extends' } });
  });

  it('falls back to a by-name USES_TYPE usage when heritage carries no bound id', () => {
    const worker = { ...cls('h0:class:a:Worker', 'Worker'), extends: { name: 'Base' } };
    worker.implements = [{ name: 'Port' }];
    const result = transformParsedRepo(createMinimalParsedRepo({ classes: [base, worker], interfaces: [port] }));

    expect(result.edges.filter((e) => e.type === 'EXTENDS')).toHaveLength(0);
    expect(result.edges.filter((e) => e.type === 'IMPLEMENTS_INTERFACE')).toHaveLength(0);
    const usages = result.edges.filter((e) => e.type === 'USES_TYPE' && e.sourceId === worker.id);
    expect(usages.map((e) => [e.properties.usage, e.targetId]).sort()).toEqual([
      ['extends', base.id],
      ['implements', port.id],
    ]);
  });

  it('marks an unresolved by-name heritage match ambiguous, at reduced confidence', () => {
    // The parse could not prove which `Base` this is; the sole same-named declaration is a
    // plausible match, not a verified one — same discipline as a name-matched member access.
    const worker = { ...cls('h0:class:a:Worker', 'Worker'), extends: { name: 'Base' } };
    const result = transformParsedRepo(createMinimalParsedRepo({ classes: [base, worker] }));

    const usage = result.edges.find((e) => e.type === 'USES_TYPE' && e.sourceId === worker.id)!;
    expect(usage).toMatchObject({ targetId: base.id, confidence: 0.5, properties: { ambiguous: true } });
  });

  it('emits NO by-name edge for a heritage base proven external, whatever shares its name', () => {
    // `class Widget extends Component` where `Component` came from an npm package: the local
    // `Component` is a different symbol, so a name match would fabricate the hierarchy outright.
    const local = cls('h0:class:a:Component', 'Component');
    const widget = { ...cls('h0:class:a:Widget', 'Widget'), extends: { name: 'Component', external: true as const } };
    const iPort = {
      ...iface('h0:interface:a:Impl', 'Impl'),
      extends: [{ name: 'Component', external: true as const }],
    };
    const widgetImpl = {
      ...cls('h0:class:a:Widget2', 'Widget2'),
      implements: [{ name: 'Component', external: true as const }],
    };
    const result = transformParsedRepo(
      createMinimalParsedRepo({ classes: [local, widget, widgetImpl], interfaces: [iPort] }),
    );

    expect(result.edges.filter((e) => e.type === 'EXTENDS')).toHaveLength(0);
    expect(
      result.edges.filter(
        (e) => e.type === 'USES_TYPE' && ['extends', 'implements'].includes(e.properties.usage as string),
      ),
    ).toHaveLength(0);
  });

  it('mirrors the bound heritage onto the class and interface node properties', () => {
    const worker = { ...cls('h0:class:a:Worker', 'Worker'), extends: { name: 'Base', resolvedId: base.id } };
    worker.implements = [{ name: 'Port', resolvedId: port.id }];
    const result = transformParsedRepo(createMinimalParsedRepo({ classes: [base, worker], interfaces: [port] }));

    const node = result.nodes.find((n) => n.type === 'class' && n.name === 'Worker')!;
    expect(node.properties.extendsName).toBe('Base');
    expect(node.properties.extendsId).toBe(base.id);
    expect(node.properties.implements).toEqual([{ name: 'Port', resolvedId: port.id }]);
  });
});

describe('transformFile - target attribution passthrough', () => {
  it('passes FileNode.target into the file node properties when present', () => {
    const repo = createMinimalParsedRepo({
      files: [
        {
          id: FILE_ID,
          versionedId: `${FILE_ID}@v`,
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'h0:package:root',
          language: 'typescript',
          contentHash: 'h',
          target: 'web',
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const node = result.nodes.find((n) => n.type === 'file' && n.id === FILE_ID);
    expect(node).toBeDefined();
    expect(node!.properties.target).toBe('web');
  });

  it('leaves target undefined in properties for single-target parses', () => {
    const repo = createMinimalParsedRepo({
      files: [
        {
          id: FILE_ID,
          versionedId: `${FILE_ID}@v`,
          path: 'src/a.ts',
          extension: '.ts',
          packageId: 'h0:package:root',
          language: 'typescript',
          contentHash: 'h',
        },
      ],
    });
    const result = transformParsedRepo(repo);
    const node = result.nodes.find((n) => n.type === 'file' && n.id === FILE_ID);
    expect(node).toBeDefined();
    expect(node!.properties.target).toBeUndefined();
  });
});

describe('transformExternalCall', () => {
  const extLoc = { filePath: 'src/a.ts', startLine: 7, endLine: 7 };

  it('persists grpc service/method from the target descriptor', () => {
    const ec: ExternalCallEdge = {
      id: 'ext-grpc',
      versionedId: 'ext-grpc@v',
      callerId: 'h0:fn:caller',
      serviceName: 'billing',
      method: 'Charge',
      location: extLoc,
      targetDescriptor: { protocol: 'grpc', grpc: { service: 'billing.Billing', method: 'Charge' } },
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ externalCalls: [ec] }));
    const node = result.nodes.find((n) => n.id === 'ext-grpc');
    expect(node?.properties.protocol).toBe('grpc');
    expect(node?.properties.grpcService).toBe('billing.Billing');
    expect(node?.properties.grpcMethod).toBe('Charge');
  });

  it('persists graphql operation type/name from the target descriptor', () => {
    const ec: ExternalCallEdge = {
      id: 'ext-gql',
      versionedId: 'ext-gql@v',
      callerId: 'h0:fn:caller',
      serviceName: 'gateway',
      method: 'createUser',
      location: extLoc,
      targetDescriptor: {
        protocol: 'graphql',
        graphql: { operationType: 'mutation', operationName: 'createUser' },
      },
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ externalCalls: [ec] }));
    const node = result.nodes.find((n) => n.id === 'ext-gql');
    expect(node?.properties.graphqlOperationType).toBe('mutation');
    expect(node?.properties.graphqlOperationName).toBe('createUser');
  });

  it('falls back to the destination token when no resolved literal is present', () => {
    const ec: ExternalCallEdge = {
      id: 'ext-msg-ref',
      versionedId: 'ext-msg-ref@v',
      callerId: 'h0:fn:caller',
      serviceName: 'events',
      method: 'emit',
      location: extLoc,
      targetDescriptor: { protocol: 'messaging', messaging: { system: 'kafka', destination: 'user-events' } },
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ externalCalls: [ec] }));
    const node = result.nodes.find((n) => n.id === 'ext-msg-ref');
    expect(node?.properties.messagingDestination).toBe('user-events');
    expect(node?.properties.messagingDestinationRef).toBe('user-events');
  });

  it('persists generic messaging system, resolved destination, and source reference', () => {
    const ec: ExternalCallEdge = {
      id: 'ext-pubsub',
      versionedId: 'ext-pubsub@v',
      callerId: 'h0:fn:caller',
      serviceName: 'gcp-pubsub',
      method: 'publish',
      location: extLoc,
      targetDescriptor: {
        protocol: 'messaging',
        messaging: {
          system: 'gcp-pubsub',
          destination: 'Topics.USER_CREATED',
          destinationValue: 'user.created',
        },
      },
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ externalCalls: [ec] }));
    const node = result.nodes.find((n) => n.id === 'ext-pubsub');
    expect(node?.properties).toMatchObject({
      protocol: 'messaging',
      messagingSystem: 'gcp-pubsub',
      messagingDestination: 'user.created',
      messagingDestinationRef: 'Topics.USER_CREATED',
    });
  });

  it('persists IPC as an electron-ipc messaging address', () => {
    const ec: ExternalCallEdge = {
      id: 'ext-ipc',
      versionedId: 'ext-ipc@v',
      callerId: 'h0:fn:caller',
      serviceName: 'desktop-main',
      method: 'invoke',
      location: extLoc,
      targetDescriptor: { protocol: 'ipc', ipc: { channel: 'config:load', direction: 'invoke' } },
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ externalCalls: [ec] }));
    const node = result.nodes.find((n) => n.id === 'ext-ipc');
    expect(node?.properties).toMatchObject({
      protocol: 'ipc',
      messagingSystem: 'electron-ipc',
      messagingDestination: 'config:load',
      messagingDestinationRef: 'config:load',
      ipcDirection: 'invoke',
    });
  });

  it('persists the SCIP moniker package + descriptor', () => {
    const ec: ExternalCallEdge = {
      id: 'ext-mon',
      versionedId: 'ext-mon@v',
      callerId: 'h0:fn:caller',
      serviceName: 'demo-calculations',
      method: 'dailySummaries',
      location: extLoc,
      moniker: {
        packageName: '@sample/demo-api-client',
        descriptor: 'src/`index.d.ts`/CalculationsClient#dailySummaries().',
      },
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ externalCalls: [ec] }));
    const node = result.nodes.find((n) => n.id === 'ext-mon');
    expect(node?.properties.monikerPackage).toBe('@sample/demo-api-client');
    expect(node?.properties.monikerDescriptor).toBe('src/`index.d.ts`/CalculationsClient#dailySummaries().');
  });

  it('persists the dynamic-dispatch method name', () => {
    const ec: ExternalCallEdge = {
      id: 'ext-dyn',
      versionedId: 'ext-dyn@v',
      callerId: 'h0:fn:caller',
      serviceName: 'sample-management-api',
      sdkName: '@sample/management-api-client',
      method: 'PERFORMAPIREQUEST',
      dispatchMethod: 'listCompanyBookings',
      location: extLoc,
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ externalCalls: [ec] }));
    const node = result.nodes.find((n) => n.id === 'ext-dyn');
    expect(node?.properties.dispatchMethod).toBe('listCompanyBookings');
  });
});

describe('transformFunction moniker round-trip', () => {
  it('writes monikerPackage/monikerDescriptor to properties when fn.moniker is set', () => {
    const fnNode: FunctionNode = {
      id: 'h0:function:a:getUser',
      versionedId: 'h0:function:a:getUser@v',
      kind: 'function',
      name: 'getUser',
      fileId: FILE_ID,
      isAsync: false,
      isGenerator: false,
      parameters: [],
      isExported: true,
      location: LOC,
      moniker: {
        packageName: '@myorg/users-sdk',
        descriptor: 'src/`users.d.ts`/UsersClient#getUser().',
      },
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ functions: [fnNode] }));
    const node = result.nodes.find((n) => n.type === 'function' && n.name === 'getUser');
    expect(node).toBeDefined();
    expect(node!.properties.monikerPackage).toBe('@myorg/users-sdk');
    expect(node!.properties.monikerDescriptor).toBe('src/`users.d.ts`/UsersClient#getUser().');
  });

  it('writes undefined monikerPackage/monikerDescriptor when fn.moniker is absent', () => {
    const fnNode: FunctionNode = {
      id: 'h0:function:a:noop',
      versionedId: 'h0:function:a:noop@v',
      kind: 'function',
      name: 'noop',
      fileId: FILE_ID,
      isAsync: false,
      isGenerator: false,
      parameters: [],
      isExported: true,
      location: LOC,
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ functions: [fnNode] }));
    const node = result.nodes.find((n) => n.type === 'function' && n.name === 'noop');
    expect(node).toBeDefined();
    expect(node!.properties.monikerPackage).toBeUndefined();
    expect(node!.properties.monikerDescriptor).toBeUndefined();
  });
});

describe('transformFunction synthesis provenance', () => {
  it('persists fn.synthesized on the Function node', () => {
    const fnNode: FunctionNode = {
      id: 'h0:function:app/models/company.rb:employees',
      versionedId: 'h0:function:app/models/company.rb:employees@v',
      kind: 'method',
      name: 'employees',
      fileId: FILE_ID,
      isAsync: false,
      isGenerator: false,
      parameters: [],
      isExported: true,
      location: LOC,
      synthesized: 'ruby-association',
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ functions: [fnNode] }));
    const node = result.nodes.find((n) => n.type === 'function' && n.name === 'employees');
    expect(node!.properties.synthesized).toBe('ruby-association');
  });

  it('must NOT write the key for a declared function', () => {
    const fnNode: FunctionNode = {
      id: 'h0:function:app/models/company.rb:declared',
      versionedId: 'h0:function:app/models/company.rb:declared@v',
      kind: 'method',
      name: 'declared',
      fileId: FILE_ID,
      isAsync: false,
      isGenerator: false,
      parameters: [],
      isExported: true,
      location: LOC,
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ functions: [fnNode] }));
    const node = result.nodes.find((n) => n.type === 'function' && n.name === 'declared');
    expect(Object.hasOwn(node!.properties, 'synthesized')).toBe(false);
  });
});

describe('transformEntity - DB structure persistence', () => {
  const entityNode: EntityNode = {
    id: 'h0:entity:src/a.ts:User',
    versionedId: 'h0:entity:src/a.ts:User@v',
    kind: 'entity',
    name: 'User',
    fileId: FILE_ID,
    ormType: 'typeorm',
    tableName: 'users',
    fields: [
      {
        name: 'id',
        columnName: 'id',
        type: { text: 'string' },
        dbType: 'uuid',
        isPrimaryKey: true,
        isNullable: false,
        isUnique: true,
        isGenerated: true,
      },
      {
        name: 'email',
        columnName: 'email_address',
        type: { text: 'string' },
        isPrimaryKey: false,
        isNullable: false,
        isUnique: true,
        isGenerated: false,
      },
    ],
    relations: [{ name: 'posts', type: 'one-to-many', targetEntityName: 'Post', joinColumn: 'user_id' }],
    location: LOC,
  };

  it('persists fields, relations, and indexes into the entity node properties', () => {
    const result = transformParsedRepo(createMinimalParsedRepo({ entities: [entityNode] }));
    const node = result.nodes.find((n) => n.type === 'entity' && n.name === 'User');

    expect(node).toBeDefined();
    expect(node!.properties.tableName).toBe('users');
    // The schema arrays are the core EntityField/EntityRelation shapes verbatim,
    // so describe_db_schema can read them back without a separate column store.
    expect(node!.properties.fields).toEqual(entityNode.fields);
    expect(node!.properties.relations).toEqual(entityNode.relations);
    expect(node!.properties.indexes).toBeUndefined();
  });

  it('deduplicates repeated node ids keeping the first occurrence and reporting them', () => {
    // Legacy route ids hashed without the declaring file: two router files
    // with the same path+component collide into one id. SQLite upserted over
    // it silently; Ladybug rejects the duplicate insert — the transformer now
    // keeps the first and reports the id.
    const routeId = 'h0:route:deadbeef';
    const routes = [
      {
        id: routeId,
        path: '/',
        componentName: 'HomePage',
        isLazy: false,
        location: { filePath: 'src/routes/A.tsx', startLine: 1, endLine: 1 },
      },
      {
        id: routeId,
        path: '/',
        componentName: 'HomePage',
        isLazy: false,
        location: { filePath: 'src/routes/B.tsx', startLine: 1, endLine: 1 },
      },
    ];
    const result = transformParsedRepo(createMinimalParsedRepo({ routes } as unknown as Partial<ParsedRepo>));

    const routeNodes = result.nodes.filter((n) => n.id === routeId);
    expect(routeNodes).toHaveLength(1);
    expect(routeNodes[0]!.filePath).toBe('src/routes/A.tsx');
    expect(result.duplicateNodeIds).toEqual([routeId]);
  });

  it('synthesizes a file node (plus repo containment) for an entity in an unparsed file', () => {
    // Prisma-schema shape: the entity's file is not a parsed source file, so
    // repo.files has no node for it. Endpoint-enforcing backends (Ladybug REL
    // tables) reject the CONTAINS_ENTITY edge unless the file node exists.
    const schemaEntity: EntityNode = {
      ...entityNode,
      id: 'h0:entity:prisma/schema.prisma:User',
      versionedId: 'h0:entity:prisma/schema.prisma:User@v',
      fileId: 'h0:file:prisma/schema.prisma',
      location: { filePath: 'prisma/schema.prisma', startLine: 1, endLine: 10 },
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ entities: [schemaEntity] }));

    const fileNode = result.nodes.find((n) => n.id === schemaEntity.fileId);
    expect(fileNode).toBeDefined();
    expect(fileNode!.type).toBe('file');
    expect(fileNode!.properties.path).toBe('prisma/schema.prisma');
    expect(fileNode!.properties.synthesized).toBe(true);

    // Full containment chain: repo -> file -> entity, with every edge endpoint present.
    const nodeIds = new Set(result.nodes.map((n) => n.id));
    const containsFile = result.edges.find(
      (e) => e.type === 'CONTAINS_FILE' && e.targetId === schemaEntity.fileId && e.sourceId === REPO_ID,
    );
    const containsEntity = result.edges.find(
      (e) => e.type === 'CONTAINS_ENTITY' && e.sourceId === schemaEntity.fileId && e.targetId === schemaEntity.id,
    );
    expect(containsFile).toBeDefined();
    expect(containsEntity).toBeDefined();
    for (const edge of result.edges) {
      expect(nodeIds.has(edge.sourceId), `dangling source ${edge.sourceId} on ${edge.id}`).toBe(true);
      expect(nodeIds.has(edge.targetId), `dangling target ${edge.targetId} on ${edge.id}`).toBe(true);
    }
  });

  it('persists enum members (values) into the enum node properties', () => {
    const enumNode = {
      id: 'h0:enum:src/a.ts:EventType',
      versionedId: 'h0:enum:src/a.ts:EventType@v',
      kind: 'enum' as const,
      name: 'EventType',
      fileId: FILE_ID,
      isExported: true,
      isConst: false,
      members: [{ name: 'ShiftsPublished', value: 'shifts:published' }, { name: 'Auto' }],
      location: LOC,
    };
    const result = transformParsedRepo(createMinimalParsedRepo({ enums: [enumNode] }));
    const node = result.nodes.find((n) => n.type === 'enum' && n.name === 'EventType');

    expect(node).toBeDefined();
    expect(node!.properties.members).toEqual(enumNode.members);
  });
});

describe('transformParsedRepo package-linker facts', () => {
  it('stores only unresolved imports with named symbols on their source File node', () => {
    const sourceFile = {
      id: FILE_ID,
      versionedId: `${FILE_ID}@v`,
      path: 'src/a.ts',
      extension: '.ts',
      packageId: 'h0:package:consumer',
      language: 'typescript',
      contentHash: 'source-hash',
    };
    const targetFile = {
      ...sourceFile,
      id: 'h0:file:src/local.ts',
      versionedId: 'h0:file:src/local.ts@v',
      path: 'src/local.ts',
      contentHash: 'target-hash',
    };
    const result = transformParsedRepo(
      createMinimalParsedRepo({
        files: [sourceFile, targetFile],
        imports: [
          {
            id: 'external-import',
            sourceFileId: sourceFile.id,
            moduleSpecifier: '@acme/acme-api-client',
            isTypeOnly: true,
            importKind: 'named',
            importedNames: [{ name: 'BookingTypes', alias: 'BookingKind' }],
          },
          {
            id: 'internal-import',
            sourceFileId: sourceFile.id,
            targetFileId: targetFile.id,
            moduleSpecifier: './local',
            isTypeOnly: false,
            importKind: 'named',
            importedNames: [{ name: 'localValue' }],
          },
          {
            id: 'unresolved-relative-import',
            sourceFileId: sourceFile.id,
            moduleSpecifier: '../unresolved-local',
            isTypeOnly: false,
            importKind: 'named',
            importedNames: [{ name: 'unresolvedLocalValue' }],
          },
          {
            id: 'side-effect-import',
            sourceFileId: sourceFile.id,
            moduleSpecifier: 'reflect-metadata',
            isTypeOnly: false,
            importKind: 'side-effect',
          },
        ],
      }),
    );

    expect(result.nodes.find((node) => node.id === sourceFile.id)?.properties.packageImports).toEqual([
      {
        id: 'external-import',
        moduleSpecifier: '@acme/acme-api-client',
        isTypeOnly: true,
        importKind: 'named',
        importedNames: [{ name: 'BookingTypes', alias: 'BookingKind' }],
      },
    ]);
  });
});

describe('CALLS edge provenance and confidence', () => {
  const call = (id: string, provenance?: 'scip' | 'di' | 'iface-impl') => ({
    id,
    callerId: `${REPO_ID}:function:src/a.ts:caller`,
    calleeId: `${REPO_ID}:function:src/a.ts:callee`,
    calleeExpression: 'callee()',
    isMethodCall: false,
    location: LOC,
    ...(provenance ? { provenance } : {}),
  });

  it('carries the resolution provenance onto every CALLS edge', () => {
    const result = transformParsedRepo(createMinimalParsedRepo({ calls: [call('c1', 'scip')] }));
    const edge = result.edges.find((e) => e.id === 'c1')!;
    expect(edge.properties.provenance).toBe('scip');
  });

  it('stores an inferred interface-dispatch binding at reduced confidence and flags it', () => {
    const result = transformParsedRepo(createMinimalParsedRepo({ calls: [call('c1', 'iface-impl')] }));
    const edge = result.edges.find((e) => e.id === 'c1')!;
    expect(edge.confidence).toBe(0.5);
    expect(edge.properties.provenanceInferred).toBe(true);
    expect(edge.properties.provenance).toBe('iface-impl');
  });

  it('leaves every other lineage at full confidence and unflagged', () => {
    const result = transformParsedRepo(
      createMinimalParsedRepo({ calls: [call('c1', 'scip'), call('c2'), call('c3', 'di')] }),
    );
    for (const id of ['c1', 'c2', 'c3']) {
      const edge = result.edges.find((e) => e.id === id)!;
      expect(edge.confidence).toBe(1.0);
      expect(edge.properties.provenanceInferred).toBeUndefined();
    }
  });
});

describe('transformParsedRepo at large scale', () => {
  // Regression: edges.push(...createCallsEdges(calls)) overflowed the V8 call
  // stack for repos with ~100k+ calls (spread-args limit). Surfaced by the
  // Phase 0 graph-dataplane bench fixture (2026-08-10).
  it('does not overflow the stack on 500k calls', () => {
    const calls = Array.from({ length: 500_000 }, (_, i) => ({
      id: `call-${i}`,
      callerId: `${REPO_ID}:function:src/a.ts:caller${i % 500}`,
      calleeId: `${REPO_ID}:function:src/a.ts:callee${i % 500}`,
      calleeExpression: `callee${i % 500}()`,
      isMethodCall: false,
      location: LOC,
    }));

    const result = transformParsedRepo(createMinimalParsedRepo({ calls }));
    expect(result.edges.filter((e) => e.type === 'CALLS')).toHaveLength(500_000);
  });
});

describe('unresolved calls', () => {
  const unresolved = (calleeExpression: string, startLine = 1) => ({
    id: `call-${calleeExpression}-${startLine}`,
    callerId: `${REPO_ID}:function:src/a.ts:caller`,
    calleeExpression,
    isMethodCall: false,
    location: { ...LOC, startLine },
  });

  it('derives the trailing identifier only when the callee ends in a plain name', () => {
    const result = transformParsedRepo(
      createMinimalParsedRepo({
        calls: [
          unresolved('app.useLogger', 1),
          unresolved('recalculateDayDurations', 2),
          unresolved('logger[logLevel]', 3),
          unresolved('getHandler()', 4),
          unresolved('sql`select 1`', 5),
          unresolved('ctx?.repositories.schedules.listCompanySchedules', 6),
        ],
      }),
    );

    expect(result.unresolvedCalls.map((call) => [call.calleeExpression, call.calleeNameTail])).toEqual([
      ['app.useLogger', 'useLogger'],
      ['recalculateDayDurations', 'recalculateDayDurations'],
      ['logger[logLevel]', null],
      ['getHandler()', null],
      ['sql`select 1`', null],
      ['ctx?.repositories.schedules.listCompanySchedules', 'listCompanySchedules'],
    ]);
  });

  it('caps the stored expression at 160 chars but takes the tail from the full text', () => {
    const tail = 'dispatchToConfiguredHandler';
    const long = `${'a.'.repeat(90)}${tail}`;
    const result = transformParsedRepo(createMinimalParsedRepo({ calls: [unresolved(long)] }));

    expect(result.unresolvedCalls[0]?.calleeExpression).toHaveLength(160);
    expect(long.startsWith(result.unresolvedCalls[0]?.calleeExpression ?? '')).toBe(true);
    expect(result.unresolvedCalls[0]?.calleeNameTail).toBe(tail);
  });

  it('collapses a wrapped expression to one line and ignores resolved calls', () => {
    const result = transformParsedRepo(
      createMinimalParsedRepo({
        calls: [
          unresolved('this.client\n  .emit', 7),
          {
            id: 'resolved',
            callerId: `${REPO_ID}:function:src/a.ts:caller`,
            calleeId: `${REPO_ID}:function:src/a.ts:callee`,
            calleeExpression: 'callee',
            isMethodCall: false,
            location: LOC,
          },
        ],
      }),
    );

    expect(result.unresolvedCalls).toEqual([
      {
        callerId: `${REPO_ID}:function:src/a.ts:caller`,
        calleeExpression: 'this.client .emit',
        calleeNameTail: 'emit',
        filePath: 'src/a.ts',
        line: 7,
      },
    ]);
  });

  // Regression: calleeNameTail was `/[A-Za-z_$][A-Za-z0-9_$]*$/.exec(...)`,
  // quadratic on a long identifier-continue run followed by a non-identifier
  // terminator (measured 3.1s at 80k chars) — ParsedRepo artifacts come from
  // authenticated-but-untrusted repo content the cloud push worker parses
  // synchronously. No timing assertion needed: vitest's default test timeout
  // is the guard against a regression back to quadratic behavior.
  describe('calleeNameTail (adversarial + boundary inputs)', () => {
    it('returns null fast for a huge identifier-continue run with a non-identifier terminator', () => {
      const adversarial = `handlers["${'a'.repeat(100_000)}"]`;
      expect(calleeNameTail(adversarial)).toBeNull();
    });

    it('trims a leading digit-only prefix of the trailing run', () => {
      expect(calleeNameTail('123abc')).toBe('abc');
    });

    it('returns null when the trailing run is digits only (no identifier-start char)', () => {
      expect(calleeNameTail('foo.123')).toBeNull();
    });

    it('returns the whole string when it is one plain identifier', () => {
      expect(calleeNameTail('recalculateDayDurations')).toBe('recalculateDayDurations');
    });

    it('returns null for the empty string', () => {
      expect(calleeNameTail('')).toBeNull();
    });
  });
});
