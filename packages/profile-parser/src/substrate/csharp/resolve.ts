import type { CallProvenance } from '@coredoc/core/types';
import type { Expression, Invocation, Method, Project, TypeDeclaration } from './model.js';
import type { CSharpProfile } from '../../types/csharp-profile.js';

const primitive: Record<string, string> = {
  'System.String': 'string',
  'System.Int32': 'int',
  'System.Boolean': 'bool',
  'System.Int64': 'long',
  'System.Double': 'double',
  'System.Object': 'object',
};
const primitiveNames = new Set(Object.values(primitive));
export const normalizeType = (type: string) => primitive[type] ?? type.replace(/^global::/, '').replace(/\s+/g, '');
export function typeHead(type: string): string {
  const normalized = normalizeType(type).replace(/\?$/, '');
  const start = normalized.indexOf('<');
  if (start < 0) return normalized;
  let depth = 0;
  let arity = 1;
  for (const c of normalized.slice(start + 1, -1)) {
    if (c === '<') depth++;
    if (c === '>') depth--;
    if (c === ',' && depth === 0) arity++;
  }
  return `${normalized.slice(0, start)}\`${arity}`;
}
export function typeArguments(type: string): string[] {
  const start = type.indexOf('<');
  if (start < 0 || !type.endsWith('>')) return [];
  const result: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of type.slice(start + 1, -1)) {
    if (c === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
      continue;
    }
    if (c === '<') depth++;
    if (c === '>') depth--;
    current += c;
  }
  if (current) result.push(current.trim());
  return result;
}
const only = <T>(items: T[]): T | undefined => (items.length === 1 ? items[0] : undefined);

/** Lexical/project resolution only. A globally unique name is never a visibility proof. */
export class CSharpResolver {
  private byName = new Map<string, TypeDeclaration[]>();
  private visible = new Map<string, Set<string>>();
  constructor(
    readonly types: TypeDeclaration[],
    readonly projects: Project[],
    readonly libraries: CSharpProfile['libraries'] = [],
  ) {
    for (const t of types) this.byName.set(t.name, [...(this.byName.get(t.name) ?? []), t]);
    for (const p of projects) {
      const found = new Set<string>();
      const visit = (path: string) => {
        if (found.has(path)) return;
        found.add(path);
        for (const ref of projects.find((p) => p.path === path)?.references ?? []) visit(ref);
      };
      visit(p.path);
      this.visible.set(p.path, found);
    }
  }
  identity(text: string, context: TypeDeclaration, attribute = false): string | undefined {
    const local =
      this.resolveType(text, context) ?? (attribute ? this.resolveType(`${text}Attribute`, context) : undefined);
    if (local) return local.name;
    const project = this.projects.find((p) => p.path === context.project);
    const catalog = new Set(
      this.libraries
        ?.filter(
          (lib) =>
            (lib.projectSdk && lib.projectSdk === project?.sdk) ||
            (lib.dependency && project?.dependencies[lib.dependency] !== undefined),
        )
        .flatMap((lib) => lib.types),
    );
    const usings = [...context.usings, ...(project?.globalUsings ?? [])];
    let name = typeHead(text);
    const aliases = [...new Set(usings.filter((u) => u.alias === name.split('.')[0]).map((u) => u.name))];
    if (aliases.length > 1) return undefined;
    if (aliases[0]) name = aliases[0] + name.slice(name.split('.')[0]!.length);
    const names = attribute ? [name, `${name}Attribute`] : [name];
    let prefix = context.name;
    while (prefix) {
      const candidates = names.map((n) => `${prefix}.${n}`).filter((n) => catalog.has(n));
      if (candidates.length) return only([...new Set(candidates)]);
      prefix = prefix.includes('.') ? prefix.slice(0, prefix.lastIndexOf('.')) : '';
    }
    const candidates = names
      .flatMap((n) => [n, ...usings.filter((u) => !u.alias && !u.static).map((u) => `${u.name}.${n}`)])
      .filter((n) => catalog.has(n));
    return only([...new Set(candidates)]);
  }
  resolveType(text: string, context: TypeDeclaration): TypeDeclaration | undefined {
    let name = typeHead(text);
    const usings = [...context.usings, ...(this.projects.find((p) => p.path === context.project)?.globalUsings ?? [])];
    const alias = usings.filter((u) => u.alias === name.split('.')[0]);
    if (alias.length > 1) return undefined;
    if (alias[0]) name = alias[0].name + name.slice(name.split('.')[0]!.length);
    const inScope = (candidate: string) =>
      (this.byName.get(candidate) ?? []).filter(
        (t) => this.visible.get(context.project)?.has(t.project) ?? t.project === context.project,
      );
    // A nested or same-namespace declaration shadows imported types.
    let prefix = context.name;
    while (prefix) {
      const candidates = inScope(`${prefix}.${name}`);
      if (candidates.length) return only(candidates);
      prefix = prefix.includes('.') ? prefix.slice(0, prefix.lastIndexOf('.')) : '';
    }
    const direct = inScope(name);
    if (direct.length) return only(direct);
    const imported = usings.filter((u) => !u.alias && !u.static).flatMap((u) => inScope(`${u.name}.${name}`));
    return only([...new Set(imported)]);
  }
  methods(type: TypeDeclaration, name: string, visited = new Set<string>()): Method[] {
    if (visited.has(type.id)) return [];
    visited.add(type.id);
    const own = type.methods.filter((m) => m.name === name);
    const inherited = type.bases.flatMap((b) => {
      const base = this.resolveType(b, type);
      return base ? this.methods(base, name, visited) : [];
    });
    return [...own, ...inherited];
  }
  private derivesFrom(type: TypeDeclaration, base: TypeDeclaration, seen = new Set<string>()): boolean {
    if (type.id === base.id) return true;
    if (seen.has(type.id)) return false;
    seen.add(type.id);
    return type.bases.some((name) => {
      const parent = this.resolveType(name, type);
      return parent !== undefined && this.derivesFrom(parent, base, seen);
    });
  }
  private accessible(method: Method, caller: TypeDeclaration, receiver: TypeDeclaration, viaBase: boolean): boolean {
    const mods = method.modifiers;
    const sameType = method.type.id === caller.id;
    const sameProject = method.type.project === caller.project;
    if (mods.includes('public') || (method.type.kind === 'interface_declaration' && !mods.includes('private')))
      return true;
    // A protected instance member can only be reached through this/base or a
    // receiver of the accessing derived type (C#'s protected receiver restriction).
    const protectedAccess = this.derivesFrom(caller, method.type) && (viaBase || this.derivesFrom(receiver, caller));
    if (mods.includes('protected')) {
      if (mods.includes('private')) return sameProject && protectedAccess;
      if (mods.includes('internal')) return sameProject || protectedAccess;
      return protectedAccess;
    }
    if (mods.includes('internal')) return sameProject;
    return sameType;
  }
  bindingType(name: string, site: Invocation, depth = 0): string | undefined {
    if (depth > 12) return undefined;
    const { caller, offset } = site;
    const locals = caller.bindings
      .filter((b) => b.name === name && b.start <= offset && offset <= b.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    if (locals.length) {
      const binding = locals[0]!;
      // A later declaration still shadows the outer variable; it cannot authorize a call.
      if (binding.declaredAt > offset || locals[1]?.start === binding.start) return undefined;
      return (
        binding.type ??
        (binding.value
          ? this.expressionType(binding.value, { ...site, offset: binding.declaredAt - 1 }, depth + 1)
          : undefined)
      );
    }
    const parameter = caller.parameters.find((p) => p.name === name);
    if (parameter) return parameter.type?.text;
    if (caller.outer) return this.bindingType(name, { ...site, caller: caller.outer }, depth + 1);
    const primary = caller.type.primaryParameters.find((p) => p.name === name);
    if (primary) return primary.type?.text;
    const property = caller.type.properties.find((p) => p.name === name);
    if (property) return property.type;
    return undefined;
  }
  bindingInitializer(name: string, site: Invocation): { value: Expression; site: Invocation } | undefined {
    for (let caller: Method | undefined = site.caller; caller; caller = caller.outer) {
      if (caller.writes.includes(name)) return undefined;
      const locals = caller.bindings
        .filter((b) => b.name === name && b.start <= site.offset && site.offset <= b.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start));
      if (locals.length) {
        const binding = locals[0]!;
        if (!binding.value || binding.declaredAt > site.offset || locals[1]?.start === binding.start) return undefined;
        return { value: binding.value, site: { ...site, caller, offset: binding.declaredAt - 1 } };
      }
      if (caller.parameters.some((p) => p.name === name)) return undefined;
    }
    return undefined;
  }
  parameterBinding(name: string, site: Invocation): { functionId: string; index: number } | undefined {
    for (let caller: Method | undefined = site.caller; caller; caller = caller.outer) {
      if (caller.writes.includes(name)) return undefined;
      const bindings = caller.bindings
        .filter((b) => b.name === name && b.start <= site.offset && site.offset <= b.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start));
      if (bindings.length) {
        const binding = bindings[0]!;
        return binding.parameterIndex === undefined || bindings[1]?.start === binding.start
          ? undefined
          : { functionId: caller.id, index: binding.parameterIndex };
      }
      const index = caller.parameters.findIndex((p) => p.name === name);
      if (index >= 0) return { functionId: caller.id, index };
    }
    const index = site.caller.type.primaryParameters.findIndex((p) => p.name === name);
    const constructors = site.caller.type.methods.filter((m) => m.name === '.ctor');
    if (index >= 0 && constructors.length === 1 && !site.caller.type.methods.some((m) => m.writes.includes(name)))
      return { functionId: constructors[0]!.id, index };
    return undefined;
  }
  expressionType(expr: Expression, site: Invocation, depth = 0): string | undefined {
    if (depth > 12) return undefined;
    if (
      expr.kind === 'string_literal' ||
      expr.kind === 'verbatim_string_literal' ||
      expr.kind === 'interpolated_string_expression'
    )
      return 'string';
    if (expr.kind === 'integer_literal') return /[lL]$/.test(expr.text) ? 'long' : 'int';
    if (expr.kind === 'boolean_literal') return 'bool';
    if (expr.kind === 'object_creation_expression') return expr.type;
    if (expr.text === 'this') return site.caller.type.name;
    if (expr.kind === 'identifier') return this.bindingType(expr.text, site, depth + 1);
    if (expr.kind === 'member_access_expression' && expr.object) {
      const receiver = this.expressionType(expr.object, site, depth + 1);
      const type = receiver
        ? this.resolveType(receiver, site.caller.type)
        : this.resolveType(expr.object.text, site.caller.type);
      const property = type?.properties.find((p) => p.name === expr.name)?.type;
      return (
        property ?? this.libraryMember(receiver ?? expr.object.text, expr.name ?? '', site.caller.type, 'properties')
      );
    }
    if (expr.kind === 'invocation_expression') {
      const resolved = this.resolveCall({ ...site, expression: expr }, depth + 1)?.method.returnType;
      if (resolved) return resolved;
      const fn = expr.object;
      if (fn?.object && fn.name) {
        const receiver = this.expressionType(fn.object, site, depth + 1) ?? fn.object.text;
        return this.libraryMember(receiver, fn.name, site.caller.type, 'methods');
      }
    }
    return undefined;
  }
  private libraryMember(
    receiver: string,
    member: string,
    context: TypeDeclaration,
    kind: 'methods' | 'properties',
  ): string | undefined {
    // Source declarations take precedence over a profile's external-library catalog.
    if (this.resolveType(receiver, context)) return undefined;
    const identity = this.identity(receiver, context);
    if (!identity) return undefined;
    const project = this.projects.find((p) => p.path === context.project);
    const matches = this.libraries
      ?.filter(
        (lib) =>
          (lib.projectSdk && lib.projectSdk === project?.sdk) ||
          (lib.dependency && project?.dependencies[lib.dependency] !== undefined),
      )
      .flatMap((lib) => lib.members?.[identity]?.[kind]?.[member] ?? []);
    return only([...new Set(matches)]);
  }
  hasValueBinding(name: string, site: Invocation): boolean {
    for (let method: Method | undefined = site.caller; method; method = method.outer) {
      if (
        method.bindings.some((b) => b.name === name && b.start <= site.offset && site.offset <= b.end) ||
        method.parameters.some((p) => p.name === name)
      )
        return true;
    }
    return (
      site.caller.type.primaryParameters.some((p) => p.name === name) ||
      site.caller.type.properties.some((p) => p.name === name)
    );
  }
  resolveCall(site: Invocation, depth = 0): { method: Method; provenance: CallProvenance } | undefined {
    if (depth > 12) return undefined;
    const fn = site.expression.object;
    if (!fn) return undefined;
    let type: TypeDeclaration | undefined;
    let provenance: CallProvenance = 'cs-lexical';
    let staticOnly = false;
    if (fn.kind === 'identifier' || fn.kind === 'generic_name') {
      if (fn.name && this.hasValueBinding(fn.name, site)) return undefined;
      type = site.caller.type;
    } else if (fn.kind === 'member_access_expression' && fn.object) {
      if (fn.object.text === 'this') type = site.caller.type;
      else if (fn.object.text === 'base') {
        type = this.resolveType(site.caller.type.bases[0] ?? '', site.caller.type);
        if (type && !['class_declaration', 'record_declaration'].includes(type.kind)) return undefined;
      } else {
        const receiverType = this.expressionType(fn.object, site, depth + 1);
        if (receiverType) type = this.resolveType(receiverType, site.caller.type);
        else {
          // An unknown local/parameter/property must not be reinterpreted as a type name.
          const name = fn.object.text;
          if (
            site.caller.bindings.some((b) => b.name === name && b.start <= site.offset && site.offset <= b.end) ||
            site.caller.parameters.some((p) => p.name === name) ||
            site.caller.type.properties.some((p) => p.name === name) ||
            site.caller.type.primaryParameters.some((p) => p.name === name)
          )
            return undefined;
          type = this.resolveType(name, site.caller.type);
          staticOnly = true;
        }
        provenance = 'cs-type';
      }
    }
    if (!type || !fn.name) return undefined;
    const args = site.expression.args ?? [];
    const candidates = this.methods(type, fn.name).filter((m) => {
      if (staticOnly && !m.modifiers.includes('static')) return false;
      if (!this.accessible(m, site.caller.type, type, fn.object?.text === 'base')) return false;
      if (m.genericArity !== (fn.typeArgs?.length ?? 0)) return false;
      return (
        args.length >= m.parameters.filter((p) => !p.isOptional && !p.isRest).length &&
        args.length <= m.parameters.length
      );
    });
    const applicability = candidates.map((method) => {
      const matches = args.map((a, i) => {
        const parameter = a.name ? method.parameters.find((p) => p.name === a.name) : method.parameters[i];
        if (!parameter) return false;
        const actual = this.expressionType(a, site, depth + 1);
        const expected = parameter.type?.text;
        // Unknown types do not prove applicability, even for one arity candidate.
        if (!actual || !expected) return undefined;
        const aName = normalizeType(actual);
        const pName = normalizeType(expected);
        if (primitiveNames.has(aName) && primitiveNames.has(pName)) {
          if (aName === pName) return true;
          // Numeric conversions and boxing are left to the compiler tier. They
          // may make a derived overload applicable, hiding an exact base match.
          if (aName === 'object' || pName === 'object') return undefined;
          if (['string', 'bool'].includes(aName) || ['string', 'bool'].includes(pName)) return false;
          return undefined;
        }
        const aType = this.resolveType(actual, site.caller.type);
        const pType = this.resolveType(expected, method.type);
        return aType !== undefined && aType === pType ? true : undefined;
      });
      return {
        method,
        match: matches.includes(false) ? false : matches.every((match) => match === true) ? true : undefined,
      };
    });
    const possible = applicability.filter(({ match }) => match !== false);
    // C# excludes base methods only after a derived method is applicable. When
    // a conversion is unsupported, abstain instead of selecting the base edge.
    const mostDerived = possible.filter(
      ({ method }) =>
        !possible.some(
          ({ method: other }) => other.type.id !== method.type.id && this.derivesFrom(other.type, method.type),
        ),
    );
    const method = only(mostDerived.filter(({ match }) => match === true).map(({ method }) => method));
    return method ? { method, provenance } : undefined;
  }
}
