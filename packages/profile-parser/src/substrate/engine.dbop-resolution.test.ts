/**
 * `stats.dbOpResolution` for the TypeScript/JS engine (spec UC-3, BR-4, BR-6, LIM-4).
 *
 * Counted in SITES: `dbOpSites` counts every `callShapes()` site whose method is in the
 * profile's `opMap` and that has a receiver — counted BEFORE the caller/receiver filters, so a
 * site the engine then drops still shows up as a miss. `boundDbOps` counts the emitted
 * operations that carry a resolved `entityId` (`unknown` is not bound). `outOfScopeDbOps`
 * counts sites whose receiver matches none of the profile's receiver families and names no
 * in-repo entity or repository class.
 */
import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { CodeGraph } from '../facts/graph/graph-builder.js';
import type { BaselineResult } from '../facts/pipeline.js';
import type { ExtractionProfile } from '../types.js';
import { SubstrateProfileEngine } from './engine.js';
import type { CallSite, Substrate, SubstrateClass } from './interface.js';

const SVC = 'src/customer.service.ts';
const ENT = 'src/customer.entity.ts';

const customerEntity: SubstrateClass = {
  name: 'Customer',
  decorators: ['Entity()'],
  methods: [],
  properties: [
    { name: 'uuid', decorators: ['PrimaryKey()'], type: 'string', loc: { filePath: ENT, startLine: 2, endLine: 2 } },
  ],
  ctorParams: [],
  loc: { filePath: ENT, startLine: 1, endLine: 5 },
};

const service: SubstrateClass = {
  name: 'CustomerService',
  decorators: [],
  methods: [
    {
      name: 'createTrialCustomer',
      decorators: [],
      params: [],
      isStatic: false,
      visibility: 'public',
      loc: { filePath: SVC, startLine: 10, endLine: 40 },
    },
  ],
  properties: [],
  ctorParams: [{ name: 'customerRepository', type: 'EntityRepository<Customer>' }],
  loc: { filePath: SVC, startLine: 5, endLine: 50 },
};

function call(calleeText: string, receiver: string, method: string, startLine: number, args: CallSite['args'] = []) {
  return {
    calleeText,
    receiver,
    method,
    args,
    enclosingCallChain: [],
    file: SVC,
    loc: { filePath: SVC, startLine, endLine: startLine },
  } as CallSite;
}

/** Bound: the injected `EntityRepository<Customer>` resolves the entity. */
const BOUND = call('this.customerRepository.create', 'this.customerRepository', 'create', 12, [{ text: '{}' }]);
/** In scope, unbound (LIM-4): `em.flush()` is a real db op the engine cannot attribute. */
const EM_FLUSH = call('this.em.flush', 'this.em', 'flush', 14);
/** Out of scope: an external ORM constant naming no in-repo entity or repository class. */
const OUT_OF_SCOPE = call('Sequelize.Op.create', 'Sequelize.Op', 'create', 16, [{ text: '{}' }]);

const profile: ExtractionProfile = {
  name: 'fake',
  include: ['**/*.ts'],
  exclude: [],
  di: { style: 'constructor-type', stripGenerics: true },
  entities: [
    {
      orm: 'mikro-orm',
      detect: { via: 'class-decorator', name: 'Entity' },
      tableName: { fallback: 'snake_case' },
      fields: { decorators: ['Property', 'PrimaryKey'], pk: 'PrimaryKey' },
      relations: { decorators: { ManyToOne: 'many-to-one' }, target: { arg: 0, as: 'arrow-target' } },
    },
  ],
  dbOperations: {
    opMap: { create: 'create', flush: 'update' },
    emReceivers: ['em', '*.em'],
    repoReceiverPattern: '/repository$|repo$/i',
    entityFrom: { arg: 0, as: 'identifier' },
    repoBaseClasses: ['EntityRepository', 'BaseRepository'],
  },
} as ExtractionProfile;

function run(calls: CallSite[], p: ExtractionProfile = profile) {
  const idGen = new StableIdGenerator('/repo', 'k');
  const substrate = {
    files: () => [{ relativePath: SVC }, { relativePath: ENT }],
    classes: () => [customerEntity, service],
    functions: () => [],
    callShapes: () => calls,
    resolveConst: () => undefined,
    resolveConstMember: () => undefined,
    requireRegistry: () => new Map(),
    internalCalls: () => [],
    externalCalls: () => [],
    hasFunctionId: () => true,
    resolveMethodOnClass: () => undefined,
    functionId: () => undefined,
    componentSites: () => [],
    resolveJsxTagBySCIP: () => undefined,
    resolveJsxTagByImport: () => undefined,
    routeSites: () => [],
    stateStoreSites: () => [],
    idGen,
  } as unknown as Substrate;
  const engine = new SubstrateProfileEngine(p, substrate);
  const baseline = {
    graph: new CodeGraph(),
    idGen,
    errors: [],
    plan: {
      vueFiles: [],
      languages: {
        typescript: { fileCount: 0, files: [] },
        javascript: { fileCount: 0, files: [] },
      },
    },
  } as unknown as BaselineResult;
  return engine.run(baseline, { repoRoot: '/repo', repoName: 'fake' });
}

describe('engine — stats.dbOpResolution', () => {
  it('counts one bound op, one out-of-scope receiver and one in-scope unbound site', () => {
    const repo = run([BOUND, EM_FLUSH, OUT_OF_SCOPE]);

    expect(repo.stats.dbOpResolution).toEqual({ dbOpSites: 3, boundDbOps: 1, outOfScopeDbOps: 1 });
    const { dbOpSites, boundDbOps, outOfScopeDbOps } = repo.stats.dbOpResolution as {
      dbOpSites: number;
      boundDbOps: number;
      outOfScopeDbOps: number;
    };
    expect(boundDbOps + outOfScopeDbOps).toBeLessThanOrEqual(dbOpSites);

    // BR-6: the emitted operations are exactly what they were before the record existed —
    // only the bound `create` ships; `em.flush()` and the external constant emit nothing.
    expect(repo.dbOperations.map((o) => `${o.operation} ${o.entityName} ${o.entityId ? 'id' : 'no-id'}`)).toEqual([
      'create Customer id',
    ]);
  });

  it('leaves a site with no enclosing function UNCOUNTED', () => {
    // Line 99 is outside every class and function span, so the site has no caller node to
    // attribute an operation to. Every other substrate drops such a site before counting
    // (Ruby/Python/Swift's `if (!def) continue`); the TS engine matches them, so it is not a
    // miss — it is uncounted by construction. The in-function sibling still counts.
    const outsideAnyFunction = call('this.customerRepository.create', 'this.customerRepository', 'create', 99, [
      { text: '{}' },
    ]);
    const repo = run([BOUND, outsideAnyFunction]);

    expect(repo.stats.dbOpResolution).toEqual({ dbOpSites: 1, boundDbOps: 1, outOfScopeDbOps: 0 });
    // BR-6: the uncounted site emitted nothing before the record existed either.
    expect(repo.dbOperations).toHaveLength(1);
  });

  it('is present on stats whenever the profile declares dbOperations', () => {
    expect(run([]).stats.dbOpResolution).toEqual({ dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 });
  });

  it('counts a site TWO raw-query matchers claim exactly once (followups G-2)', () => {
    // The site key is `callerId|file:line|expression`, the same key the call lane uses. Two
    // matchers naming the same method describe ONE call expression; counting it per matcher
    // inflated the denominator and deflated the rate without any site being missed.
    const twoMatchers = {
      ...profile,
      dbOperations: {
        ...profile.dbOperations,
        rawQueries: [{ methods: ['query'] }, { methods: ['query'] }],
      },
    } as ExtractionProfile;
    const raw = call('this.db.query', 'this.db', 'query', 12, [{ text: "'SELECT * FROM customer'" }]);

    const repo = run([raw], twoMatchers);

    expect(repo.stats.dbOpResolution).toEqual({ dbOpSites: 1, boundDbOps: 0, outOfScopeDbOps: 0 });
    // BR-6: both matchers mint the same operation id, so one op ships — as before.
    expect(repo.dbOperations).toHaveLength(1);
  });
});
