import { describe, expect, it } from 'vitest';
import { parseRailsSchema } from './ruby-schema.js';

const SCHEMA = `
ActiveRecord::Schema[7.0].define(version: 2024_01_01_000000) do
  enable_extension "pgcrypto"

  create_table "companies", id: :uuid, force: :cascade do |t|
    t.string "name", null: false
    t.string "slug"
    t.datetime "created_at", precision: 6, null: false
    t.uuid "external_id", default: -> { "gen_random_uuid()" }
    t.index ["slug"], name: "index_companies_on_slug", unique: true
    t.index ["name"], name: "index_companies_on_name"
  end

  create_table "events", primary_key: "event_id", force: :cascade do |t|
    t.integer "count", default: 0
    t.references "company", type: :uuid, null: false
    t.belongs_to "owner"
  end
end
`;

describe('parseRailsSchema', () => {
  const tables = parseRailsSchema(SCHEMA);

  it('parses every create_table block into a SchemaTable', () => {
    expect([...tables.keys()].sort()).toEqual(['companies', 'events']);
  });

  it('uses id: :uuid as the primary key and marks the id column', () => {
    const companies = tables.get('companies');
    expect(companies?.primaryKey).toBe('id');
    const id = companies?.columns.find((c) => c.name === 'id');
    expect(id).toMatchObject({
      name: 'id',
      type: 'uuid',
      isPrimaryKey: true,
      isGenerated: true,
      nullable: false,
    });
  });

  it('parses a NOT NULL string column', () => {
    const name = tables.get('companies')?.columns.find((c) => c.name === 'name');
    expect(name).toMatchObject({
      name: 'name',
      type: 'string',
      nullable: false,
      isPrimaryKey: false,
      isGenerated: false,
      unique: false,
    });
  });

  it('parses a nullable column (no null: false)', () => {
    const slug = tables.get('companies')?.columns.find((c) => c.name === 'slug');
    expect(slug?.nullable).toBe(true);
  });

  it('parses a datetime column with the macro as its type', () => {
    const createdAt = tables.get('companies')?.columns.find((c) => c.name === 'created_at');
    expect(createdAt).toMatchObject({ type: 'datetime', nullable: false });
  });

  it('marks a column with a default: -> { } expression as generated', () => {
    const ext = tables.get('companies')?.columns.find((c) => c.name === 'external_id');
    expect(ext?.isGenerated).toBe(true);
    expect(ext?.type).toBe('uuid');
  });

  it('captures a literal defaultValue', () => {
    const count = tables.get('events')?.columns.find((c) => c.name === 'count');
    expect(count?.defaultValue).toBe('0');
    expect(count?.isGenerated).toBe(false);
  });

  it('marks a single-column unique index column as unique (and only that one)', () => {
    const cols = tables.get('companies')?.columns ?? [];
    expect(cols.find((c) => c.name === 'slug')?.unique).toBe(true);
    // non-unique index must NOT mark the column unique
    expect(cols.find((c) => c.name === 'name')?.unique).toBe(false);
  });

  it('honors a custom primary_key option', () => {
    const events = tables.get('events');
    expect(events?.primaryKey).toBe('event_id');
    // a custom string pk does not auto-create an id column
    expect(events?.columns.find((c) => c.name === 'id')).toBeUndefined();
  });

  it('emits a <name>_id column for t.references and t.belongs_to', () => {
    const cols = tables.get('events')?.columns ?? [];
    expect(cols.find((c) => c.name === 'company_id')).toMatchObject({ name: 'company_id', type: 'uuid' });
    expect(cols.find((c) => c.name === 'owner_id')).toMatchObject({ name: 'owner_id' });
  });

  it('returns an empty map for a schema with no create_table blocks', () => {
    expect(parseRailsSchema('# no tables here').size).toBe(0);
  });
});

describe('parseRailsSchema — unique indexes (B3.2)', () => {
  it('captures a composite unique index WITHOUT marking its columns individually unique', () => {
    const schema = parseRailsSchema(`
create_table "memberships", id: :uuid, force: :cascade do |t|
  t.uuid "user_id"
  t.uuid "team_id"
  t.index ["user_id", "team_id"], unique: true
end
`);
    const t = schema.get('memberships');
    expect(t?.uniqueIndexes).toContainEqual(['user_id', 'team_id']);
    // A composite-unique member is NOT individually unique.
    expect(t?.columns.find((c) => c.name === 'user_id')?.unique).toBe(false);
  });

  it('captures single-column unique indexes in uniqueIndexes AND on the column', () => {
    const schema = parseRailsSchema(`
create_table "users", id: :uuid, force: :cascade do |t|
  t.string "email"
  t.index ["email"], unique: true
end
`);
    const t = schema.get('users');
    expect(t?.uniqueIndexes).toContainEqual(['email']);
    expect(t?.columns.find((c) => c.name === 'email')?.unique).toBe(true);
  });

  it('does not record non-unique indexes', () => {
    const schema = parseRailsSchema(`
create_table "posts", id: :uuid, force: :cascade do |t|
  t.string "slug"
  t.index ["slug"]
end
`);
    expect(schema.get('posts')?.uniqueIndexes).toEqual([]);
  });
});
