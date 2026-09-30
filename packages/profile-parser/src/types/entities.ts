import type { ArgRef, Detector } from './detectors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Entity rules
// ─────────────────────────────────────────────────────────────────────────────

/** Decorator/factory ORM: entities are detected in the source code. */
export type ConventionEntityRule = {
  orm: string;
  detect: Detector;
  /** factory ORMs name the entity in an arg (decorator ORMs use the class name). */
  name?: ArgRef;
  tableName?: { option?: string; fallback?: 'snake_case' | 'verbatim' };
  fields: {
    // decorator ORMs
    decorators?: string[];
    pk?: string;
    columnNameOption?: string;
    flags?: { nullable?: string; unique?: string; generated?: string };
    // factory ORMs
    factoryFieldsArg?: number;
    dataTypeMap?: Record<string, string>;
    /**
     * Decorator option keys carrying the DB type, read as a fallback when the TS
     * annotation is missing/`unknown` (decorator ORMs). Defaults to
     * `['type', 'columnType']` (MikroORM/TypeORM); `dataTypeMap` normalizes the
     * recovered token.
     */
    typeOption?: string[];
  };
  relations: {
    /** decorator → relation type (decorator ORMs). */
    decorators?: Record<string, string>;
    /** assoc method → relation type (factory ORMs). */
    assocMethods?: Record<string, string>;
    target: ArgRef;
  };
};

/**
 * Prisma: models (entities) live in a `schema.prisma` DSL file, not in source code,
 * so the engine parses the schema directly — there is no in-code detector. Fields,
 * `@@map` table names, and model-typed relation fields are read from the schema.
 */
export type PrismaSchemaEntityRule = {
  orm: 'prisma';
  /** Repo-relative path to the schema.prisma file. */
  schemaPath: string;
};

export type EntityRule = ConventionEntityRule | PrismaSchemaEntityRule;
