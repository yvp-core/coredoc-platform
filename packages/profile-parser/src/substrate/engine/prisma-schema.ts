/**
 * Self-contained Prisma schema parser.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityField, EntityRelation } from '@coredoc/core/types';

export interface PrismaModel {
  name: string;
  tableName: string;
  line: number;
  fields: EntityField[];
  relations: EntityRelation[];
}

/** Read + parse a schema.prisma file (repo-relative). Returns [] if absent/unreadable. */
export function loadPrismaModels(repoRoot: string, schemaPath: string): PrismaModel[] {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, schemaPath), 'utf8');
  } catch {
    return [];
  }
  return parsePrismaSchema(text);
}

/**
 * Minimal Prisma schema parser: each `model` block → entity name, `@@map` table name,
 * scalar/enum fields, and model-typed relation fields. Block-/line-based; the Prisma
 * grammar is regular enough that this is reliable for the common shapes. One
 * simplification: a singular model-typed field is reported many-to-one (the `[]` side
 * is one-to-many), so an optional 1:1 reads as many-to-one.
 */
export function parsePrismaSchema(raw: string): PrismaModel[] {
  // Strip // line + /* */ block comments first, so braces inside them (e.g.
  // `// { function: 120 }`) don't truncate a model block at the wrong `}`.
  const text = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const blockRe = /(model|enum)\s+(\w+)\s*\{([\s\S]*?)\}/g;
  const modelNames = new Set<string>();
  const blocks: { kind: string; name: string; body: string; index: number }[] = [];
  for (let bm = blockRe.exec(text); bm !== null; bm = blockRe.exec(text)) {
    blocks.push({ kind: bm[1], name: bm[2], body: bm[3], index: bm.index });
    if (bm[1] === 'model') modelNames.add(bm[2]);
  }
  const models: PrismaModel[] = [];
  for (const b of blocks) {
    if (b.kind !== 'model') continue;
    const line = text.slice(0, b.index).split('\n').length;
    const mapM = /@@map\("([^"]+)"\)/.exec(b.body);
    const tableName = mapM ? mapM[1] : b.name;
    const fields: EntityField[] = [];
    const relations: EntityRelation[] = [];
    for (const rawLine of b.body.split('\n')) {
      const l = rawLine.trim();
      if (!l || l.startsWith('//') || l.startsWith('@@')) continue;
      const fm = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(l);
      if (!fm) continue;
      const [, fname, baseType, list, opt, attrs] = fm;
      if (modelNames.has(baseType)) {
        relations.push({ name: fname, type: list ? 'one-to-many' : 'many-to-one', targetEntityName: baseType });
        continue;
      }
      const colM = /@map\("([^"]+)"\)/.exec(attrs);
      const defM = /@default\(([^)]*)\)/.exec(attrs);
      fields.push({
        name: fname,
        columnName: colM ? colM[1] : fname,
        type: { text: baseType + (list ? '[]' : '') },
        isPrimaryKey: /@id\b/.test(attrs),
        isNullable: !!opt,
        isUnique: /@unique\b/.test(attrs),
        isGenerated: !!defM && /autoincrement|uuid|cuid|now|gen_random/i.test(defM[1]),
        defaultValue: defM ? defM[1].trim() : undefined,
      });
    }
    models.push({ name: b.name, tableName, line, fields, relations });
  }
  return models;
}
