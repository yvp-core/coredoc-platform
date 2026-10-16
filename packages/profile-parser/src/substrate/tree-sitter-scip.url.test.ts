import { describe, expect, it } from 'vitest';
import type { ArgRef } from '../types.js';
import { inlineConstInterpolations, resolveHttpUrl } from './scip/url-topic-helpers.js';

/**
 * `object-property` HTTP URL extraction — the URL lives in a named key of an
 * object-literal argument, e.g.
 *   `this.request({ entrypoint: this.entrypoints.core.url, uri: `/v2/...`, method: 'PUT' })`
 * with `url: { arg: 0, as: 'object-property', key: 'uri' }`.
 *
 * The engine must read the keyed STRING/TEMPLATE value, not the whole multi-line
 * object literal (which collapsed to `/:_,\n}` garbage under normalizeUrlTemplate
 * and never matched an entrypoint — the acme-api-client cross-repo bug).
 */
describe('resolveHttpUrl (object-property URL extraction)', () => {
  const uriRef: ArgRef = { arg: 0, as: 'object-property', key: 'uri' };

  it('returns the keyed string-literal value, not the whole object text', () => {
    const arg = `{ entrypoint: this.entrypoints.walle.url, uri: '/v1/management/walle/subscriptions', method: 'PUT' }`;
    expect(resolveHttpUrl(arg, uriRef)).toBe('/v1/management/walle/subscriptions');
  });

  it('handles a multi-line object literal (real this.request shape)', () => {
    const arg = `{
      entrypoint: this.entrypoints.core.url,
      uri: \`/v2/management/walle/events\`,
      method: "POST",
      json: { content: eventBody },
    }`;
    expect(resolveHttpUrl(arg, uriRef)).toBe('/v2/management/walle/events');
  });

  it('normalizes template-literal interpolations in the keyed value to {param}', () => {
    const arg = `{
      entrypoint: this.entrypoints.core.url,
      uri: \`/v2/management/core/companies/\${options.companyUuid}/user_profiles/\${options.userProfileUuid}\`,
      method: "POST",
    }`;
    expect(resolveHttpUrl(arg, uriRef)).toBe(
      '/v2/management/core/companies/{companyUuid}/user_profiles/{userProfileUuid}',
    );
  });

  it('returns undefined when the key is absent (honestly unresolved, not garbage)', () => {
    const arg = `{ entrypoint: this.entrypoints.core.url, method: 'GET' }`;
    expect(resolveHttpUrl(arg, uriRef)).toBeUndefined();
  });

  it('returns undefined when the keyed value is not a static string/template', () => {
    const arg = `{ entrypoint: this.entrypoints.core.url, uri: buildUrl(path), method: 'GET' }`;
    expect(resolveHttpUrl(arg, uriRef)).toBeUndefined();
  });

  it('returns undefined for an absent arg', () => {
    expect(resolveHttpUrl(undefined, uriRef)).toBeUndefined();
  });

  it('non-object-property refs normalize the arg directly (string-literal URL)', () => {
    const directRef: ArgRef = { arg: 0, as: 'string-literal' };
    expect(resolveHttpUrl(`'/api/v1/companies/\${id}/holidays'`, directRef)).toBe('/api/v1/companies/{id}/holidays');
  });
});

/**
 * Leading-const route prefix: `const BASE = '/vacation_policies/companies'` used
 * as `` `${BASE}/${companyUuid}/${policyUuid}${query}` ``. Without inlining BASE
 * first, templateTailRoute mistakes the leading `${BASE}` for a runtime config
 * host and strips it, leaving an all-param path (`/{companyUuid}/{policyUuid}`)
 * that mis-resolves cross-repo (an admin-frontend vacation-policy → calculations
 * false positive). Inlining restores the static `/vacation_policies/companies`
 * anchor so the route survives.
 */
describe('inlineConstInterpolations (const route-prefix preservation)', () => {
  const BASE = '/vacation_policies/companies';
  const resolve = (ident: string) => (ident === 'BASE' ? BASE : undefined);
  const directRef: ArgRef = { arg: 0, as: 'string-literal' };

  // The inputs below are literal template-literal SOURCE text under test (the
  // raw call-argument the parser sees), not real interpolations — single-quoted
  // so the `${…}` stays verbatim.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text under test
  const PREFIXED = '`${BASE}/${companyUuid}/${policyUuid}${query}`';
  const PREFIXED_NORMALIZED = '/vacation_policies/companies/{companyUuid}/{policyUuid}{query}';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text under test
  const HOST_TEMPLATE = '`${this.entrypoints.core.url}/v2/management/core/companies/${id}`';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text under test
  const RUNTIME_BASE = '`${baseUrl}/path`';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text under test
  const HOST_FOO = '`${this.entrypoints.core.url}/v2/foo/${id}`';

  it('inlines a bare-identifier string const, leaves params verbatim', () => {
    expect(inlineConstInterpolations(PREFIXED, resolve)).toBe(`\`${BASE}/\${companyUuid}/\${policyUuid}\${query}\``);
  });

  it('leaves member-expression interpolations untouched (a runtime host stays droppable)', () => {
    expect(inlineConstInterpolations(HOST_TEMPLATE, resolve)).toBe(HOST_TEMPLATE);
  });

  it('leaves an unresolvable identifier verbatim', () => {
    expect(inlineConstInterpolations(RUNTIME_BASE, resolve)).toBe(RUNTIME_BASE);
  });

  it('end-to-end: inlined const prefix survives resolveHttpUrl (not tail-stripped)', () => {
    expect(resolveHttpUrl(inlineConstInterpolations(PREFIXED, resolve), directRef)).toBe(PREFIXED_NORMALIZED);
  });

  it('regression guard: a genuine member-expression host is still tail-stripped', () => {
    // No inlining applies (member expr), so resolveHttpUrl drops the leading host.
    expect(resolveHttpUrl(inlineConstInterpolations(HOST_FOO, resolve), directRef)).toBe('/v2/foo/{id}');
  });
});
