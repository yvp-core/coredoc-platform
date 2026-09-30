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
import type { BaselineResult } from '../facts/index.js';
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

function run(calls: CallSite[]) {
  const idGen = new StableIdGenerator('/repo', 'k');
  const substrate = {
    files: () => [{ relativePath: SVC }],
    classes: () => [store],
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
  const engine = new SubstrateProfileEngine(profile, substrate);
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
