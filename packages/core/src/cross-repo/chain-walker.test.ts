import { describe, it, expect } from 'vitest';
import { callEdgeKey, walkChains } from './chain-walker.js';
import type { EntrypointIndex, ExternalCallLike } from './descriptor-matcher.js';
import type { SdkMapping } from './mapper-schema.js';
import { buildSdkMappingIndex } from './sdk-mapping-fallback.js';
import type { SdkSymbolEntry } from './types.js';

// A tiny stub EntrypointIndex so the walker test does not depend on the real
// descriptor-matcher build. matchHttp/matchMessaging return entrypoint IDs.
// `stripPrefix` IS honoured: the walker's prefix-strip recovery tier is defined by
// re-running the hop with the prefix removed, so a stub that ignored it could not
// tell that tier apart from the plain unscoped retry. `targetRepo` scoping stays the
// real index's job — every entry here belongs to whichever repo the test names.
function stubIndex(
  entries: { http?: Record<string, string[]>; topic?: Record<string, string[]> } = {},
): EntrypointIndex {
  return {
    matchHttp: (method: string, path: string, opts?: { stripPrefix?: string }) => {
      const stripped =
        opts?.stripPrefix && path.startsWith(opts.stripPrefix) ? path.slice(opts.stripPrefix.length) : path;
      return entries.http?.[`${method} ${stripped}`] ?? [];
    },
    matchMessaging: (_system: string | undefined, destination: string) => entries.topic?.[destination] ?? [],
    systemsForDestination: () => [],
  };
}

const emptySymbolIndex = new Map<string, SdkSymbolEntry>();

/** `WorkspaceCfg.callTargetsByCaller` is repo-scoped — build its keys the one way. */
function callEdges(repoName: string, callerId: string, callees: string[]): Map<string, string[]> {
  return new Map([[callEdgeKey(repoName, callerId), callees]]);
}

function httpCall(
  id: string,
  method: string,
  pathTemplate: string,
  extra: Partial<ExternalCallLike> = {},
): ExternalCallLike {
  return {
    id,
    callerId: `${id}-fn`,
    serviceName: 'svc',
    method: 'm',
    sourceRepoName: 'web',
    targetDescriptor: { protocol: 'http', http: { method: method as never, pathTemplate } },
    ...extra,
  } as ExternalCallLike;
}

describe('walkChains', () => {
  it('resolves a direct HTTP protocol hop into a single-hop chain', () => {
    const calls = [httpCall('c1', 'GET', '/users/:id')];
    const ep = stubIndex({ http: { 'GET /users/:id': ['ep-users'] } });
    const { chains, unresolved } = walkChains(calls, emptySymbolIndex, ep, {});
    expect(unresolved).toHaveLength(0);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      sourceCallId: 'c1',
      finalEntrypointId: 'ep-users',
    });
    expect(chains[0]!.hops).toHaveLength(1);
    expect(chains[0]!.hops[0]!.via).toBe('http');
    expect(chains[0]!.confidence).toBeGreaterThan(0);
  });

  it('composes a symbol hop then a protocol hop over the SDK method egress', () => {
    // Consumer call carries a moniker; the SDK method node it joins to has an
    // egress (the real downstream HTTP call) that matches a workspace entrypoint.
    const symbolIndex = new Map<string, SdkSymbolEntry>([
      [
        '@sample/demo-api-client::CalculationsClient#dailySummaries',
        {
          packageName: '@sample/demo-api-client',
          normalizedDescriptor: 'CalculationsClient#dailySummaries',
          methodNodeId: 'sdk:calc:dailySummaries',
          egress: { protocol: 'http', http: { method: 'GET', pathTemplate: '/daily-summaries' } },
        },
      ],
    ]);
    const call: ExternalCallLike = {
      id: 'c2',
      callerId: 'c2-fn',
      serviceName: 'sampleApiClient',
      sdkName: '@sample/demo-api-client',
      method: 'dailySummaries',
      sourceRepoName: 'sample-admin',
      moniker: {
        packageName: '@sample/demo-api-client',
        descriptor: 'src/`index.d.ts`/CalculationsClient#dailySummaries().',
      },
    } as ExternalCallLike;
    const ep = stubIndex({ http: { 'GET /daily-summaries': ['ep-calc'] } });

    const { chains, unresolved } = walkChains([call], symbolIndex, ep, {});
    expect(unresolved).toHaveLength(0);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.finalEntrypointId).toBe('ep-calc');
    expect(chains[0]!.hops.map((h) => h.via)).toEqual(['moniker', 'http']);
    // composed confidence is the product of both hop confidences
    expect(chains[0]!.confidence).toBeCloseTo(chains[0]!.hops[0]!.confidence * chains[0]!.hops[1]!.confidence, 5);
  });

  it('buckets an unresolved call when neither the direct hop nor the symbol hop matches', () => {
    const calls = [httpCall('c3', 'GET', '/nope')];
    const { chains, unresolved } = walkChains(calls, emptySymbolIndex, stubIndex(), {});
    expect(chains).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.sourceId).toBe('c3');
    expect(unresolved[0]!.code).toBe('no-entrypoint-match');
  });

  describe('call-edge hop', () => {
    // Two SDK methods named `update` under ONE package — the shape the declarative
    // (package, method) tier cannot tell apart. The caller's own CALLS edge names
    // which one it invokes.
    const sdkIndex = () =>
      new Map<string, SdkSymbolEntry>([
        [
          '@sample/api-client::PlanningSpaceJobTitlesService#update',
          {
            packageName: '@sample/api-client',
            normalizedDescriptor: 'PlanningSpaceJobTitlesService#update',
            methodNodeId: 'sdk:planning:update',
            egress: { protocol: 'http', http: { method: 'PUT', pathTemplate: '/planning-space-job-titles/:id' } },
          },
        ],
        [
          '@sample/api-client::UserProfilePlanningSpacesService#update',
          {
            packageName: '@sample/api-client',
            normalizedDescriptor: 'UserProfilePlanningSpacesService#update',
            methodNodeId: 'sdk:profiles:update',
            egress: { protocol: 'http', http: { method: 'PUT', pathTemplate: '/user-profile-planning-spaces/:id' } },
          },
        ],
      ]);
    const sdkEntrypoints = () =>
      stubIndex({
        http: {
          'PUT /planning-space-job-titles/:id': ['ep-planning'],
          'PUT /user-profile-planning-spaces/:id': ['ep-profiles'],
        },
      });
    // No moniker (the SCIP join declined) and no descriptor of its own.
    const sdkCall: ExternalCallLike = {
      id: 'c-sdk',
      callerId: 'gw-update-fn',
      sourceRepoName: 'gateway',
      sdkName: '@sample/api-client',
      method: 'update',
    } as ExternalCallLike;

    it("resolves an ambiguous SDK method through the caller's CALLS edge to the SDK method node", () => {
      const { chains, unresolved } = walkChains([sdkCall], sdkIndex(), sdkEntrypoints(), {
        callTargetsByCaller: callEdges('gateway', 'gw-update-fn', ['sdk:planning:update']),
      });
      expect(unresolved).toHaveLength(0);
      expect(chains).toHaveLength(1);
      expect(chains[0]!.finalEntrypointId).toBe('ep-planning');
      expect(chains[0]!.finalEntrypointId).not.toBe('ep-profiles');
      expect(chains[0]!.hops.map((h) => h.via)).toEqual(['call-edge', 'http']);
      expect(chains[0]!.hops[0]!.targetId).toBe('sdk:planning:update');
    });

    it('leaves the same call unresolved when no CALLS edges are supplied', () => {
      const { chains, unresolved } = walkChains([sdkCall], sdkIndex(), sdkEntrypoints(), {});
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]!.sourceId).toBe('c-sdk');
    });

    it('resolves nothing when the caller calls TWO same-named SDK methods (no coin flip)', () => {
      const { chains, unresolved } = walkChains([{ ...sdkCall, method: undefined }], sdkIndex(), sdkEntrypoints(), {
        callTargetsByCaller: callEdges('gateway', 'gw-update-fn', ['sdk:planning:update', 'sdk:profiles:update']),
      });
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
    });

    it('abstains when the call name matches NO callee descriptor, even with a sole candidate', () => {
      // The co-residence fabrication: `grpcClient.fetchQuota()` sits in a function
      // that also calls one SDK method. Nothing but shared residence links them, so
      // the tier must not hand `fetchQuota` the SDK method's route.
      const { chains, unresolved } = walkChains(
        [{ ...sdkCall, id: 'c-unnamed-method', method: 'fetchQuota' }],
        sdkIndex(),
        sdkEntrypoints(),
        { callTargetsByCaller: callEdges('gateway', 'gw-update-fn', ['sdk:planning:update']) },
      );
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]!.sourceId).toBe('c-unnamed-method');
    });

    it('abstains for a nameless call whose caller has exactly one SDK method callee', () => {
      // Same fabrication without any method name at all — there is no evidence to
      // narrow on, so a single candidate is still not a match.
      const { chains, unresolved } = walkChains(
        [{ ...sdkCall, id: 'c-no-method', method: undefined }],
        sdkIndex(),
        sdkEntrypoints(),
        { callTargetsByCaller: callEdges('gateway', 'gw-update-fn', ['sdk:planning:update']) },
      );
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
    });

    it("ignores CALLS edges recorded under a DIFFERENT repo's caller of the same id", () => {
      // Node ids embed only a repo-NAME hash, so two same-named repos mint identical
      // caller ids. The evidence map is repo-scoped precisely so repo B's callees
      // never answer for repo A's caller.
      const { chains, unresolved } = walkChains([sdkCall], sdkIndex(), sdkEntrypoints(), {
        callTargetsByCaller: callEdges('other-gateway', 'gw-update-fn', ['sdk:planning:update']),
      });
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]!.sourceId).toBe('c-sdk');
    });

    it('abstains for a non-SDK egress even when its caller has one SDK method callee', () => {
      // A raw HTTP/messaging egress (no sdkName) in a function that also invokes one
      // SDK method must NOT inherit that method's route — its method name ('post')
      // matches no descriptor, so the old sole-candidate fallback would bind it.
      const rawEgress = {
        id: 'c-raw-http',
        callerId: 'gw-update-fn',
        sourceRepoName: 'gateway',
        method: 'post',
      } as ExternalCallLike;
      const { chains, unresolved } = walkChains([rawEgress], sdkIndex(), sdkEntrypoints(), {
        callTargetsByCaller: callEdges('gateway', 'gw-update-fn', ['sdk:planning:update']),
      });
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]!.sourceId).toBe('c-raw-http');
    });

    it('still resolves an SDK egress whose profile rule declared no sdkName', () => {
      // `sdkName` is OPTIONAL on the `sdk` / `imported-sdk` egress rules, so a profile
      // that names only `serviceName` emits SDK-mediated calls with no sdkName at all.
      // The call names no transport target of its own and its method is an SDK method
      // name (not an HTTP verb), so nothing about it looks like a raw egress — the
      // call-edge hop must still bind it to the SDK method the caller actually calls.
      const noSdkName = {
        id: 'c-sdk-unnamed',
        callerId: 'gw-update-fn',
        sourceRepoName: 'gateway',
        method: 'update',
      } as ExternalCallLike;
      const { chains, unresolved } = walkChains([noSdkName], sdkIndex(), sdkEntrypoints(), {
        callTargetsByCaller: callEdges('gateway', 'gw-update-fn', ['sdk:planning:update']),
      });
      expect(unresolved).toHaveLength(0);
      expect(chains).toHaveLength(1);
      expect(chains[0]!.finalEntrypointId).toBe('ep-planning');
      expect(chains[0]!.hops.map((h) => h.via)).toEqual(['call-edge', 'http']);
    });

    it('abstains for a raw egress that names its own unmatched route, even with a non-verb method', () => {
      // The other half of the raw-egress signal: a `fetch`-style wrapper whose method
      // name is not an HTTP verb, but which carries its own concrete path. The direct
      // hop already tried that path and missed; inheriting the sibling SDK method's
      // route would mint a RESOLVES_TO to an entrypoint this call never reaches.
      const rawEgress = {
        id: 'c-raw-path',
        callerId: 'gw-update-fn',
        sourceRepoName: 'gateway',
        method: 'sendRequest',
        targetDescriptor: { protocol: 'http', http: { method: 'POST', pathTemplate: '/unknown/route' } },
      } as ExternalCallLike;
      const { chains, unresolved } = walkChains([rawEgress], sdkIndex(), sdkEntrypoints(), {
        callTargetsByCaller: callEdges('gateway', 'gw-update-fn', ['sdk:planning:update']),
      });
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]!.sourceId).toBe('c-raw-path');
    });

    it('abstains for a call that carries BOTH an sdkName and its own unmatched route', () => {
      // `sdkName` answers "who wrote the client"; `isRawEgress` answers "does the call
      // name its own address". A call that names `/v1/foo` and whose method name
      // matches a sibling SDK method must not inherit that sibling's `/v2/bar` route
      // just because the client is branded — the address is the stronger evidence.
      const branded = {
        id: 'c-branded-path',
        callerId: 'gw-update-fn',
        sourceRepoName: 'gateway',
        sdkName: '@sample/api-client',
        method: 'update',
        targetDescriptor: { protocol: 'http', http: { method: 'PUT', pathTemplate: '/v1/foo' } },
      } as ExternalCallLike;
      const { chains, unresolved } = walkChains([branded], sdkIndex(), sdkEntrypoints(), {
        callTargetsByCaller: callEdges('gateway', 'gw-update-fn', ['sdk:planning:update']),
      });
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]!.sourceId).toBe('c-branded-path');
    });

    it('abstains for a MESSAGING egress that names its own destination', () => {
      // The third arm of the raw-egress proof, symmetric with the two HTTP ones: a
      // publish to `orders.created` with no consumer in the workspace must stay
      // unresolved, not inherit the route of the SDK method its function also calls —
      // and its method name DOES match that method, so only this arm abstains.
      const publish = {
        id: 'c-raw-topic',
        callerId: 'gw-update-fn',
        sourceRepoName: 'gateway',
        method: 'update',
        targetDescriptor: { protocol: 'messaging', messaging: { system: 'kafka', destination: 'orders.created' } },
      } as ExternalCallLike;
      const { chains, unresolved } = walkChains([publish], sdkIndex(), sdkEntrypoints(), {
        callTargetsByCaller: callEdges('gateway', 'gw-update-fn', ['sdk:planning:update']),
      });
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]!.sourceId).toBe('c-raw-topic');
      expect(unresolved[0]!.code).toBe('no-messaging-match');
    });

    it('keeps a unique moniker call on the moniker hop, never entering the call-edge tier', () => {
      // Sibling regression: the symbol hop resolves, so the recovery tiers never run —
      // a decoy CALLS edge to the OTHER SDK method must not change the outcome.
      const call: ExternalCallLike = {
        id: 'c-moniker',
        callerId: 'gw-update-fn',
        sourceRepoName: 'gateway',
        sdkName: '@sample/api-client',
        method: 'update',
        moniker: {
          packageName: '@sample/api-client',
          descriptor: 'src/`index.d.ts`/PlanningSpaceJobTitlesService#update().',
        },
      } as ExternalCallLike;
      const { chains, unresolved } = walkChains([call], sdkIndex(), sdkEntrypoints(), {
        callTargetsByCaller: callEdges('gateway', 'gw-update-fn', ['sdk:profiles:update']),
      });
      expect(unresolved).toHaveLength(0);
      expect(chains[0]!.finalEntrypointId).toBe('ep-planning');
      expect(chains[0]!.hops.map((h) => h.via)).toEqual(['moniker', 'http']);
    });
  });

  describe('sdkMapping recovery tier', () => {
    // The SDK method node is in the symbol index (so the moniker hop LANDS) but the
    // parse captured no egress for it — the "symbol hop resolved, nothing to chain
    // through" branch. The declared mapping row supplies the missing
    // (class, method) → route step.
    const noEgressIndex = () =>
      new Map<string, SdkSymbolEntry>([
        [
          '@sample/api-client::SchedulesClient#createSchedule',
          {
            packageName: '@sample/api-client',
            normalizedDescriptor: 'SchedulesClient#createSchedule',
            methodNodeId: 'sdk:schedules:createSchedule',
          },
        ],
      ]);
    const monikerCall: ExternalCallLike = {
      id: 'c-mapping',
      callerId: 'admin-fn',
      sourceRepoName: 'sample-admin',
      sdkName: 'SchedulesClient',
      method: 'createSchedule',
      moniker: {
        packageName: '@sample/api-client',
        descriptor: 'src/`index.d.ts`/SchedulesClient#createSchedule().',
      },
    } as ExternalCallLike;
    const mappingRow = (sdkClass: string, sdkMethod: string, pathTemplate: string): SdkMapping =>
      ({
        sdkPackage: '@sample/api-client',
        sdkClass,
        sdkMethod,
        targetService: 'schedules',
        http: { method: 'POST', pathTemplate, pathParams: [] },
      }) as SdkMapping;

    it('recovers an egress-less SDK method through a declared mapping row', () => {
      const { chains, unresolved } = walkChains(
        [monikerCall],
        noEgressIndex(),
        stubIndex({ http: { 'POST /schedules': ['ep-schedules'] } }),
        {
          sdkMappingIndex: buildSdkMappingIndex([mappingRow('SchedulesClient', 'createSchedule', '/schedules')]),
        },
      );
      expect(unresolved).toHaveLength(0);
      expect(chains).toHaveLength(1);
      expect(chains[0]!.finalEntrypointId).toBe('ep-schedules');
      // The synthetic first hop records that the (class, method) → route step came
      // from a declared override row, not a SCIP moniker join.
      expect(chains[0]!.hops.map((h) => h.via)).toEqual(['override', 'http']);
      expect(chains[0]!.hops[0]!.targetId).toBe('sdkMapping:SchedulesClient.createSchedule');
      expect(chains[0]!.confidence).toBeCloseTo(chains[0]!.hops[0]!.confidence * chains[0]!.hops[1]!.confidence, 5);
    });

    it('leaves the call unresolved when no declared row matches it', () => {
      // A table that names a DIFFERENT class and a different method: no class, package
      // or method-only key can hit, so the tier declines and the walker keeps its
      // existing "symbol hop landed, no entrypoint" bucketing.
      const { chains, unresolved } = walkChains(
        [monikerCall],
        noEgressIndex(),
        stubIndex({ http: { 'POST /schedules': ['ep-schedules'] } }),
        {
          sdkMappingIndex: buildSdkMappingIndex([mappingRow('BillingClient', 'charge', '/charges')]),
        },
      );
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]!.sourceId).toBe('c-mapping');
      expect(unresolved[0]!.code).toBe('no-entrypoint-match');
      expect(unresolved[0]!.detail).toBe('sdk:schedules:createSchedule');
    });
  });

  describe('route-prefix strip recovery', () => {
    // The gateway-prefix gap: the caller path carries the FULL gateway prefix while
    // the target service's entrypoints sit at the bare setGlobalPrefix-relative path,
    // and no service hint named the repo. The route's own leading prefix is the only
    // thing left that names it.
    const prefixedCall = () => httpCall('c-prefixed', 'GET', '/v3/management/assistant/threads');

    it("recovers by resolving the target repo from the route's own prefix, then stripping it", () => {
      const ep = stubIndex({ http: { 'GET /threads': ['ep-threads'] } });
      const { chains, unresolved } = walkChains([prefixedCall()], emptySymbolIndex, ep, {
        httpPrefixByRepo: { assistant: '/v3/management/assistant', billing: '/v3/management/billing' },
      });
      expect(unresolved).toHaveLength(0);
      expect(chains).toHaveLength(1);
      expect(chains[0]!.finalEntrypointId).toBe('ep-threads');
      expect(chains[0]!.hops.map((h) => h.via)).toEqual(['http']);
    });

    it('reports ambiguous when two repos declare the SAME matching prefix', () => {
      const ep = stubIndex({ http: { 'GET /threads': ['ep-threads'] } });
      const { chains, unresolved } = walkChains([prefixedCall()], emptySymbolIndex, ep, {
        httpPrefixByRepo: { 'assistant-a': '/v3/management/assistant', 'assistant-b': '/v3/management/assistant' },
      });
      expect(chains).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]!.code).toBe('ambiguous');
      expect(unresolved[0]!.detail).toBe('route prefix matches >1 repo: /v3/management/assistant/threads');
    });

    it('keeps the original miss reason when no declared prefix matches the route', () => {
      const ep = stubIndex({ http: { 'GET /threads': ['ep-threads'] } });
      const { chains, unresolved } = walkChains([prefixedCall()], emptySymbolIndex, ep, {
        httpPrefixByRepo: { billing: '/v3/management/billing' },
      });
      expect(chains).toHaveLength(0);
      expect(unresolved[0]!.code).toBe('no-entrypoint-match');
    });
  });

  it('resolves a topic protocol hop for an event call', () => {
    const call: ExternalCallLike = {
      id: 'c4',
      callerId: 'c4-fn',
      serviceName: 'messageBus',
      method: 'publishEvent',
      sourceRepoName: 'demo-core',
      targetDescriptor: { protocol: 'messaging', messaging: { system: 'kafka', destination: 'user.created' } },
    } as ExternalCallLike;
    const ep = stubIndex({ topic: { 'user.created': ['ep-event'] } });
    const { chains, unresolved } = walkChains([call], emptySymbolIndex, ep, {});
    expect(unresolved).toHaveLength(0);
    expect(chains[0]!.finalEntrypointId).toBe('ep-event');
    expect(chains[0]!.hops[0]!.via).toBe('messaging');
  });
});
