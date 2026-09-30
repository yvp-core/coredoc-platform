import type { Node } from 'web-tree-sitter';
import type { ParameterInfo, SourceLocation } from '@coredoc/core/types';
import type { Attribute, Expression, Invocation, Method, TypeDeclaration, Using } from './model.js';

const child = (n: Node, type: string) => n.namedChildren.find((c) => c.type === type);
const field = (n: Node, name: string) => n.childForFieldName(name);
const range = (n: Node) => [n.startPosition.row, n.startPosition.column, n.endPosition.row, n.endPosition.column];
export const modifiers = (n: Node) => n.namedChildren.filter((c) => c.type === 'modifier').map((c) => c.text);
const location = (n: Node, filePath: string): SourceLocation => ({
  filePath,
  startLine: n.startPosition.row + 1,
  endLine: n.endPosition.row + 1,
  startColumn: n.startPosition.column,
  endColumn: n.endPosition.column,
});

export function stringValue(text: string): string | undefined {
  if (text.startsWith('@"') && text.endsWith('"')) return text.slice(2, -1).replaceAll('""', '"');
  if (text.startsWith('"') && !text.startsWith('"""')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function expression(n: Node): Expression {
  const base: Expression = { kind: n.type, text: n.text, start: n.startIndex, end: n.endIndex };
  if (n.type === 'argument' || n.type === 'attribute_argument') {
    const value = n.namedChildren.at(-1);
    if (n.type === 'attribute_argument' && value?.type === 'assignment_expression') {
      const right = field(value, 'right');
      if (right) return { ...expression(right), name: field(value, 'left')?.text };
    }
    return value ? { ...expression(value), name: field(n, 'name')?.text } : base;
  }
  if (n.type === 'invocation_expression') {
    const fn = field(n, 'function');
    return {
      ...base,
      object: fn ? expression(fn) : undefined,
      args: field(n, 'arguments')?.namedChildren.map(expression) ?? [],
    };
  }
  if (n.type === 'member_access_expression') {
    const receiver = field(n, 'expression');
    const name = field(n, 'name');
    return {
      ...base,
      object: receiver ? expression(receiver) : undefined,
      name: name?.type === 'generic_name' ? name.namedChildren[0]?.text : name?.text,
      nameRange: name ? range(name.type === 'generic_name' ? name.namedChildren[0]! : name) : undefined,
      typeArgs: name ? child(name, 'type_argument_list')?.namedChildren.map((c) => c.text) : undefined,
    };
  }
  if (n.type === 'generic_name')
    return {
      ...base,
      name: n.namedChildren[0]?.text,
      nameRange: n.namedChildren[0] ? range(n.namedChildren[0]) : undefined,
      typeArgs: child(n, 'type_argument_list')?.namedChildren.map((c) => c.text),
    };
  if (n.type === 'identifier') return { ...base, name: n.text, nameRange: range(n) };
  if (n.type === 'object_creation_expression')
    return { ...base, type: field(n, 'type')?.text, args: field(n, 'arguments')?.namedChildren.map(expression) };
  if (n.type === 'await_expression' || n.type === 'parenthesized_expression' || n.type === 'arrow_expression_clause')
    return n.namedChildren[0] ? expression(n.namedChildren[0]) : base;
  if (n.type === 'lambda_expression')
    return {
      ...base,
      args: field(n, 'parameters')?.namedChildren.map(expression),
      object: field(n, 'body') ? expression(field(n, 'body')!) : undefined,
    };
  return base;
}

function attributes(n: Node): Attribute[] {
  return n.namedChildren
    .filter((c) => c.type === 'attribute_list')
    .flatMap((list) =>
      list.namedChildren
        .filter((c) => c.type === 'attribute')
        .map((a) => ({
          name: field(a, 'name')?.text ?? '',
          text: a.text,
          args: child(a, 'attribute_argument_list')?.namedChildren.map(expression) ?? [],
        })),
    );
}
function parameters(n: Node | undefined | null): ParameterInfo[] {
  return (
    n?.namedChildren
      .filter((c) => c.type === 'parameter')
      .map((p) => ({
        name: field(p, 'name')?.text ?? '',
        type: field(p, 'type') ? { text: field(p, 'type')!.text } : undefined,
        isOptional: p.children.some((c) => c.text === '='),
        isRest: p.children.some((c) => c.text === 'params'),
      })) ?? []
  );
}
function using(n: Node): Using {
  return {
    name: n.namedChildren.at(-1)?.text ?? '',
    alias: field(n, 'name')?.text,
    static: n.children.some((c) => c.text === 'static'),
  };
}
/** A `new T(...)` site: a use of T even when T declares no constructor to call. */
export interface Construction {
  type: string;
  caller: Method;
  loc: SourceLocation;
}
export interface FileFacts {
  types: TypeDeclaration[];
  invocations: Invocation[];
  constructions: Construction[];
  globalUsings: Using[];
}

export function extractFile(root: Node, file: string, project: string, originalSource?: string): FileFacts {
  const facts: FileFacts = { types: [], invocations: [], constructions: [], globalUsings: [] };
  const typeKinds = new Set([
    'class_declaration',
    'struct_declaration',
    'record_declaration',
    'interface_declaration',
    'enum_declaration',
  ]);
  function readMethod(n: Node, type: TypeDeclaration, forcedName?: string, outer?: Method, bodies?: Node[]): Method {
    const params = parameters(field(n, 'parameters') ?? child(n, 'parameter_list'));
    const name = forcedName ?? field(n, 'name')?.text ?? '';
    const genericArity = child(n, 'type_parameter_list')?.namedChildCount ?? 0;
    const signature = `${name}${genericArity ? `\`${genericArity}` : ''}(${params.map((p) => p.type?.text.replace(/\s+/g, '') ?? '?').join(',')})`;
    const method: Method = {
      nameRange: field(n, 'name') ? range(field(n, 'name')!) : undefined,
      outer,
      id: '',
      name,
      signature,
      parameters: params,
      returnType: field(n, 'returns')?.text ?? field(n, 'type')?.text,
      modifiers: modifiers(n),
      attributes: attributes(n),
      loc: location(n, file),
      source: originalSource?.slice(n.startIndex, n.endIndex) ?? n.text,
      type,
      bindings: [],
      writes: [],
      start: n.startIndex,
      end: n.endIndex,
      genericArity,
    };
    type.methods.push(method);
    let lambdaOrdinal = 0;
    let localOrdinal = 0;
    function visit(node: Node, scope: Node) {
      if (node.type === 'block' || node.type === 'lambda_expression' || node.type === 'local_function_statement')
        scope = node;
      if ((node.type === 'lambda_expression' || node.type === 'local_function_statement') && node !== n) {
        const nested = readMethod(
          node,
          type,
          `${signature}.$${node.type === 'lambda_expression' ? `lambda${++lambdaOrdinal}` : `${field(node, 'name')?.text}#${++localOrdinal}`}`,
          method,
        );
        // A nested binding shadows the outer one even when its inferred type is unknown.
        const ps = field(node, 'parameters');
        const names: Pick<ParameterInfo, 'name' | 'type'>[] =
          ps?.type === 'implicit_parameter' ? [{ name: ps.text }] : parameters(ps);
        for (const [parameterIndex, p] of names.entries())
          nested.bindings.push({
            parameterIndex,
            name: p.name,
            type: 'type' in p ? p.type?.text : undefined,
            start: node.startIndex,
            end: node.endIndex,
            declaredAt: node.startIndex,
          });
        method.writes.push(...nested.writes);
        return;
      }
      const written =
        node.type === 'assignment_expression'
          ? field(node, 'left')
          : node.type === 'argument' && /^(ref|out)\b/.test(node.text)
            ? node
            : undefined;
      if (written) {
        const identifiers = written.type === 'identifier' ? [written] : written.descendantsOfType('identifier');
        method.writes.push(...identifiers.map((identifier) => identifier.text));
      }
      if (node.type === 'variable_declarator') {
        const declaredType = node.parent ? field(node.parent, 'type')?.text : undefined;
        method.bindings.push({
          name: field(node, 'name')?.text ?? '',
          type: declaredType === 'var' ? undefined : declaredType,
          value: node.namedChildren.length > 1 ? expression(node.namedChildren.at(-1)!) : undefined,
          start: scope.startIndex,
          end: scope.endIndex,
          declaredAt: node.startIndex,
        });
      }
      if (node.type === 'object_creation_expression') {
        const type = field(node, 'type')?.text;
        if (type) facts.constructions.push({ type, caller: method, loc: location(node, file) });
      }
      if (node.type === 'invocation_expression') {
        let parent = node.parent;
        while (parent && !['variable_declarator', 'expression_statement', 'block'].includes(parent.type))
          parent = parent.parent;
        facts.invocations.push({
          expression: expression(node),
          caller: method,
          loc: location(node, file),
          offset: node.startIndex,
          assignedTo: parent?.type === 'variable_declarator' ? field(parent, 'name')?.text : undefined,
        });
      }
      for (const c of node.namedChildren) visit(c, scope);
    }
    const body = field(n, 'body');
    if (bodies) for (const statement of bodies) visit(statement, n);
    else if (body && !typeKinds.has(n.type)) visit(body, body);
    return method;
  }
  function visit(n: Node, namespace: string, inheritedUsings: Using[], parentName?: string) {
    const fileNamespace = n.namedChildren.find((c) => c.type === 'file_scoped_namespace_declaration');
    if (fileNamespace) namespace = field(fileNamespace, 'name')?.text ?? namespace;
    const directives = n.namedChildren.filter((c) => c.type === 'using_directive');
    for (const directive of directives.filter((c) => c.children.some((t) => t.text === 'global')))
      facts.globalUsings.push(using(directive));
    const usings = [...inheritedUsings, ...directives.map(using)];
    for (const node of n.namedChildren) {
      if (node.type === 'namespace_declaration') {
        const body = field(node, 'body');
        if (body) visit(body, [namespace, field(node, 'name')?.text].filter(Boolean).join('.'), usings);
      } else if (
        typeKinds.has(node.type) &&
        !node.namedChildren.some((c) => c.type !== 'declaration_list' && c.hasError)
      ) {
        const simpleName = field(node, 'name')?.text ?? '';
        const arity = child(node, 'type_parameter_list')?.namedChildCount ?? 0;
        const name = [parentName ?? namespace, `${simpleName}${arity ? `\`${arity}` : ''}`].filter(Boolean).join('.');
        const type: TypeDeclaration = {
          nameRange: field(node, 'name') ? range(field(node, 'name')!) : undefined,
          id: '',
          name,
          simpleName,
          namespace,
          kind: node.type,
          project,
          file,
          usings,
          modifiers: modifiers(node),
          attributes: attributes(node),
          bases:
            child(node, 'base_list')
              ?.namedChildren.filter((c) => c.type !== 'argument_list')
              .map((c) => c.text) ?? [],
          methods: [],
          properties: [],
          primaryParameters: parameters(child(node, 'parameter_list')),
          loc: location(node, file),
          source: originalSource?.slice(node.startIndex, node.endIndex) ?? node.text,
          enumMembers: [],
        };
        facts.types.push(type);
        const body = field(node, 'body');
        for (const member of body?.namedChildren ?? []) {
          if (member.hasError) continue;
          if (member.type === 'method_declaration') readMethod(member, type);
          else if (member.type === 'constructor_declaration') readMethod(member, type, '.ctor');
          else if (member.type === 'property_declaration' || member.type === 'field_declaration') {
            const declaration = member.type === 'field_declaration' ? child(member, 'variable_declaration') : member;
            const entries =
              member.type === 'field_declaration'
                ? (declaration?.namedChildren.filter((c) => c.type === 'variable_declarator') ?? [])
                : [member];
            for (const entry of entries) {
              const value =
                field(entry, 'value') ??
                (entry.type === 'variable_declarator' && entry.namedChildren.length > 1
                  ? entry.namedChildren.at(-1)
                  : undefined);
              type.properties.push({
                name: field(entry, 'name')?.text ?? '',
                type: declaration ? field(declaration, 'type')?.text : undefined,
                value: value ? expression(value) : undefined,
                modifiers: modifiers(member),
                attributes: attributes(member),
                loc: location(member, file),
              });
            }
          } else if (member.type === 'enum_member_declaration')
            type.enumMembers.push({
              name: field(member, 'name')?.text ?? member.namedChildren[0]?.text ?? '',
              value: field(member, 'value')?.text,
            });
        }
        const primaryParameters = child(node, 'parameter_list');
        if (primaryParameters) {
          const ctor = readMethod(node, type, '.ctor');
          // Primary constructor body is the type declaration list, not an executable body.
          facts.invocations = facts.invocations.filter((c) => c.caller !== ctor);
          ctor.end = primaryParameters.endIndex;
          ctor.loc.endLine = primaryParameters.endPosition.row + 1;
          ctor.loc.endColumn = primaryParameters.endPosition.column;
          ctor.source = (originalSource ?? root.text).slice(node.startIndex, primaryParameters.endIndex);
          if (node.type === 'record_declaration')
            for (const p of type.primaryParameters)
              type.properties.push({
                name: p.name,
                type: p.type?.text,
                modifiers: ['public'],
                attributes: [],
                loc: type.loc,
              });
        }
        if (body) visit(body, namespace, usings, name);
      }
    }
  }
  visit(root, '', []);
  const statements = root.namedChildren.filter((n) => n.type === 'global_statement');
  if (statements.length) {
    const first = statements[0]!;
    const last = statements.at(-1)!;
    const type: TypeDeclaration = {
      id: '',
      name: 'Program',
      simpleName: 'Program',
      namespace: '',
      kind: 'class_declaration',
      project,
      file,
      usings: root.namedChildren.filter((n) => n.type === 'using_directive').map(using),
      modifiers: ['internal', 'partial'],
      attributes: [],
      bases: [],
      methods: [],
      properties: [],
      primaryParameters: [],
      enumMembers: [],
      loc: { ...location(first, file), endLine: last.endPosition.row + 1, endColumn: last.endPosition.column },
      source: (originalSource ?? root.text).slice(first.startIndex, last.endIndex),
    };
    facts.types.push(type);
    const main = readMethod(
      root,
      type,
      '$Main',
      undefined,
      statements.filter((n) => !n.hasError),
    );
    main.loc = type.loc;
    main.source = type.source;
    main.modifiers = ['private', 'static'];
  }
  return facts;
}
