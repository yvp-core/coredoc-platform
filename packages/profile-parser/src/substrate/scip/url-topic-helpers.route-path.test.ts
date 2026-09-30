/**
 * `routePathFromUrl` — the gate that decides whether a matched egress call carries a
 * linkable route.
 *
 * The regression it guards: a URL built from a same-file base const
 * (`let base = 'http://localhost:4747'` → `` `${base}/api/info` ``) resolves to an ABSOLUTE
 * url, and the old gate accepted only paths starting with `/`. Resolving the host therefore
 * *destroyed* the edge, while a sibling call whose host came from an imported const stayed
 * unresolved, kept its `${…}` prefix, and survived. Every gitnexus backend-client call was
 * lost this way.
 */
import { describe, expect, it } from 'vitest';
import { routePathFromUrl } from './url-topic-helpers.js';

describe('routePathFromUrl', () => {
  it('passes a plain path through unchanged', () => {
    expect(routePathFromUrl('/api/info')).toBe('/api/info');
    expect(routePathFromUrl('/api/repo/{id}')).toBe('/api/repo/{id}');
  });

  it('reduces an absolute url to its path', () => {
    expect(routePathFromUrl('http://localhost:4747/api/info')).toBe('/api/info');
    expect(routePathFromUrl('https://api.example.com/v2/things/{id}')).toBe('/v2/things/{id}');
  });

  it('accepts any scheme, not just http', () => {
    expect(routePathFromUrl('ws://localhost:4747/socket')).toBe('/socket');
  });

  it('stays undefined for a host-only url — no synthetic root path', () => {
    expect(routePathFromUrl('https://api.example.com')).toBeUndefined();
    expect(routePathFromUrl('https://api.example.com/')).toBeUndefined();
  });

  it('stays undefined for an unresolved or non-url value', () => {
    expect(routePathFromUrl(undefined)).toBeUndefined();
    expect(routePathFromUrl('')).toBeUndefined();
    // A bare identifier the resolver could not turn into anything routable.
    expect(routePathFromUrl('url')).toBeUndefined();
  });

  // The host is the ONLY thing separating an internal call from a third-party one. When it
  // was written at the call site rather than resolved from an in-repo const, stripping it
  // hands the linker's unscoped tier a bare path it can bind to any workspace repo's
  // `GET /v1/:_` — a confident false cross-repo edge.
  //
  // `siteArgText` is the UNTOUCHED source expression, quotes and all. Passing any
  // normalized or const-inlined form instead makes every host look site-written and drops
  // the const-hosted edges this exists to keep — see engine.egress-url-host.test.ts, which
  // pins the same contract through the real pipeline.
  describe('site-literal hosts are third-party and stay unresolved', () => {
    it('drops a url whose host is a literal at the call site', () => {
      expect(
        routePathFromUrl('https://api.stripe.com/v1/charges', "'https://api.stripe.com/v1/charges'"),
      ).toBeUndefined();
      expect(
        routePathFromUrl('https://api.anthropic.com/v1/messages', '`https://api.anthropic.com/v1/messages`'),
      ).toBeUndefined();
    });

    it('still reduces a url whose host came from an in-repo const', () => {
      // The source text interpolates the host, so nothing at the site claims it.
      expect(routePathFromUrl('http://localhost:4747/api/info', '`${BASE}/api/info`')).toBe('/api/info');
    });

    it('leaves a relative raw url alone', () => {
      expect(routePathFromUrl('/api/info', "'/api/info'")).toBe('/api/info');
    });
  });
});
