/**
 * ERD Generator Utility
 *
 * Generates Mermaid ERD diagrams from parsed entity data.
 */

import type { EntityNode } from '../types/output.js';

export interface ERDOptions {
  /** Include entity fields (default: true) */
  includeFields?: boolean;
  /** Max entities to include (default: 30) */
  maxEntities?: number;
  /** Max fields per entity (default: 15) */
  maxFieldsPerEntity?: number;
}

/**
 * Generate ER diagram in Mermaid format
 */
export function generateERDiagram(entities: EntityNode[], options: ERDOptions = {}): string {
  const { includeFields = true, maxEntities = 30, maxFieldsPerEntity = 15 } = options;

  if (entities.length === 0) {
    return '';
  }

  const lines: string[] = ['erDiagram'];
  const entityNames = new Set(entities.map((e) => e.name));
  const addedRelations = new Set<string>();

  // Add entities with their fields
  if (includeFields) {
    for (const entity of entities.slice(0, maxEntities)) {
      lines.push(`    ${entity.name} {`);

      for (const field of entity.fields.slice(0, maxFieldsPerEntity)) {
        const type = field.dbType || field.type?.text || 'unknown';
        const pk = field.isPrimaryKey ? ' PK' : '';
        lines.push(`        ${type} ${field.name}${pk}`);
      }

      lines.push('    }');
    }
  }

  // Add relationships
  for (const entity of entities.slice(0, maxEntities)) {
    for (const rel of entity.relations || []) {
      // Only include relations where target entity is in our set
      if (!entityNames.has(rel.targetEntityName)) {
        continue;
      }

      // Create unique key to avoid duplicate relations
      const relationKey = [entity.name, rel.targetEntityName].sort().join('_');
      if (addedRelations.has(relationKey)) {
        continue;
      }
      addedRelations.add(relationKey);

      const cardinality =
        rel.type === 'one-to-many'
          ? '||--o{'
          : rel.type === 'many-to-one'
            ? '}o--||'
            : rel.type === 'many-to-many'
              ? '}o--o{'
              : '||--||';

      // Sanitize relation name for Mermaid
      const label = rel.name.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`    ${entity.name} ${cardinality} ${rel.targetEntityName} : ${label}`);
    }
  }

  // If no content generated (no fields and no relations), list entity names
  if (lines.length === 1) {
    for (const entity of entities.slice(0, maxEntities)) {
      lines.push(`    ${entity.name} {}`);
    }
  }

  return lines.join('\n');
}
