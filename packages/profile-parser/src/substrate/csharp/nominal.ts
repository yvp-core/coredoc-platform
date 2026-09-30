import type { StableIdGenerator } from '@coredoc/core';
import type { Entrypoint, EntityNode, DbOperation, DbOpResolutionStats } from '@coredoc/core/types';
import type { NominalRules } from '../../types/csharp-profile.js';
import type { NominalAttributeFact, NominalTypeFact, NominalCallFact, NominalValueFact } from './model.js';
import { fluentModelMappings } from './nominal-model-mapping.js';

function uniqueTypes(types: NominalTypeFact[]): Map<string, NominalTypeFact> {
  const groups = new Map<string, NominalTypeFact[]>();
  for (const type of types) groups.set(type.name, [...(groups.get(type.name) ?? []), type]);
  return new Map([...groups].flatMap(([name, matches]) => (matches.length === 1 ? [[name, matches[0]!]] : [])));
}

/** Interpret profile selectors; controller route tokens follow ASP.NET's [controller], [action] and ~/ conventions. */
export function nominalEntrypoints(
  rules: NominalRules,
  types: NominalTypeFact[],
  ids: StableIdGenerator,
  calls: NominalCallFact[] = [],
): Entrypoint[] {
  const result = new Map<string, Entrypoint>();
  const byName = uniqueTypes(types);
  function inherited(type: NominalTypeFact, seen = new Set<string>()): NominalTypeFact[] {
    if (seen.has(type.id)) return [];
    seen.add(type.id);
    return [
      type,
      ...type.baseTypes.flatMap((base) => {
        const t = byName.get(base);
        return t ? inherited(t, seen) : [];
      }),
    ];
  }
  const positional = (attribute: NominalAttributeFact) => attribute.args.filter((a) => !a.name);
  const template = (attribute: NominalAttributeFact) =>
    positional(attribute).length ? positional(attribute)[0]?.value : '';
  for (const rule of rules.controllers ?? []) {
    for (const type of types) {
      if (type.abstract) continue;
      const ancestry = inherited(type);
      if (!ancestry.some((t) => t.baseTypes.some((base) => rule.baseTypes.includes(base)))) continue;
      const routeOwner = ancestry.find((t) =>
        t.attributes.some((a) => a.type && rule.routeAttributes.includes(a.type)),
      );
      const classRoutes = routeOwner?.attributes
        .filter((a) => a.type && rule.routeAttributes.includes(a.type))
        .map(template) ?? [''];
      const signatures = new Set<string>();
      for (const owner of ancestry) {
        for (const method of owner.methods) {
          if (signatures.has(method.signature)) continue;
          if (
            !method.public ||
            method.static ||
            method.abstract ||
            method.attributes.some((a) => a.type && rule.ignoreAttributes?.includes(a.type))
          )
            continue;
          const verbs = method.attributes.filter((a) => a.type && rule.verbAttributes[a.type]);
          const routes = method.attributes.filter((a) => a.type && rule.routeAttributes.includes(a.type));
          for (const verb of verbs) {
            const methodTemplates = positional(verb).length
              ? [template(verb)]
              : routes.length
                ? routes.map(template)
                : [''];
            for (const prefix of classRoutes)
              for (const suffix of methodTemplates) {
                if (suffix === undefined) continue;
                const rooted = /^(\/|~\/)/.test(suffix);
                if (!rooted && prefix === undefined) continue;
                let path = rooted ? suffix.replace(/^~/, '') : `${prefix ?? ''}/${suffix}`;
                const controller =
                  rule.controllerSuffix && type.simpleName.endsWith(rule.controllerSuffix)
                    ? type.simpleName.slice(0, -rule.controllerSuffix.length)
                    : type.simpleName;
                path = path.replace(/\[controller\]/gi, controller).replace(/\[action\]/gi, method.name);
                if (/\[[^\]]+\]/.test(path)) continue;
                path = `/${path.split('/').filter(Boolean).join('/')}`;
                const httpMethod = rule.verbAttributes[verb.type!]!;
                const id = ids.entrypointId('http', `${httpMethod}:${path}:${method.id}`, method.location.filePath);
                result.set(id, {
                  id,
                  versionedId: ids.versionedId(id, `${method.id}:${httpMethod}:${path}`),
                  type: 'http',
                  handlerId: method.id,
                  location: method.location,
                  details: { type: 'http', method: httpMethod, path, fullPath: path },
                });
              }
          }
        }
        for (const method of owner.methods) signatures.add(method.signature);
      }
    }
  }
  for (const rule of rules.httpCalls ?? []) {
    const prefixFor = (value: NominalValueFact | undefined): string | undefined => {
      if (!value?.type) return undefined;
      if (rule.groups?.receiverTypes.includes(value.type)) {
        const builder = value.initializer ?? value;
        const pathArg = builder.member ? rule.groups.methods[builder.member] : undefined;
        const path = pathArg === undefined ? undefined : builder.args?.[pathArg]?.value;
        const parent = prefixFor(builder.receiver);
        return path === undefined || parent === undefined ? undefined : `${parent}/${path}`;
      }
      return rule.receiverTypes.includes(value.type) ? '' : undefined;
    };
    for (const call of calls) {
      const verb = call.member && rule.verbs[call.member];
      if (!verb) continue;
      const prefix = prefixFor(call.receiver);
      const path = call.args?.[rule.pathArg]?.value;
      const handlerId = call.args?.[rule.handlerArg]?.functionId;
      if (prefix === undefined || path === undefined || !handlerId) continue;
      const fullPath = `/${`${prefix}/${path}`.split('/').filter(Boolean).join('/')}`;
      const id = ids.entrypointId('http', `${verb}:${fullPath}:${handlerId}`, call.location.filePath);
      result.set(id, {
        id,
        versionedId: ids.versionedId(id, `${handlerId}:${verb}:${fullPath}`),
        type: 'http',
        handlerId,
        location: call.location,
        details: { type: 'http', method: verb, path: fullPath, fullPath },
      });
    }
  }
  for (const rule of rules.registrations ?? [])
    for (const call of calls) {
      if (
        !call.member ||
        !rule.methods.includes(call.member) ||
        !call.receiver?.type ||
        !rule.receiverTypes.includes(call.receiver.type)
      )
        continue;
      const type = byName.get(call.typeArguments?.[rule.typeArgument] ?? '');
      if (!type || type.abstract) continue;
      const ancestry = inherited(type);
      if (rule.baseTypes && !ancestry.some((t) => t.baseTypes.some((base) => rule.baseTypes!.includes(base)))) continue;
      const path = rule.pathArg === undefined ? undefined : call.args?.[rule.pathArg]?.value;
      if (rule.kind === 'websocket' && path === undefined) continue;
      for (const method of type.methods) {
        if (
          method.static ||
          method.abstract ||
          (rule.handlers && !rule.handlers.includes(method.name)) ||
          rule.excludeHandlers?.includes(method.name)
        )
          continue;
        if (rule.kind === 'websocket' && !method.public) continue;
        if (rule.kind === 'event' && !rule.eventName) continue;
        const details =
          rule.kind === 'event'
            ? { type: 'event' as const, eventName: rule.eventName! }
            : { type: 'websocket' as const, event: method.name, namespace: path };
        const id = ids.entrypointId(rule.kind, `${method.id}:${rule.eventName ?? path}`, method.location.filePath);
        result.set(id, {
          id,
          versionedId: ids.versionedId(id, JSON.stringify(details)),
          type: rule.kind,
          handlerId: method.id,
          location: method.location,
          details,
        });
      }
    }
  return [...result.values()];
}

export function nominalModels(
  rules: NominalRules,
  types: NominalTypeFact[],
  calls: NominalCallFact[],
  ids: StableIdGenerator,
): { entities: EntityNode[]; operations: DbOperation[]; stats: DbOpResolutionStats } {
  const entities = new Map<string, EntityNode>();
  const operations = new Map<string, DbOperation>();
  const sites = new Set<string>();
  const missingModels = new Set<string>();
  const boundSites = new Set<string>();
  const byName = uniqueTypes(types);
  const isA = (type: NominalTypeFact, names: string[], seen = new Set<string>()): boolean => {
    if (seen.has(type.id)) return false;
    seen.add(type.id);
    return (
      names.includes(type.name) ||
      type.baseTypes.some((base) => names.includes(base) || (byName.has(base) && isA(byName.get(base)!, names, seen)))
    );
  };
  const properties = (type: NominalTypeFact, seen = new Set<string>()): NominalTypeFact['properties'] => {
    if (seen.has(type.id)) return [];
    seen.add(type.id);
    const inherited = type.baseTypes.flatMap((name) => {
      const base = byName.get(name);
      return base ? properties(base, seen) : [];
    });
    return [...new Map([...inherited, ...type.properties].map((property) => [property.name, property])).values()];
  };
  for (const rule of rules.models ?? []) {
    const mappings = fluentModelMappings(rule, byName, calls);
    const registered = new Set(mappings.keys());
    for (const type of types.filter((t) => isA(t, rule.contextTypes))) {
      for (const property of type.properties)
        if (property.type && rule.setTypes.includes(property.type) && property.typeArguments[0])
          registered.add(property.typeArguments[0]);
    }
    for (const name of registered) {
      const type = byName.get(name);
      if (!type) continue;
      const tables = type.attributes.filter((a) => a.type && rule.tableAttributes.includes(a.type));
      const table = tables.length === 1 ? tables[0] : undefined;
      const mapping = mappings.get(name);
      const fluentTables = new Map(mapping?.tables.map((t) => [JSON.stringify(t), t]));
      if (fluentTables.size > 1 || new Set(mapping?.keys).size > 1) continue;
      const fluentTable = [...fluentTables.values()][0];
      const tableName = fluentTable ? fluentTable.name : table?.args.find((a) => !a.name)?.value;
      // The graph's required tableName must not turn an unknown mapping into a
      // purported explicit table. Additional mapping conventions need a profile rule.
      if (!tableName) continue;
      const fields = properties(type)
        .filter(
          (p) =>
            p.public &&
            !p.static &&
            !mapping?.ignored.has(p.name) &&
            !(p.type && registered.has(p.type)) &&
            !p.typeArguments.some((a) => a !== undefined && registered.has(a)) &&
            !p.attributes.some((a) => a.type && rule.ignoreAttributes?.includes(a.type)),
        )
        .filter((p) =>
          [mapping?.columns.get(p.name), mapping?.columnTypes.get(p.name)].every(
            (values) => !values || (!values.includes(undefined) && new Set(values).size === 1),
          ),
        )
        .map((p) => {
          const column = p.attributes.find((a) => a.type && rule.columnAttributes?.includes(a.type));
          return {
            name: p.name,
            columnName: mapping?.columns.get(p.name)?.[0] ?? column?.args.find((a) => !a.name)?.value ?? p.name,
            type: { text: p.type ?? p.typeText ?? 'unknown' },
            dbType: mapping?.columnTypes.get(p.name)?.[0] ?? column?.args.find((a) => a.name === 'TypeName')?.value,
            isPrimaryKey: mapping?.keys.length
              ? mapping.keys[0] === p.name
              : p.attributes.some((a) => a.type && rule.keyAttributes?.includes(a.type)),
            isNullable: p.nullable,
            isUnique: false,
            isGenerated: false,
          };
        });
      const id = ids.entityId(type.location.filePath, type.name);
      entities.set(name, {
        id,
        versionedId: ids.versionedId(id, JSON.stringify({ tableName, fields })),
        name: type.name,
        kind: 'entity',
        fileId: ids.fileId(type.location.filePath),
        location: type.location,
        ormType: rule.orm,
        tableName,
        schema: fluentTable ? fluentTable.schema : table?.args.find((a) => a.name === 'Schema')?.value,
        fields,
        relations: [],
      });
    }
    for (const [name, mapping] of mappings) {
      const entity = entities.get(name);
      if (!entity) continue;
      const relations = new Map<string, Map<string, (typeof entity.relations)[number]>>();
      for (const relation of mapping.relations) {
        const matches = relations.get(relation.name) ?? new Map();
        matches.set(JSON.stringify(relation), relation);
        relations.set(relation.name, matches);
      }
      entity.relations = [...relations.values()]
        .filter((matches) => matches.size === 1)
        .map((matches) => {
          const relation = [...matches.values()][0]!;
          const target = entities.get(relation.targetEntityName);
          const columnOwner = relation.type === 'one-to-many' ? target : entity;
          return {
            ...relation,
            targetEntityId: target?.id,
            joinColumn:
              columnOwner?.fields.find((f) => f.name === relation.joinColumn)?.columnName ?? relation.joinColumn,
          };
        });
      entity.versionedId = ids.versionedId(
        entity.id,
        JSON.stringify({ tableName: entity.tableName, fields: entity.fields, relations: entity.relations }),
      );
    }
    const receiverModel = (value: NominalValueFact | undefined): { name?: string } | undefined => {
      if (!value) return undefined;
      if (value.type && rule.setTypes.includes(value.type)) return { name: value.typeArguments?.[0] };
      if (value.initializer) return receiverModel(value.initializer);
      if (value.member && rule.setMethods?.includes(value.member) && value.receiver?.type) {
        const receiver = byName.get(value.receiver.type);
        if (rule.contextTypes.includes(value.receiver.type) || (receiver && isA(receiver, rule.contextTypes)))
          return { name: value.typeArguments?.[0] };
      }
      if (value.member && rule.chainMethods?.includes(value.member)) return receiverModel(value.receiver);
      return undefined;
    };
    for (const call of calls) {
      const operation = call.member && rule.operations[call.member];
      if (!operation || !call.receiver) continue;
      const model = receiverModel(call.receiver);
      if (!model) continue;
      const site = `${call.callerId}:${call.location.filePath}:${call.location.startLine}:${call.location.startColumn}:${call.text}`;
      sites.add(site);
      const entity = model.name ? entities.get(model.name) : undefined;
      if (!entity) {
        if (model.name) missingModels.add(site);
        continue;
      }
      boundSites.add(site);
      const id = ids.dbOperationId(call.callerId, entity.id, operation, site);
      operations.set(id, {
        id,
        versionedId: ids.versionedId(id, call.text),
        performerId: call.callerId,
        entityId: entity.id,
        entityName: entity.name,
        operation,
        details: call.text,
        location: call.location,
      });
    }
  }
  return {
    entities: [...entities.values()],
    operations: [...operations.values()],
    stats: {
      dbOpSites: sites.size,
      boundDbOps: operations.size,
      outOfScopeDbOps: [...missingModels].filter((site) => !boundSites.has(site)).length,
    },
  };
}
