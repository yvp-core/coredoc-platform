import { EdgeType, NodeType } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import {
  LADYBUG_EDGE_TYPES,
  LADYBUG_NODE_TYPES,
  getLadybugSchemaStatements,
  ladybugRelationTableStatement,
} from './schema.js';

describe('Ladybug schema', () => {
  it('is deterministic and derived from the complete graph vocabulary', () => {
    expect(LADYBUG_NODE_TYPES).toEqual([...Object.values(NodeType)].sort());
    expect(LADYBUG_EDGE_TYPES).toEqual([...Object.values(EdgeType)].sort());
    expect(getLadybugSchemaStatements()).toEqual(getLadybugSchemaStatements());
  });

  it('defines the generic node, metadata, and every relationship table', () => {
    const statements = getLadybugSchemaStatements();
    const nodeDdl = statements.find((statement) => statement.includes('NODE TABLE IF NOT EXISTS GraphNode'));
    const metadataDdl = statements.find((statement) => statement.includes('NODE TABLE IF NOT EXISTS CoredocMeta'));
    const relationDdl = statements.filter((statement) => statement.includes('REL TABLE IF NOT EXISTS'));

    expect(nodeDdl).toBe(
      'CREATE NODE TABLE IF NOT EXISTS GraphNode(' +
        'id STRING PRIMARY KEY, type STRING, name STRING, properties STRING, summary STRING, embedding DOUBLE[], ' +
        'repoId STRING, filePath STRING, startLine INT64, endLine INT64)',
    );
    expect(metadataDdl).toBe('CREATE NODE TABLE IF NOT EXISTS CoredocMeta(repoId STRING PRIMARY KEY, snapshot STRING)');
    expect(relationDdl).toHaveLength(Object.values(EdgeType).length);
    for (const edgeType of Object.values(EdgeType)) {
      expect(relationDdl).toContain(ladybugRelationTableStatement(edgeType));
    }
  });

  it('rejects unsafe relationship-table identifiers', () => {
    expect(() => ladybugRelationTableStatement('CALLS) DELETE n' as EdgeType)).toThrow(/identifier/i);
  });
});
