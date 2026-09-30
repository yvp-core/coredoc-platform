import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { parseRailsSchema } from './ruby-schema.js';
import { type RubyEntityConfig, extractRubyEntities } from './ruby-entities.js';

/** Same seed the CFG uses — assertions recompute canonical ids through it. */
const ID = new StableIdGenerator('/demo', 'demo');

const SCHEMA = parseRailsSchema(`
ActiveRecord::Schema[7.0].define(version: 1) do
  create_table "departments", id: :uuid, force: :cascade do |t|
    t.string "name", null: false
    t.datetime "created_at", null: false
    t.references "company", type: :uuid
  end

  create_table "user_profiles", id: :uuid, force: :cascade do |t|
    t.string "email", null: false
    t.index ["email"], unique: true
  end
end
`);

const CFG: RubyEntityConfig = {
  idGen: ID,
  baseClasses: ['ApplicationRecord', 'ActiveRecord::Base'],
  orm: 'activerecord',
};

const DEPARTMENT = {
  relPath: 'app/models/department.rb',
  source: `
class Department < ApplicationRecord
  belongs_to :company
  has_many :employees, class_name: "UserProfile"
  has_one :lead, foreign_key: "lead_id", dependent: :destroy
end
`,
};

const USER_PROFILE = {
  relPath: 'app/models/user_profile.rb',
  source: `
class UserProfile < ActiveRecord::Base
  self.table_name = "user_profiles"
  belongs_to :owner, polymorphic: true
end
`,
};

const NOT_AN_ENTITY = {
  relPath: 'app/services/report.rb',
  source: `
class Report < Base
  def run; end
end
`,
};

describe('extractRubyEntities', async () => {
  const { entities, entityIdByName } = await extractRubyEntities(
    [DEPARTMENT, USER_PROFILE, NOT_AN_ENTITY],
    SCHEMA,
    CFG,
  );

  const dept = entities.find((e) => e.name === 'Department');
  const up = entities.find((e) => e.name === 'UserProfile');

  it('extracts only classes whose superclass is a configured base class', () => {
    expect(entities.map((e) => e.name).sort()).toEqual(['Department', 'UserProfile']);
    // Report extends Base, which is NOT in baseClasses -> excluded.
    expect(entities.find((e) => e.name === 'Report')).toBeUndefined();
  });

  it('derives the table name by convention (pluralized snake_case)', () => {
    expect(dept?.tableName).toBe('departments');
  });

  it('honors an explicit self.table_name', () => {
    expect(up?.tableName).toBe('user_profiles');
  });

  it('sets ORM, kind, fileId and canonical StableIdGenerator ids', () => {
    const expectedId = ID.entityId('app/models/department.rb', 'Department');
    expect(dept).toMatchObject({
      kind: 'entity',
      ormType: 'activerecord',
      id: expectedId,
      fileId: ID.fileId('app/models/department.rb'),
    });
    // versionedId is a real content checksum (not the legacy literal @1).
    expect(ID.getStableId(dept?.versionedId ?? '')).toBe(expectedId);
    expect(dept?.versionedId).not.toBe(`${expectedId}@1`);
    expect(ID.belongsToRepo(dept?.id ?? '')).toBe(true);
    expect(dept?.location.filePath).toBe('app/models/department.rb');
    expect(entityIdByName.get('Department')).toBe(expectedId);
  });

  it('maps schema columns into entity fields', () => {
    const name = dept?.fields.find((f) => f.name === 'name');
    expect(name).toMatchObject({
      name: 'name',
      columnName: 'name',
      dbType: 'string',
      isNullable: false,
      isPrimaryKey: false,
      isUnique: false,
    });
    expect(name?.type.text).toBe('string');

    const id = dept?.fields.find((f) => f.name === 'id');
    expect(id).toMatchObject({ isPrimaryKey: true, isGenerated: true });

    const companyId = dept?.fields.find((f) => f.name === 'company_id');
    expect(companyId?.dbType).toBe('uuid');

    const email = up?.fields.find((f) => f.name === 'email');
    expect(email?.isUnique).toBe(true);
  });

  it('maps belongs_to to a many-to-one relation with a classified target', () => {
    const rel = dept?.relations.find((r) => r.name === 'company');
    expect(rel).toMatchObject({ type: 'many-to-one', targetEntityName: 'Company' });
    // Company is not a known entity here -> unresolved id.
    expect(rel?.targetEntityId).toBeUndefined();
  });

  it('maps has_many to one-to-many and resolves class_name override + known target id', () => {
    const rel = dept?.relations.find((r) => r.name === 'employees');
    expect(rel).toMatchObject({
      type: 'one-to-many',
      targetEntityName: 'UserProfile',
      targetEntityId: ID.entityId('app/models/user_profile.rb', 'UserProfile'),
    });
  });

  it('maps has_one with foreign_key and dependent into joinColumn + cascade', () => {
    const rel = dept?.relations.find((r) => r.name === 'lead');
    expect(rel).toMatchObject({
      type: 'one-to-one',
      targetEntityName: 'Lead',
      joinColumn: 'lead_id',
      cascade: ['delete'],
    });
  });

  it('handles a polymorphic belongs_to (target classified from the assoc name, id unresolved)', () => {
    const rel = up?.relations.find((r) => r.name === 'owner');
    expect(rel).toMatchObject({ type: 'many-to-one', targetEntityName: 'Owner' });
    expect(rel?.targetEntityId).toBeUndefined();
  });
});

describe('extractRubyEntities — association target classification (review #14)', () => {
  it('classifies a plural has_many association without double-singularizing', async () => {
    const { entities } = await extractRubyEntities(
      [{ relPath: 'app/models/order.rb', source: 'class Order < ApplicationRecord\n  has_many :statuses\nend\n' }],
      new Map(),
      { idGen: new StableIdGenerator('/r', 'r'), baseClasses: ['ApplicationRecord'], orm: 'active_record' },
    );
    const rel = entities.find((e) => e.name === 'Order')?.relations.find((r) => r.name === 'statuses');
    // classify already singularizes; the old `classify(singularize(...))` produced 'Statu'.
    expect(rel?.targetEntityName).toBe('Status');
  });
});

describe('extractRubyEntities — unique indexes (B3.2)', () => {
  it('emits unique indexes (single + composite) as EntityNode.indexes', async () => {
    const schema = parseRailsSchema(`
ActiveRecord::Schema[7.0].define(version: 1) do
  create_table "memberships", id: :uuid, force: :cascade do |t|
    t.uuid "user_id"
    t.uuid "team_id"
    t.string "email"
    t.index ["email"], unique: true
    t.index ["user_id", "team_id"], unique: true
  end
end
`);
    const { entities } = await extractRubyEntities(
      [{ relPath: 'app/models/membership.rb', source: 'class Membership < ApplicationRecord\nend\n' }],
      schema,
      { idGen: new StableIdGenerator('/r', 'r'), baseClasses: ['ApplicationRecord'], orm: 'active_record' },
    );
    const m = entities.find((e) => e.name === 'Membership');
    expect(m?.indexes).toContainEqual({ columns: ['email'], isUnique: true });
    expect(m?.indexes).toContainEqual({ columns: ['user_id', 'team_id'], isUnique: true });
  });
});

describe('extractRubyEntities — versionedId reflects schema column changes', () => {
  // Same model class body in both parses; only a column flag in schema.rb
  // changes. The version seed must fold the schema-derived columns in, otherwise
  // the incremental cloud diff (which compares versionedId only) keeps stale
  // columns when the model class isn't touched.
  const MODEL = {
    relPath: 'app/models/account.rb',
    source: `\nclass Account < ApplicationRecord\nend\n`,
  };
  const schemaWith = (nullable: string) =>
    parseRailsSchema(`
ActiveRecord::Schema[7.0].define(version: 1) do
  create_table "accounts", id: :uuid, force: :cascade do |t|
    t.string "email", null: ${nullable}
  end
end
`);

  it('changes versionedId when a column nullability changes (model class unchanged)', async () => {
    const a = await extractRubyEntities([MODEL], schemaWith('false'), CFG);
    const b = await extractRubyEntities([MODEL], schemaWith('true'), CFG);
    const ea = a.entities.find((e) => e.name === 'Account');
    const eb = b.entities.find((e) => e.name === 'Account');

    expect(ea).toBeDefined();
    expect(eb).toBeDefined();
    // Same stable id (same name + file), but the content checksum must differ.
    expect(ea!.id).toBe(eb!.id);
    expect(ea!.versionedId).not.toBe(eb!.versionedId);
    // Sanity: the column flag really did change.
    expect(ea!.fields.find((f) => f.name === 'email')?.isNullable).toBe(false);
    expect(eb!.fields.find((f) => f.name === 'email')?.isNullable).toBe(true);
  });
});

/**
 * `associationsByClass` is the call graph's input, not an emitted collection: it must only carry
 * macros written in the model's OWN scope. `associationCalls` scans descendants (which is right
 * for relations), so a macro in a nested class or a `class << self` block is reported on the
 * model — minting a reader from one would invent a method Ruby never defined.
 */
describe('extractRubyEntities — associationsByClass scoping', () => {
  const run = (relPath: string, source: string) => extractRubyEntities([{ relPath, source }], SCHEMA, CFG);

  it('carries the model’s own association macros', async () => {
    const { associationsByClass } = await run(
      'app/models/company.rb',
      `class Company < ApplicationRecord
  has_many :employees
end`,
    );

    expect(associationsByClass.get('Company')?.map((a) => a.name)).toEqual(['employees']);
  });

  it('does not carry a macro declared in a NESTED class inside the model file', async () => {
    const { associationsByClass, entities } = await run(
      'app/models/foo.rb',
      `class Foo < ApplicationRecord
  has_many :employees

  class Bar
    has_many :things
  end
end`,
    );

    expect(associationsByClass.get('Foo')?.map((a) => a.name)).toEqual(['employees']);
    // Emitted relations are untouched by the scoping — still both, exactly as before.
    expect(entities.find((e) => e.name === 'Foo')?.relations.map((r) => r.name)).toEqual(['employees', 'things']);
  });

  it('does not carry a macro declared inside a `class << self` block', async () => {
    const { associationsByClass, entities } = await run(
      'app/models/foo.rb',
      `class Foo < ApplicationRecord
  class << self
    has_many :x
  end
end`,
    );

    expect(associationsByClass.get('Foo')).toEqual([]);
    expect(entities.find((e) => e.name === 'Foo')?.relations.map((r) => r.name)).toEqual(['x']);
  });

  it('does not carry a macro called on ANOTHER object inside a class method', async () => {
    const { associationsByClass, entities } = await run(
      'app/models/company.rb',
      `class Company < ApplicationRecord
  def self.configure(other)
    other.has_many :employees
  end
end`,
    );

    // `other.has_many` declares on whatever `other` is at call time — never on Company.
    expect(associationsByClass.get('Company')).toEqual([]);
    // Emitted relations are untouched by the scoping, exactly as for the other twins.
    expect(entities.find((e) => e.name === 'Company')?.relations.map((r) => r.name)).toEqual(['employees']);
  });

  it('does not carry a BARE macro written inside a def body', async () => {
    const { associationsByClass } = await run(
      'app/models/company.rb',
      `class Company < ApplicationRecord
  def extend_later
    has_many :employees
  end
end`,
    );

    expect(associationsByClass.get('Company')).toEqual([]);
  });
});
