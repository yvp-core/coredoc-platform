import type { ParameterInfo, SourceLocation } from '@coredoc/core/types';

export interface Using {
  name: string;
  alias?: string;
  static: boolean;
}
export interface Attribute {
  name: string;
  args: Expression[];
  text: string;
}
/** Compact expression facts; no live syntax tree crosses the file extraction boundary. */
export interface Expression {
  nameRange?: number[];
  start?: number;
  end?: number;
  kind: string;
  text: string;
  name?: string;
  type?: string;
  object?: Expression;
  args?: Expression[];
  typeArgs?: string[];
}
export interface Binding {
  parameterIndex?: number;
  name: string;
  type?: string;
  value?: Expression;
  start: number;
  end: number;
  declaredAt: number;
}
export interface Method {
  nameRange?: number[];
  outer?: Method;
  id: string;
  name: string;
  signature: string;
  parameters: ParameterInfo[];
  returnType?: string;
  modifiers: string[];
  attributes: Attribute[];
  loc: SourceLocation;
  source: string;
  type: TypeDeclaration;
  bindings: Binding[];
  writes: string[];
  start: number;
  end: number;
  genericArity: number;
}
export interface Property {
  name: string;
  type?: string;
  value?: Expression;
  modifiers: string[];
  attributes: Attribute[];
  loc: SourceLocation;
}
export interface TypeDeclaration {
  nameRange?: number[];
  id: string;
  name: string;
  simpleName: string;
  namespace: string;
  kind: string;
  project: string;
  file: string;
  usings: Using[];
  modifiers: string[];
  attributes: Attribute[];
  bases: string[];
  methods: Method[];
  properties: Property[];
  primaryParameters: ParameterInfo[];
  loc: SourceLocation;
  source: string;
  enumMembers: { name: string; value?: string | number }[];
}
export interface Invocation {
  expression: Expression;
  caller: Method;
  loc: SourceLocation;
  offset: number;
  assignedTo?: string;
}
export interface Project {
  sdk?: string;
  path: string;
  directory: string;
  name: string;
  references: string[];
  dependencies: Record<string, string>;
  globalUsings: Using[];
}

export interface NominalAttributeFact {
  /** Absent when identity is ambiguous or the library is not an established dependency. */
  type?: string;
  args: { text: string; value?: string; name?: string }[];
}
export interface NominalMethodFact {
  id: string;
  name: string;
  signature: string;
  public: boolean;
  static: boolean;
  abstract: boolean;
  isConstructor?: boolean;
  /** Exact method IDs implemented according to the compiler index. */
  implements?: string[];
  attributes: NominalAttributeFact[];
  location: SourceLocation;
}
export interface NominalTypeFact {
  id: string;
  name: string;
  simpleName: string;
  abstract: boolean;
  baseTypes: string[];
  attributes: NominalAttributeFact[];
  methods: NominalMethodFact[];
  properties: NominalPropertyFact[];
  location: SourceLocation;
}

export interface NominalPropertyFact {
  name: string;
  /** Display text is never used as proof of a resolved identity. */
  typeText?: string;
  type?: string;
  typeArguments: (string | undefined)[];
  public: boolean;
  static?: boolean;
  nullable: boolean;
  attributes: NominalAttributeFact[];
  location: SourceLocation;
}
/** Resolved expression relationships, independent of a language's CST node names. */
export interface NominalValueFact {
  text: string;
  /** Exact lexical parameter binding, used to relate a callback body to its registration. */
  parameter?: { functionId: string; index: number };
  /** Initializer of a scoped local with no observed reassignment or ref/out escape. */
  initializer?: NominalValueFact;
  value?: string;
  type?: string;
  typeArguments?: (string | undefined)[];
  member?: string;
  receiver?: NominalValueFact;
  args?: NominalValueFact[];
  /** A direct parameter-member lambda such as p => p.Name. */
  lambdaMember?: string;
  functionId?: string;
}
export interface NominalCallFact extends NominalValueFact {
  id: string;
  callerId: string;
  calleeId?: string;
  location: SourceLocation;
}
