import { describe, expect, it } from 'vitest';
import type { ExternalCallTarget } from '../types/output.js';
import type { ExternalCallLike } from './descriptor-matcher.js';
import { isResolved } from './types.js';
import { buildSdkSymbolIndex, matchSymbolHop, type SdkRepoLike, structuralFallbackKey } from './moniker-resolver.js';

const PKG = '@sample/demo-api-client';

const egress: ExternalCallTarget = {
  protocol: 'http',
  http: { method: 'GET', pathTemplate: '/companies/{companyUuid}/daily-summaries' },
  targetService: 'demo-calculations',
};

function sdkRepo(): SdkRepoLike {
  return {
    name: 'shared-packages',
    functions: [
      {
        id: 'fn-dailySummaries',
        name: 'dailySummaries',
        moniker: {
          packageName: PKG,
          descriptor: 'src/lib/clients/`calculations.ts`/CalculationsClient#dailySummaries().',
        },
        egress,
      },
      {
        id: 'fn-noMoniker',
        name: 'helper',
      },
    ],
  };
}

function consumerCall(over: Partial<ExternalCallLike> = {}): ExternalCallLike {
  return {
    id: 'call-1',
    sdkName: PKG,
    method: 'dailySummaries',
    moniker: { packageName: PKG, descriptor: 'src/`index.d.ts`/CalculationsClient#dailySummaries().' },
    ...over,
  } as ExternalCallLike;
}

describe('buildSdkSymbolIndex', () => {
  it('indexes SDK method nodes by packageName::normalizedDescriptor', () => {
    const index = buildSdkSymbolIndex([sdkRepo()]);
    const entry = index.get(`${PKG}::CalculationsClient#dailySummaries`);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      packageName: PKG,
      normalizedDescriptor: 'CalculationsClient#dailySummaries',
      methodNodeId: 'fn-dailySummaries',
      egress,
    });
  });

  it('also inserts an unambiguous structural fallback key (packageName, methodName)', () => {
    const index = buildSdkSymbolIndex([sdkRepo()]);
    expect(index.get(structuralFallbackKey(PKG, 'dailySummaries'))?.methodNodeId).toBe('fn-dailySummaries');
  });

  it('skips method nodes without a moniker', () => {
    const index = buildSdkSymbolIndex([sdkRepo()]);
    expect([...index.values()].some((e) => e.methodNodeId === 'fn-noMoniker')).toBe(false);
  });

  it('does not insert a structural fallback key when the method name is ambiguous across the package', () => {
    const repo: SdkRepoLike = {
      name: 'shared-packages',
      functions: [
        {
          id: 'a',
          name: 'list',
          moniker: { packageName: PKG, descriptor: 'src/`a.d.ts`/Alpha#list().' },
        },
        {
          id: 'b',
          name: 'list',
          moniker: { packageName: PKG, descriptor: 'src/`b.d.ts`/Beta#list().' },
        },
      ],
    };
    const index = buildSdkSymbolIndex([repo]);
    // Both precise keys exist; the shared structural key must not be present.
    expect(index.get(`${PKG}::Alpha#list`)?.methodNodeId).toBe('a');
    expect(index.get(`${PKG}::Beta#list`)?.methodNodeId).toBe('b');
    expect(index.has(structuralFallbackKey(PKG, 'list'))).toBe(false);
  });
});

describe('matchSymbolHop', () => {
  it('resolves a consumer call to the SDK method node via the precise descriptor join', () => {
    const index = buildSdkSymbolIndex([sdkRepo()]);
    const hop = matchSymbolHop(consumerCall(), index);
    expect(isResolved(hop)).toBe(true);
    if (!isResolved(hop)) return;
    expect(hop).toMatchObject({
      kind: 'symbol',
      sourceId: 'call-1',
      targetId: 'fn-dailySummaries',
      via: 'moniker',
    });
    expect(hop.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('falls back to the structural (packageName, methodName) join when the descriptor key misses', () => {
    const index = buildSdkSymbolIndex([sdkRepo()]);
    const hop = matchSymbolHop(
      consumerCall({
        // descriptor that normalizes to a class the SDK source did not export under that name
        moniker: { packageName: PKG, descriptor: 'src/`index.d.ts`/RenamedClient#dailySummaries().' },
      }),
      index,
    );
    expect(isResolved(hop)).toBe(true);
    if (!isResolved(hop)) return;
    expect(hop.targetId).toBe('fn-dailySummaries');
    expect(hop.via).toBe('moniker');
    // structural fallback is lower confidence than the precise join
    expect(hop.confidence).toBeLessThan(0.95);
  });

  it('returns no-moniker-match when the call carries a moniker but neither key hits', () => {
    const index = buildSdkSymbolIndex([sdkRepo()]);
    const hop = matchSymbolHop(
      consumerCall({ moniker: { packageName: PKG, descriptor: 'src/`index.d.ts`/Other#missing().' } }),
      index,
    );
    expect(isResolved(hop)).toBe(false);
    if (isResolved(hop)) return;
    expect(hop).toMatchObject({ sourceId: 'call-1', code: 'no-moniker-match' });
  });

  it('returns no-moniker-match when the call has no moniker at all', () => {
    const index = buildSdkSymbolIndex([sdkRepo()]);
    const hop = matchSymbolHop(consumerCall({ moniker: undefined }), index);
    expect(isResolved(hop)).toBe(false);
    if (isResolved(hop)) return;
    expect(hop.code).toBe('no-moniker-match');
  });
});

describe('owner join (consumer names the member it called through)', () => {
  // Two classes share a method name, so the structural (package, method) key is ambiguous;
  // the owner — class or a client member typed as that class — still pins one method.
  const repo = (memberTypes?: SdkRepoLike['memberTypes']): SdkRepoLike => ({
    name: 'sdk',
    functions: [
      { id: 'core-get', name: 'get', moniker: { packageName: PKG, descriptor: 'src/`core.ts`/Core#get().' }, egress },
      {
        id: 'plan-get',
        name: 'get',
        moniker: { packageName: PKG, descriptor: 'src/`plans.ts`/Plans#get().' },
        egress: { ...egress, http: { method: 'GET', pathTemplate: '/plans' } },
      },
    ],
    memberTypes,
  });
  const call = (descriptor: string) => consumerCall({ method: 'get', moniker: { packageName: PKG, descriptor } });

  it('joins a member segment named like its class, case-insensitively', () => {
    const hop = matchSymbolHop(call('core#get().'), buildSdkSymbolIndex([repo()]));
    expect(isResolved(hop) && hop.targetId).toBe('core-get');
  });

  it('joins a member segment through the client property type (`_billing: Plans`)', () => {
    const hop = matchSymbolHop(
      call('billing#get().'),
      buildSdkSymbolIndex([repo([{ name: '_billing', typeName: 'Plans' }])]),
    );
    expect(isResolved(hop) && hop.targetId).toBe('plan-get');
  });

  it('refuses a segment that resolves to two different methods', () => {
    const index = buildSdkSymbolIndex([repo([{ name: 'core', typeName: 'Plans' }])]);
    const hop = matchSymbolHop(call('core#get().'), index);
    expect(isResolved(hop)).toBe(false);
  });

  it('does not guess for an unknown segment when the method name is ambiguous', () => {
    const hop = matchSymbolHop(call('other#get().'), buildSdkSymbolIndex([repo()]));
    expect(isResolved(hop)).toBe(false);
  });
});

describe('ambiguous fallback keys narrowed by routable egress', () => {
  const fn = (id: string, descriptor: string, e?: ExternalCallTarget) => ({
    id,
    name: 'listX',
    moniker: { packageName: PKG, descriptor },
    egress: e,
  });
  const call = consumerCall({ method: 'listX', moniker: { packageName: PKG, descriptor: 'listX().' } });

  it('prefers the only same-named method that has a routable egress over a delegating wrapper', () => {
    const index = buildSdkSymbolIndex([
      {
        name: 'r',
        functions: [
          fn('wrapper', 'src/`repo.ts`/XRepository#listX().'),
          fn('client', 'src/`c.ts`/Client#listX().', egress),
        ],
      },
    ]);
    const hop = matchSymbolHop(call, index);
    expect(isResolved(hop) && hop.targetId).toBe('client');
  });

  it('resolves duplicates that route to the same place, deterministically', () => {
    const index = buildSdkSymbolIndex([
      {
        name: 'r',
        functions: [
          fn('b-legacy', 'src/`l.ts`/Legacy#listX().', egress),
          fn('a-current', 'src/`c.ts`/Client#listX().', egress),
        ],
      },
    ]);
    const hop = matchSymbolHop(call, index);
    expect(isResolved(hop) && hop.targetId).toBe('a-current');
  });
});
