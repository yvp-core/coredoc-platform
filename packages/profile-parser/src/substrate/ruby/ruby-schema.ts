/**
 * Parse a Rails `db/schema.rb` into per-table column metadata. Generic ActiveRecord —
 * no client/table-specific strings. `schema.rb` is machine-generated and highly regular
 * (one `create_table "name", <opts> do |t| … end` block per table, one `t.<type> "col"`
 * macro per column), so a line-oriented parser over the source is deterministic and
 * sufficient — no full CST needed (and the public signature is synchronous).
 *
 * Column type = the macro name (`t.string` -> 'string', `t.jsonb` -> 'jsonb', etc.).
 * nullable  = NOT `null: false`. isGenerated = a `default: -> { … }` expression OR the
 * default serial/uuid primary key. defaultValue = the literal after `default:` (skipped
 * for the lambda form). A single-column `t.index [...], unique: true` marks that column
 * unique. `t.references`/`t.belongs_to "x"` emit an `x_id` column.
 */

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isGenerated: boolean;
  defaultValue?: string;
  unique: boolean;
}

export interface SchemaTable {
  tableName: string;
  primaryKey: string;
  columns: SchemaColumn[];
  /**
   * Unique-index column groups (single AND composite). A composite group is NOT marked
   * on its member columns (`SchemaColumn.unique` stays false) because the COMBINATION is
   * unique, not each column. Surfaced as `EntityNode.indexes` by the entity extractor.
   */
  uniqueIndexes: string[][];
}

/** Macros that declare a real column (anything else, like `t.index`, is handled separately). */
const REFERENCE_MACROS = new Set(['references', 'belongs_to']);
/** Macros that are not column declarations and not references. */
const NON_COLUMN_MACROS = new Set(['index', 'check_constraint', 'foreign_key']);

/** Header line of a create_table block: captures table name and the option tail. */
const CREATE_TABLE_RE = /^create_table\s+(["'])(.+?)\1\s*(?:,(.*))?\s+do\s*\|/;
/** A `t.<macro> "col"[, opts]` line. */
const MACRO_RE = /^t\.(\w+)\s+(["'])(.+?)\2\s*(?:,(.*))?$/;
/** A `t.index [ ... ]` line — captured separately to apply uniqueness flags. */
const INDEX_RE = /^t\.index\s+\[(.*?)\]\s*(?:,(.*))?$/;

/** Extract a `key: value` literal from an options tail. Returns the raw value text or undefined. */
function optionValue(opts: string | undefined, key: string): string | undefined {
  if (!opts) return undefined;
  const m = new RegExp(`\\b${key}:\\s*([^,]+)`).exec(opts);
  return m ? m[1].trim() : undefined;
}

/** Strip surrounding quotes / a leading `:` from a literal token. */
function unquote(value: string): string {
  return value.replace(/^['":]+/, '').replace(/['"]+$/, '');
}

/** Does the options tail carry a `default: -> { … }` lambda (a DB-generated value)? */
function hasGeneratedDefault(opts: string | undefined): boolean {
  return opts !== undefined && /\bdefault:\s*->/.test(opts);
}

/** Literal default value (skips the lambda form, which is `isGenerated` instead). */
function defaultLiteral(opts: string | undefined): string | undefined {
  if (!opts || hasGeneratedDefault(opts)) return undefined;
  const raw = optionValue(opts, 'default');
  return raw === undefined ? undefined : unquote(raw);
}

/** Resolve the create_table primary-key declaration into [pkName, idColumnType | undefined]. */
function resolvePrimaryKey(headerOpts: string | undefined): { pkName: string; idType?: string } {
  // `primary_key: "x"` overrides the default 'id' and suppresses the auto id column.
  const explicit = optionValue(headerOpts, 'primary_key');
  if (explicit !== undefined) return { pkName: unquote(explicit) };
  // `id: :uuid` / `id: :bigint` -> typed id column. `id: false` -> no pk column.
  const idOpt = optionValue(headerOpts, 'id');
  if (idOpt !== undefined) {
    const v = unquote(idOpt);
    if (v === 'false') return { pkName: 'id' };
    return { pkName: 'id', idType: v };
  }
  return { pkName: 'id', idType: 'bigint' };
}

export function parseRailsSchema(schemaSource: string): Map<string, SchemaTable> {
  const tables = new Map<string, SchemaTable>();
  const lines = schemaSource.split('\n');

  let current: SchemaTable | undefined;
  const byName = new Map<string, SchemaColumn>();
  // Pending single-column unique index column names, applied once the block closes.
  let uniqueCols = new Set<string>();
  // Pending unique-index column groups (single + composite), applied once the block closes.
  let uniqueIndexGroups: string[][] = [];

  const closeTable = () => {
    if (!current) return;
    for (const c of current.columns) {
      if (uniqueCols.has(c.name)) c.unique = true;
    }
    current.uniqueIndexes = uniqueIndexGroups;
    tables.set(current.tableName, current);
    current = undefined;
    byName.clear();
    uniqueCols = new Set();
    uniqueIndexGroups = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const header = CREATE_TABLE_RE.exec(line);
    if (header) {
      closeTable();
      const tableName = header[2];
      const headerOpts = header[3];
      const { pkName, idType } = resolvePrimaryKey(headerOpts);
      current = { tableName, primaryKey: pkName, columns: [], uniqueIndexes: [] };
      // Emit the implicit id/primary-key column when it is a generated id (typed id),
      // not when the table opts to a custom string pk (that column is declared as a t.<type>).
      if (idType !== undefined) {
        const idCol: SchemaColumn = {
          name: pkName,
          type: idType,
          nullable: false,
          isPrimaryKey: true,
          isGenerated: true,
          unique: true,
        };
        current.columns.push(idCol);
        byName.set(idCol.name, idCol);
      }
      continue;
    }

    if (!current) continue;
    if (line === 'end') {
      closeTable();
      continue;
    }

    const index = INDEX_RE.exec(line);
    if (index) {
      const cols = index[1]
        .split(',')
        .map((c) => unquote(c.trim()))
        .filter(Boolean);
      const isUnique = /\bunique:\s*true\b/.test(index[2] ?? '');
      if (isUnique && cols.length > 0) {
        uniqueIndexGroups.push(cols);
        // Mark single-column unique on the column itself; a composite is the group's property.
        if (cols.length === 1) uniqueCols.add(cols[0]);
      }
      continue;
    }

    const macro = MACRO_RE.exec(line);
    if (!macro) continue;
    const macroName = macro[1];
    const firstArg = macro[3];
    const opts = macro[4];

    if (NON_COLUMN_MACROS.has(macroName)) continue;

    if (REFERENCE_MACROS.has(macroName)) {
      // t.references "company", type: :uuid -> a 'company_id' column of the referenced key type.
      const refType = optionValue(opts, 'type');
      const col: SchemaColumn = {
        name: `${firstArg}_id`,
        type: refType ? unquote(refType) : 'bigint',
        nullable: !/\bnull:\s*false\b/.test(opts ?? ''),
        isPrimaryKey: false,
        isGenerated: false,
        unique: false,
      };
      if (!byName.has(col.name)) {
        current.columns.push(col);
        byName.set(col.name, col);
      }
      continue;
    }

    // Mark a column that matches the resolved custom primary key.
    const isPk = firstArg === current.primaryKey;
    const col: SchemaColumn = {
      name: firstArg,
      type: macroName,
      nullable: !/\bnull:\s*false\b/.test(opts ?? ''),
      isPrimaryKey: isPk,
      isGenerated: isPk || hasGeneratedDefault(opts),
      defaultValue: defaultLiteral(opts),
      unique: false,
    };
    if (!byName.has(col.name)) {
      current.columns.push(col);
      byName.set(col.name, col);
    }
  }

  closeTable();
  return tables;
}
