import { describe, expect, it } from 'vitest';
import type { Mapper } from '@coredoc/core';
import { buildSdkMappings, type SdkSourceParsed } from './generate.js';

const baseMapper: Mapper = {
  $schemaVersion: 1,
  project: 'demo',
  services: [],
  sdkMappings: [],
  // Derives targetService from the first segment after /v2/management/.
  pathRewriteRules: [{ match: '^/v2/management/(?<svc>[^/]+)/', targetServiceFrom: 'svc' }],
  unresolvableServices: [],
};

/** Build a minimal parsed SDK-source repo for the pure builder. */
function source(
  name: string,
  functions: SdkSourceParsed['repo']['functions'],
  externalCalls: SdkSourceParsed['repo']['externalCalls'],
  classes: SdkSourceParsed['repo']['classes'],
  packages: string[],
): SdkSourceParsed {
  return { name, repo: { functions, externalCalls, classes }, packages };
}

const PKG = '@sample/management-api-client';

function method(id: string, name: string, classId: string, pkg = PKG) {
  return { id, name, kind: 'method' as const, classId, moniker: { packageName: pkg, descriptor: `${name}().` } };
}
function httpEgress(callerId: string, methodVerb: string, pathTemplate: string) {
  return { callerId, targetDescriptor: { protocol: 'http' as const, http: { method: methodVerb, pathTemplate } } };
}

describe('buildSdkMappings', () => {
  it('derives a row from a moniker-tagged client method whose egress is an http route', () => {
    const result = buildSdkMappings(
      [
        source(
          'acme-api-client',
          [method('fn1', 'listCompanyBookings', 'c1')],
          [httpEgress('fn1', 'GET', '/v2/management/bookings/companies/:companyUuid/company_bookings')],
          [{ id: 'c1', name: 'ApiClient' }],
          [PKG],
        ),
      ],
      baseMapper,
    );
    expect(result.sdkMappings).toHaveLength(1);
    const row = result.sdkMappings[0]!;
    expect(row).toMatchObject({
      sdkPackage: PKG,
      sdkClass: 'ApiClient',
      sdkMethod: 'listCompanyBookings',
      targetService: 'bookings',
    });
    expect(row.http).toMatchObject({
      method: 'GET',
      pathTemplate: '/v2/management/bookings/companies/:companyUuid/company_bookings',
    });
    expect(result.perRepo['acme-api-client']).toEqual({ emitted: 1, noService: 0 });
    // The merged mapper validates and preserves the rest of the base mapper.
    expect(result.mapper.project).toBe('demo');
    expect(result.mapper.sdkMappings).toHaveLength(1);
  });

  it('skips a method whose moniker package is not in the source packages list', () => {
    const result = buildSdkMappings(
      [
        source(
          'src',
          [method('fn1', 'getThing', 'c1', '@other/sdk')],
          [httpEgress('fn1', 'GET', '/v2/management/things/x')],
          [{ id: 'c1', name: 'Client' }],
          [PKG], // restricts to PKG; the method's package is @other/sdk → skipped
        ),
      ],
      baseMapper,
    );
    expect(result.sdkMappings).toHaveLength(0);
    expect(result.perRepo.src).toEqual({ emitted: 0, noService: 0 });
  });

  it('drops a method whose route has no derivable targetService (counts noService)', () => {
    const result = buildSdkMappings(
      [
        source(
          'src',
          [method('fn1', 'ping', 'c1')],
          [httpEgress('fn1', 'GET', '/health/ping')], // does not match the pathRewriteRule
          [{ id: 'c1', name: 'Client' }],
          [PKG],
        ),
      ],
      baseMapper,
    );
    expect(result.sdkMappings).toHaveLength(0);
    expect(result.perRepo.src).toEqual({ emitted: 0, noService: 1 });
  });

  it('skips non-method functions, methods without a moniker, and methods without egress', () => {
    const result = buildSdkMappings(
      [
        source(
          'src',
          [
            { id: 'f1', name: 'freeFn', kind: 'function', moniker: { packageName: PKG, descriptor: 'x' } },
            { id: 'f2', name: 'noMoniker', kind: 'method', classId: 'c1' },
            method('f3', 'noEgress', 'c1'),
          ],
          [], // no egress for any
          [{ id: 'c1', name: 'Client' }],
          [PKG],
        ),
      ],
      baseMapper,
    );
    expect(result.sdkMappings).toHaveLength(0);
  });

  it('dedupes rows by package::class::method', () => {
    const result = buildSdkMappings(
      [
        source(
          'src',
          [method('fn1', 'listX', 'c1'), method('fn2', 'listX', 'c1')],
          [httpEgress('fn1', 'GET', '/v2/management/x/a'), httpEgress('fn2', 'GET', '/v2/management/x/b')],
          [{ id: 'c1', name: 'Client' }],
          [PKG],
        ),
      ],
      baseMapper,
    );
    expect(result.sdkMappings).toHaveLength(1);
    expect(result.perRepo.src).toEqual({ emitted: 1, noService: 0 });
  });
});
