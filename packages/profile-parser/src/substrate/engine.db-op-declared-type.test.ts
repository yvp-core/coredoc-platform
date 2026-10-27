/**
 * dbOperations — `entityFrom: { as: 'declared-type' }` (SF-008 C-3).
 *
 * `em.persist(grant)` passes an entity INSTANCE, not the class, so the `identifier` read
 * drops it. `declared-type` reads the entity the code states for that local: its parameter
 * annotation, or its const/let initializer, in the enclosing function. No unique entity →
 * no op.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArgRef, ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const ENTITIES = `declare function Entity(): ClassDecorator;
@Entity() export class Grant { id!: string; }
@Entity() export class Job { id!: string; }
`;

async function run(service: string, entityFrom: ArgRef = { arg: 0, as: 'declared-type' }): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-declared-type-'));
  writeFileSync(join(dir, 'entities.ts'), ENTITIES);
  writeFileSync(
    join(dir, 'service.ts'),
    `import { Grant, Job } from './entities';
declare const em: any;

export class AcmeService {
${service}
}
`,
  );
  const profile: ExtractionProfile = {
    parserId: 'test-declared-type',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    entities: [
      {
        orm: 'mikro-orm',
        detect: { via: 'class-decorator', name: 'Entity' },
        tableName: { fallback: 'snake_case' },
        fields: { decorators: [] },
        relations: { decorators: {}, target: { arg: 0, as: 'arrow-target' } },
      },
    ],
    dbOperations: {
      opMap: { persist: 'create', remove: 'delete', assign: 'update' },
      emReceivers: ['em'],
      entityFrom,
    },
  } as ExtractionProfile;
  const { repo } = await runProfile(profile, dir, 'declared-type-test');
  return repo;
}

const ops = (repo: ParsedRepo) => repo.dbOperations.map((o) => `${o.operation}:${o.entityName}`).sort();

describe('entityFrom declared-type', () => {
  it('reads a parameter annotation, including array forms', async () => {
    const repo = await run(`  save(grant: Grant, jobs: Job[], more: Array<Job>) {
    em.persist(grant);
    em.remove(jobs);
    em.remove(more);
  }`);
    expect(ops(repo)).toEqual(['create:Grant', 'delete:Job', 'delete:Job']);
  });

  it('reads a const/let initializer: create, new, Object.assign, find ?? create', async () => {
    const repo = await run(`  async save(dto: object) {
    const a = em.create(Grant, dto);
    em.persist(a);
    let b = Object.assign(new Job(), dto);
    em.persist(b);
    const c = (await em.findOne(Grant, { id: '1' })) ?? em.create(Grant, dto);
    em.assign(c, dto);
  }`);
    expect(ops(repo)).toEqual(['create:Grant', 'create:Job', 'update:Grant']);
  });

  it('binds the same variable name to a different entity in each function', async () => {
    const repo = await run(`  first() {
    const x = new Grant();
    em.persist(x);
  }
  second() {
    const x = new Job();
    em.persist(x);
  }
  third(x: Job) {
    [1].forEach(() => em.remove(x));
  }`);
    expect(ops(repo)).toEqual(['create:Grant', 'create:Job', 'delete:Job']);
  });

  it('reads a reassigned `let` when every assignment names the same entity', async () => {
    const repo = await run(`  async upsert(dto: object) {
    let x = await em.findOne(Grant, { id: '1' });
    if (!x) x = em.create(Grant, dto);
    em.persist(x);
  }
  async mixed(dto: object) {
    let y = await em.findOne(Grant, { id: '1' });
    if (!y) y = em.create(Job, dto);
    em.persist(y);
  }`);
    expect(ops(repo)).toEqual(['create:Grant']);
  });

  it("reads a same-class method's annotated return type, and infers nothing", async () => {
    const repo = await run(`  private newGrant(dto: object): Grant {
    return em.create(Grant, dto);
  }
  private async loadJob(id: string): Promise<Job> {
    return em.findOneOrFail(Job, { id });
  }
  private newUntyped(dto: object) {
    return em.create(Grant, dto);
  }
  async save(dto: object) {
    const g = this.newGrant(dto);
    em.persist(g);
    const j = await this.loadJob('1');
    em.remove(j);
    const u = this.newUntyped(dto);
    em.persist(u);
  }`);
    expect(ops(repo)).toEqual(['create:Grant', 'delete:Job']);
  });

  it('reads a same-class `find*` method by its return annotation, not as `em.find(Entity)`', async () => {
    const repo = await run(`  private async findOneOrFail(companyId: string, id: string): Promise<Grant> {
    return em.findOneOrFail(Grant, { companyId, id });
  }
  async touch(companyId: string, id: string) {
    const grant = await this.findOneOrFail(companyId, id);
    em.persist(grant);
  }`);
    expect(ops(repo)).toEqual(['create:Grant']);
  });

  it('reads an argument written on its own line', async () => {
    const repo = await run(`  save(grant: Grant) {
    em.persist(
      grant,
    );
  }`);
    expect(ops(repo)).toEqual(['create:Grant']);
  });

  it('drops only the reassigned `let`, not a same-named binding in another function', async () => {
    const repo = await run(`  first(other: Grant) {
    let x = new Grant();
    x = other;
    em.persist(x);
  }
  second() {
    const x = new Job();
    em.persist(x);
  }`);
    expect(ops(repo)).toEqual(['create:Job']);
  });

  it('emits nothing for an untyped local, or one that names two entities', async () => {
    const repo = await run(`  touch(x: any, flag: boolean) {
    const g = new Grant();
    const j = new Job();
    const either = flag ? g : j;
    em.persist(x);
    em.persist(either);
    const pair = em.create(Grant, { job: new Job() }) ?? new Job();
    em.persist(pair);
  }`);
    expect(ops(repo)).toEqual([]);
  });

  it('still reads an entity class argument, and identifier mode ignores instances', async () => {
    const repo = await run(`  save(grant: Grant) {
    em.persist(Job);
    em.persist(grant);
  }`);
    expect(ops(repo)).toEqual(['create:Grant', 'create:Job']);
    const legacy = await run(
      `  save(grant: Grant) {
    em.persist(Job);
    em.persist(grant);
  }`,
      { arg: 0, as: 'identifier' },
    );
    expect(ops(legacy)).toEqual(['create:Job']);
  });
});
