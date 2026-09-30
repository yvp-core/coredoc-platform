import { EdgeType, NodeType } from '@coredoc/core';

export const LADYBUG_NODE_TABLE = 'GraphNode';
export const LADYBUG_METADATA_TABLE = 'CoredocMeta';
/**
 * Statically unresolved call sites. A node table, not a relation: the whole
 * point of these rows is that there is no callee node to point at.
 *
 * Deliberately NOT part of the schema a reader requires (see
 * `validateLadybugGraphSchema`) — a file published before this table existed is
 * still a valid graph, and answers unresolved-call queries as empty.
 */
export const LADYBUG_UNRESOLVED_CALL_TABLE = 'UnresolvedCall';
export const LADYBUG_FTS_INDEX_NAME = 'graph_node_name_fts';

export const LADYBUG_NODE_TYPES: readonly NodeType[] = Object.freeze([...Object.values(NodeType)].sort());
export const LADYBUG_EDGE_TYPES: readonly EdgeType[] = Object.freeze([...Object.values(EdgeType)].sort());

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`Invalid Ladybug schema identifier: ${JSON.stringify(value)}`);
  }
}

export function ladybugRelationTableStatement(edgeType: EdgeType): string {
  assertIdentifier(edgeType);
  if (!LADYBUG_EDGE_TYPES.includes(edgeType)) {
    throw new Error(`Unsupported Ladybug relationship type: ${edgeType}`);
  }

  return (
    `CREATE REL TABLE IF NOT EXISTS ${edgeType}(` +
    `FROM ${LADYBUG_NODE_TABLE} TO ${LADYBUG_NODE_TABLE}, ` +
    'id STRING, confidence DOUBLE, createdBy STRING, properties STRING)'
  );
}

const GRAPH_NODE_DDL =
  `CREATE NODE TABLE IF NOT EXISTS ${LADYBUG_NODE_TABLE}(` +
  'id STRING PRIMARY KEY, type STRING, name STRING, properties STRING, summary STRING, embedding DOUBLE[], ' +
  'repoId STRING, filePath STRING, startLine INT64, endLine INT64)';

const UNRESOLVED_CALL_DDL =
  `CREATE NODE TABLE IF NOT EXISTS ${LADYBUG_UNRESOLVED_CALL_TABLE}(` +
  'id STRING PRIMARY KEY, repoId STRING, callerId STRING, calleeExpression STRING, calleeNameTail STRING, ' +
  'filePath STRING, line INT64)';

const METADATA_DDL =
  `CREATE NODE TABLE IF NOT EXISTS ${LADYBUG_METADATA_TABLE}(` + 'repoId STRING PRIMARY KEY, snapshot STRING)';

export const LADYBUG_CREATE_FTS_INDEX_STATEMENT = `CALL CREATE_FTS_INDEX('${LADYBUG_NODE_TABLE}', '${LADYBUG_FTS_INDEX_NAME}', ['name'])`;

/**
 * Primary key for an unresolved-call row. The records have no natural identity
 * (the same expression can legitimately appear twice on one line), so identity
 * is positional within the repo's set — which is written and replaced whole.
 */
export function ladybugUnresolvedCallId(repoId: string, index: number): string {
  return `${repoId}:unresolved-call:${index}`;
}

export function getLadybugSchemaStatements(): readonly string[] {
  return [GRAPH_NODE_DDL, METADATA_DDL, UNRESOLVED_CALL_DDL, ...LADYBUG_EDGE_TYPES.map(ladybugRelationTableStatement)];
}
