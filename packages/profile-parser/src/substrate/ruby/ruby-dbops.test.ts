import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { extractRubyDbOps } from './ruby-dbops.js';

/**
 * Ruby ActiveRecord DB-OPERATION extraction (P4) — generic ActiveRecord query call
 * sites (`Model.where`, `Model.create`, `record.update`, …) plus raw-SQL execute
 * calls. The method→operation map is GENERIC and configurable; no client model or
 * table names are inlined. Each matched call becomes a `DbOperation` whose performer
 * is the enclosing `def` (a synthesized `FunctionNode`). Entity resolution is
 * best-effort: only a leftmost CONSTANT receiver that is a known entity resolves;
 * everything else is `entityName: 'unknown'`. Module-scope calls (no enclosing def)
 * are skipped.
 */
/** Same seed the parser uses — assertions recompute canonical ids through it. */
const ID = new StableIdGenerator('/demo', 'demo');
// Entity ids are echoed back by dbops from the passed-in map; use canonical ones.
const DEPT_ID = ID.entityId('app/models/department.rb', 'Department');
const USER_ID = ID.entityId('app/models/user.rb', 'User');
const ENTITY_NAMES = new Set(['Department', 'User']);
const ENTITY_IDS = new Map([
  ['Department', DEPT_ID],
  ['User', USER_ID],
]);
const file = (relPath: string, source: string) => [{ relPath, source }];
const run = (relPath: string, source: string) =>
  extractRubyDbOps(file(relPath, source), ENTITY_NAMES, ENTITY_IDS, { idGen: ID });

describe('extractRubyDbOps', () => {
  it('classifies read/create/update and resolves known-entity receivers (generic case)', async () => {
    const { dbOperations, functions } = await run(
      'app/services/foo_service.rb',
      `class FooService
  def run
    Department.where(active: true).first
    User.create(name: 'x')
    self.scope.update_all(seen: true)
  end
end`,
    );

    // One read on Department (id resolved), one create on User (id resolved),
    // one update with an unresolved (non-constant) receiver.
    const dept = dbOperations.find((o) => o.operation === 'read');
    expect(dept?.entityName).toBe('Department');
    expect(dept?.entityId).toBe(DEPT_ID);

    const create = dbOperations.find((o) => o.operation === 'create');
    expect(create?.entityName).toBe('User');
    expect(create?.entityId).toBe(USER_ID);

    const update = dbOperations.find((o) => o.operation === 'update');
    expect(update?.entityName).toBe('unknown');
    expect(update?.entityId).toBeUndefined();

    // `.first` on the Department chain is also a read → 4 ops total (where, first, create, update_all).
    // Every op's performer is the FooService#run def.
    const performerIds = new Set(dbOperations.map((o) => o.performerId));
    expect(performerIds.size).toBe(1);
    const performerId = [...performerIds][0];
    expect(performerId).toContain('FooService.run');

    // Exactly one FunctionNode for the single enclosing def, with matching id.
    expect(functions).toHaveLength(1);
    expect(functions[0]?.id).toBe(performerId);
    expect(functions[0]?.name).toBe('run');
    expect(functions[0]?.kind).toBe('method');
  });

  it('resolves the leftmost root constant through a chain (Model.where(...).first)', async () => {
    const { dbOperations } = await run(
      'app/x.rb',
      `class X
  def go
    Department.where(active: true).first
  end
end`,
    );
    // Both `where` (read) and `first` (read) resolve their root to Department.
    expect(dbOperations).toHaveLength(2);
    for (const op of dbOperations) {
      expect(op.operation).toBe('read');
      expect(op.entityName).toBe('Department');
      expect(op.entityId).toBe(DEPT_ID);
    }
  });

  it('does NOT fabricate an entity from a non-constant / non-known root', async () => {
    const { dbOperations } = await run(
      'app/x.rb',
      `class X
  def go
    self.company.bookings.where(active: true)
  end
end`,
    );
    const op = dbOperations.find((o) => o.operation === 'read');
    expect(op?.entityName).toBe('unknown');
    expect(op?.entityId).toBeUndefined();
  });

  it('treats an unknown CONSTANT root as unknown (not fabricated)', async () => {
    const { dbOperations } = await run(
      'app/x.rb',
      `class X
  def go
    Widget.find(1)
  end
end`,
    );
    const op = dbOperations[0];
    expect(op?.operation).toBe('read');
    // Widget is a constant but NOT in entityNames → unknown, no id.
    expect(op?.entityName).toBe('unknown');
    expect(op?.entityId).toBeUndefined();
  });

  it('skips db-ops at module scope (no enclosing def)', async () => {
    const { dbOperations, functions } = await run('app/x.rb', `User.create(name: 'x')`);
    expect(dbOperations).toEqual([]);
    expect(functions).toEqual([]);
  });

  it('emits one FunctionNode per enclosing def and dedups by id', async () => {
    const { dbOperations, functions } = await run(
      'app/x.rb',
      `class X
  def a
    User.find(1)
    User.create(name: 'y')
  end
  def b
    Department.all
  end
end`,
    );
    // 3 ops, 2 distinct performers (a, b), 2 FunctionNodes.
    expect(dbOperations).toHaveLength(3);
    expect(new Set(dbOperations.map((o) => o.performerId)).size).toBe(2);
    expect(functions).toHaveLength(2);
    expect(new Set(functions.map((f) => f.id)).size).toBe(2);
    expect(functions.map((f) => f.name).sort()).toEqual(['a', 'b']);
  });

  it('covers delete and transaction operations', async () => {
    const { dbOperations } = await run(
      'app/x.rb',
      `class X
  def go
    User.destroy_all
    Department.transaction do
    end
  end
end`,
    );
    const ops = Object.fromEntries(dbOperations.map((o) => [o.operation, o]));
    expect(ops.delete?.entityName).toBe('User');
    expect(ops.transaction?.entityName).toBe('Department');
  });

  it('honors a configurable opMap override', async () => {
    const out = await extractRubyDbOps(
      file(
        'app/x.rb',
        `class X
  def go
    User.upsert_custom(name: 'x')
  end
end`,
      ),
      ENTITY_NAMES,
      ENTITY_IDS,
      { idGen: ID, opMap: { upsert_custom: 'create' } },
    );
    // The default map does not contain upsert_custom; the override makes it a create.
    expect(out.dbOperations).toHaveLength(1);
    expect(out.dbOperations[0]?.operation).toBe('create');
    expect(out.dbOperations[0]?.entityName).toBe('User');
  });

  it('does not match Grape/Rails route DSL verbs (get/post/resource) — not in opMap', async () => {
    const { dbOperations } = await run(
      'app/api/x.rb',
      `class X < Grape::API
  def routes
    get 'industry' do
    end
    resource :widgets do
    end
  end
end`,
    );
    expect(dbOperations).toEqual([]);
  });

  it('records details (call text, sliced) and 1-based location lines', async () => {
    const { dbOperations } = await run(
      'app/x.rb',
      `class X
  def go
    User.create(name: 'x')
  end
end`,
    );
    const op = dbOperations[0];
    expect(op?.details).toContain('User.create');
    // `User.create(...)` sits on line 3 (1-based).
    expect(op?.location.startLine).toBe(3);
    expect(op?.location.endLine).toBe(3);
    expect(op?.location.filePath).toBe('app/x.rb');
  });

  it('assigns canonical db-op ids and content-checksum versionedIds', async () => {
    const { dbOperations } = await run(
      'app/x.rb',
      `class X
  def go
    User.find(1)
    User.create(name: 'z')
  end
end`,
    );
    const ids = dbOperations.map((o) => o.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2); // distinct
    for (const op of dbOperations) {
      expect(ID.belongsToRepo(op.id)).toBe(true);
      expect(op.id).toContain(':db-op:');
      // versionedId is a real content checksum, not the legacy literal @1.
      expect(ID.getStableId(op.versionedId)).toBe(op.id);
      expect(op.versionedId).not.toBe(`${op.id}@1`);
    }
  });

  it('synthesizes a deterministic performerId including class and method', async () => {
    const { dbOperations, functions } = await run(
      'app/services/foo_service.rb',
      `class FooService
  def run
    User.find(1)
  end
end`,
    );
    // Canonical method id: {repoHash}:method:{filePath}:{ClassOrModule}.{method}.
    const expected = ID.methodId('app/services/foo_service.rb', 'FooService', 'run');
    expect(dbOperations[0]?.performerId).toBe(expected);
    expect(functions[0]?.id).toBe(expected);
  });

  it('labels a module-nested def via its enclosing module', async () => {
    const { dbOperations } = await run(
      'app/x.rb',
      `module Admin
  def cleanup
    User.delete_all
  end
end`,
    );
    expect(dbOperations[0]?.performerId).toContain('Admin.cleanup');
  });

  it('processes multiple files independently, emitting distinct canonical db-op ids', async () => {
    const out = await extractRubyDbOps(
      [
        { relPath: 'app/a.rb', source: `class A\n  def x\n    User.find(1)\n  end\nend` },
        { relPath: 'app/b.rb', source: `class B\n  def y\n    Department.all\n  end\nend` },
      ],
      ENTITY_NAMES,
      ENTITY_IDS,
      { idGen: ID },
    );
    const ids = out.dbOperations.map((o) => o.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => ID.belongsToRepo(id))).toBe(true);
    expect(out.functions).toHaveLength(2);
  });

  describe('raw SQL', () => {
    it('extracts a raw execute SELECT and resolves the table to an entity name', async () => {
      // `teams` is not a known entity name; the raw table name is used as-is.
      const { dbOperations } = await run(
        'app/x.rb',
        `class X
  def go
    execute("SELECT * FROM teams")
  end
end`,
      );
      const op = dbOperations.find((o) => o.details?.includes('execute'));
      expect(op?.operation).toBe('read');
      expect(op?.entityName).toBe('teams');
    });

    it('classifies INSERT/UPDATE/DELETE raw SQL verbs and their target table', async () => {
      const { dbOperations } = await run(
        'app/x.rb',
        `class X
  def go
    exec_query("INSERT INTO users (id) VALUES (1)")
    exec_query("UPDATE teams SET x = 1")
    exec_query("DELETE FROM widgets WHERE id = 1")
  end
end`,
      );
      const byOp = Object.fromEntries(dbOperations.map((o) => [o.operation, o]));
      // INSERT INTO users → create; `users` classifies to `User`, a known entity (B3.3).
      expect(byOp.create?.entityName).toBe('User');
      expect(byOp.create?.entityId).toBe(USER_ID);
      // teams/widgets do not classify to a known entity → raw table name.
      expect(byOp.update?.entityName).toBe('teams');
      expect(byOp.delete?.entityName).toBe('widgets');
    });

    it('skips raw-SQL helpers without a static string first arg', async () => {
      const { dbOperations } = await run(
        'app/x.rb',
        `class X
  def go
    execute(some_dynamic_sql)
  end
end`,
      );
      expect(dbOperations).toEqual([]);
    });

    it('bridges a snake_case plural SQL table to its PascalCase entity (B3.3)', async () => {
      // `departments` classifies to `Department`, a known entity → resolves id.
      const { dbOperations } = await run(
        'app/x.rb',
        `class X
  def go
    execute("SELECT * FROM departments WHERE id = 1")
  end
end`,
      );
      const op = dbOperations.find((o) => o.operation === 'read');
      expect(op?.entityName).toBe('Department');
      expect(op?.entityId).toBe(DEPT_ID);
    });

    it('bridges an irregular-plural SQL table (people → Person) (B3.1 + B3.3)', async () => {
      const { dbOperations } = await extractRubyDbOps(
        file('app/x.rb', `class X\n  def go\n    exec_query("SELECT name FROM people")\n  end\nend`),
        new Set(['Person']),
        new Map([['Person', ID.entityId('app/models/person.rb', 'Person')]]),
        { idGen: ID },
      );
      const op = dbOperations.find((o) => o.operation === 'read');
      expect(op?.entityName).toBe('Person');
      expect(op?.entityId).toBe(ID.entityId('app/models/person.rb', 'Person'));
    });

    // Self-review: a schema-qualified table (`public.users`) must resolve to its entity.
    it('strips a schema qualifier before classifying (public.users → User)', async () => {
      const { dbOperations } = await run(
        'app/x.rb',
        `class X
  def go
    execute("SELECT count(*) FROM public.users")
  end
end`,
      );
      const op = dbOperations.find((o) => o.operation === 'read');
      expect(op?.entityName).toBe('User');
      expect(op?.entityId).toBe(USER_ID);
    });
  });
});

/**
 * DB-op resolution record (BR-4): pure observation of what the lane enumerated, counted where
 * the site is enumerated rather than after the filter. Emitted `dbOperations` are unchanged.
 */
describe('extractRubyDbOps — dbOpResolution record', () => {
  const SOURCE = `class ReportService
  def run
    Department.where(active: true)
    self.scope.where(y: 2)
    Kaminari.paginate_array([]).where(x: 1)
  end
end`;

  it('counts every enumerated site, binds only a resolved entity id, and scopes out an undeclared constant', async () => {
    const { dbOperations, stats } = await run('app/services/report_service.rb', SOURCE);

    expect(stats).toEqual({ dbOpSites: 3, boundDbOps: 1, outOfScopeDbOps: 1 });
    // The two unbound sites ARE emitted (unchanged behaviour) — they are counted, not bound.
    expect(dbOperations).toHaveLength(3);
    expect(dbOperations.filter((o) => o.entityName === 'unknown')).toHaveLength(2);
    expect(dbOperations.filter((o) => o.entityId !== undefined)).toHaveLength(1);
    expect(stats.boundDbOps + stats.outOfScopeDbOps).toBeLessThanOrEqual(stats.dbOpSites);
  });

  it('counts boundDbOps from the EMITTED operations, not per enumerated site', async () => {
    const { dbOperations, stats } = await run(
      'app/services/report_service.rb',
      `class ReportService
  def run
    Department.where(active: true); Department.where(active: true)
  end
end`,
    );

    // Two enumerated sites, one emitted operation (identical performer + op + entity + line +
    // text collapse on the dedup key). `boundDbOps` counts what was EMITTED with an entity id,
    // so it can never exceed the operations that exist.
    expect(stats.dbOpSites).toBe(2);
    expect(dbOperations).toHaveLength(1);
    expect(stats.boundDbOps).toBe(dbOperations.filter((o) => o.entityId !== undefined).length);
    expect(stats.boundDbOps).toBe(1);
  });

  it('MUST NOT read a call named after an Object.prototype member as a db operation', async () => {
    const { dbOperations, stats } = await run(
      'app/services/report_service.rb',
      `class ReportService
  def run
    Department.constructor(active: true)
    Department.toString
  end
end`,
    );

    // The method→operation table used to answer `constructor`/`toString` from the prototype
    // chain, emitting an operation whose `operation` was a Function.
    expect(dbOperations).toEqual([]);
    expect(stats).toEqual({ dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 });
  });

  it('does not count a matching call outside any def (module scope is not a site)', async () => {
    const { stats } = await run(
      'app/services/boot.rb',
      `class Boot
  Department.where(active: true)
end`,
    );

    expect(stats).toEqual({ dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 });
  });

  it('does not scope out a constant the repo declares (a service object, not a gem)', async () => {
    const { stats } = await run(
      'app/services/report_service.rb',
      `class Ledger
  def self.rows; end
end

class ReportService
  def run
    Ledger.where(x: 1)
  end
end`,
    );

    expect(stats).toEqual({ dbOpSites: 1, boundDbOps: 0, outOfScopeDbOps: 0 });
  });
});
