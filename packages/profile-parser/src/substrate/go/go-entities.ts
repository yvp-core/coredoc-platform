/**
 * Go persistence entities → `EntityNode[]`. Four sources run together and dedupe on TABLE NAME,
 * because a Go repo describes the same table from more than one place:
 *
 *   1. **Plain-SQL DDL** in the schema globs — the highest-fidelity source in Go exactly as it is
 *      in Rust. sqlc, goose and golang-migrate all keep real `CREATE TABLE` statements in the repo,
 *      so the text parse yields real column names, types, nullability, PKs and `REFERENCES`
 *      relations. Crucially the names it produces are the same ones `parseSqlOp` reads out of the
 *      raw SQL in the code (`db.Query("SELECT … FROM users")`), so db-op `entityId` resolution
 *      LANDS instead of dangling.
 *   2. **Struct tags naming a column** — `db:"id"` (sqlx, pgx/scany) and `gorm:"column:id"`. The
 *      presence of a configured tag key is what marks a struct persisted; nothing keys on a path.
 *   3. **GORM model structs** — embedding `gorm.Model`, or declaring `TableName() string`. Those
 *      say "table" without any per-field tag at all.
 *   4. **A struct whose name matches a table the DDL already declared** — this is the
 *      sqlc-generated `models.go` case. sqlc emits `type User struct` for table `users`, with NO
 *      tags unless the repo opts into `emit_json_tags` / `emit_db_tags`, so nothing about the
 *      struct itself marks it persisted. This lane MERGES ONLY — it never creates an entity — so a
 *      false positive costs one lookup key, never a phantom table. It is detected by name against
 *      the DDL, not by filename and not by any repo-specific path.
 *
 * Two decisions carry most of the precision:
 *
 *   - **`json` is NOT a default tag key.** A `json:`-tagged struct is an API DTO far more often
 *     than a table (`LoginRequest`, `UserResponse`), so defaulting it on would emit hundreds of
 *     entities that no db-op ever touches — the "entities but 0 dbOperations" red flag, and the
 *     same trap Rust documents for `sqlx::FromRow` projections. A repo whose sqlc config sets
 *     `emit_json_tags` AND keeps no DDL in scope opts in with `structTags: ['db', 'gorm', 'json']`.
 *   - **DDL is authoritative for identity.** `CREATE TABLE users` and `type User struct` describe
 *     ONE table. Emitting both doubles the entity count and SPLITS db-op attribution across two
 *     ids — half the ops point at `users`, half at `User`, and either answer is half the truth. A
 *     struct whose table already exists merges into it and registers `User → entityId`, which is
 *     exactly the spelling the GORM lane of `go-dbops.ts` looks up (`&User{}`).
 *
 * Tier-B gaps, deliberately not guessed:
 *   - An embedded struct other than `gorm.Model` (`type Admin struct { Base }`) contributes no
 *     columns; flattening it needs cross-package type resolution this lane does not do.
 *   - A `TableName()` that returns a constant or a `fmt.Sprintf` rather than a literal is unread.
 *   - Struct-to-struct relations resolve within one PACKAGE (directory), which is Go's own scoping
 *     rule for an unqualified type name; a model referenced across packages (`db.User`) loses its
 *     qualifier in the CST and is not resolved here.
 */
import { readFileSync } from 'node:fs';
import type { EntityField, EntityNode, EntityRelation, StableIdGenerator } from '@coredoc/core';
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';
import { singularize, snakeCase } from '../engine/text-helpers.js';
import { globMatches } from '../glob.js';
import {
  FIELD_DECLARATION,
  FIELD_DECLARATION_LIST,
  type GoFile,
  INTERPRETED_STRING_LITERAL,
  METHOD_DECLARATION,
  RAW_STRING_LITERAL,
  RETURN_STATEMENT,
  STRUCT_TYPE,
  TYPE_SPEC,
  type TsNode,
  baseTypeName,
  fieldNames,
  goStringValue,
  isExported,
  itemName,
  namedChildrenOfType,
  receiverTypeName,
  structTags,
} from './go-cst.js';

export interface GoEntityConfig {
  /** Canonical id generator (seeded for this repo) — mints entity/file ids. */
  idGen: StableIdGenerator;
  /** Repo root, for reading the plain-SQL schema files. */
  repoRoot: string;
  /** Struct-tag keys that mark a struct as persisted. */
  structTags?: string[];
  /** ORM label written onto every emitted entity; default: inferred per source. */
  orm?: string;
  /** Where plain-SQL DDL lives. */
  schemaFileGlobs?: string[];
}

/** What the extractor hands the db-op lane so its `entityId` resolution can land. */
export interface GoEntityResult {
  entities: EntityNode[];
  /** table name, entity name AND struct name → entity id (every db-op-site spelling). */
  entityIdByName: Map<string, string>;
  /** Known table names — the db-op lane falls back to these when no entity id answers. */
  tableNames: Set<string>;
}

/**
 * `db` is sqlx / pgx / scany / sqlc-with-`emit_db_tags`; `gorm` is GORM's own tag. `json` is
 * deliberately absent — see the module comment.
 */
const DEFAULT_STRUCT_TAGS: string[] = ['db', 'gorm'];

// Depth-agnostic on purpose: in a multi-module Go repo the migrations live under the owning module
// (`services/api/migrations/…`), not at the repo root, so a root-anchored glob finds nothing.
const DEFAULT_SCHEMA_GLOBS: string[] = ['**/migrations/**/*.sql', '**/schema.sql', '**/db/**/*.sql'];

/** GORM's tag key — its column name lives INSIDE the value (`column:id`), unlike `db:"id"`. */
const GORM_TAG = 'gorm';
/** The embedded type that makes a struct a GORM model without any per-field tag. */
const GORM_MODEL_TYPE = 'gorm.Model';
/** GORM's explicit table override: `func (User) TableName() string { return "app_users" }`. */
const TABLE_NAME_METHOD = 'TableName';

/** ORM labels this lane stamps. `go` is the honest answer when no library identifies itself. */
enum GoOrm {
  /** A `CREATE TABLE` in the repo's own migrations. */
  Sql = 'sql',
  /** `gorm.Model`, a `gorm:` tag or a `TableName()` method. */
  Gorm = 'gorm',
  /**
   * A `db:`-tagged struct. The tag alone does NOT name a library — sqlx, pgx/scany and sqlc all
   * emit it — so guessing `sqlx` here would be a fabrication; the language is what we actually know.
   */
  Go = 'go',
}

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
  /** Extra names that must resolve to this entity at a db-op site (the Go struct name). */
  aliases: Set<string>;
  /** Raw text the versionedId checksums. */
  checksumText: string;
}

function makeField(
  name: string,
  columnName: string,
  type: string,
  opts: { dbType?: string; nullable?: boolean; primaryKey?: boolean; unique?: boolean } = {},
): EntityField {
  return {
    name,
    columnName,
    type: { text: type },
    dbType: opts.dbType ?? type,
    isPrimaryKey: opts.primaryKey ?? false,
    isNullable: opts.nullable ?? false,
    isUnique: opts.unique ?? false,
    isGenerated: false,
  };
}

/** `users` → `User`; `user_profiles` → `UserProfile`. */
function entityNameFromTable(table: string): string {
  return singularize(table)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Naive plural of a snake_cased stem. `go-dbops.ts` carries the same rule for its lookup
 * candidates; the two stay duplicated until a third caller appears, because hoisting a
 * three-line inflector into the shared `text-helpers` would make it look canonical when it is
 * only ever a GUESS about a naming convention.
 */
function pluralize(name: string): string {
  if (/(?:s|x|z|ch|sh)$/.test(name)) return `${name}es`;
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/**
 * The table names a struct could map to, best guess first.
 *
 * The plural snake_case leads because it is what BOTH conventions produce: GORM's default naming
 * strategy pluralizes (`User` → `users`) and sqlc names its model after the SINGULARIZED table
 * (`users` → `User`). The singular and the bare lowercase follow as lookup fallbacks only — a
 * repo that spells its table `user` still merges instead of double-emitting.
 */
function tableCandidates(structName: string): string[] {
  const snake = snakeCase(structName);
  return [...new Set([pluralize(snake), snake, structName.toLowerCase()])];
}

/** dirname of a repo-relative path ('' at the repo root) — a Go package IS a directory. */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/**
 * Index key for a named type. Go type identity is PACKAGE-scoped, so two directories may each
 * declare `User`; keying on the bare name would cross-wire their relations.
 */
function typeKey(dir: string, typeName: string): string {
  return `${dir} ${typeName}`;
}

// =============================================================================
// Source 1 — plain-SQL DDL
// =============================================================================

/**
 * Split a `CREATE TABLE (...)` column list on top-level commas (paren aware, so `NUMERIC(10, 2)`
 * stays one column).
 */
function splitColumns(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/**
 * Parse every `CREATE TABLE` in a `.sql` file into a draft entity.
 *
 * This mirrors the reader in `rust-entities.ts`: both substrates face the same plain-SQL migration
 * convention, and the duplication is the repo's rule-of-three (two occurrences, not yet three) —
 * hoisting it would mean editing the Rust substrate for no behavioural gain.
 */
function parseCreateTables(sql: string, relPath: string): Draft[] {
  const drafts: Draft[] = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?["`']?([\w.]+)["`']?\s*\(/gi;
  let m: RegExpExecArray | null = re.exec(sql);
  while (m !== null) {
    // Scan forward to the matching close paren of the column list.
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
    }
    const body = sql.slice(m.index + m[0].length, i - 1);
    // `public.users` → `users`: the schema qualifier is dropped so the name matches what
    // `parseSqlOp` reads out of a query string, which is a bare word.
    const tableName = (m[1].split('.').pop() as string).toLowerCase();
    const startLine = sql.slice(0, m.index).split('\n').length;
    const fields: EntityField[] = [];
    const relations: EntityRelation[] = [];
    const pkFromConstraint = new Set<string>();

    for (const raw of splitColumns(body)) {
      const line = raw.trim();
      if (!line) continue;
      const pk = /^primary\s+key\s*\(([^)]*)\)/i.exec(line);
      if (pk) {
        for (const c of pk[1].split(',')) pkFromConstraint.add(c.trim().replace(/["`']/g, ''));
        continue;
      }
      const fk =
        /^(?:constraint\s+\w+\s+)?foreign\s+key\s*\(\s*["`']?(\w+)["`']?\s*\)\s*references\s+["`']?(\w+)/i.exec(line);
      if (fk) {
        relations.push({ name: fk[1], type: 'many-to-one', targetEntityName: fk[2].toLowerCase() });
        continue;
      }
      if (/^(unique|check|constraint|primary|foreign|exclude)\b/i.test(line)) continue;
      const col = /^["`']?(\w+)["`']?\s+([\w]+(?:\s*\([^)]*\))?(?:\s+\w+)?)/.exec(line);
      if (!col) continue;
      const name = col[1];
      const inlineRef = /references\s+["`']?(\w+)/i.exec(line);
      if (inlineRef) {
        relations.push({ name, type: 'many-to-one', targetEntityName: inlineRef[1].toLowerCase() });
      }
      fields.push(
        makeField(name, name, col[2].trim(), {
          nullable: !/\bnot\s+null\b/i.test(line) && !/\bprimary\s+key\b/i.test(line),
          primaryKey: /\bprimary\s+key\b/i.test(line),
          unique: /\bunique\b/i.test(line),
        }),
      );
    }
    for (const f of fields) if (pkFromConstraint.has(f.name)) f.isPrimaryKey = true;

    if (fields.length > 0) {
      drafts.push({
        name: entityNameFromTable(tableName),
        tableName,
        relPath,
        startLine,
        endLine: sql.slice(0, i).split('\n').length,
        orm: GoOrm.Sql,
        fields,
        relations,
        aliases: new Set(),
        checksumText: sql.slice(m.index, i),
      });
    }
    re.lastIndex = i;
    m = re.exec(sql);
  }
  return drafts;
}

// =============================================================================
// Sources 2–4 — struct bodies
// =============================================================================

/**
 * The DIRECT field declarations of a struct.
 *
 * A descendant scan would also pull the fields of a NESTED anonymous struct
 * (`Meta struct { A string }`) up into the parent's column list, inventing columns the table
 * does not have.
 */
function structFieldDecls(structType: TsNode): TsNode[] {
  const list = namedChildrenOfType(structType, FIELD_DECLARATION_LIST)[0];
  return list ? namedChildrenOfType(list, FIELD_DECLARATION) : [];
}

/** The declared type text of a field (`*string`, `[]Order`, `gorm.Model`). */
function fieldTypeText(fieldDecl: TsNode): string {
  return (fieldDecl?.childForFieldName?.('type')?.text ?? '') as string;
}

/** An EMBEDDED field has no `field_identifier` children at all — its type IS its name. */
function isEmbedded(fieldDecl: TsNode): boolean {
  return fieldNames(fieldDecl).length === 0;
}

/** `gorm.Model` embedded — the marker that makes a struct a GORM model with no tags anywhere. */
function embedsGormModel(fieldDecl: TsNode): boolean {
  return isEmbedded(fieldDecl) && fieldTypeText(fieldDecl).replace(/^\*/, '') === GORM_MODEL_TYPE;
}

/**
 * The four columns `gorm.Model` contributes. These are not a guess: `gorm.Model` is a fixed struct
 * in GORM's public API (`ID uint; CreatedAt, UpdatedAt time.Time; DeletedAt gorm.DeletedAt`), and a
 * repo that embeds it really does have those columns. Any DDL for the same table still wins, since
 * a struct never overwrites the fields of a table the DDL already claimed.
 */
function gormModelFields(): EntityField[] {
  return [
    makeField('ID', 'id', 'uint', { primaryKey: true }),
    makeField('CreatedAt', 'created_at', 'time.Time'),
    makeField('UpdatedAt', 'updated_at', 'time.Time'),
    makeField('DeletedAt', 'deleted_at', 'gorm.DeletedAt', { nullable: true }),
  ];
}

/**
 * The GORM tag's options, normalized: `gorm:"column:user_id;primaryKey;not null"` →
 * `{ column: 'user_id', primarykey: '', notnull: '' }`.
 *
 * Read from the tag's RAW text rather than through `structTags`, which returns each value's first
 * comma segment: a GORM tag is SEMICOLON-separated and legitimately contains commas
 * (`type:decimal(10,2);column:price`), so the comma cut would drop every option after the type.
 * Keys are lowercased with separators removed because GORM itself accepts `primaryKey`,
 * `primary_key` and `PRIMARYKEY` alike.
 */
function gormOptions(fieldDecl: TsNode): Map<string, string> {
  const out = new Map<string, string>();
  const body = rawTagBody(fieldDecl);
  const m = body ? /(?:^|\s)gorm:"([^"]*)"/.exec(body) : null;
  if (!m) return out;
  for (const part of m[1].split(';')) {
    const raw = part.trim();
    if (!raw) continue;
    const sep = raw.indexOf(':');
    const key = (sep === -1 ? raw : raw.slice(0, sep)).toLowerCase().replace(/[\s_-]/g, '');
    if (key && !out.has(key)) out.set(key, sep === -1 ? '' : raw.slice(sep + 1).trim());
  }
  return out;
}

/** The struct tag body of a field (delimiters stripped) — the TRAILING string literal child. */
function rawTagBody(fieldDecl: TsNode): string | undefined {
  const n = fieldDecl?.namedChildCount ?? 0;
  let literal: TsNode | undefined;
  for (let i = 0; i < n; i++) {
    const c = fieldDecl.namedChild(i) as TsNode | undefined;
    if (c && (c.type === RAW_STRING_LITERAL || c.type === INTERPRETED_STRING_LITERAL)) literal = c;
  }
  return literal ? goStringValue(literal) : undefined;
}

/** The first string literal under a node, in source order. */
function firstStringLiteral(node: TsNode | undefined): TsNode | undefined {
  const literals = [
    ...((node?.descendantsOfType?.(INTERPRETED_STRING_LITERAL) ?? []) as TsNode[]),
    ...((node?.descendantsOfType?.(RAW_STRING_LITERAL) ?? []) as TsNode[]),
  ];
  return literals.sort((a, b) => a.startIndex - b.startIndex)[0];
}

/**
 * `receiver type → declared table name` for every `TableName() string` in the repo, keyed by
 * package.
 *
 * The method lives at FILE scope and Go has no per-file scope, so `models.go` may declare the
 * struct while `table_names.go` next to it declares the override — the index therefore spans all
 * files before any struct is resolved. A body that returns anything but a string literal (a
 * constant, a `fmt.Sprintf`) contributes nothing rather than a guess.
 */
function tableNameMethods(files: GoFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    const dir = dirOf(file.relPath);
    for (const method of (file.root?.descendantsOfType?.(METHOD_DECLARATION) ?? []) as TsNode[]) {
      if (itemName(method) !== TABLE_NAME_METHOD) continue;
      const receiver = receiverTypeName(method);
      if (!receiver) continue;
      const ret = (method.childForFieldName?.('body')?.descendantsOfType?.(RETURN_STATEMENT) ?? [])[0] as
        | TsNode
        | undefined;
      const value = goStringValue(firstStringLiteral(ret));
      const key = typeKey(dir, receiver);
      if (value && !out.has(key)) out.set(key, value);
    }
  }
  return out;
}

/** A struct that could be a table, with its table name already resolved. */
interface StructCandidate {
  file: GoFile;
  name: string;
  /** The `type_spec` node — the entity's location and checksum source. */
  node: TsNode;
  /** Direct field declarations of the struct body. */
  decls: TsNode[];
  tableName: string;
  /** A persistence signal makes this struct entity-worthy on its own (sources 2 and 3). */
  persisted: boolean;
  /** A GORM signal (embed, tag or `TableName()`), which decides the `ormType` label. */
  gorm: boolean;
}

/** Whether any of the configured tag keys appears on this field. */
function hasPersistenceTag(fieldDecl: TsNode, tagKeys: string[]): boolean {
  const tags = structTags(fieldDecl);
  return tagKeys.some((k) => tags.has(k));
}

/**
 * The column a field maps to.
 *
 * GORM's explicit `column:` wins because it is unambiguous; a configured tag key (`db:"user_id"`)
 * comes next in the order the profile listed them; snake_case of the Go name is the fallback, which
 * is what every reflect-based mapper in the ecosystem defaults to.
 */
function columnNameOf(fieldDecl: TsNode, fieldName: string, tagKeys: string[], grouped: boolean): string {
  const gorm = gormOptions(fieldDecl);
  const gormColumn = gorm.get('column');
  if (gormColumn) return gormColumn;
  // A grouped declaration (`a, b int `db:"x"`) shares ONE tag between two names, so the tag cannot
  // be naming either column specifically — only the per-name default is defensible there.
  if (!grouped) {
    const tags = structTags(fieldDecl);
    for (const key of tagKeys) {
      const value = key === GORM_TAG ? undefined : tags.get(key);
      if (value && value !== '-') return value;
    }
  }
  return snakeCase(fieldName);
}

/** `db:"-"` / `gorm:"-"` — the field is explicitly NOT persisted. */
function isSkippedField(fieldDecl: TsNode, tagKeys: string[]): boolean {
  if (gormOptions(fieldDecl).has('-')) return true;
  const tags = structTags(fieldDecl);
  return tagKeys.some((k) => k !== GORM_TAG && tags.get(k) === '-');
}

/**
 * Whether a Go type is nullable in the database sense.
 *
 * A POINTER is Go's nullability declaration the way `Option<T>` is Rust's, and the
 * `database/sql` `NullString`/`NullInt64` family (which sqlc emits) says the same thing in a value
 * type. An explicit `not null` in a GORM tag overrides both.
 */
function isNullableType(typeText: string): boolean {
  if (typeText.startsWith('*')) return true;
  const base = baseTypeName(typeText) ?? '';
  return /^Null[A-Z]/.test(base);
}

/** The columns and associations a struct body declares. */
function projectStructBody(
  candidate: StructCandidate,
  tagKeys: string[],
  tableByType: Map<string, string>,
): { fields: EntityField[]; relations: EntityRelation[] } {
  const fields: EntityField[] = [];
  const relations: EntityRelation[] = [];
  const dir = dirOf(candidate.file.relPath);

  for (const fd of candidate.decls) {
    const names = fieldNames(fd);
    if (names.length === 0) {
      // Embedded. `gorm.Model` expands to its four real columns; any other embedded struct would
      // need cross-package type resolution to flatten — a documented Tier-B gap, not a guess.
      if (embedsGormModel(fd)) fields.push(...gormModelFields());
      continue;
    }
    if (isSkippedField(fd, tagKeys)) continue;
    const typeText = fieldTypeText(fd);

    // An association, not a column: the field's type is another persisted struct in this package.
    // `Orders []Order` is a join, while the `UserID` scalar beside it is the actual FK column.
    const target = baseTypeName(typeText);
    const targetTable = target ? tableByType.get(typeKey(dir, target)) : undefined;
    if (targetTable && names.length === 1 && isExported(names[0])) {
      const gorm = gormOptions(fd);
      relations.push({
        name: names[0],
        type: gorm.has('many2many') ? 'many-to-many' : typeText.startsWith('[]') ? 'one-to-many' : 'many-to-one',
        targetEntityName: targetTable,
      });
      continue;
    }

    for (const name of names) {
      // Go's own rule: an unexported field is invisible to reflection, so no `database/sql`
      // mapper, no ORM and no encoder can ever persist it.
      if (!isExported(name)) continue;
      const gorm = gormOptions(fd);
      const column = columnNameOf(fd, name, tagKeys, names.length > 1);
      fields.push(
        makeField(name, column, typeText, {
          dbType: gorm.get('type') || undefined,
          nullable: !gorm.has('notnull') && isNullableType(typeText),
          primaryKey: gorm.has('primarykey') || column === 'id',
          unique: gorm.has('unique') || gorm.has('uniqueindex'),
        }),
      );
    }
  }
  return { fields, relations };
}

// =============================================================================
// Assembly
// =============================================================================

export function extractGoEntities(files: GoFile[], cfg: GoEntityConfig): GoEntityResult {
  const idGen = cfg.idGen;
  const tagKeys = cfg.structTags ?? DEFAULT_STRUCT_TAGS;
  const schemaGlobs = cfg.schemaFileGlobs ?? DEFAULT_SCHEMA_GLOBS;

  /** table name → draft. Insertion order is the emit order; the DDL claims a table first. */
  const byTable = new Map<string, Draft>();

  // --- Source 1: plain-SQL DDL ---
  // Sorted: migrations are numbered, several may touch one table, and FIRST-WINS is only a rule if
  // the order is fixed (the non-git `walk()` fallback in the enumerator is filesystem-ordered).
  const schemaFiles = enumerateRepoFiles(cfg.repoRoot)
    .filter((rel) => rel.endsWith('.sql') && globMatches(rel, schemaGlobs))
    .sort();
  for (const rel of schemaFiles) {
    let sql: string;
    try {
      sql = readFileSync(`${cfg.repoRoot}/${rel}`, 'utf-8');
    } catch {
      continue;
    }
    for (const draft of parseCreateTables(sql, rel)) {
      const existing = byTable.get(draft.tableName);
      if (!existing) {
        byTable.set(draft.tableName, draft);
        continue;
      }
      // A later migration re-declaring the table (a rebuild, a different dialect's copy) adds only
      // the relations the first one did not state; the first declaration keeps identity.
      for (const r of draft.relations) {
        if (!existing.relations.some((e) => e.name === r.name)) existing.relations.push(r);
      }
    }
  }

  // --- Sources 2-4: struct candidates, table names resolved before any body is projected ---
  const tableMethods = tableNameMethods(files);
  const candidates: StructCandidate[] = [];
  /** package-scoped struct name → its table, for resolving associations. */
  const tableByType = new Map<string, string>();

  for (const file of files) {
    const dir = dirOf(file.relPath);
    for (const spec of (file.root?.descendantsOfType?.(TYPE_SPEC) ?? []) as TsNode[]) {
      const name = itemName(spec);
      const structType = spec.childForFieldName?.('type') as TsNode | undefined;
      if (!name || structType?.type !== STRUCT_TYPE) continue;

      const decls = structFieldDecls(structType);
      const declared = tableMethods.get(typeKey(dir, name));
      const embedsModel = decls.some(embedsGormModel);
      // Sources 2 and 3: a configured tag key, an embedded `gorm.Model`, or a `TableName()` — each
      // is a struct saying "table" on its own, without any DDL to corroborate it.
      const persisted = declared !== undefined || embedsModel || decls.some((d) => hasPersistenceTag(d, tagKeys));
      const gormSignal = declared !== undefined || embedsModel || decls.some((d) => structTags(d).has(GORM_TAG));
      const spellings = declared ? [declared] : tableCandidates(name);
      // Source 4: no persistence signal of its own, but the DDL already declared a table by one of
      // its names — the sqlc `models.go` case. Merge-only, so this can never invent an entity.
      const known = spellings.find((t) => byTable.has(t));
      if (!persisted && known === undefined) continue;

      const tableName = known ?? spellings[0];
      candidates.push({ file, name, node: spec, decls, tableName, persisted, gorm: gormSignal });
      const key = typeKey(dir, name);
      if (!tableByType.has(key)) tableByType.set(key, tableName);
    }
  }

  for (const c of candidates) {
    const { fields, relations } = projectStructBody(c, tagKeys, tableByType);
    const existing = byTable.get(c.tableName);
    if (existing) {
      // MERGE: an authoritative source (or an earlier struct) already described this table.
      // Register the struct name so `&User{}` at a db-op site and `FROM users` in a query string
      // resolve to ONE id, and take only the relations the existing draft does not state.
      existing.aliases.add(c.name);
      for (const r of relations) {
        if (!existing.relations.some((e) => e.name === r.name)) existing.relations.push(r);
      }
      continue;
    }
    // Source 4 never creates: its acceptance test was "the DDL already has this table".
    if (!c.persisted) continue;
    byTable.set(c.tableName, {
      name: c.name,
      tableName: c.tableName,
      relPath: c.file.relPath,
      startLine: c.node.startPosition.row + 1,
      endLine: c.node.endPosition.row + 1,
      orm: c.gorm ? GoOrm.Gorm : GoOrm.Go,
      fields,
      relations,
      aliases: new Set([c.name]),
      checksumText: c.node.text as string,
    });
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

  return { entities, entityIdByName, tableNames: new Set(byTable.keys()) };
}
