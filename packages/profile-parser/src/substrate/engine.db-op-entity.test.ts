/**
 * dbOperations — repo-receiver entity resolution.
 *
 * Regression for the MikroORM CREATE gap: `this.<repo>.create({...})` where the
 * repo is injected DIRECTLY as `EntityRepository<Customer>` (NestJS-MikroORM
 * `@InjectRepository(Customer)`) must resolve the entity from the field's generic
 * type arg, not just from custom subclasses. Without it the op was emitted with
 * entity='unknown' → entityId=null → the OPERATES_ON edge was dropped.
 */
import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { CodeGraph } from '../facts/graph/graph-builder.js';
import type { BaselineResult } from '../facts/index.js';
import type { ExtractionProfile } from '../types.js';
import { SubstrateProfileEngine } from './engine.js';
import type { CallSite, SubstrateClass, Substrate } from './interface.js';

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

function service(repoType: string): SubstrateClass {
  return {
    name: 'CustomerService',
    decorators: [],
    methods: [
      {
        name: 'createTrialCustomer',
        decorators: [],
        params: [],
        isStatic: false,
        visibility: 'public',
        loc: { filePath: SVC, startLine: 10, endLine: 20 },
      },
    ],
    properties: [],
    ctorParams: [{ name: 'customerRepository', type: repoType }],
    loc: { filePath: SVC, startLine: 5, endLine: 30 },
  };
}

// `this.customerRepository.create({...})` on line 12 — inside createTrialCustomer (10–20).
const createCall: CallSite = {
  calleeText: 'this.customerRepository.create',
  receiver: 'this.customerRepository',
  method: 'create',
  args: [{ text: '{}' }],
  enclosingCallChain: [],
  file: SVC,
  loc: { filePath: SVC, startLine: 12, endLine: 12 },
};

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
    opMap: { create: 'create', persist: 'create' },
    emReceivers: ['em', '*.em'],
    repoReceiverPattern: '/repository$|repo$/i',
    entityFrom: { arg: 0, as: 'identifier' },
    repoBaseClasses: ['EntityRepository', 'BaseRepository'],
  },
} as ExtractionProfile;

function fakeSubstrate(idGen: StableIdGenerator, classes: SubstrateClass[], calls: CallSite[]): Substrate {
  return {
    files: () => [{ relativePath: SVC }, { relativePath: ENT }],
    classes: () => classes,
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
}

function run(classes: SubstrateClass[], calls: CallSite[]) {
  const idGen = new StableIdGenerator('/repo', 'k');
  const engine = new SubstrateProfileEngine(profile, fakeSubstrate(idGen, classes, calls));
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

describe('dbOperations — repo-receiver entity resolution', () => {
  it('resolves the entity from a directly-injected EntityRepository<Customer> generic', () => {
    const repo = run([customerEntity, service('EntityRepository<Customer>')], [createCall]);
    const creates = repo.dbOperations.filter((o) => o.operation === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0].entityName).toBe('Customer');
    // entityId must resolve so the OPERATES_ON edge survives the transformer filter.
    expect(creates[0].entityId).toBeTruthy();
  });

  it('still resolves a custom subclass (CustomerRepository extends EntityRepository<Customer>)', () => {
    const customRepo: SubstrateClass = {
      name: 'CustomerRepository',
      decorators: [],
      methods: [],
      properties: [],
      ctorParams: [],
      extendsClass: { name: 'EntityRepository', typeArgs: ['Customer'] },
      loc: { filePath: 'src/customer.repository.ts', startLine: 1, endLine: 10 },
    };
    const repo = run([customerEntity, customRepo, service('CustomerRepository')], [createCall]);
    const creates = repo.dbOperations.filter((o) => o.operation === 'create');
    expect(creates[0].entityName).toBe('Customer');
    expect(creates[0].entityId).toBeTruthy();
  });

  it('falls back to "unknown" when the repo type names no known entity', () => {
    const repo = run([customerEntity, service('EntityRepository<NotAnEntity>')], [createCall]);
    const creates = repo.dbOperations.filter((o) => o.operation === 'create');
    expect(creates[0].entityName).toBe('unknown');
    expect(creates[0].entityId).toBeFalsy();
  });
});
