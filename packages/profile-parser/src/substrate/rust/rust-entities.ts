/**
 * Rust persistence entities → `EntityNode[]`. Three sources run together and dedupe on TABLE
 * NAME, because Rust's ORMs describe the same table from more than one place:
 *
 *   1. **diesel `table!`** — the highest-confidence source in the catalog. `schema.rs` is
 *      diesel-cli-generated and more regular than Rails' `db/schema.rb`, and
 *      `joinable!(posts -> users (user_id))` hands over a REAL foreign key, which no other Rust
 *      ORM declares.
 *   2. **Plain-SQL DDL** in the migration globs. Every sqlx project has `migrations/*.sql`, and
 *      `CREATE TABLE users (…)` yields real names, types, nullability, PKs and `REFERENCES`
 *      relations from a text parse. Crucially the entity names it produces EXACTLY match what
 *      `parseSqlOp` extracts from `sqlx::query!` strings, so db-op `entityId` resolution lands
 *      instead of dangling.
 *   3. **Derive macros** — sea-orm's `#[derive(DeriveEntityModel)] + #[sea_orm(table_name)]`
 *      and diesel's `#[derive(Queryable)] + #[diesel(table_name = users)]`.
 *
 * Two naming traps decide whether the entity index is usable at all:
 *
 *   - **`table!` / DDL is authoritative for identity.** `#[derive(Queryable)] struct User` with
 *     `#[diesel(table_name = users)]` describes the SAME table as `table! { users … }`. Emitting
 *     both doubles the entity count and SPLITS db-op attribution across two ids — half the ops
 *     point at `users`, half at `User`, and either answer is half the truth. A derive struct
 *     whose table already exists MERGES into it and registers `structName → entityId`.
 *   - **Every sea-orm entity struct is literally named `Model`.** Naming the EntityNode after
 *     the struct collapses every entity in the repo onto one node. The name is
 *     `PascalCase(singularize(table_name))`, falling back to the module/file stem
 *     (`entity/user.rs` → `User`), and the resolution key is registered by MODULE PATH too,
 *     because that is what `post::Entity::find()` presents at the db-op site.
 */
import { readFileSync } from 'node:fs';
import type { EntityField, EntityNode, EntityRelation, StableIdGenerator } from '@coredoc/core';
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';
import { entityNameFromTable, makeField, parseCreateTables } from '../engine/sql-ddl.js';
import { globMatches } from '../glob.js';
import {
  ENUM_ITEM,
  MACRO_INVOCATION,
  type RustFile,
  STRUCT_ITEM,
  type TsNode,
  attributeKeyValue,
  deriveMacros,
  findAttribute,
  itemName,
} from './rust-cst.js';

export interface RustEntityConfig {
  /** Canonical id generator (seeded for this repo) — mints entity/file ids. */
  idGen: StableIdGenerator;
  /** Repo root, for reading the plain-SQL schema files. */
  repoRoot: string;
  /** Derive macros that mark a struct as persisted. */
  deriveMacros?: string[];
  /** ORM label written onto every emitted entity; default: inferred per source. */
  orm?: string;
  /** Where plain-SQL DDL lives. */
  schemaFileGlobs?: string[];
}

/** A plain-SQL schema/migration file that backed at least one emitted entity. */
export interface RustSchemaFile {
  relPath: string;
  /** Raw text, for the FileNode's content hash and loc. */
  source: string;
}

/** What the extractor hands the db-op lane so its `entityId` resolution can land. */
export interface RustEntityResult {
  entities: EntityNode[];
  /** table name, struct name AND sea-orm module path → entity id (every db-op-site spelling). */
  entityIdByName: Map<string, string>;
  /** Known table names — the db-op receiver gate matches bare diesel DSL roots against these. */
  tableNames: Set<string>;
  /**
   * The `.sql` files an emitted entity's `fileId` points at. They are outside the `.rs` substrate
   * scope, so the parser has no other way to learn they must become FileNodes — without this the
   * DDL entities reference files nobody emitted.
   */
  schemaFiles: RustSchemaFile[];
}

const DEFAULT_DERIVE_MACROS = ['DeriveEntityModel', 'Queryable', 'Insertable'];
// Depth-agnostic on purpose: in a Cargo WORKSPACE the migrations live under the owning crate
// (`crates/api/migrations/…`), not at the repo root, so a root-anchored glob finds nothing.
const DEFAULT_SCHEMA_GLOBS = ['**/migrations/**/*.sql', '**/schema.sql', '**/db/**/*.sql'];

/** A working entity under construction, before ids are minted. */
interface Draft {
  name: string;
  tableName: string;
  relPath: string;
  startLine: number;
  endLine: number;
  orm: string;
  fields: EntityField[];
  relations: EntityRelation[];
  /** Extra names that must resolve to this entity at a db-op site (struct name, module path). */
  aliases: Set<string>;
  /** Raw text the versionedId checksums. */
  checksumText: string;
}

// =============================================================================
// Source 1 — diesel `table!` + `joinable!`
// =============================================================================

/** The header + column lines of one `table!` token tree. */
function parseTableMacro(
  text: string,
): { tableName: string; primaryKeys: string[]; fields: EntityField[] } | undefined {
  // `posts (id) { id -> Int4, … }`; the optional parens name the primary key(s).
  const header = /(?:^|[\s{])([a-zA-Z_][\w]*)\s*(?:\(([^)]*)\))?\s*\{/.exec(text);
  if (!header) return undefined;
  const tableName = header[1];
  const primaryKeys = (header[2] ?? 'id')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fields: EntityField[] = [];
  const body = text.slice(header.index + header[0].length);
  for (const line of body.split('\n')) {
    const col = /^\s*([a-zA-Z_][\w]*)\s*->\s*([^,]+),?\s*$/.exec(line);
    if (!col) continue;
    const type = col[2].trim();
    const nullable = /^Nullable</.test(type);
    fields.push(makeField(col[1], type, { nullable, primaryKey: primaryKeys.includes(col[1]) }));
  }
  return fields.length > 0 ? { tableName, primaryKeys, fields } : undefined;
}

/** `joinable!(posts -> users (user_id))` → a real many-to-one FK on `posts`. */
function parseJoinable(text: string): { from: string; to: string; column: string } | undefined {
  const m = /\(\s*([a-zA-Z_][\w]*)\s*->\s*([a-zA-Z_][\w]*)\s*\(\s*([a-zA-Z_][\w]*)\s*\)\s*\)/.exec(text);
  return m ? { from: m[1], to: m[2], column: m[3] } : undefined;
}

// =============================================================================
// Source 2 — plain-SQL DDL: `splitColumns` / `parseCreateTables` / `entityNameFromTable` live in
// `../engine/sql-ddl.ts`, shared with the Zig substrate's db-op lane; see the call site below.
// =============================================================================

// =============================================================================
// Source 3 — derive macros (sea-orm / diesel)
// =============================================================================

/** The table name a persistence derive declares, from `#[sea_orm(...)]` / `#[diesel(...)]`. */
function declaredTableName(structNode: TsNode): string | undefined {
  for (const attrName of ['sea_orm', 'diesel']) {
    const attr = findAttribute(structNode, [attrName]);
    const value = attr ? attributeKeyValue(attr, 'table_name') : undefined;
    if (value) return value.replace(/["']/g, '');
  }
  return undefined;
}

/** Struct fields → entity fields; `Option<T>` IS the nullability declaration in Rust. */
function structFields(structNode: TsNode): EntityField[] {
  const out: EntityField[] = [];
  for (const fd of structNode.descendantsOfType('field_declaration') as TsNode[]) {
    const name = fd.childForFieldName?.('name')?.text as string | undefined;
    const typeText = (fd.childForFieldName?.('type')?.text ?? '') as string;
    if (!name) continue;
    const primaryKey =
      name === 'id' ||
      (findAttribute(fd, ['sea_orm'])?.childForFieldName?.('arguments')?.text ?? '').includes('primary_key');
    out.push(makeField(name, typeText, { nullable: typeText.startsWith('Option<'), primaryKey }));
  }
  return out;
}

/** sea-orm's `Relation` enum: `#[sea_orm(has_many = "super::post::Entity")]` → a relation. */
function seaOrmRelations(file: RustFile): EntityRelation[] {
  const out: EntityRelation[] = [];
  for (const enumNode of file.root.descendantsOfType(ENUM_ITEM) as TsNode[]) {
    if (itemName(enumNode) !== 'Relation') continue;
    for (const variant of enumNode.descendantsOfType('enum_variant') as TsNode[]) {
      const attr = findAttribute(variant, ['sea_orm']);
      if (!attr) continue;
      const args = (attr.childForFieldName?.('arguments')?.text ?? '') as string;
      const m = /\b(has_many|has_one|belongs_to)\s*=\s*"([^"]+)"/.exec(args);
      if (!m) continue;
      // `super::post::Entity` → module `post` → entity name resolved later via the alias index.
      const segments = m[2].split('::').filter((s) => s !== 'super' && s !== 'Entity');
      const target = segments[segments.length - 1] ?? m[2];
      out.push({
        name: itemName(variant) ?? target,
        type: m[1] === 'has_many' ? 'one-to-many' : m[1] === 'has_one' ? 'one-to-one' : 'many-to-one',
        targetEntityName: target,
      });
    }
  }
  return out;
}

/** The module/file stem of a sea-orm entity file (`src/entity/user.rs` → 'user'). */
function fileStem(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.rs$/, '');
  if (base !== 'mod') return base;
  const dir = relPath.slice(0, relPath.lastIndexOf('/'));
  return dir.slice(dir.lastIndexOf('/') + 1);
}

// =============================================================================
// Assembly
// =============================================================================

export function extractRustEntities(files: RustFile[], cfg: RustEntityConfig): RustEntityResult {
  const idGen = cfg.idGen;
  const derives = cfg.deriveMacros ?? DEFAULT_DERIVE_MACROS;
  const schemaGlobs = cfg.schemaFileGlobs ?? DEFAULT_SCHEMA_GLOBS;

  /** table name → draft. Insertion order is the emit order; `table!`/DDL claim a table first. */
  const byTable = new Map<string, Draft>();
  const fkEdges: { from: string; to: string; column: string }[] = [];

  // --- Source 1: diesel table! / joinable! ---
  for (const file of files) {
    for (const macro of file.root.descendantsOfType(MACRO_INVOCATION) as TsNode[]) {
      const macroName = (macro.childForFieldName?.('macro')?.text ?? '') as string;
      const bare = macroName.slice(macroName.lastIndexOf('::') + 1).replace(/^:+/, '');
      const tree = macro.child(macro.childCount - 1) as TsNode | undefined;
      const text = (tree?.text ?? '') as string;
      if (bare === 'table') {
        const parsed = parseTableMacro(text);
        if (!parsed || byTable.has(parsed.tableName)) continue;
        byTable.set(parsed.tableName, {
          name: entityNameFromTable(parsed.tableName),
          tableName: parsed.tableName,
          relPath: file.relPath,
          startLine: macro.startPosition.row + 1,
          endLine: macro.endPosition.row + 1,
          orm: 'diesel',
          fields: parsed.fields,
          relations: [],
          aliases: new Set(),
          checksumText: text,
        });
      } else if (bare === 'joinable') {
        const j = parseJoinable(text);
        if (j) fkEdges.push(j);
      }
    }
  }

  // --- Source 2: plain-SQL DDL ---
  /** relPath → raw text, for every `.sql` file read; narrowed to the emitted ones at the end. */
  const sqlSources = new Map<string, string>();
  for (const rel of enumerateRepoFiles(cfg.repoRoot)) {
    if (!rel.endsWith('.sql') || !globMatches(rel, schemaGlobs)) continue;
    let sql: string;
    try {
      sql = readFileSync(`${cfg.repoRoot}/${rel}`, 'utf-8');
    } catch {
      continue;
    }
    sqlSources.set(rel, sql);
    for (const draft of parseCreateTables(sql)) {
      const existing = byTable.get(draft.tableName);
      if (!existing) {
        byTable.set(draft.tableName, {
          name: entityNameFromTable(draft.tableName),
          tableName: draft.tableName,
          relPath: rel,
          startLine: sql.slice(0, draft.matchIndex).split('\n').length,
          endLine: sql.slice(0, draft.endIndex).split('\n').length,
          orm: 'sql',
          fields: draft.fields,
          relations: draft.relations,
          aliases: new Set(),
          checksumText: sql.slice(draft.matchIndex, draft.endIndex),
        });
        continue;
      }
      // A `table!` already claimed this table; keep its identity and take only the DDL's
      // relations, which diesel's schema.rs does not express outside `joinable!`.
      for (const r of draft.relations) {
        if (!existing.relations.some((e) => e.name === r.name)) existing.relations.push(r);
      }
    }
  }

  // --- Source 3: derive-marked structs ---
  for (const file of files) {
    for (const structNode of file.root.descendantsOfType(STRUCT_ITEM) as TsNode[]) {
      const structName = itemName(structNode);
      if (!structName) continue;
      const macros = deriveMacros(structNode);
      if (!macros.some((m) => derives.includes(m))) continue;

      const declared = declaredTableName(structNode);
      const isSeaOrm = macros.includes('DeriveEntityModel');
      // sea-orm names EVERY entity struct `Model`, so the struct name is never the entity name
      // there; fall back to the module/file stem when no `table_name` is declared.
      const tableName = declared ?? (isSeaOrm ? fileStem(file.relPath) : structName.toLowerCase());
      const existing = byTable.get(tableName);
      if (existing) {
        // MERGE: the authoritative source already described this table. Register the struct name
        // (and, for sea-orm, its module) so a db-op site spelled either way resolves to ONE id.
        existing.aliases.add(structName);
        if (isSeaOrm) existing.aliases.add(fileStem(file.relPath));
        for (const r of isSeaOrm ? seaOrmRelations(file) : []) {
          if (!existing.relations.some((e) => e.name === r.name)) existing.relations.push(r);
        }
        continue;
      }
      const aliases = new Set<string>([structName]);
      if (isSeaOrm) aliases.add(fileStem(file.relPath));
      byTable.set(tableName, {
        name: isSeaOrm ? entityNameFromTable(tableName) : structName,
        tableName,
        relPath: file.relPath,
        startLine: structNode.startPosition.row + 1,
        endLine: structNode.endPosition.row + 1,
        orm: isSeaOrm ? 'sea-orm' : 'diesel',
        fields: structFields(structNode),
        relations: isSeaOrm ? seaOrmRelations(file) : [],
        aliases,
        checksumText: structNode.text as string,
      });
    }
  }

  // `joinable!` FKs, applied after every table is known so the target id resolves.
  for (const fk of fkEdges) {
    const from = byTable.get(fk.from);
    if (!from || from.relations.some((r) => r.name === fk.column)) continue;
    from.relations.push({ name: fk.column, type: 'many-to-one', targetEntityName: fk.to });
  }

  // Mint ids, then resolve relation targets (a target may be any spelling in the alias index).
  const entityIdByName = new Map<string, string>();
  const drafts = [...byTable.values()];
  for (const d of drafts) {
    const id = idGen.entityId(d.relPath, d.name);
    for (const key of [d.tableName, d.name, ...d.aliases]) {
      if (!entityIdByName.has(key)) entityIdByName.set(key, id);
    }
  }

  const entities: EntityNode[] = drafts.map((d) => {
    const id = idGen.entityId(d.relPath, d.name);
    const relations = d.relations.map((r) => ({
      ...r,
      targetEntityId: entityIdByName.get(r.targetEntityName),
    }));
    return {
      id,
      versionedId: idGen.versionedId(id, d.checksumText),
      name: d.name,
      kind: 'entity',
      fileId: idGen.fileId(d.relPath),
      ormType: cfg.orm ?? d.orm,
      tableName: d.tableName,
      fields: d.fields,
      relations,
      location: { filePath: d.relPath, startLine: d.startLine, endLine: d.endLine },
    };
  });

  // Only the `.sql` files an EMITTED entity actually points at: a migration whose table was
  // already claimed by a `table!` contributes relations to the existing draft and no fileId of
  // its own, so emitting a FileNode for it would add a node nothing references.
  const referencedSqlPaths = new Set(entities.map((e) => e.location.filePath).filter((p) => sqlSources.has(p)));
  const schemaFiles: RustSchemaFile[] = [...referencedSqlPaths].map((relPath) => ({
    relPath,
    source: sqlSources.get(relPath) as string,
  }));

  return { entities, entityIdByName, tableNames: new Set(byTable.keys()), schemaFiles };
}
