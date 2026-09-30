import { describe, expect, it } from 'vitest';
import {
  buildEntrypointIndex,
  buildServiceRepoMap,
  matchProtocolHop,
  normalizePath,
  resolveRepoByRoutePrefix,
  type EntrypointLike,
  type ExternalCallLike,
} from './descriptor-matcher.js';
import { isResolved } from './types.js';

function httpEp(id: string, repoName: string, method: string, fullPath: string, path?: string): EntrypointLike {
  return { id, repoName, type: 'http', http: { method: method as never, fullPath, path: path ?? fullPath } };
}
function messagingEp(
  id: string,
  repoName: string,
  type: 'queue' | 'event',
  destination: string,
  system = 'kafka',
): EntrypointLike {
  return { id, repoName, type, system, destination };
}
function httpCall(id: string, method: string, pathTemplate: string): ExternalCallLike {
  return { id, targetDescriptor: { protocol: 'http', http: { method: method as never, pathTemplate } } };
}
function kafkaCall(id: string, topic: string, topicValue?: string): ExternalCallLike {
  return {
    id,
    targetDescriptor: {
      protocol: 'messaging',
      messaging: { system: 'kafka', destination: topic, ...(topicValue ? { destinationValue: topicValue } : {}) },
    },
  };
}
function messagingCall(id: string, system: string, destination: string, destinationValue?: string): ExternalCallLike {
  return {
    id,
    targetDescriptor: {
      protocol: 'messaging',
      messaging: { system, destination, destinationValue },
    },
  };
}

describe('normalizePath', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: tests handling of literal ${param} URL syntax
  it('collapses ${param}, {param}, and :param to one token', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal ${...} path syntax under test
    expect(normalizePath('/customers/${customerId}/shifts')).toBe(normalizePath('/customers/:id/shifts'));
    expect(normalizePath('/customers/{customerId}/shifts')).toBe(normalizePath('/customers/:id/shifts'));
  });
  it('strips query string and fragment', () => {
    expect(normalizePath('/users/:id?expand=true#frag')).toBe(normalizePath('/users/:id'));
  });
  it('collapses duplicate slashes, drops trailing slash, ensures leading slash', () => {
    expect(normalizePath('users//list/')).toBe('/users/list');
  });
});

describe('buildEntrypointIndex + matchHttp', () => {
  it('matches an exact http (method, normalizedPath) pair and returns the entrypoint id', () => {
    const index = buildEntrypointIndex([httpEp('ep1', 'svc-a', 'GET', '/v1/things/:id')]);
    expect(index.matchHttp('GET', '/v1/things/{id}')).toEqual(['ep1']);
    expect(index.matchHttp('POST', '/v1/things/{id}')).toEqual([]);
  });

  it('segment-wise: a caller literal matches an entrypoint path-param (most-specific tie-break)', () => {
    const index = buildEntrypointIndex([
      httpEp('specific', 'svc-a', 'GET', '/report/inconsistency'),
      httpEp('param', 'svc-a', 'GET', '/report/:reportType'),
    ]);
    // caller literal '/report/inconsistency' hits the literal entrypoint exactly (tier 1)
    expect(index.matchHttp('GET', '/report/inconsistency')).toEqual(['specific']);
    // caller param hits only the param entrypoint
    expect(index.matchHttp('GET', '/report/:x')).toEqual(['param']);
  });

  it('reports ambiguity when two entrypoints with equal specificity match', () => {
    const index = buildEntrypointIndex([
      httpEp('a', 'svc-a', 'GET', '/things/:id'),
      httpEp('b', 'svc-b', 'GET', '/things/:other'),
    ]);
    expect(index.matchHttp('GET', '/things/42').sort()).toEqual(['a', 'b']);
  });

  it('gateway httpPrefix strip: a prefixed entrypoint matches an unprefixed caller path', () => {
    const index = buildEntrypointIndex([httpEp('gw', 'gateway', 'GET', '/v3/public/api-gateway/orders')]);
    expect(index.matchHttp('GET', '/orders', { httpPrefix: '/v3/public/api-gateway' })).toEqual(['gw']);
    // without the prefix opt, the unprefixed caller does not match
    expect(index.matchHttp('GET', '/orders')).toEqual([]);
  });

  it('stripPrefix: a fully-prefixed caller path matches a BARE entrypoint after the prefix is stripped', () => {
    // Entrypoint sits at the bare setGlobalPrefix-relative path `/onboarding/x`.
    const index = buildEntrypointIndex([httpEp('bare', 'demo-assistant', 'GET', '/onboarding/x')]);
    // Fully-prefixed caller, prefix stripped → matches the bare entrypoint.
    expect(
      index.matchHttp('GET', '/v3/management/assistant/onboarding/x', { stripPrefix: '/v3/management/assistant' }),
    ).toEqual(['bare']);
    // Without stripping, the fully-prefixed caller does not match.
    expect(index.matchHttp('GET', '/v3/management/assistant/onboarding/x')).toEqual([]);
  });
});

describe('resolveRepoByRoutePrefix', () => {
  it('matches a route to the repo whose httpPrefix is a leading segment match', () => {
    const byRepo = { 'demo-assistant': '/v3/management/assistant', web: undefined };
    expect(resolveRepoByRoutePrefix('/v3/management/assistant/onboarding/steps', byRepo)).toEqual({
      repo: 'demo-assistant',
      prefix: '/v3/management/assistant',
    });
  });

  it('longest-prefix wins when two repos share a leading prefix', () => {
    const byRepo = {
      'demo-reports': '/v2/management/reports',
      'demo-calculations': '/v2/management/calculations',
    };
    expect(resolveRepoByRoutePrefix('/v2/management/calculations/daily-summaries/42', byRepo)).toEqual({
      repo: 'demo-calculations',
      prefix: '/v2/management/calculations',
    });
  });

  it('reports ambiguous on an equal-length prefix tie', () => {
    const byRepo = { 'repo-a': '/v2/management', 'repo-b': '/v2/management' };
    expect(resolveRepoByRoutePrefix('/v2/management/things/1', byRepo)).toBe('ambiguous');
  });

  it('does not match a partial-segment collision', () => {
    const byRepo = { 'demo-admin': '/v2/management' };
    // `/v2/manage/...` must NOT match prefix `/v2/management` (not a segment boundary).
    expect(resolveRepoByRoutePrefix('/v2/manage/things', byRepo)).toBeUndefined();
  });

  it('returns undefined when no repo prefix is a leading match', () => {
    const byRepo = { 'demo-assistant': '/v3/management/assistant' };
    expect(resolveRepoByRoutePrefix('/v1/public/orders', byRepo)).toBeUndefined();
  });
});

describe('matchMessaging', () => {
  it('matches a queue entrypoint by system and destination', () => {
    const index = buildEntrypointIndex([messagingEp('q1', 'svc-a', 'queue', 'user.created')]);
    expect(index.matchMessaging(' KAFKA ', 'user.created')).toEqual(['q1']);
    expect(index.matchMessaging('kafka', 'user.deleted')).toEqual([]);
  });
  it('indexes both the source destination token and its resolved runtime value', () => {
    const index = buildEntrypointIndex([
      {
        id: 'q1',
        repoName: 'events',
        type: 'queue',
        system: 'gcp-pubsub',
        destination: 'Topics.UserCreated',
        destinationValue: 'user.created',
      },
    ]);
    expect(index.matchMessaging('gcp-pubsub', 'Topics.UserCreated')).toEqual(['q1']);
    expect(index.matchMessaging('gcp-pubsub', 'user.created')).toEqual(['q1']);
  });
  it('matches an event entrypoint by emitter spelling', () => {
    const index = buildEntrypointIndex([messagingEp('e1', 'svc-b', 'event', 'shift.updated', 'celery')]);
    expect(index.matchMessaging('celery', 'shift.updated')).toEqual(['e1']);
  });
  it('keeps identical destinations in different systems distinct', () => {
    const index = buildEntrypointIndex([
      messagingEp('k', 'svc-k', 'queue', 'orders', 'kafka'),
      messagingEp('n', 'svc-n', 'queue', 'orders', 'nats'),
    ]);
    expect(index.matchMessaging('kafka', 'orders')).toEqual(['k']);
    expect(index.matchMessaging('nats', 'orders')).toEqual(['n']);
  });
  // Matching is exact on (system, destination). A consumer carrying no system is
  // only reachable by a producer that also carries none — there is no cross-system
  // fallback, so an unrelated transport can never borrow it.
  it('does not let one system borrow a consumer indexed under another', () => {
    const index = buildEntrypointIndex([
      { id: 'systemless', repoName: 'old', type: 'queue', destination: 'orders' },
      messagingEp('nats', 'new', 'queue', 'orders', 'nats'),
    ]);
    expect(index.matchMessaging('nats', 'orders')).toEqual(['nats']);
    expect(index.matchMessaging('sqs', 'orders')).toEqual([]);
    expect(index.matchMessaging(undefined, 'orders')).toEqual(['systemless']);
  });
});

describe('matchProtocolHop', () => {
  const index = buildEntrypointIndex([
    httpEp('http-ep', 'svc-a', 'GET', '/v1/things/:id'),
    messagingEp('topic-ep', 'svc-b', 'queue', 'user.created'),
  ]);

  it('resolves an http call to its entrypoint via "http"', () => {
    const r = matchProtocolHop(httpCall('c1', 'GET', '/v1/things/{id}'), index, {});
    expect(isResolved(r)).toBe(true);
    if (isResolved(r)) {
      expect(r.kind).toBe('protocol');
      expect(r.via).toBe('http');
      expect(r.sourceId).toBe('c1');
      expect(r.targetId).toBe('http-ep');
      expect(r.confidence).toBeGreaterThan(0);
    }
  });

  it('reads a legacy kafka call and resolves it via messaging using topicValue', () => {
    const r = matchProtocolHop(kafkaCall('c2', 'TOPIC_ENUM', 'user.created'), index, {});
    expect(isResolved(r)).toBe(true);
    if (isResolved(r)) {
      expect(r.via).toBe('messaging');
      expect(r.targetId).toBe('topic-ep');
    }
  });

  it('falls back to the source token when only the producer resolved the runtime value', () => {
    const tokenOnly = buildEntrypointIndex([messagingEp('consumer', 'events', 'queue', 'Topics.UserCreated')]);
    const result = matchProtocolHop(kafkaCall('producer', 'Topics.UserCreated', 'user.created'), tokenOnly, {});
    expect(result).toMatchObject({ targetId: 'consumer', via: 'messaging' });
  });

  it('tries all exact-system addresses before falling back to a systemless consumer', () => {
    const mixed = buildEntrypointIndex([
      messagingEp('exact-token', 'current', 'queue', 'Topics.ORDERS', 'kafka'),
      { id: 'legacy-value', repoName: 'legacy', type: 'queue', destination: 'orders' },
    ]);
    const result = matchProtocolHop(messagingCall('producer', 'kafka', 'Topics.ORDERS', 'orders'), mixed, {});
    expect(result).toMatchObject({ targetId: 'exact-token', via: 'messaging' });
  });

  it('resolves a non-Kafka messaging descriptor by exact system and destination', () => {
    const pubsub = buildEntrypointIndex([messagingEp('consumer', 'events', 'queue', 'user.created', 'gcp-pubsub')]);
    const result = matchProtocolHop(
      messagingCall('producer', 'gcp-pubsub', 'Topics.UserCreated', 'user.created'),
      pubsub,
      {},
    );
    expect(result).toMatchObject({ targetId: 'consumer', via: 'messaging' });
  });

  it('reports no-path when an http call carries no path template', () => {
    const r = matchProtocolHop({ id: 'c3', targetDescriptor: { protocol: 'http' } }, index, {});
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) expect(r.code).toBe('no-path');
  });

  it('reports no-entrypoint-match when an http path has no matching entrypoint', () => {
    const r = matchProtocolHop(httpCall('c4', 'GET', '/nope/{x}'), index, {});
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) expect(r.code).toBe('no-entrypoint-match');
  });

  it('reports ambiguous when more than one entrypoint matches', () => {
    const ambIndex = buildEntrypointIndex([
      httpEp('a', 'svc-a', 'GET', '/things/:id'),
      httpEp('b', 'svc-b', 'GET', '/things/:other'),
    ]);
    const r = matchProtocolHop(httpCall('c5', 'GET', '/things/42'), ambIndex, {});
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) expect(r.code).toBe('ambiguous');
  });

  it('reports no-destination when a messaging call carries an empty destination', () => {
    const r = matchProtocolHop(kafkaCall('c6', ''), index, {});
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) expect(r.code).toBe('no-destination');
  });

  it('reports no-messaging-match when a destination has no matching entrypoint', () => {
    const r = matchProtocolHop(kafkaCall('c7', 'absent.topic'), index, {});
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) {
      expect(r.code).toBe('no-messaging-match');
      // Nothing carries this destination at all, so no misleading spelling hint.
      expect(r.detail).toBe('absent.topic');
    }
  });

  // The dominant zero-recall cause is one bus spelled two ways across a producer
  // profile and a consumer profile — which the per-profile lint cannot see. The
  // miss must name the systems that DO carry the destination, without matching them.
  it('names the other systems carrying the destination on a messaging miss', () => {
    const drifted = buildEntrypointIndex([messagingEp('consumer', 'events', 'queue', 'orders', 'google-pubsub')]);
    const r = matchProtocolHop(messagingCall('producer', 'gcp-pubsub', 'orders'), drifted, {});
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) {
      expect(r.code).toBe('no-messaging-match');
      expect(r.detail).toContain('google-pubsub');
      expect(r.detail).toContain('gcp-pubsub');
    }
  });

  it('names a systemless legacy consumer as the other spelling', () => {
    const legacy = buildEntrypointIndex([{ id: 'old', repoName: 'legacy', type: 'queue', destination: 'orders' }]);
    const r = matchProtocolHop(messagingCall('producer', 'kafka', 'orders'), legacy, {});
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) expect(r.detail).toContain('(no system)');
  });

  it('names the reserved electron-ipc spelling when a handler used another one', () => {
    const misspelled = buildEntrypointIndex([messagingEp('handler', 'desktop', 'queue', 'config:load', 'ipc')]);
    const r = matchProtocolHop(
      { id: 'invoke', targetDescriptor: { protocol: 'ipc', ipc: { channel: 'config:load', direction: 'invoke' } } },
      misspelled,
      {},
    );
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) {
      expect(r.code).toBe('no-messaging-match');
      expect(r.detail).toContain('electron-ipc');
      expect(r.detail).toContain('indexed under ipc');
    }
  });

  it.each(['grpc', 'graphql'] as const)('reports unsupported-protocol for %s descriptors', (protocol) => {
    const r = matchProtocolHop({ id: `unsupported-${protocol}`, targetDescriptor: { protocol } }, index, {});
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) expect(r.code).toBe('unsupported-protocol');
  });

  it('remains total when persisted data contains an out-of-union protocol', () => {
    const r = matchProtocolHop(
      { id: 'unsupported-runtime', targetDescriptor: { protocol: 'websocket' } as never },
      index,
      {},
    );
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) expect(r.code).toBe('unsupported-protocol');
  });

  it('uses the gateway httpPrefix from RepoCfg to strip before matching', () => {
    const gwIndex = buildEntrypointIndex([httpEp('gw', 'gateway', 'GET', '/v3/public/api-gateway/orders')]);
    const r = matchProtocolHop(httpCall('c8', 'GET', '/orders'), gwIndex, { httpPrefix: '/v3/public/api-gateway' });
    expect(isResolved(r)).toBe(true);
    if (isResolved(r)) expect(r.targetId).toBe('gw');
  });
});

describe('buildServiceRepoMap', () => {
  it('maps name and aliases to the repo (v1, no target)', () => {
    const map = buildServiceRepoMap([{ name: 'core', repo: 'acme-core', aliases: ['core-service'] }]);
    expect(map.toRepo('core')).toBe('acme-core');
    expect(map.toRepo('CORE-SERVICE')).toBe('acme-core'); // case/whitespace-insensitive
    expect(map.toRepo('unknown')).toBeUndefined();
    expect(map.toRepo(undefined)).toBeUndefined();
  });

  it('resolves name, aliases, and v2 targets all to the repo (repo-level projection)', () => {
    const map = buildServiceRepoMap([
      { name: 'ui', repo: 'mono', aliases: ['web-ui'], target: 'web' },
      { name: 'api', repo: 'mono', aliases: [] },
    ]);
    // A v2 `(repo, target)` entry and its aliases still scope by repo alone.
    expect(map.toRepo('ui')).toBe('mono');
    expect(map.toRepo('web-ui')).toBe('mono');
    expect(map.toRepo('api')).toBe('mono');
    expect(map.toRepo('nope')).toBeUndefined();
  });
});
