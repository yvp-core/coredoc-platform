import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type PythonFile, parsePython } from './python-cst.js';
import { UNRESOLVED_PREFIX } from '../../unresolved-sentinel.js';
import { type PythonDbOpConfig, extractPythonDbOps } from './python-dbops.js';

/** Same seed the parser uses — assertions recompute canonical ids through it. */
const ID = new StableIdGenerator('/demo', 'demo');
const USER_ID = ID.entityId('app/models.py', 'User');
const ENTITY_NAMES = new Set(['User']);
const ENTITY_IDS = new Map([['User', USER_ID]]);
const CFG: PythonDbOpConfig = { idGen: ID };

async function pf(relPath: string, source: string): Promise<PythonFile> {
  return { relPath, source, root: await parsePython(source) };
}

const run = (relPath: string, source: string) =>
  pf(relPath, source).then((f) => extractPythonDbOps([f], ENTITY_NAMES, ENTITY_IDS, CFG));

describe('extractPythonDbOps', () => {
  it('classifies a Manager read on a known entity and resolves its id', async () => {
    const { dbOperations, functions } = await run(
      'app/svc.py',
      `def load(pk):
    return User.objects.filter(id=pk)
`,
    );
    expect(dbOperations).toHaveLength(1);
    const op = dbOperations[0];
    expect(op.operation).toBe('read');
    expect(op.entityName).toBe('User');
    expect(op.entityId).toBe(USER_ID);
    expect(op.details).toBe('User.objects.filter(id=pk)');

    // performer is the enclosing `load` def, returned as a FunctionNode.
    const expectedPerformer = ID.functionId('app/svc.py', 'load');
    expect(op.performerId).toBe(expectedPerformer);
    const perf = functions.find((fn) => fn.id === expectedPerformer)!;
    expect(perf).toBeDefined();
    expect(perf.name).toBe('load');
    expect(perf.kind).toBe('function');
  });

  it('maps an instance obj.save() to create with entity unknown (no fabricated id)', async () => {
    const { dbOperations, functions } = await run(
      'app/svc.py',
      `def touch(obj):
    obj.save()
`,
    );
    expect(dbOperations).toHaveLength(1);
    const op = dbOperations[0];
    expect(op.operation).toBe('create');
    expect(op.entityName).toBe('unknown');
    expect(op.entityId).toBeUndefined();
    // The performer FunctionNode is still returned.
    expect(functions.some((fn) => fn.name === 'touch')).toBe(true);
  });

  it('maps Manager create / bulk_create; unknown Capitalized receiver stays unknown', async () => {
    const { dbOperations } = await run(
      'app/svc.py',
      `def make():
    User.objects.create(name='a')
    Widget.objects.bulk_create([1, 2])
`,
    );
    const create = dbOperations.find((o) => o.details?.startsWith('User.objects.create'))!;
    expect(create.operation).toBe('create');
    expect(create.entityName).toBe('User');
    expect(create.entityId).toBe(USER_ID);

    // Widget is Capitalized but not a known entity → unknown, no id (never fabricated).
    const bulk = dbOperations.find((o) => o.details?.startsWith('Widget.objects.bulk_create'))!;
    expect(bulk.operation).toBe('create');
    expect(bulk.entityName).toBe('unknown');
    expect(bulk.entityId).toBeUndefined();
  });

  it('skips module-scope calls (no enclosing def)', async () => {
    const { dbOperations } = await run('app/svc.py', `User.objects.filter(active=True)\n`);
    expect(dbOperations).toHaveLength(0);
  });

  it('ignores a mapped verb that is neither a Manager call nor an instance save/delete', async () => {
    // `.filter` on a plain list is not a DB op (no `.objects.`, not save/delete).
    const { dbOperations } = await run(
      'app/svc.py',
      `def transform(rows):
    return rows.filter(lambda x: x)
`,
    );
    expect(dbOperations).toHaveLength(0);
  });

  it('mints db-op ids through the shared idGen with a real-checksum versionedId', async () => {
    const { dbOperations } = await run(
      'app/svc.py',
      `def load(pk):
    return User.objects.get(pk=pk)
`,
    );
    const op = dbOperations[0];
    const performerId = ID.functionId('app/svc.py', 'load');
    const expectedId = ID.dbOperationId(performerId, 'User', 'read', `app/svc.py:${op.location.startLine}`);
    expect(op.id).toBe(expectedId);
    expect(ID.getStableId(op.versionedId)).toBe(expectedId);
    expect(op.versionedId).not.toBe(`${expectedId}@1`);
  });

  it('captures a chained-queryset write `Model.objects.filter(...).update(...)` as UPDATE on the model (FIX 1)', async () => {
    const MODEL_ID = ID.entityId('app/models.py', 'Model');
    const cfg: PythonDbOpConfig = { idGen: ID };
    const f = await pf(
      'app/svc.py',
      `def f():
    Model.objects.filter(x=1).update(y=2)
`,
    );
    const { dbOperations } = extractPythonDbOps([f], new Set(['Model']), new Map([['Model', MODEL_ID]]), cfg);

    // The outer `.update()` chains off a `.filter()` call node — previously the receiver-chain
    // walk returned [] and the bulk UPDATE was dropped. Now it is captured on Model with an id.
    const updates = dbOperations.filter((o) => o.operation === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].entityName).toBe('Model');
    expect(updates[0].entityId).toBe(MODEL_ID);
    expect(updates[0].details).toBe('Model.objects.filter(x=1).update(y=2)');
  });

  it('recovers the model through the call receiver for `.filter().delete()` (no longer unknown) (FIX 1)', async () => {
    const { dbOperations } = await run(
      'app/svc.py',
      `def purge():
    User.objects.filter(active=False).delete()
`,
    );
    const del = dbOperations.find((o) => o.operation === 'delete')!;
    expect(del).toBeDefined();
    // Root recovered through the chained `.filter()` call — was 'unknown' before the fix.
    expect(del.entityName).toBe('User');
    expect(del.entityId).toBe(USER_ID);
  });

  it('drops a chained write on a non-model queryset (`rows.filter().update()`) (precision-first)', async () => {
    const { dbOperations } = await run(
      'app/svc.py',
      `def bump(rows):
    rows.filter(active=True).update(seen=True)
`,
    );
    // `rows` is neither a `.objects.` Manager chain nor a known model → no DB op fabricated.
    expect(dbOperations).toHaveLength(0);
  });

  it('de-dups structurally identical op sites', async () => {
    const { dbOperations } = await run(
      'app/svc.py',
      `def load():
    User.objects.filter(a=1)
    User.objects.filter(a=1)
`,
    );
    // Two identical calls on different lines are distinct sites → 2 ops.
    expect(dbOperations).toHaveLength(2);
    expect(new Set(dbOperations.map((o) => o.id)).size).toBe(2);
  });
});

describe('extractPythonDbOps — instance mutators are shape-gated', () => {
  // `save`/`delete` are accepted with no Manager in the chain, which on its own matches every
  // `image.save(path)` and `cache.delete(key)` in a repo and emits them against
  // `entityName: 'unknown'`. The ORM mutators take keyword args only; the namesakes take a
  // positional one, so the call's own shape separates them without a receiver-name list.
  it('keeps a no-arg instance save/delete', async () => {
    const { dbOperations } = await run(
      'app/svc.py',
      `def touch(u):
    u.save()
    u.delete()
`,
    );
    expect(dbOperations.map((o) => o.operation).sort()).toEqual(['create', 'delete']);
  });

  it('keeps a kwargs-only save (update_fields=)', async () => {
    const { dbOperations } = await run('app/svc.py', "def touch(u):\n    u.save(update_fields=['name'])\n");
    expect(dbOperations).toHaveLength(1);
  });

  it('drops a positional-arg save/delete (file and cache namesakes)', async () => {
    const { dbOperations } = await run(
      'app/svc.py',
      `def store(image, cache, key, path):
    image.save(path)
    cache.delete(key)
`,
    );
    expect(dbOperations).toEqual([]);
  });
});

describe('extractPythonDbOps — cfg.methods actually fires', () => {
  // The site rule encodes Django's Manager/queryset grammar, which no other ORM follows.
  // Without treating a configured verb as an op site in its own right, `dbOperations.methods`
  // registered a verb that could never match and the only knob on this path was inert.
  it('emits an op for a configured verb with no Manager in the chain (SQLAlchemy shape)', async () => {
    const f = await pf('app/svc.py', 'def load(session, q):\n    return session.execute(q)\n');
    const { dbOperations } = extractPythonDbOps([f], ENTITY_NAMES, ENTITY_IDS, { idGen: ID, methods: ['execute'] });
    expect(dbOperations).toHaveLength(1);
    expect(dbOperations[0].operation).toBe('query');
    expect(dbOperations[0].entityName).toBe('unknown');
  });

  it('does not emit that verb when the profile did not configure it', async () => {
    const { dbOperations } = await run('app/svc.py', 'def load(session, q):\n    return session.execute(q)\n');
    expect(dbOperations).toEqual([]);
  });

  it('does not downgrade a verb already in the default map', async () => {
    const f = await pf('app/svc.py', 'def load(pk):\n    return User.objects.filter(id=pk)\n');
    const { dbOperations } = extractPythonDbOps([f], ENTITY_NAMES, ENTITY_IDS, { idGen: ID, methods: ['filter'] });
    expect(dbOperations[0].operation).toBe('read');
  });
});

describe('extractPythonDbOps — rawQueries (raw-SQL call shapes)', () => {
  const RAW: PythonDbOpConfig = {
    idGen: ID,
    rawQueries: [{ functions: ['sync_execute'], emitUnresolved: true }],
  };
  const rawRun = (source: string, cfg: PythonDbOpConfig = RAW) =>
    pf('app/ch.py', source).then((f) => extractPythonDbOps([f], ENTITY_NAMES, ENTITY_IDS, cfg));

  it('reads a literal SQL argument, including the triple-quoted form', async () => {
    const { dbOperations, functions } = await rawRun(
      `def counts(team_id):
    return sync_execute("""
        SELECT count() FROM sharded_events WHERE team_id = %(team_id)s
    """, {"team_id": team_id})
`,
    );
    expect(dbOperations).toHaveLength(1);
    expect(dbOperations[0].operation).toBe('read');
    expect(dbOperations[0].entityName).toBe('sharded_events');
    expect(functions.some((fn) => fn.name === 'counts')).toBe(true);
  });

  it('resolves a module-level SQL constant referenced by name', async () => {
    const { dbOperations } = await rawRun(
      `INSERT_LOG_ENTRY_SQL = "INSERT INTO log_entries (team_id, message) VALUES"

def write(row):
    sync_execute(INSERT_LOG_ENTRY_SQL, row)
`,
    );
    expect(dbOperations).toHaveLength(1);
    expect(dbOperations[0].operation).toBe('create');
    expect(dbOperations[0].entityName).toBe('log_entries');
  });

  it('resolves a constant reached through .format() and reads DDL verbs', async () => {
    const { dbOperations } = await rawRun(
      `DELETE_SQL = "TRUNCATE TABLE IF EXISTS {table} ON CLUSTER '{cluster}'"

def wipe(table, cluster):
    sync_execute(DELETE_SQL.format(table=table, cluster=cluster))
`,
    );
    expect(dbOperations).toHaveLength(1);
    expect(dbOperations[0].operation).toBe('ddl');
    // The target is an interpolation placeholder, so the op is marked rather than invented.
    expect(dbOperations[0].entityName.startsWith(UNRESOLVED_PREFIX)).toBe(true);
  });

  it('parses what is statically visible in an f-string and marks the rest', async () => {
    const { dbOperations } = await rawRun(
      `def probe(table_name):
    a = sync_execute(f"SELECT COUNT(*) FROM {table_name} LIMIT 1")
    b = sync_execute(f"SELECT * FROM person WHERE team_id = {team_id}")
    return a, b
`,
    );
    expect(dbOperations).toHaveLength(2);
    expect(dbOperations[0].operation).toBe('read');
    expect(dbOperations[0].entityName.startsWith(UNRESOLVED_PREFIX)).toBe(true);
    expect(dbOperations[1].entityName).toBe('person');
  });

  it('marks a runtime-built query and drops it entirely without emitUnresolved', async () => {
    const source = `def run(query, params):
    sync_execute(query, params)
`;
    const marked = await rawRun(source);
    expect(marked.dbOperations).toHaveLength(1);
    expect(marked.dbOperations[0].operation).toBe('query');
    expect(marked.dbOperations[0].entityName.startsWith(UNRESOLVED_PREFIX)).toBe(true);
    expect(marked.dbOperations[0].entityId).toBeUndefined();

    const quiet = await rawRun(source, { idGen: ID, rawQueries: [{ functions: ['sync_execute'] }] });
    expect(quiet.dbOperations).toEqual([]);
  });

  it('matches an attribute-tail callee and honours queryArg', async () => {
    const { dbOperations } = await rawRun(
      `def read(client):
    client.sync_execute(SETTINGS, "SELECT id FROM persons")
`,
      { idGen: ID, rawQueries: [{ functions: ['sync_execute'], queryArg: 1 }] },
    );
    expect(dbOperations).toHaveLength(1);
    expect(dbOperations[0].entityName).toBe('persons');
  });

  it('emits nothing for a raw-query callee the profile did not declare', async () => {
    const { dbOperations } = await rawRun('def counts():\n    return sync_execute("SELECT count() FROM events")\n', {
      idGen: ID,
    });
    expect(dbOperations).toEqual([]);
  });
});

/**
 * BR-4 — the lane's own resolution record. `dbOpSites` counts what the walk ENUMERATED (a
 * matched op call inside a `def`); module-scope calls are uncounted by construction (LIM-4).
 */
describe('extractPythonDbOps — resolution record (BR-4)', () => {
  it('counts enumerated sites, binds resolved entities, puts unknown receivers out of scope', async () => {
    const { dbOperations, stats } = await run(
      'app/svc.py',
      `User.objects.all()

def load(pk):
    return User.objects.filter(id=pk)

def touch(obj):
    obj.save()
`,
    );
    // BR-6: the emitted ops are unchanged — the module-scope call is still dropped.
    expect(dbOperations.map((o) => `${o.operation} ${o.entityName}`)).toEqual(['read User', 'create unknown']);
    expect(stats).toEqual({ dbOpSites: 2, boundDbOps: 1, outOfScopeDbOps: 1 });
    expect(stats.boundDbOps + stats.outOfScopeDbOps).toBeLessThanOrEqual(stats.dbOpSites);
  });

  it('counts boundDbOps from the EMITTED ops, so two identical calls on one line count once', async () => {
    // The two sites share a dedup key (performer|op|entity|line|text), so ONE operation ships.
    // A loop counter reported 2 bound against 1 emitted op — a rate over 100% at the extreme.
    const { dbOperations, stats } = await run(
      'app/svc.py',
      `def load(pk):
    User.objects.filter(id=pk); User.objects.filter(id=pk)
`,
    );
    expect(dbOperations).toHaveLength(1);
    expect(stats.dbOpSites).toBe(2); // both sites are still ENUMERATED
    expect(stats.boundDbOps).toBe(dbOperations.filter((o) => o.entityId !== undefined).length);
    expect(stats.boundDbOps).toBe(1);
  });

  it('counts a DROPPED unresolvable raw query as an in-scope unbound site', async () => {
    const f = await pf('app/raw.py', `def q():\n    sync_execute(build_query())\n`);
    const { dbOperations, stats } = extractPythonDbOps([f], ENTITY_NAMES, ENTITY_IDS, {
      idGen: ID,
      rawQueries: [{ functions: ['sync_execute'] }],
    });
    expect(dbOperations).toEqual([]); // still dropped (no emitUnresolved) — BR-6
    expect(stats).toEqual({ dbOpSites: 1, boundDbOps: 0, outOfScopeDbOps: 0 });
  });
});
