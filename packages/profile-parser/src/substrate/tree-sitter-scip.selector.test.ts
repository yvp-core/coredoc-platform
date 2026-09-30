import { describe, expect, it } from 'vitest';
import type { ArgRef, ServiceSelector } from '../types.js';
import { resolveHttpMethodArg, resolveHttpUrl, resolveServiceSelector, templateTailRoute } from './tree-sitter-scip.js';

/**
 * Config-driven cross-repo egress: a service-selector TOKEN read from the call
 * (CONFIG.<token> arg, or entrypoints.<token> in a uri template) translates through
 * a per-rule serviceMap to the target repo, and the static tail after the leading
 * `${...}` interpolation is the real route. Both repos this targets route HTTP this
 * way: sample-admin (sendRequest arg-3 CONFIG token) and sample-client-admin-api
 * (this.performRequest entrypoints.<svc> uri template).
 */
describe('resolveServiceSelector (arg-member — sample-admin sendRequest)', () => {
  const selector: ServiceSelector = {
    via: 'arg-member',
    arg: 3,
    container: 'CONFIG',
    default: 'api',
    serviceMap: {
      client_admin_api: 'client-admin-api',
      client_admin_api_v3: 'api-gateway',
      api_exporting: 'exporting',
    },
  };

  it('reads the CONFIG.<token> member of arg 3 and translates it via serviceMap', () => {
    const args = ['{}', "'GET'", "'/companies/x/domains'", 'CONFIG.client_admin_api'];
    expect(resolveServiceSelector(selector, args, undefined)).toBe('client-admin-api');
  });

  it('reads the token from a template-literal arg `${CONFIG.token}/...`', () => {
    const args = ['{ access_token }', "'POST'", "'/v2/public/sso'", '`${CONFIG.api_exporting}/v2/public/exporting`'];
    expect(resolveServiceSelector(selector, args, undefined)).toBe('exporting');
  });

  it('falls back to the default token when arg 3 is absent (CONFIG.api default)', () => {
    const args = ['{}', "'GET'", "'/utc_time'"];
    // default token 'api' has no serviceMap entry → Rails-bound → unset (unresolved).
    expect(resolveServiceSelector(selector, args, undefined)).toBeUndefined();
  });

  it('leaves targetService UNSET for a token with no serviceMap entry (no fabrication)', () => {
    const args = ['{}', "'POST'", "'/v2/public/sso/x'", 'CONFIG.api_admin'];
    expect(resolveServiceSelector(selector, args, undefined)).toBeUndefined();
  });

  it('maps a v3-gateway token to the gateway repo', () => {
    const args = ['{}', "'GET'", "'/x'", 'CONFIG.client_admin_api_v3'];
    expect(resolveServiceSelector(selector, args, undefined)).toBe('api-gateway');
  });
});

describe('resolveServiceSelector (uri-template — client-admin-api performRequest)', () => {
  const selector: ServiceSelector = {
    via: 'uri-template',
    container: 'entrypoints',
    serviceMap: {
      requests: 'requests',
      core: 'core',
      walle: 'walle',
    },
  };

  it('reads the entrypoints.<svc> member of the uri template and translates it', () => {
    const uri = '`${this.entrypoints.requests.url}/v2/management/requests/companies/${uuid}/types`';
    expect(resolveServiceSelector(selector, [], uri)).toBe('requests');
  });

  it('reads the token from a full object-literal arg text (the real performRequest shape)', () => {
    const objArg = `{
      uri: \`\${this.entrypoints.core.url}/v2/management/core/companies/\${companyUuid}/user_profiles/list\`,
      method: "POST",
      json: payload
    }`;
    expect(resolveServiceSelector(selector, [], objArg)).toBe('core');
  });

  it('leaves targetService UNSET for an unmapped entrypoints token', () => {
    const uri = '`${this.entrypoints.unknownSvc.url}/v2/management/unknown/x`';
    expect(resolveServiceSelector(selector, [], uri)).toBeUndefined();
  });

  it('returns undefined when the url arg is absent', () => {
    expect(resolveServiceSelector(selector, [], undefined)).toBeUndefined();
  });
});

describe('templateTailRoute (static tail after the leading ${...} base)', () => {
  it('returns the static tail after the leading interpolation, normalizing inner params', () => {
    const uri = '`${this.entrypoints.requests.url}/v2/management/requests/companies/${uuid}/types`';
    expect(templateTailRoute(uri)).toBe('/v2/management/requests/companies/{uuid}/types');
  });

  it('returns the bare tail when there are no inner params', () => {
    expect(templateTailRoute('`${this.entrypoints.walle.url}/v1/management/walle/subscriptions`')).toBe(
      '/v1/management/walle/subscriptions',
    );
  });

  it('returns undefined for a literal-led template (no leading interpolation)', () => {
    expect(templateTailRoute('`/v2/management/core/companies/${id}`')).toBeUndefined();
  });

  it('returns undefined for a plain (non-template) string literal', () => {
    expect(templateTailRoute("'/companies/x/domains'")).toBeUndefined();
  });

  it('returns undefined when the tail is empty (base-only template, no synthetic /)', () => {
    expect(templateTailRoute('`${this.entrypoints.core.url}`')).toBeUndefined();
  });

  it('returns undefined for an absent arg', () => {
    expect(templateTailRoute(undefined)).toBeUndefined();
  });
});

describe('resolveHttpMethodArg (real HTTP verb from a request-wrapper { method } option)', () => {
  const ref: ArgRef = { arg: 0, as: 'object-property', key: 'method' };

  it('reads the verb from the object { method: "POST" } key', () => {
    const objArg = `{ uri: \`\${this.entrypoints.core.url}/v2/management/core/x\`, method: "POST", json: payload }`;
    expect(resolveHttpMethodArg(objArg, ref)).toBe('POST');
  });

  it('upper-cases a lower-case verb', () => {
    expect(resolveHttpMethodArg(`{ uri: \`\${e.url}/x\`, method: "get" }`, ref)).toBe('GET');
  });

  it('returns undefined when the method key is absent (caller falls back to the wrapper name)', () => {
    expect(resolveHttpMethodArg(`{ uri: \`\${e.url}/x\` }`, ref)).toBeUndefined();
  });

  it('returns undefined for a non-verb method value', () => {
    expect(resolveHttpMethodArg(`{ method: "fetch" }`, ref)).toBeUndefined();
  });
});

describe('resolveHttpUrl yields the template tail for a leading-interpolation uri (object-property)', () => {
  const uriRef: ArgRef = { arg: 0, as: 'object-property', key: 'uri' };

  it('drops the runtime-host base and returns the static route tail', () => {
    const objArg = `{
      uri: \`\${this.entrypoints.requests.url}/v2/management/requests/companies/\${companyUuid}/types/tree\`,
      method: "GET",
    }`;
    expect(resolveHttpUrl(objArg, uriRef)).toBe('/v2/management/requests/companies/{companyUuid}/types/tree');
  });

  it('still returns a literal-led keyed uri unchanged (no leading interpolation)', () => {
    const objArg = `{ uri: \`/v2/management/core/companies/\${companyUuid}/list\`, method: "POST" }`;
    expect(resolveHttpUrl(objArg, uriRef)).toBe('/v2/management/core/companies/{companyUuid}/list');
  });
});
