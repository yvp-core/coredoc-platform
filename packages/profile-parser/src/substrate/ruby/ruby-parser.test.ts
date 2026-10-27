import { rubyProvider } from '../../providers/ruby.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { StableIdGenerator } from '@coredoc/core';
import type { ParsedRepo } from '@coredoc/core';
import type { RubyProfile } from '../../types/ruby-profile.js';

/**
 * End-to-end plumbing of the two parse-time records this substrate now fills: the association
 * readers the entity pass feeds into the def index (UC-1/AC-1), and the db-op resolution record
 * (BR-4/AC-3). Both are asserted on the real `rubyProvider.parse` path, because
 * a unit test on either lane cannot prove the wiring between them.
 */
describe('ruby provider parse — association readers and the dbOp record', () => {
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
    repo = await rubyProvider.parse(profile, { repoRoot: FIXTURE, repoName: 'assoc-app', repoKey: 'assoc-app' });
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

/**
 * A Rails route's `handlerId` is the controller action's method node, which is what the graph
 * writer turns into the route's HANDLES edge. An action the repo does not define keeps the
 * synthetic `"<METHOD> <path>"` id, which names no function.
 */
describe('ruby provider parse — Rails route handlers', () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/routes-app');
  const CONTROLLERS = 'app/controllers/admin_api';
  const profile: RubyProfile = { parserId: 'routes-app-v1', substrate: { language: 'ruby', include: ['**/*.rb'] } };
  const idGen = new StableIdGenerator(FIXTURE, 'routes-app');

  let repo: ParsedRepo;
  const handlerOf = (method: string, path: string) =>
    repo.entrypoints.find((e) => e.details.type === 'http' && e.details.method === method && e.details.path === path)
      ?.handlerId;

  beforeAll(async () => {
    repo = await rubyProvider.parse(profile, { repoRoot: FIXTURE, repoName: 'routes-app', repoKey: 'routes-app' });
  }, 60_000);

  it('binds a route to the action its controller defines', () => {
    const create = idGen.methodId(`${CONTROLLERS}/widgets_controller.rb`, 'AdminApi::WidgetsController', 'create');

    expect(handlerOf('POST', '/api/admin/widgets')).toBe(create);
    expect(repo.functions.some((f) => f.id === create)).toBe(true);
  });

  it('binds a route to an action the controller inherits', () => {
    const index = idGen.methodId(
      `${CONTROLLERS}/application_controller.rb`,
      'AdminApi::ApplicationController',
      'index',
    );

    expect(handlerOf('GET', '/api/admin/widgets')).toBe(index);
  });

  it('keeps the synthetic handler for an action the repo does not define', () => {
    expect(handlerOf('DELETE', '/api/admin/widgets/:id')).toBe(
      idGen.functionId('config/routes.rb', 'DELETE /api/admin/widgets/:id'),
    );
  });
});
