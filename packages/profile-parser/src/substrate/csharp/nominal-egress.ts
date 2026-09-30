import type { StableIdGenerator } from '@coredoc/core';
import type { ExternalCallEdge, HttpMethod } from '@coredoc/core/types';
import type { NominalRules } from '../../types/csharp-profile.js';
import type { NominalCallFact, NominalTypeFact, NominalValueFact } from './model.js';

function initializer(value: NominalValueFact): NominalValueFact {
  return value.initializer ? initializer(value.initializer) : value;
}

function address(path: string | undefined, base: string | undefined): { target?: string; path?: string } {
  if (path === undefined) return {};
  try {
    const url = base ? new URL(path, base) : new URL(path);
    if (!['http:', 'https:'].includes(url.protocol)) return {};
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return { target: url.href, path: url.pathname };
  } catch {
    if (base || /^[a-z][a-z\d+.-]*:/i.test(path)) return {};
    return { path: `/${path.split(/[?#]/, 1)[0]!.replace(/^\/+/, '')}` };
  }
}

/** Outgoing calls need a declared receiver and profile-owned service/verb identity. */
export function nominalExternalCalls(
  rules: NominalRules,
  types: NominalTypeFact[],
  calls: NominalCallFact[],
  ids: StableIdGenerator,
): ExternalCallEdge[] {
  const methods = new Map(
    types.flatMap((type) => type.methods.map((method) => [method.id, { type, method }] as const)),
  );
  const result: ExternalCallEdge[] = [];
  for (const call of calls) {
    if (!call.receiver?.type || !call.member) continue;
    const candidates = new Map<string, ExternalCallEdge>();
    for (const rule of rules.externalCalls ?? []) {
      if (!rule.receiverTypes.includes(call.receiver.type)) continue;
      if (rule.factory) {
        const client = initializer(call.receiver);
        if (
          !client.member ||
          !client.receiver?.type ||
          !rule.factory.methods.includes(client.member) ||
          !rule.factory.receiverTypes.includes(client.receiver.type) ||
          client.args?.[rule.factory.nameArg]?.value !== rule.factory.name
        )
          continue;
      }
      let verb: HttpMethod | undefined;
      let path: string | undefined;
      if (rule.via === 'methods') {
        const method = rule.methods[call.member];
        if (!method) continue;
        verb = method.verb;
        path = method.pathArg === undefined ? undefined : call.args?.[method.pathArg]?.value;
      } else {
        const target = call.calleeId ? methods.get(call.calleeId) : undefined;
        if (!target || !rule.receiverTypes.includes(target.type.name)) continue;
        const routes = target.method.attributes.filter(
          (attribute) => attribute.type && rule.verbAttributes[attribute.type],
        );
        if (routes.length !== 1) continue;
        const route = routes[0]!;
        verb = rule.verbAttributes[route.type!]!;
        path = route.args.filter((arg) => !arg.name)[rule.pathArg]?.value;
      }
      const destination = address(path, rule.baseAddress);
      if (rule.via === 'attributes') {
        // URL serialization escapes route placeholders; the linker needs the declared template.
        const template = (value: string | undefined) => value?.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
        destination.path = template(destination.path);
        destination.target = template(destination.target);
      }
      const method = verb ?? call.member;
      const id = ids.externalCallId(
        call.callerId,
        rule.sdkName ?? rule.serviceName,
        method,
        `${call.location.filePath}:${call.location.startLine}:${call.location.startColumn}`,
      );
      const edge: ExternalCallEdge = {
        id,
        versionedId: ids.versionedId(
          id,
          JSON.stringify({ text: call.text, service: rule.serviceName, sdk: rule.sdkName, method, destination }),
        ),
        callerId: call.callerId,
        serviceName: rule.serviceName,
        sdkName: rule.sdkName,
        method,
        location: call.location,
        targetPattern: destination.target ?? destination.path,
        details: verb ? { httpMethod: verb, path: destination.path } : undefined,
        targetDescriptor:
          verb && destination.path
            ? { protocol: 'http', http: { method: verb, pathTemplate: destination.path } }
            : undefined,
      };
      candidates.set(JSON.stringify({ service: edge.serviceName, sdk: edge.sdkName, method, destination }), edge);
    }
    // Overlapping rules must not choose a target merely by profile ordering.
    if (candidates.size === 1) result.push([...candidates.values()][0]!);
  }
  return result;
}
