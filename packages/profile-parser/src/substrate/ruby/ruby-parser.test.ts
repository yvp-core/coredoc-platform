import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { StableIdGenerator } from '@coredoc/core';
import type {
  ClassNode,
  DbOperation,
  EntityNode,
  Entrypoint,
  ExternalCallEdge,
  FileNode,
  FunctionNode,
  ParsedRepo,
} from '@coredoc/core';
import type { RubyProfile } from '../../types/ruby-profile.js';
import { type RubyParsedRepo, parseRubyRepo, toFullParsedRepo } from './ruby-parser.js';

/**
 * `toFullParsedRepo` adapts the Ruby parser's `RubyParsedRepo` to a full `ParsedRepo`
 * for the CLI parse → push → DB flow (the transformer + MCP/docs consume `ParsedRepo`).
 * It carries the Ruby-extracted facts and fills the TS/SCIP-only collections empty.
 */
describe('toFullParsedRepo', () => {
  const ep = { id: 'r:ep:GET:/x', type: 'http' } as unknown as Entrypoint;
  const entity = { id: 'r:entity:User', name: 'User', kind: 'entity' } as unknown as EntityNode;
  const dbop = { id: 'r:dbop:0', entityName: 'User', operation: 'read' } as unknown as DbOperation;
  const fn = { id: 'r:rbfn:a.rb:Svc#run:1', name: 'run', kind: 'method' } as unknown as FunctionNode;
  const ec = { id: 'r:ec:0', method: 'GET' } as unknown as ExternalCallEdge;
  const file = { id: 'r:file:a.rb', path: 'a.rb' } as unknown as FileNode;
  const cls = { id: 'r:class:a.rb:Svc', name: 'Svc', kind: 'class' } as unknown as ClassNode;

  const ruby: RubyParsedRepo = {
    id: 'repo:demo',
    name: 'demo',
    entrypoints: [ep],
    externalCalls: [ec],
    functions: [fn],
    type: 'backend',
    httpPrefix: '/api',
    entities: [entity],
    dbOperations: [dbop],
    packages: [{ id: 'r:package:.', name: 'demo', path: '.' }],
    files: [file],
    classes: [cls],
    errors: [],
    parseStats: { totalFiles: 2, parsedFiles: 1, skippedFiles: 1, parseTimeMs: 42 },
  };

  it('carries Ruby facts and fills the TS-only collections empty, with computed stats', () => {
    const full = toFullParsedRepo(ruby, '/repo/path', 'rails-v1', '2026-06-20T00:00:00Z');

    // Carried Ruby facts
    expect(full.entrypoints).toHaveLength(1);
    expect(full.entities).toHaveLength(1);
    expect(full.dbOperations).toHaveLength(1);
    expect(full.functions).toHaveLength(1);
    expect(full.externalCalls).toHaveLength(1);

    // Required ParsedRepo metadata
    expect(full.id).toBe('repo:demo');
    expect(full.name).toBe('demo');
    expect(full.path).toBe('/repo/path');
    expect(full.parserId).toBe('rails-v1');
    expect(full.parsedAt).toBe('2026-06-20T00:00:00Z');
    // Bumped again with the synthesized association readers (new node ids), the `.new` →
    // `initialize` constructor edges and the retargeted mixin/ancestry edges: GUARDRAILS #3
    // names "a re-parse with the same parser version produces different IDs" as the failure
    // this stamp exists to make visible.
    expect(full.parserVersion).toBe('1.4.0-ruby');

    // Structure nodes come through from the parser
    expect(full.packages).toHaveLength(1);
    expect(full.files).toEqual([file]);
    expect(full.classes).toEqual([cls]);

    // Collections Ruby has no lane for are empty (not undefined — the transformer iterates them)
    expect(full.calls).toEqual([]);
    expect(full.imports).toEqual([]);
    expect(full.interfaces).toEqual([]);

    // Stats reflect the Ruby facts and the parser's own file counts
    expect(full.stats.totalEntrypoints).toBe(1);
    expect(full.stats.totalEntities).toBe(1);
    expect(full.stats.totalFunctions).toBe(1);
    expect(full.stats.totalExternalCalls).toBe(1);
    expect(full.stats.totalClasses).toBe(1);
    expect(full.stats.totalFiles).toBe(2);
    expect(full.stats.parsedFiles).toBe(1);
    expect(full.stats.skippedFiles).toBe(1);
    expect(full.stats.parseTimeMs).toBe(42);

    // `httpPrefix` is not a ParsedRepo field (applied at link time, not parse).
    expect('httpPrefix' in full).toBe(false);
  });

  it('carries the in-repo call-resolution record through to ParseStats, and omits it when absent', () => {
    const measured = toFullParsedRepo(
      {
        ...ruby,
        parseStats: { ...ruby.parseStats, callResolution: { callSites: 9, resolvedCalls: 4, outOfScopeCalls: 3 } },
      },
      '/repo/path',
      'rails-v1',
      '2026-06-20T00:00:00Z',
    );
    expect(measured.stats.callResolution).toEqual({ callSites: 9, resolvedCalls: 4, outOfScopeCalls: 3 });
    expect(
      toFullParsedRepo(ruby, '/repo/path', 'rails-v1', '2026-06-20T00:00:00Z').stats.callResolution,
    ).toBeUndefined();
  });
});

/**
 * End-to-end plumbing of the two parse-time records this substrate now fills: the association
 * readers the entity pass feeds into the def index (UC-1/AC-1), and the db-op resolution record
 * (BR-4/AC-3). Both are asserted on the real `parseRubyRepo` → `toFullParsedRepo` path, because
 * a unit test on either lane cannot prove the wiring between them.
 */
describe('parseRubyRepo — association readers and the dbOp record', () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/assoc-app');
  const MODEL = 'app/models/company.rb';
  const profile: RubyProfile = {
    parserId: 'assoc-app-v1',
    substrate: { language: 'ruby', include: ['**/*.rb'] },
    entities: { orm: 'activerecord', baseClasses: ['ApplicationRecord'], modelGlob: 'app/models/**' },
    dbOperations: {},
  };

  let repo: ParsedRepo;
  let readerId: string;

  beforeAll(async () => {
    const ruby = await parseRubyRepo(FIXTURE, 'assoc-app', { repoKey: 'assoc-app' }, profile);
    repo = toFullParsedRepo(ruby, FIXTURE, 'assoc-app-v1', '2026-09-18T00:00:00Z');
    readerId = new StableIdGenerator(FIXTURE, 'assoc-app').methodId(MODEL, 'Company', 'employees');
  }, 60_000);

  it('carries the synthesized reader into functions[] and the model ClassNode', () => {
    const reader = repo.functions.find((f) => f.id === readerId);

    expect(reader?.synthesized).toBe('ruby-association');
    expect(reader?.name).toBe('employees');
    expect(reader?.parameters).toEqual([]);
    expect(repo.classes.find((c) => c.name === 'Company')?.methods).toContain(readerId);
    // …and no entrypoint is minted for it (BR-1).
    expect(repo.entrypoints.some((e) => e.handlerId === readerId)).toBe(false);
  });

  it('ships the in-model self send as a call edge to the reader', () => {
    expect(repo.calls.some((c) => c.calleeId === readerId && c.provenance === 'rb-self')).toBe(true);
  });

  it('reaches ParseStats with the dbOp resolution record', () => {
    expect(repo.stats.dbOpResolution).toEqual({ dbOpSites: 3, boundDbOps: 1, outOfScopeDbOps: 1 });
  });
});
