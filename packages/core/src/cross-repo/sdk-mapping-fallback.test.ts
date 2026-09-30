import { describe, it, expect } from 'vitest';
import { buildSdkMappingIndex } from './sdk-mapping-fallback.js';
import type { ExternalCallLike } from './descriptor-matcher.js';
import type { SdkMapping } from './mapper-schema.js';

function row(
  sdkClass: string,
  sdkMethod: string,
  targetService: string,
  pathTemplate: string,
  sdkPackage = '@sample/api-client',
): SdkMapping {
  return {
    sdkPackage,
    sdkClass,
    sdkMethod,
    targetService,
    http: { method: 'POST', pathTemplate, pathParams: [] },
  } as SdkMapping;
}

/** A call that can only hit the package tier: sdkName is the PACKAGE, not a class. */
function pkgCall(sdkPackage: string, method: string): ExternalCallLike {
  return { id: 'c1', sdkName: sdkPackage, method } as ExternalCallLike;
}

describe('buildSdkMappingIndex package::method tier', () => {
  const ambiguous = [
    row('PlanningSpaceJobTitlesService', 'update', 'planning', '/planning-space-job-titles/:id'),
    row('UserProfilePlanningSpacesService', 'update', 'profiles', '/user-profile-planning-spaces/:id'),
  ];

  it('registers NO package key when one (package, method) declares two distinct routes', () => {
    const index = buildSdkMappingIndex(ambiguous);
    expect(index.lookup(pkgCall('@sample/api-client', 'update'))).toBeUndefined();
  });

  it('produces the same lookup for the reversed row order (order-independent index)', () => {
    const forward = buildSdkMappingIndex(ambiguous);
    const reversed = buildSdkMappingIndex([...ambiguous].reverse());
    const call = pkgCall('@sample/api-client', 'update');
    expect(reversed.lookup(call)).toEqual(forward.lookup(call));
  });

  it('still resolves a package key whose (package, method) has exactly one route', () => {
    const index = buildSdkMappingIndex([
      ...ambiguous,
      row('SchedulesService', 'createSchedule', 'schedules', '/schedules'),
    ]);
    const hit = index.lookup(pkgCall('@sample/api-client', 'createSchedule'));
    expect(hit?.http?.pathTemplate).toBe('/schedules');
  });

  it('resolves a package key whose rows all agree on one route, in either order', () => {
    const duplicates = [row('AliasA', 'lock', 'planning', '/lock'), row('AliasB', 'lock', 'planning', '/lock')];
    const call = pkgCall('@sample/api-client', 'lock');
    const forward = buildSdkMappingIndex(duplicates).lookup(call);
    const reversed = buildSdkMappingIndex([...duplicates].reverse()).lookup(call);
    expect(forward?.http?.pathTemplate).toBe('/lock');
    expect(reversed).toEqual(forward);
  });

  it('keeps the class tier resolving an ambiguous method name by its exact class', () => {
    const index = buildSdkMappingIndex(ambiguous);
    const hit = index.lookup({
      id: 'c1',
      sdkName: 'UserProfilePlanningSpacesService',
      method: 'update',
    } as ExternalCallLike);
    expect(hit?.http?.pathTemplate).toBe('/user-profile-planning-spaces/:id');
  });
});

describe('buildSdkMappingIndex class::method tier', () => {
  // Same (class, method) declared twice under DIFFERENT packages with different
  // routes — the shape that used to resolve to whichever row appeared last in the
  // mapper file, in the tier `lookup` consults first.
  const conflicting = [
    row('ResourcesClient', 'fetch', 'svc-a', '/a', '@sample/a-client'),
    row('ResourcesClient', 'fetch', 'svc-b', '/b', '@sample/b-client'),
  ];
  const classCall = { id: 'c1', sdkName: 'ResourcesClient', method: 'fetch' } as ExternalCallLike;

  it('registers NO class key when one (class, method) declares two distinct routes', () => {
    expect(buildSdkMappingIndex(conflicting).lookup(classCall)).toBeUndefined();
  });

  it('produces the same lookup for the reversed row order (order-independent index)', () => {
    const forward = buildSdkMappingIndex(conflicting);
    const reversed = buildSdkMappingIndex([...conflicting].reverse());
    expect(reversed.lookup(classCall)).toEqual(forward.lookup(classCall));
  });

  it('still resolves a class key whose rows all agree on one route, in either order', () => {
    const duplicates = [
      row('ResourcesClient', 'fetch', 'svc-a', '/a', '@sample/a-client'),
      row('ResourcesClient', 'fetch', 'svc-a', '/a', '@sample/b-client'),
    ];
    const forward = buildSdkMappingIndex(duplicates).lookup(classCall);
    const reversed = buildSdkMappingIndex([...duplicates].reverse()).lookup(classCall);
    expect(forward?.http?.pathTemplate).toBe('/a');
    expect(reversed).toEqual(forward);
  });
});
