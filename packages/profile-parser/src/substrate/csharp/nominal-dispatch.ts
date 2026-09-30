import type { NominalRules } from '../../types/csharp-profile.js';
import type { CallEdgeFact } from '../interface.js';
import type { NominalCallFact, NominalTypeFact } from './model.js';

/** Only a unique explicit binding and a compiler-proven implementation permit constructor dispatch. */
export function nominalDispatch(
  rules: NominalRules,
  types: NominalTypeFact[],
  calls: NominalCallFact[],
  edges: CallEdgeFact[],
): CallEdgeFact[] {
  const bindings = new Map<string, Set<string | undefined>>();
  for (const rule of rules.bindings ?? []) {
    for (const call of calls) {
      if (
        !call.member ||
        !rule.methods.includes(call.member) ||
        !call.receiver?.type ||
        !rule.receiverTypes.includes(call.receiver.type)
      )
        continue;
      const service = call.typeArguments?.[rule.serviceTypeArgument];
      if (!service) continue;
      const implementations = bindings.get(service) ?? new Set<string | undefined>();
      implementations.add(call.typeArguments?.[rule.implementationTypeArgument]);
      bindings.set(service, implementations);
    }
  }
  const constructors = new Set(types.flatMap((t) => t.methods.filter((m) => m.isConstructor).map((m) => m.id)));
  const facts = new Map(calls.map((call) => [call.id, call]));
  return edges.map((edge) => {
    const call = facts.get(edge.id);
    const receiver = call?.receiver;
    if (!edge.calleeId || !receiver?.type || !receiver.parameter || !constructors.has(receiver.parameter.functionId))
      return edge;
    const names = bindings.get(receiver.type);
    if (names?.size !== 1) return edge;
    const name = [...names][0];
    if (!name) return edge;
    const implementations = types.filter((type) => type.name === name && !type.abstract);
    if (implementations.length !== 1) return edge;
    const methods = implementations[0]!.methods.filter(
      (method) => method.implements?.includes(edge.calleeId!) && !method.abstract,
    );
    if (methods.length !== 1) return edge;
    return { ...edge, calleeId: methods[0]!.id, provenance: 'di' };
  });
}
