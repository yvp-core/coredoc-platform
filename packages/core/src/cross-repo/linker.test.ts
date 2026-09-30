import { describe, it, expect } from 'vitest';
import { linkWorkspace, type ParsedRepoLike } from './linker.js';
import type { Entrypoint, ExternalCallEdge, FunctionNode } from '../types/output.js';

function httpEntrypoint(id: string, method: string, fullPath: string): Entrypoint {
  return {
    id,
    versionedId: `${id}@1`,
    type: 'http',
    handlerId: `${id}-handler`,
    location: { filePath: 'f.ts', startLine: 1, endLine: 2 },
    details: { type: 'http', method: method as never, path: fullPath, fullPath },
  } as Entrypoint;
}

function httpCall(id: string, method: string, pathTemplate: string): ExternalCallEdge {
  return {
    id,
    versionedId: `${id}@1`,
    callerId: `${id}-fn`,
    serviceName: 'svc',
    method: 'm',
    targetDescriptor: { protocol: 'http', http: { method: method as never, pathTemplate } },
    location: { filePath: 'c.ts', startLine: 1, endLine: 1 },
  } as ExternalCallEdge;
}

function repo(id: string, name: string, entrypoints: Entrypoint[], externalCalls: ExternalCallEdge[]): ParsedRepoLike {
  return { id, name, entrypoints, externalCalls };
}

describe('linkWorkspace', () => {
  it('emits a RESOLVES_TO LinkEdge for a direct HTTP cross-repo call with chain provenance', () => {
    const web = repo('r-web', 'web', [], [httpCall('c1', 'GET', '/users/:id')]);
    const users = repo('r-users', 'users-svc', [httpEntrypoint('ep-users', 'GET', '/users/:id')], []);

    const result = linkWorkspace([web, users]);

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.id).toBe('resolve:c1:ep-users');
    expect(edge.sourceId).toBe('c1');
    expect(edge.targetId).toBe('ep-users');
    expect(edge.confidence).toBeGreaterThan(0);
    expect(edge.properties.sourceRepoName).toBe('web');
    expect(edge.properties.targetRepoName).toBe('users-svc');
    expect(Array.isArray(edge.properties.chain)).toBe(true);
    expect((edge.properties.chain as unknown[]).length).toBe(1);
  });

  it('does not emit a self cross-repo edge when a repo resolves to its own entrypoint', () => {
    // Gateway/proxy shape: one repo BOTH serves GET /industries AND makes an egress to
    // /industries. With no service hint the HTTP hop runs unscoped and self-matches; the
    // self-edge guard must drop it (an intra-repo call is not a cross-repo edge).
    const gw = repo(
      'r-gw',
      'gateway',
      [httpEntrypoint('ep-gw', 'GET', '/industries')],
      [httpCall('c1', 'GET', '/industries')],
    );
    const result = linkWorkspace([gw]);
    expect(result.edges).toHaveLength(0);
  });

  it('buckets an unmatched call into unresolved and reports honest metrics', () => {
    const web = repo('r-web', 'web', [], [httpCall('c1', 'GET', '/users/:id'), httpCall('c2', 'GET', '/orphan')]);
    const users = repo('r-users', 'users-svc', [httpEntrypoint('ep-users', 'GET', '/users/:id')], []);

    const result = linkWorkspace([web, users]);

    expect(result.edges).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.sourceId).toBe('c2');
    expect(result.metrics.total).toBe(2);
    expect(result.metrics.resolved).toBe(1);
    expect(result.metrics.unresolvableExcluded).toBe(0);
    expect(result.metrics.rate).toBeCloseTo(0.5, 5);
  });

  it('excludes calls to override.unresolvableServices from the denominator', () => {
    const web = repo(
      'r-web',
      'web',
      [],
      [
        { ...httpCall('c1', 'GET', '/users/:id'), serviceName: 'redis' } as ExternalCallEdge,
        httpCall('c2', 'GET', '/users/:id'),
      ],
    );
    const users = repo('r-users', 'users-svc', [httpEntrypoint('ep-users', 'GET', '/users/:id')], []);

    const result = linkWorkspace([web, users], {
      $schemaVersion: 1,
      project: 'p',
      services: [],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: ['redis'],
    });

    expect(result.metrics.total).toBe(2);
    expect(result.metrics.unresolvableExcluded).toBe(1);
    expect(result.metrics.resolved).toBe(1);
    // denominator = total - excluded = 1, so rate = 1/1
    expect(result.metrics.rate).toBeCloseTo(1, 5);
  });
});

// =============================================================================
// C3 — end-to-end ground-truth fixtures (mirror the demo fleet shape):
//   repo NAMES differ from service HINTS, and a gateway has an httpPrefix.
// These exercise the two wiring bugs (C2: prefix dropped; C1: service hint used
// as repo name without translation, no unscoped fallback).
// =============================================================================

/** Build an ExternalCallEdge with an explicit targetService hint on its descriptor. */
function httpCallToService(id: string, method: string, pathTemplate: string, targetService: string): ExternalCallEdge {
  return {
    id,
    versionedId: `${id}@1`,
    callerId: `${id}-fn`,
    serviceName: targetService,
    method: 'm',
    targetDescriptor: { protocol: 'http', http: { method: method as never, pathTemplate }, targetService },
    location: { filePath: 'c.ts', startLine: 1, endLine: 1 },
  } as ExternalCallEdge;
}

/** A repo that owns a gateway prefix (RepoConfig.httpPrefix). */
function gatewayRepo(
  id: string,
  name: string,
  httpPrefix: string,
  entrypoints: Entrypoint[],
  externalCalls: ExternalCallEdge[] = [],
): ParsedRepoLike {
  return { id, name, httpPrefix, entrypoints, externalCalls };
}

describe('linkWorkspace — C3 ground-truth fixtures', () => {
  it('(a) resolves a UI call to a prefixed gateway entrypoint via httpPrefix strip', () => {
    // UI issues the UNprefixed path; gateway repo's entrypoint lives under the
    // /v3/management/shifts prefix. Repo name 'shared-packages' differs from any hint.
    const ui = repo(
      'r-admin',
      'sample-admin',
      [],
      [httpCallToService('c-shift', 'POST', '/shifts/:id/analyze-conflicts', 'shifts')],
    );
    // Entrypoint = httpPrefix + caller path (the prefix-join semantics matchHttp uses).
    const gateway = gatewayRepo('r-gw', 'shared-packages', '/v3/management/shifts', [
      httpEntrypoint('ep-gw', 'POST', '/v3/management/shifts/shifts/:id/analyze-conflicts'),
    ]);

    const result = linkWorkspace([ui, gateway], {
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'shifts', repo: 'shared-packages', aliases: [] }],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-shift');
    expect(edge.targetId).toBe('ep-gw');
    expect(edge.properties.targetRepoName).toBe('shared-packages');
  });

  it('(b) resolves a service-hint call through override.services service→repo translation', () => {
    // Consumer's targetService is the SERVICE HINT 'calculations' (NOT a repo name);
    // the target entrypoint lives in a repo named 'demo-calculations'.
    const consumer = repo(
      'r-core',
      'demo-core',
      [],
      [httpCallToService('c-calc', 'GET', '/daily-summaries/:companyId', 'calculations')],
    );
    const calc = repo(
      'r-calc',
      'demo-calculations',
      [httpEntrypoint('ep-calc', 'GET', '/daily-summaries/:companyId')],
      [],
    );

    const result = linkWorkspace([consumer, calc], {
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'calculations', repo: 'demo-calculations', aliases: ['calc'] }],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-calc');
    expect(edge.targetId).toBe('ep-calc');
    expect(edge.properties.targetRepoName).toBe('demo-calculations');
  });

  it('(c) recovers a LOCAL-client SDK call via the declarative sdkMapping fallback when the symbol hop misses', () => {
    // Consumer issues an SDK-mediated call through a client class defined LOCALLY
    // (sdkName = 'local:SampleApiClient', method = 'listActivities'). The call
    // carries NO moniker (local moniker → no cross-repo join key) and NO http
    // descriptor, so BOTH the direct protocol hop and the symbol hop miss. Only
    // the declarative sdkMapping fallback — keyed on (sdkClass, method) → route —
    // can resolve it onto the target entrypoint.
    const consumer: ParsedRepoLike = {
      id: 'r-consumer',
      name: 'sample-client-admin-api',
      entrypoints: [],
      externalCalls: [
        {
          id: 'c-sdk',
          versionedId: 'c-sdk@1',
          callerId: 'c-sdk-fn',
          serviceName: 'projects',
          sdkName: 'local:SampleApiClient',
          method: 'listActivities',
          location: { filePath: 'c.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
      ],
    };
    const projects = repo(
      'r-projects',
      'sample-projects',
      [httpEntrypoint('ep-activities', 'POST', '/v2/management/projects/companies/:companyUuid/activities')],
      [],
    );

    const result = linkWorkspace([consumer, projects], {
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'projects', repo: 'sample-projects', aliases: [] }],
      sdkMappings: [
        {
          sdkPackage: '@sample/management-api-client',
          sdkClass: 'SampleApiClient',
          sdkMethod: 'listActivities',
          targetService: 'projects',
          http: {
            method: 'POST',
            pathTemplate: '/v2/management/projects/companies/:companyUuid/activities',
            pathParams: [],
          },
        },
      ],
      pathRewriteRules: [],
      unresolvableServices: [],
    });

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-sdk');
    expect(edge.targetId).toBe('ep-activities');
    expect(edge.properties.targetRepoName).toBe('sample-projects');
    // Provenance: the (class, method) → route step came from the declarative override.
    expect(edge.properties.via).toContain('override');
  });

  it('(c-negative) does NOT recover the local-client call when no sdkMapping row is declared', () => {
    // Same shape as (c) but with an EMPTY sdkMappings table — the fallback must be
    // a no-op, so the call stays unresolved (proves the fallback, not some other
    // tier, is what resolves it in (c)).
    const consumer: ParsedRepoLike = {
      id: 'r-consumer',
      name: 'sample-client-admin-api',
      entrypoints: [],
      externalCalls: [
        {
          id: 'c-sdk',
          versionedId: 'c-sdk@1',
          callerId: 'c-sdk-fn',
          serviceName: 'projects',
          sdkName: 'local:SampleApiClient',
          method: 'listActivities',
          location: { filePath: 'c.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
      ],
    };
    const projects = repo(
      'r-projects',
      'sample-projects',
      [httpEntrypoint('ep-activities', 'POST', '/v2/management/projects/companies/:companyUuid/activities')],
      [],
    );

    const result = linkWorkspace([consumer, projects], {
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'projects', repo: 'sample-projects', aliases: [] }],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });

    expect(result.edges).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.sourceId).toBe('c-sdk');
  });

  it('(c-unscoped) recovers a sdkMapping-fallback call whose targetService does NOT map to a repo, by route path UNSCOPED', () => {
    // Bug 1: a local-client SDK call (no moniker, no http descriptor) whose matched
    // sdkMapping row carries a `targetService` that is NOT declared in services[],
    // so it cannot translate to a repo. The fallback must still resolve it by matching
    // the row's pathTemplate UNSCOPED across all repos — a single global path match
    // resolves (exactly like the C1 direct-call fallback). The target entrypoint lives
    // in a repo whose NAME differs from the (untranslatable) service hint.
    const consumer: ParsedRepoLike = {
      id: 'r-consumer',
      name: 'sample-integrations-api',
      entrypoints: [],
      externalCalls: [
        {
          id: 'c-sdk',
          versionedId: 'c-sdk@1',
          callerId: 'c-sdk-fn',
          serviceName: 'workflows',
          sdkName: 'app/lib/sample-api-client', // local module path: matches neither class nor package
          method: 'listWorkflows',
          location: { filePath: 'c.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
      ],
    };
    // The route lives in a gateway repo under its httpPrefix; the entrypoint's
    // fullPath carries the prefix, so the index keys it under the full route.
    const gateway = gatewayRepo('r-gw', 'shared-packages', '/v3/management/workflows', [
      httpEntrypoint('ep-wf', 'GET', '/v3/management/workflows/companies/{companyUuid}/workflows'),
    ]);

    const result = linkWorkspace([consumer, gateway], {
      $schemaVersion: 1,
      project: 'demo',
      // 'workflows' is intentionally absent from services[] — it cannot translate to a repo.
      services: [{ name: 'projects', repo: 'sample-projects', aliases: [] }],
      sdkMappings: [
        {
          sdkPackage: '@sample/management-api-client',
          sdkClass: 'Workflows',
          sdkMethod: 'listWorkflows',
          targetService: 'workflows', // does NOT resolve to a repo
          http: {
            method: 'GET',
            pathTemplate: '/v3/management/workflows/companies/:companyUuid/workflows',
            pathParams: [],
          },
        },
      ],
      pathRewriteRules: [],
      unresolvableServices: [],
    });

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-sdk');
    expect(edge.targetId).toBe('ep-wf');
    expect(edge.properties.targetRepoName).toBe('shared-packages');
    // Resolved through the declarative override step, then the unscoped path hop.
    expect(edge.properties.via).toBe('override+http');
  });

  it('(d-event) resolves a kafka publisher Topics.X to a consumer queue/event entrypoint Topics.X', () => {
    // Bug 2: a kafka publisher egress carries serviceName 'kafka' (the transport
    // literal) which collides with the 'kafka' infra entry in unresolvableServices.
    // It must NOT be excluded when its descriptor carries a concrete topic — the
    // topic hop matches it to a consumer queue/event entrypoint with the same
    // Topics.X key, producing a RESOLVES_TO edge with via='topic'.
    const publisher: ParsedRepoLike = {
      id: 'r-pub',
      name: 'demo-core',
      entrypoints: [],
      externalCalls: [
        {
          id: 'c-emit',
          versionedId: 'c-emit@1',
          callerId: 'c-emit-fn',
          serviceName: 'kafka', // transport literal — also listed in unresolvableServices
          method: 'emit',
          targetDescriptor: {
            protocol: 'messaging',
            messaging: { system: 'kafka', destination: 'Topics.CommuteMinutesUpdatedV1' },
          },
          location: { filePath: 'p.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
      ],
    };
    const consumer: ParsedRepoLike = {
      id: 'r-con',
      name: 'demo-calculations',
      entrypoints: [
        {
          id: 'ep-evt',
          versionedId: 'ep-evt@1',
          type: 'queue',
          handlerId: 'h',
          location: { filePath: 'f.ts', startLine: 1, endLine: 2 },
          details: { type: 'queue', system: 'kafka', topic: 'Topics.CommuteMinutesUpdatedV1', pattern: 'event' },
        } as Entrypoint,
      ],
      externalCalls: [],
    };

    const result = linkWorkspace([publisher, consumer], {
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      sdkMappings: [],
      pathRewriteRules: [],
      // 'kafka' IS declared unresolvable (raw transport handles); the topic-bearing
      // publisher must survive the exclusion on data shape and resolve by topic.
      unresolvableServices: ['kafka'],
    });

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-emit');
    expect(edge.targetId).toBe('ep-evt');
    expect(edge.properties.via).toBe('messaging');
    expect(edge.properties.sourceRepoName).toBe('demo-core');
    expect(edge.properties.targetRepoName).toBe('demo-calculations');
    // The topic-bearing publisher is NOT counted as unresolvable-excluded.
    expect(result.metrics.unresolvableExcluded).toBe(0);
    expect(result.metrics.resolved).toBe(1);
  });

  it('(d-event-negative) still excludes a topic-LESS kafka transport call as unresolvable', () => {
    // A bare kafka transport handle with no topic value remains genuine infra noise:
    // it must stay excluded from the denominator so the resolution rate stays honest.
    const pub: ParsedRepoLike = {
      id: 'r-pub',
      name: 'demo-core',
      entrypoints: [],
      externalCalls: [
        {
          id: 'c-bare',
          versionedId: 'c-bare@1',
          callerId: 'c-bare-fn',
          serviceName: 'kafka',
          method: 'connect',
          targetDescriptor: { protocol: 'messaging', messaging: { system: 'kafka', destination: '' } },
          location: { filePath: 'p.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
      ],
    };

    const result = linkWorkspace([pub], {
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: ['kafka'],
    });

    expect(result.edges).toHaveLength(0);
    expect(result.metrics.unresolvableExcluded).toBe(1);
  });

  // ===========================================================================
  // Gateway prefix-strip recovery — the final lever for the `no-entrypoint-match`
  // bucket. An SDK/http egress carries a full prefixed path; the target service
  // (NestJS setGlobalPrefix) parses its @Controller paths RELATIVE, so its
  // entrypoints sit at the BARE path. The service hint did not translate, so the
  // linker resolves the target repo from the ROUTE's own leading prefix
  // (httpPrefixByRepo, longest wins) and strips it before matching.
  // ===========================================================================

  it('(e-prefix-strip) resolves a prefixed SDK route to a BARE entrypoint via route-prefix→repo + strip', () => {
    // SDK route carries the full gateway prefix `/v3/management/assistant`. The
    // target service `assistant` is NOT declared in services[], so it cannot
    // translate to a repo. demo-assistant owns httpPrefix `/v3/management/assistant`
    // and exposes the entrypoint at the BARE relative path `/onboarding/steps`.
    const consumer = repo(
      'r-gw',
      'shared-packages',
      [],
      [httpCallToService('c-wh', 'GET', '/v3/management/assistant/onboarding/steps', 'assistant')],
    );
    const assistant = gatewayRepo('r-ai', 'demo-assistant', '/v3/management/assistant', [
      httpEntrypoint('ep-wh', 'GET', '/onboarding/steps'),
    ]);

    const result = linkWorkspace([consumer, assistant], {
      $schemaVersion: 1,
      project: 'demo',
      // 'assistant' intentionally absent — it cannot translate to a repo, so only
      // the route-prefix→repo lever can pick demo-assistant and strip its prefix.
      services: [],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-wh');
    expect(edge.targetId).toBe('ep-wh');
    expect(edge.properties.targetRepoName).toBe('demo-assistant');
    expect(edge.properties.via).toBe('http');
  });

  it('(f-no-regress) a FULL-prefix entrypoint still resolves by DIRECT match (no strip regression)', () => {
    // demo-calculations declares @Controller('/v2/management/calculations'), so its
    // entrypoint already carries the FULL prefix. A caller route at the full path
    // must resolve by the DIRECT (unstripped) match — the strip recovery must NOT
    // fire and re-route it to a bare-path miss. The repo's httpPrefix is populated
    // (so the prefix lever exists), but the direct match wins first.
    const consumer = repo(
      'r-core',
      'demo-core',
      [],
      [httpCallToService('c-calc', 'GET', '/v2/management/calculations/companies/:companyId/summary', 'calculations')],
    );
    const calc = gatewayRepo('r-calc', 'demo-calculations', '/v2/management/calculations', [
      httpEntrypoint('ep-calc', 'GET', '/v2/management/calculations/companies/:companyId/summary'),
    ]);

    const result = linkWorkspace([consumer, calc], {
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'calculations', repo: 'demo-calculations', aliases: [] }],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-calc');
    expect(edge.targetId).toBe('ep-calc');
    expect(edge.properties.targetRepoName).toBe('demo-calculations');
    expect(edge.properties.via).toBe('http');
  });

  it('(g-longest-prefix) disambiguates two repos sharing /v2/management by LONGEST matching prefix', () => {
    // Two repos share the leading `/v2/management` prefix. The route
    // `/v2/management/calculations/...` must resolve to demo-calculations via the
    // longer `/v2/management/calculations` prefix, NOT demo-reports via the
    // shorter `/v2/management/reports`, and NOT collapse to ambiguous.
    const consumer = repo(
      'r-core',
      'demo-core',
      [],
      // service hint absent so only route-prefix resolution can pick the repo.
      [httpCallToService('c-calc', 'GET', '/v2/management/calculations/daily-summaries/:id', 'calculations')],
    );
    const calc = gatewayRepo('r-calc', 'demo-calculations', '/v2/management/calculations', [
      httpEntrypoint('ep-calc', 'GET', '/daily-summaries/:id'),
    ]);
    const projects = gatewayRepo('r-proj', 'demo-reports', '/v2/management/reports', [
      httpEntrypoint('ep-proj', 'GET', '/daily-summaries/:id'),
    ]);

    const result = linkWorkspace([consumer, calc, projects], {
      $schemaVersion: 1,
      project: 'demo',
      services: [],
      sdkMappings: [],
      pathRewriteRules: [],
      unresolvableServices: [],
    });

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-calc');
    expect(edge.targetId).toBe('ep-calc');
    expect(edge.properties.targetRepoName).toBe('demo-calculations');
  });

  it('(b-variant) resolves a single-candidate match via the unscoped fallback when no service entry maps the hint', () => {
    // The hint 'calculations' has no override.services entry, so it does not
    // translate to a repo. The repo-scoped match would find nothing; the
    // unscoped fallback resolves the single global candidate.
    const consumer = repo(
      'r-core',
      'demo-core',
      [],
      [httpCallToService('c-calc', 'GET', '/daily-summaries/:companyId', 'calculations')],
    );
    const calc = repo(
      'r-calc',
      'demo-calculations',
      [httpEntrypoint('ep-calc', 'GET', '/daily-summaries/:companyId')],
      [],
    );

    const result = linkWorkspace([consumer, calc]);

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-calc');
    expect(edge.targetId).toBe('ep-calc');
  });

  // ===========================================================================
  // Dynamic-dispatch SDK egress (P1) — `performApiRequest("listCompanyBookings", …)`
  // puts the SDK method NAME in a positional string arg; the call site has no
  // static path. The parser emits `method` as the wrapper VERB ('PERFORMAPIREQUEST')
  // and carries the real method name on `dispatchMethod`. The existing sdkMapping
  // fallback must key its (package, method) lookup off `dispatchMethod`, not the
  // wrapper verb, so the call resolves to the SDK method's declared route.
  // ===========================================================================

  it('(h-dynamic-dispatch) resolves a performApiRequest dynamic-dispatch call by its dispatchMethod', () => {
    // The edge carries the wrapper verb in `method` and the SDK method name in
    // `dispatchMethod`; NO moniker and NO targetDescriptor, so the direct hop and
    // symbol hop both miss and only the sdkMapping fallback — keyed on the
    // (package, dispatchMethod) → route — can resolve it. Target repo name
    // ('sample-booking') is DISTINCT from the service hint ('bookings').
    const consumer: ParsedRepoLike = {
      id: 'r-integrations',
      name: 'sample-integrations-api',
      entrypoints: [],
      externalCalls: [
        {
          id: 'c-dyn',
          versionedId: 'c-dyn@1',
          callerId: 'c-dyn-fn',
          serviceName: 'sample-management-api',
          sdkName: '@sample/management-api-client',
          method: 'PERFORMAPIREQUEST',
          dispatchMethod: 'listCompanyBookings',
          location: { filePath: 'c.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
      ],
    };
    const booking = repo(
      'r-booking',
      'sample-booking',
      [httpEntrypoint('ep-bookings', 'GET', '/v2/management/bookings/companies/:companyUuid/company_bookings')],
      [],
    );

    const result = linkWorkspace([consumer, booking], {
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'bookings', repo: 'sample-booking', aliases: [] }],
      sdkMappings: [
        {
          sdkPackage: '@sample/management-api-client',
          sdkClass: 'ApiClient',
          sdkMethod: 'listCompanyBookings',
          targetService: 'bookings',
          http: {
            method: 'GET',
            pathTemplate: '/v2/management/bookings/companies/:companyUuid/company_bookings',
            pathParams: [],
          },
        },
      ],
      pathRewriteRules: [],
      unresolvableServices: [],
    });

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-dyn');
    expect(edge.targetId).toBe('ep-bookings');
    expect(edge.properties.targetRepoName).toBe('sample-booking');
    // Provenance: the (package, method) → route step came from the declarative override.
    expect(edge.properties.via).toContain('override');
  });

  it('(h-dynamic-dispatch-negative) does NOT resolve when the dispatchMethod is absent', () => {
    // Same shape as (h) but the edge carries ONLY the wrapper verb in `method` and
    // NO dispatchMethod. The fallback keys off `method` = 'PERFORMAPIREQUEST', which
    // matches no sdkMapping row, so the call stays unresolved — proving dispatchMethod
    // (not the wrapper verb) is what closes the gap.
    const consumer: ParsedRepoLike = {
      id: 'r-integrations',
      name: 'sample-integrations-api',
      entrypoints: [],
      externalCalls: [
        {
          id: 'c-dyn',
          versionedId: 'c-dyn@1',
          callerId: 'c-dyn-fn',
          serviceName: 'sample-management-api',
          sdkName: '@sample/management-api-client',
          method: 'PERFORMAPIREQUEST',
          location: { filePath: 'c.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
      ],
    };
    const booking = repo(
      'r-booking',
      'sample-booking',
      [httpEntrypoint('ep-bookings', 'GET', '/v2/management/bookings/companies/:companyUuid/company_bookings')],
      [],
    );

    const result = linkWorkspace([consumer, booking], {
      $schemaVersion: 1,
      project: 'demo',
      services: [{ name: 'bookings', repo: 'sample-booking', aliases: [] }],
      sdkMappings: [
        {
          sdkPackage: '@sample/management-api-client',
          sdkClass: 'ApiClient',
          sdkMethod: 'listCompanyBookings',
          targetService: 'bookings',
          http: {
            method: 'GET',
            pathTemplate: '/v2/management/bookings/companies/:companyUuid/company_bookings',
            pathParams: [],
          },
        },
      ],
      pathRewriteRules: [],
      unresolvableServices: [],
    });

    expect(result.edges).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.sourceId).toBe('c-dyn');
  });

  it("(d) disambiguates an ambiguous SDK (package, method) through the caller's CALLS edge, not a coin-flip override row", () => {
    // Gateway method calls the in-workspace SDK's `update`; the SDK declares TWO
    // `update` methods under one package, so both the moniker structural index and
    // (post-guard) the declarative package tier refuse the key. The gateway's own
    // intra-repo CALLS edge names the exact SDK method node, whose egress carries the
    // right route.
    const sdkFn = (id: string, className: string) =>
      ({
        id,
        name: 'update',
        kind: 'method',
        fileId: 'sdk-file',
        isExported: true,
        location: { filePath: 'sdk.ts', startLine: 1, endLine: 2 },
        moniker: { packageName: '@sample/api-client', descriptor: `src/sdk.ts/${className}#update().` },
      }) as unknown as FunctionNode;
    const sdk: ParsedRepoLike = {
      id: 'r-sdk',
      name: 'sample-sdk',
      entrypoints: [],
      functions: [
        sdkFn('sdk:planning:update', 'PlanningSpaceJobTitlesService'),
        sdkFn('sdk:profiles:update', 'UserProfilePlanningSpacesService'),
      ],
      externalCalls: [
        {
          id: 'sdk-egress-planning',
          versionedId: 'sdk-egress-planning@1',
          callerId: 'sdk:planning:update',
          serviceName: 'planning',
          method: 'put',
          targetDescriptor: {
            protocol: 'http',
            http: { method: 'PUT', pathTemplate: '/planning-space-job-titles/:id' },
          },
          location: { filePath: 'sdk.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
        {
          id: 'sdk-egress-profiles',
          versionedId: 'sdk-egress-profiles@1',
          callerId: 'sdk:profiles:update',
          serviceName: 'planning',
          method: 'put',
          targetDescriptor: {
            protocol: 'http',
            http: { method: 'PUT', pathTemplate: '/user-profile-planning-spaces/:id' },
          },
          location: { filePath: 'sdk.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
      ],
    };
    const gateway: ParsedRepoLike = {
      id: 'r-gw',
      name: 'sample-gateway',
      entrypoints: [],
      externalCalls: [
        {
          id: 'c-update',
          versionedId: 'c-update@1',
          callerId: 'gw-update-fn',
          serviceName: 'planning',
          sdkName: '@sample/api-client',
          method: 'update',
          location: { filePath: 'gw.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
      ],
      calls: [
        {
          id: 'call-1',
          callerId: 'gw-update-fn',
          calleeId: 'sdk:planning:update',
          calleeExpression: 'client.update',
          isMethodCall: true,
          location: { filePath: 'gw.ts', startLine: 1, endLine: 1 },
        },
      ],
    };
    const planning = repo(
      'r-planning',
      'sample-planning',
      [
        httpEntrypoint('ep-planning', 'PUT', '/planning-space-job-titles/:id'),
        httpEntrypoint('ep-profiles', 'PUT', '/user-profile-planning-spaces/:id'),
      ],
      [],
    );

    const mapper = {
      $schemaVersion: 1 as const,
      project: 'demo',
      services: [{ name: 'planning', repo: 'sample-planning', aliases: [] }],
      sdkMappings: [
        {
          sdkPackage: '@sample/api-client',
          sdkClass: 'PlanningSpaceJobTitlesService',
          sdkMethod: 'update',
          targetService: 'planning',
          http: { method: 'PUT' as const, pathTemplate: '/planning-space-job-titles/:id', pathParams: [] },
        },
        {
          sdkPackage: '@sample/api-client',
          sdkClass: 'UserProfilePlanningSpacesService',
          sdkMethod: 'update',
          targetService: 'planning',
          http: { method: 'PUT' as const, pathTemplate: '/user-profile-planning-spaces/:id', pathParams: [] },
        },
      ],
      pathRewriteRules: [],
      unresolvableServices: [],
    };

    const result = linkWorkspace([gateway, sdk, planning], mapper);
    const edge = result.edges.find((e) => e.sourceId === 'c-update');
    expect(edge?.targetId).toBe('ep-planning');
    expect(edge?.properties.via).toBe('call-edge+http');

    // Without the CALLS edges the same workspace must NOT guess a route from the
    // ambiguous override rows.
    const guarded = linkWorkspace([{ ...gateway, calls: [] }, sdk, planning], mapper);
    expect(guarded.edges.find((e) => e.sourceId === 'c-update')).toBeUndefined();
    expect(guarded.unresolved.some((u) => u.sourceId === 'c-update')).toBe(true);
  });
});
