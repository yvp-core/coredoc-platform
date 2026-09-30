/**
 * describe_db_schema Tool Handler
 *
 * Return the database structure — entities (tables) with their columns,
 * relations, and indexes. Omit `entityName` to dump the whole schema; pass it
 * to deep-dive one table. Backs both "what does the DB look like?" and the
 * schema context needed to write correct SQL.
 */

import { type IGraphReadRepository, type EntityInfo } from '@coredoc/db';
import { formatDbSchema, createMetadata } from '../../response-formatter.js';
import { resolveFieldEnums } from '../../entity-enums.js';
import { detectAmbiguity, toNodeTypes } from '../../ambiguity.js';
import { debug, debugResult } from '../../debug-logger.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  DbSchemaEntity,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';
import { findEntityByName } from '../../function-name.js';

/** Map a db-layer EntityInfo to the MCP-facing DbSchemaEntity (columns/relations always present). */
function toDbSchemaEntity(entity: EntityInfo): DbSchemaEntity {
  return {
    id: entity.id,
    name: entity.name,
    tableName: entity.tableName,
    ormType: entity.ormType,
    schema: entity.schema,
    filePath: entity.filePath,
    startLine: entity.startLine,
    fields: entity.fields ?? [],
    relations: entity.relations ?? [],
    indexes: entity.indexes,
  };
}

/**
 * Handle describe_db_schema tool.
 */
export async function handleDescribeDbSchema(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<DbSchemaEntity[] | string>> {
  const entityName = (args.entityName as string | undefined)?.trim() || undefined;

  // Single-entity deep-dive.
  if (entityName) {
    debug('findEntity', `name=${entityName}`);
    const entity = await findEntityByName(repository, entityName, scope.repoHashes);
    if (!entity) {
      debugResult('findEntity', 0);
      const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
      return {
        data: format === 'raw' ? [] : `Entity '${entityName}' not found in scope`,
        metadata,
        isError: true,
      };
    }
    debugResult('findEntity', 1);

    const ambiguity = await detectAmbiguity(repository, {
      name: entity.name,
      scope,
      nodeTypes: toNodeTypes('entity'),
      resolvedId: entity.id,
      resolvedFilePath: entity.filePath,
    });
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository, ambiguity);
    // Resolve enum-typed columns to their value sets (same-repo, fail-soft).
    const enumValues =
      format === 'raw' ? undefined : await resolveFieldEnums(entity.fields, repository, scope.repoHashes);
    return formatDbSchema([toDbSchemaEntity(entity)], metadata, { single: true, compact: false, enumValues });
  }

  // Whole-schema dump. These are per-service DBs, so a no-entityName dump must
  // resolve to exactly ONE repo — otherwise it would conflate tables across
  // services (and risk a token bomb). Require an explicit `scope` when the
  // current scope spans zero or many repos.
  if (scope.repoHashes.length !== 1) {
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    const hint =
      scope.repoHashes.length === 0
        ? 'no repository is in scope'
        : `scope spans ${scope.repoHashes.length} repositories (${scope.resolvedRepos.join(', ')})`;
    return {
      data:
        format === 'raw'
          ? []
          : `Pass \`scope\` to dump a whole DB schema — ${hint}. A whole-schema dump is per-service (one repo's tables); give the repo name/path, or pass \`entityName\` to deep-dive a single table.`,
      metadata,
      isError: true,
    };
  }

  debug('listEntities', `hashes=${scope.repoHashes.join(',')}`);
  const entities = await repository.listEntities(scope.repoHashes);
  debugResult('listEntities', entities.length);

  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
  // Default the whole-schema dump to a compact overview (table + column names) to
  // avoid blowing the context on a 50-table service; full per-column detail is
  // opt-in via detailLevel:full (or per-table via entityName).
  const explicitFull = args.detailLevel === 'full';
  // Resolve enums only for the full path (compact lists names only). Scope is a
  // single repo here (guarded above), so one map covers every table's columns.
  const enumValues =
    explicitFull && format !== 'raw'
      ? await resolveFieldEnums(
          entities.flatMap((e) => e.fields ?? []),
          repository,
          scope.repoHashes,
        )
      : undefined;
  return formatDbSchema(entities.map(toDbSchemaEntity), metadata, {
    single: false,
    compact: !explicitFull,
    enumValues,
  });
}
