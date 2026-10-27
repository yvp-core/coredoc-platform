/**
 * dbOperations — raw-query-only profiles (no ORM, so no `opMap`).
 *
 * Regression for the gitnexus crash: a repo with no ORM declares `dbOperations`
 * with `rawQueries` alone. `extractDbOperations` indexed `rule.opMap[site.method]`
 * unguarded, so the first call shape with a receiver+method blew up — in gitnexus
 * that was `skippedByLang.entries()`, surfacing as
 * "Cannot read properties of undefined (reading 'entries')" and failing the whole parse.
 */
import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { CodeGraph } from '../facts/graph/graph-builder.js';
import type { BaselineResult } from '../facts/pipeline.js';
import type { ExtractionProfile } from '../types.js';
import { SubstrateProfileEngine } from './engine.js';
import type { CallSite, Substrate, SubstrateClass } from './interface.js';

const SVC = 'src/graph-store.ts';

const store: SubstrateClass = {
  name: 'GraphStore',
  decorators: [],
  methods: [
    {
      name: 'loadNodes',
      decorators: [],
      params: [],
      isStatic: false,
      visibility: 'public',
      loc: { filePath: SVC, startLine: 10, endLine: 30 },
    },
  ],
  properties: [],
  ctorParams: [],
  loc: { filePath: SVC, startLine: 1, endLine: 40 },
};

/** The exact shape that crashed: a plain Map iteration, receiver + method, no ORM meaning. */
const entriesCall: CallSite = {
  calleeText: 'skippedByLang.entries',
  receiver: 'skippedByLang',
  method: 'entries',
  args: [],
  enclosingCallChain: [],
  file: SVC,
  loc: { filePath: SVC, startLine: 12, endLine: 12 },
};

const cypherCall: CallSite = {
  calleeText: 'lbug.executeQuery',
  receiver: 'lbug',
  method: 'executeQuery',
  args: [{ text: "'MATCH (n:Function) RETURN n'" }],
  enclosingCallChain: [],
  file: SVC,
  loc: { filePath: SVC, startLine: 14, endLine: 14 },
};

const profile: ExtractionProfile = {
  name: 'fake-raw-only',
  include: ['**/*.ts'],
  exclude: [],
  di: { style: 'constructor-type', stripGenerics: false },
  entities: [],
  dbOperations: {
    rawQueries: [
      {
        dialect: 'cypher',
        methods: ['executeQuery'],
        queryArg: 0,
        receivers: ['lbug$'],
        inPaths: ['src'],
      },
    ],
  },
} as ExtractionProfile;

function run(calls: CallSite[], prof: ExtractionProfile = profile, classes: SubstrateClass[] = [store]) {
  const idGen = new StableIdGenerator('/repo', 'k');
  const substrate = {
    files: () => [{ relativePath: SVC }],
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
  const engine = new SubstrateProfileEngine(prof, substrate);
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

describe('dbOperations — rawQueries without opMap', () => {
  it('does not crash on an ordinary method call when the profile declares no opMap', () => {
    expect(() => run([entriesCall])).not.toThrow();
  });

  it('still extracts raw Cypher queries when opMap is absent', () => {
    const repo = run([entriesCall, cypherCall]);
    const ops = repo.dbOperations;
    expect(ops).toHaveLength(1);
    expect(ops[0].entityName).toBe('Function');
  });
});

describe('dbOperations — raw SQL joins the entity owning the table', () => {
  const job: SubstrateClass = {
    name: 'Job',
    decorators: ["Entity({ tableName: 'jobs' })"],
    methods: [],
    properties: [],
    ctorParams: [],
    loc: { filePath: 'src/job.entity.ts', startLine: 1, endLine: 5 },
  };
  const sqlProfile = {
    ...profile,
    entities: [
      {
        orm: 'mikro-orm',
        detect: { via: 'class-decorator', name: 'Entity' },
        tableName: { option: 'tableName' },
        fields: {},
        relations: {},
      },
    ],
    dbOperations: { rawQueries: [{ dialect: 'sql', methods: ['execute'], receivers: ['client$'] }] },
  } as ExtractionProfile;
  const ops = (text: string) =>
    run(
      [
        {
          calleeText: 'client.execute',
          receiver: 'client',
          method: 'execute',
          args: [{ text }],
          enclosingCallChain: [],
          file: SVC,
          loc: { filePath: SVC, startLine: 12, endLine: 12 },
        },
      ],
      sqlProfile,
      [store, job],
    ).dbOperations.map((o) => [o.operation, o.entityName, o.entityId !== undefined]);

  it('names the entity whose tableName is the quoted SQL table, bound to its node', () => {
    expect(ops(`'update "JOBS" set state = 1'`)).toEqual([['update', 'Job', true]]);
  });

  it('keeps the table name when no entity owns the table', () => {
    expect(ops(`'select * from audit_log'`)).toEqual([['read', 'audit_log', false]]);
  });

  it('reads a query split across concatenated literals', () => {
    expect(ops(`'delete from ' +\n  "jobs " + \`where id = $1\``)).toEqual([['delete', 'Job', true]]);
  });
});
