import { describe, it, expect } from 'vitest';
import { linkWorkspace, type ParsedRepoLike } from './linker.js';
import type { Entrypoint, ExternalCallEdge } from '../types/output.js';

// =============================================================================
// Phase 0 — Behavior probes (spec: docs/superpowers/specs/2026-07-16-intra-repo-
// linking-mapper-v2.md §5 Phase 0, policy §4.5).
//
// These tests PIN the CURRENT behavior of `linkWorkspace` for same-repo /
// self-loop matches, so the Phase 3 implementer has a verified baseline.
//
// KEY FINDING (the same-repo exclusion the spec §4.5 asks Phase 0 to locate):
//   `packages/core/src/cross-repo/linker.ts:218-223` — the edge builder ends with
//   `.filter((chain) => callRepoName.get(chain.sourceCallId) !== epRepoName.get(
//    chain.finalEntrypointId))`. It drops EVERY chain whose source repo NAME equals
//   its target repo NAME. The descriptor matcher itself has NO same-repo exclusion
//   (matchMessaging / matchHttpOne index all repos' entrypoints as candidates); the
//   suppression is purely this final name-keyed filter in linker.ts.
//
// Consequence for §4.5: because the filter keys on `ParsedRepoLike.name`, a
// single repoLike's publish→consume topic self-loop is SUPPRESSED today, even
// though §4.5 declares it a LEGAL edge. After Phase 3 slicing, distinct slices
// carry distinct `.name`s (service names like `<repo>#<target>`), so cross-target
// (ui→api) matches survive the filter; only SAME-service self-loops still hit it.
// Phase 3 relaxed this filter for the queue/topic self-loop case per §4.5 (the
// topic self-loop probe below now pins the NEW policy = 1 edge; the HTTP self-match
// probe still pins suppression). Everything else remains a pinned baseline.
// =============================================================================

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

/** Kafka publisher egress carrying a concrete topic (mirrors linker.test.ts (d-event)). */
function kafkaPublish(id: string, topic: string): ExternalCallEdge {
  return {
    id,
    versionedId: `${id}@1`,
    callerId: `${id}-fn`,
    serviceName: 'kafka',
    method: 'emit',
    targetDescriptor: { protocol: 'messaging', messaging: { system: 'kafka', destination: topic } },
    location: { filePath: 'p.ts', startLine: 1, endLine: 1 },
  } as ExternalCallEdge;
}

/** Queue/event consumer entrypoint on a topic (mirrors linker.test.ts (d-event)). */
function queueEntrypoint(id: string, topic: string): Entrypoint {
  return {
    id,
    versionedId: `${id}@1`,
    type: 'queue',
    handlerId: 'h',
    location: { filePath: 'f.ts', startLine: 1, endLine: 2 },
    details: { type: 'queue', system: 'kafka', topic, pattern: 'event' },
  } as Entrypoint;
}

function repo(id: string, name: string, entrypoints: Entrypoint[], externalCalls: ExternalCallEdge[]): ParsedRepoLike {
  return { id, name, entrypoints, externalCalls };
}

// -----------------------------------------------------------------------------
// Probe 1 — Same-repo HTTP match (§4.5 "HTTP").
// -----------------------------------------------------------------------------
describe('Phase 0 probe: same-repo HTTP self-match', () => {
  it('SUPPRESSES a same-repo http self-match (one repoLike; call path == own entrypoint path) — filter at linker.ts:218-223', () => {
    // §4.5: same-service http self-matches have no suppression rule in the matcher,
    // but the linker's final name-keyed self-edge filter DOES drop them because
    // source repo name === target repo name. CURRENT BEHAVIOR = suppressed (0 edges).
    const svc = repo(
      'r-svc',
      'svc-a',
      [httpEntrypoint('ep-users', 'GET', '/users/:id')],
      [httpCall('c1', 'GET', '/users/:id')],
    );

    const result = linkWorkspace([svc]);

    // The topic/http descriptor matches at walker level, then the self-edge filter drops it.
    expect(result.edges).toHaveLength(0);
  });

  it('CONTROL: cross-repo http match (two DIFFERENT names) emits exactly one edge (§4.5 "the entire point")', () => {
    // The known-working multi-repo case: distinct repo names, so the self-edge
    // filter does NOT fire. Establishes that the descriptor match itself works and
    // that name-equality is the ONLY thing suppressing the self-match above.
    const web = repo('r-web', 'web', [], [httpCall('c1', 'GET', '/users/:id')]);
    const users = repo('r-users', 'users-svc', [httpEntrypoint('ep-users', 'GET', '/users/:id')], []);

    const result = linkWorkspace([web, users]);

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c1');
    expect(edge.targetId).toBe('ep-users');
    expect(edge.properties.sourceRepoName).toBe('web');
    expect(edge.properties.targetRepoName).toBe('users-svc');
  });
});

// -----------------------------------------------------------------------------
// Probe 2 — Queue topic self-loop (§4.5 "Queue/topic").
// -----------------------------------------------------------------------------
describe('Phase 0 probe: queue topic self-loop', () => {
  it('EMITS a topic self-loop edge (ONE repoLike publishes T and consumes T) — policy changed in Phase 3 (§4.5)', () => {
    // §4.5 DECLARES this a LEGAL edge (a service publishing to a topic it also
    // consumes), including the self-loop case, with "no same-service suppression".
    // POLICY CHANGED IN PHASE 3 (spec §4.5): the self-edge filter at linker.ts was
    // relaxed for queue/topic hops — a same-name topic match now emits an edge (the
    // Phase 0 baseline pinned suppression; this test now pins the NEW policy). HTTP
    // self-matches stay suppressed (see Probe 1, unchanged).
    const svc: ParsedRepoLike = {
      id: 'r-svc',
      name: 'svc-a',
      entrypoints: [queueEntrypoint('ep-evt', 'Topics.OrderPlacedV1')],
      externalCalls: [kafkaPublish('c-emit', 'Topics.OrderPlacedV1')],
    };

    const result = linkWorkspace([svc]);

    // NEW policy: the topic self-loop resolves AND survives the relaxed filter.
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-emit');
    expect(edge.targetId).toBe('ep-evt');
    expect(edge.properties.via).toBe('messaging');
    // Same-service self-loop: source and target repo NAMES are identical.
    expect(edge.properties.sourceRepoName).toBe('svc-a');
    expect(edge.properties.targetRepoName).toBe('svc-a');
  });

  it('CONTROL: cross-repo topic match (two DIFFERENT names, publish→consume same topic) emits exactly one edge', () => {
    // Distinct names, so the self-edge filter does NOT fire — proves matchMessaging
    // resolves publish→consume and that name-equality alone suppresses the self-loop.
    const publisher: ParsedRepoLike = {
      id: 'r-pub',
      name: 'producer-svc',
      entrypoints: [],
      externalCalls: [kafkaPublish('c-emit', 'Topics.OrderPlacedV1')],
    };
    const consumer: ParsedRepoLike = {
      id: 'r-con',
      name: 'consumer-svc',
      entrypoints: [queueEntrypoint('ep-evt', 'Topics.OrderPlacedV1')],
      externalCalls: [],
    };

    const result = linkWorkspace([publisher, consumer]);

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-emit');
    expect(edge.targetId).toBe('ep-evt');
    expect(edge.properties.via).toBe('messaging');
    expect(edge.properties.sourceRepoName).toBe('producer-svc');
    expect(edge.properties.targetRepoName).toBe('consumer-svc');
  });

  it('preserves the one-call-at-most-one-edge invariant when a destination has multiple consumers', () => {
    const publisher = repo('r-pub', 'producer', [], [kafkaPublish('c-emit', 'orders')]);
    const consumerA = repo('r-a', 'consumer-a', [queueEntrypoint('ep-a', 'orders')], []);
    const consumerB = repo('r-b', 'consumer-b', [queueEntrypoint('ep-b', 'orders')], []);

    const result = linkWorkspace([publisher, consumerA, consumerB]);

    expect(result.edges.filter((edge) => edge.sourceId === 'c-emit')).toHaveLength(0);
    expect(result.unresolved).toContainEqual(expect.objectContaining({ sourceId: 'c-emit', code: 'ambiguous' }));
    expect(new Set(result.edges.map((edge) => edge.sourceId)).size).toBe(result.edges.length);
    expect(result.metrics.rate).toBeLessThanOrEqual(1);
  });
});

// -----------------------------------------------------------------------------
// IPC channel self-loop — the Electron bridge inside one repo: the preload's
// `ipcRenderer.invoke(channel)` egress resolves onto the `ipcMain.handle(channel)`
// queue entrypoint through the generic address index, so it rides the same
// relaxed self-edge policy as messaging (via 'ipc' survives the same-name filter).
// -----------------------------------------------------------------------------
describe('ipc channel self-loop', () => {
  function ipcInvoke(id: string, channel: string): ExternalCallEdge {
    return {
      id,
      versionedId: `${id}@1`,
      callerId: `${id}-fn`,
      serviceName: 'desktop-main',
      sdkName: 'electron-ipc',
      method: channel,
      targetDescriptor: { protocol: 'ipc', ipc: { channel, direction: 'invoke' } },
      location: { filePath: 'preload.ts', startLine: 1, endLine: 1 },
    } as ExternalCallEdge;
  }

  function ipcEntrypoint(id: string, channel: string): Entrypoint {
    return {
      id,
      versionedId: `${id}@1`,
      type: 'queue',
      handlerId: 'h',
      location: { filePath: 'main.ts', startLine: 1, endLine: 2 },
      details: { type: 'queue', system: 'electron-ipc', topic: channel },
    } as Entrypoint;
  }

  it('EMITS an edge for a same-repo ipc invoke → ipcMain.handle registration (via ipc)', () => {
    const app = repo('r-app', 'desktop', [ipcEntrypoint('ep-cfg', 'config:load')], [ipcInvoke('c-cfg', 'config:load')]);

    const result = linkWorkspace([app]);

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-cfg');
    expect(edge.targetId).toBe('ep-cfg');
    expect(edge.properties.via).toBe('ipc');
    expect(edge.properties.sourceRepoName).toBe('desktop');
    expect(edge.properties.targetRepoName).toBe('desktop');
  });

  it('buckets an unmatched channel as no-messaging-match (never a silent drop)', () => {
    const app = repo('r-app', 'desktop', [ipcEntrypoint('ep-cfg', 'config:load')], [ipcInvoke('c-x', 'config:save')]);

    const result = linkWorkspace([app]);

    expect(result.edges).toHaveLength(0);
    expect(result.unresolved.some((u) => u.sourceId === 'c-x' && u.code === 'no-messaging-match')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Probe 3 — Provenance / persistence shape carried on each edge.
// Documents what Phase 3's provenance assertions can rely on. The LinkEdge shape
// (types.ts:42-48) is: { id, sourceId, targetId, confidence, properties }. `id` is
// `resolve:<callId>:<entrypointId>`. `properties` carries:
//   { chain: ResolvedHop[], via: string, sourceRepoName: string,
//     targetRepoName: string, confidenceLevel: 'exact'|'inferred' }.
// It carries repo NAMES (not repo ids) and per-hop chain provenance. persistLinkResult
// (packages/db/src/resolution.ts:31-78) writes edges straight through under the
// affected repo IDs (PersistRepoRef.id) and passes `properties` verbatim as edge
// properties — so service/repo NAMES live only in `properties`, graph placement is
// keyed by repo id. See report for the full shape + file:line map.
// -----------------------------------------------------------------------------
describe('Phase 0 probe: LinkEdge provenance shape', () => {
  it('carries repo NAMES + per-hop chain provenance in edge.properties (no repo id on the edge)', () => {
    const web = repo('r-web', 'web', [], [httpCall('c1', 'GET', '/users/:id')]);
    const users = repo('r-users', 'users-svc', [httpEntrypoint('ep-users', 'GET', '/users/:id')], []);

    const result = linkWorkspace([web, users]);
    const edge = result.edges[0]!;

    expect(edge.id).toBe('resolve:c1:ep-users');
    expect(edge).toMatchObject({ id: expect.any(String), sourceId: 'c1', targetId: 'ep-users' });
    expect(edge.confidence).toBeGreaterThan(0);
    // properties provenance: names, not ids; plus chain array + via + confidenceLevel.
    expect(edge.properties.sourceRepoName).toBe('web');
    expect(edge.properties.targetRepoName).toBe('users-svc');
    expect(edge.properties.via).toBe('http');
    expect(['exact', 'inferred']).toContain(edge.properties.confidenceLevel);
    expect(Array.isArray(edge.properties.chain)).toBe(true);
    // No repo id anywhere on the edge — graph placement is keyed by PersistRepoRef.id.
    expect(JSON.stringify(edge)).not.toContain('r-web');
    expect(JSON.stringify(edge)).not.toContain('r-users');
  });
});
