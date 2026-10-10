/**
 * Project a graph node's stored `properties` blob into the typed, drawer-facing
 * {@link NodeDetailData} the explorer renders. Pure + total: every value is
 * defensively narrowed (properties is `Record<string, unknown>` — SQLite parses
 * it from a JSON column, Neo4j from its per-node props), so a missing or
 * malformed key becomes an omitted optional, never a throw. Keyed by the node's
 * NodeType string value; unknown/plain kinds fall through to `generic`.
 *
 * The property keys mirror packages/db/src/transformer.ts (the push-time
 * mapping): entrypoints carry `method`/`path`/`fullPath`/`entrypointType`,
 * functions carry AI `purpose`/`businessLogic`/`sideEffects`, classes carry
 * `properties_`/`constructorParams`/`implements`, interfaces/enums carry inline
 * `members`, entities carry `fields`/`relations`/`indexes`.
 */

import type { EntityFieldDetail, MemberDetail, NodeDetailData } from '@coredoc/core';
import { asArray as arr, asFiniteNumber as num } from '../../libs/coerce.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function projectNodeDetail(type: string, p: Record<string, unknown>): NodeDetailData {
  const documentation = str(p.documentation);

  switch (type) {
    case 'entrypoint':
      return {
        kind: 'entrypoint',
        entrypointType: str(p.entrypointType),
        method: str(p.method),
        path: str(p.path),
        fullPath: str(p.fullPath),
        schedule: str(p.schedule),
        topic: str(p.topic),
        fieldName: str(p.fieldName),
        operationType: str(p.operationType),
        purpose: str(p.purpose),
        documentation,
      };

    case 'function':
      return {
        kind: 'function',
        purpose: str(p.purpose),
        businessLogic: str(p.businessLogic),
        sideEffects: str(p.sideEffects),
        isAsync: bool(p.isAsync),
        visibility: str(p.visibility),
        complexity: num(p.complexity),
        documentation,
      };

    case 'class': {
      const implementsNames = arr(p.implements)
        .map((i) => str(obj(i).name))
        .filter((n): n is string => !!n);
      const fields: MemberDetail[] = arr(p.properties_)
        .map((f) => {
          const o = obj(f);
          return {
            name: str(o.name) ?? '',
            typeText: str(o.typeText),
            visibility: str(o.visibility),
            isStatic: bool(o.isStatic),
            isReadonly: bool(o.isReadonly),
            isOptional: bool(o.isOptional),
          };
        })
        .filter((m) => m.name);
      const constructorParams = arr(p.constructorParams)
        .map((c) => {
          const o = obj(c);
          return { name: str(o.name) ?? '', typeText: str(o.typeText) };
        })
        .filter((c) => c.name);
      return {
        kind: 'class',
        extendsName: str(p.extendsName),
        implements: implementsNames.length ? implementsNames : undefined,
        fields,
        constructorParams: constructorParams.length ? constructorParams : undefined,
        documentation,
      };
    }

    case 'interface': {
      const members: MemberDetail[] = arr(p.members)
        .map((m) => {
          const o = obj(m);
          return {
            name: str(o.name) ?? '',
            kind: str(o.kind),
            typeText: str(o.typeText),
            returnTypeText: str(o.returnTypeText),
            isOptional: bool(o.isOptional),
            isReadonly: bool(o.isReadonly),
          };
        })
        .filter((m) => m.name);
      return { kind: 'interface', members, documentation };
    }

    case 'enum': {
      const members = arr(p.members)
        .map((m) => {
          const o = obj(m);
          const name = str(o.name);
          if (!name) return null;
          const value = typeof o.value === 'string' || typeof o.value === 'number' ? o.value : undefined;
          return value !== undefined ? { name, value } : { name };
        })
        .filter((m): m is { name: string; value?: string | number } => m !== null);
      return { kind: 'enum', members, documentation };
    }

    case 'entity': {
      const fields: EntityFieldDetail[] = arr(p.fields)
        .map((f) => {
          const o = obj(f);
          return {
            name: str(o.name) ?? '',
            columnName: str(o.columnName),
            // EntityField.type is a TypeInfo { text }; fall back to a flat typeText.
            typeText: str(obj(o.type).text) ?? str(o.typeText),
            dbType: str(o.dbType),
            isPrimaryKey: bool(o.isPrimaryKey),
            isNullable: bool(o.isNullable),
            isUnique: bool(o.isUnique),
          };
        })
        .filter((f) => f.name);
      const relations = arr(p.relations)
        .map((r) => obj(r))
        .filter((o) => str(o.name))
        .map((o) => ({
          name: str(o.name) as string,
          type: str(o.type),
          targetEntityName: str(o.targetEntityName),
        }));
      const indexes = arr(p.indexes).map((i) => {
        const o = obj(i);
        const columns = arr(o.columns)
          .map((c) => str(c))
          .filter((c): c is string => !!c);
        return { name: str(o.name), columns, isUnique: bool(o.isUnique) };
      });
      return {
        kind: 'entity',
        ormType: str(p.ormType),
        tableName: str(p.tableName),
        schema: str(p.schema),
        fields,
        relations,
        indexes: indexes.length ? indexes : undefined,
        documentation,
      };
    }

    case 'external_call':
      return {
        kind: 'external_call',
        serviceName: str(p.serviceName),
        targetService: str(p.targetService),
        method: str(p.method),
        protocol: str(p.protocol),
        httpMethod: str(p.httpMethod),
        pathTemplate: str(p.pathTemplate),
        messagingSystem: str(p.messagingSystem),
        messagingDestination: str(p.messagingDestination),
        messagingDestinationRef: str(p.messagingDestinationRef),
        ipcDirection: str(p.ipcDirection),
      };

    default:
      return { kind: 'generic', documentation };
  }
}
