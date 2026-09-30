import type { EntityRelation } from '@coredoc/core/types';
import type { NominalRules } from '../../types/csharp-profile.js';
import type { NominalCallFact, NominalTypeFact, NominalValueFact } from './model.js';

type ModelRule = NonNullable<NominalRules['models']>[number];
export interface ModelMapping {
  tables: { name?: string; schema?: string }[];
  columns: Map<string, (string | undefined)[]>;
  columnTypes: Map<string, (string | undefined)[]>;
  keys: (string | undefined)[];
  ignored: Set<string>;
  relations: EntityRelation[];
}
interface Builder {
  entity: string;
  property?: string;
  relation?: EntityRelation;
}

/** Resolve only chains rooted in a declared model builder, including its exact callback parameter. */
export function fluentModelMappings(
  rule: ModelRule,
  types: Map<string, NominalTypeFact>,
  calls: NominalCallFact[],
): Map<string, ModelMapping> {
  const mappings = new Map<string, ModelMapping>();
  const fluent = rule.fluent;
  if (!fluent) return mappings;
  const callbacks = new Map<string, Builder>();
  const role = (value: NominalValueFact) => value.member && fluent.methods[value.member];
  const member = (value: NominalValueFact | undefined) => value?.lambdaMember ?? value?.value;
  const builder = (value: NominalValueFact | undefined): Builder | undefined => {
    if (!value) return undefined;
    if (value.initializer) return builder(value.initializer);
    if (value.parameter?.index === 0) {
      const callback = callbacks.get(value.parameter.functionId);
      if (callback) return callback;
    }
    if (role(value) === 'entity' && value.receiver?.type && fluent.builderTypes.includes(value.receiver.type)) {
      const entity = value.typeArguments?.[0];
      return entity && types.has(entity) ? { entity } : undefined;
    }
    if (value.type && fluent.entityBuilderTypes.includes(value.type)) {
      const entity = value.typeArguments?.[0];
      return entity && types.has(entity) ? { entity } : undefined;
    }
    const receiver = builder(value.receiver);
    if (!receiver || !role(value)) return undefined;
    switch (role(value)) {
      case 'property':
        return { entity: receiver.entity, property: member(value.args?.[0]) };
      case 'reference':
      case 'collection': {
        const name = member(value.args?.[0]);
        const property = types.get(receiver.entity)?.properties.find((p) => p.name === name);
        const target = role(value) === 'reference' ? property?.type : property?.typeArguments[0];
        if (!name || !target || !types.has(target)) return undefined;
        return {
          entity: receiver.entity,
          relation: {
            name,
            targetEntityName: target,
            type: role(value) === 'reference' ? 'many-to-one' : 'one-to-many',
          },
        };
      }
      case 'inverseReference':
      case 'inverseCollection': {
        if (!receiver.relation) return undefined;
        const collection = receiver.relation.type === 'one-to-many';
        return {
          ...receiver,
          relation: {
            ...receiver.relation,
            inverseSide: member(value.args?.[0]),
            type: collection
              ? role(value) === 'inverseReference'
                ? 'one-to-many'
                : 'many-to-many'
              : role(value) === 'inverseReference'
                ? 'one-to-one'
                : 'many-to-one',
          },
        };
      }
      default:
        return receiver;
    }
  };
  for (const call of calls) {
    if (role(call) !== 'entity') continue;
    const state = builder(call);
    const callback =
      fluent.entityCallbackArg === undefined ? undefined : call.args?.[fluent.entityCallbackArg]?.functionId;
    if (state && callback) callbacks.set(callback, state);
  }
  for (const call of calls) {
    const state = builder(call);
    if (!state) continue;
    let mapping = mappings.get(state.entity);
    if (!mapping) {
      mapping = { tables: [], columns: new Map(), columnTypes: new Map(), keys: [], ignored: new Set(), relations: [] };
      mappings.set(state.entity, mapping);
    }
    switch (role(call)) {
      case 'table':
        mapping.tables.push({
          name: call.args?.[1] && call.args[1].value === undefined ? undefined : call.args?.[0]?.value,
          schema: call.args?.[1]?.value,
        });
        break;
      case 'key':
        mapping.keys.push(member(call.args?.[0]));
        break;
      case 'ignore': {
        const name = member(call.args?.[0]);
        if (name) mapping.ignored.add(name);
        break;
      }
      case 'column':
      case 'columnType': {
        if (!state.property) break;
        const values = role(call) === 'column' ? mapping.columns : mapping.columnTypes;
        values.set(state.property, [...(values.get(state.property) ?? []), call.args?.[0]?.value]);
        break;
      }
      case 'foreignKey': {
        const joinColumn = member(call.args?.[0]);
        if (state.relation && joinColumn) mapping.relations.push({ ...state.relation, joinColumn });
        break;
      }
    }
  }
  return mappings;
}
