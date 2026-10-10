/**
 * Coredoc Parser Output Types
 *
 * Comprehensive type definitions for parsed codebase output.
 * All nodes use stable IDs for graph relationships and versioned IDs for caching.
 */

// =============================================================================
// Core Types
// =============================================================================

export type RepoType = 'backend' | 'frontend' | 'mobile' | 'library' | 'monorepo';

export type Visibility = 'public' | 'private' | 'protected' | 'internal';

export type EntrypointType =
  | 'http'
  | 'graphql'
  | 'grpc'
  | 'websocket'
  | 'cron'
  | 'queue' // Kafka, RabbitMQ, SQS, etc.
  | 'event' // Generic event handlers
  | 'cli'
  | 'mobile'; // Externally triggered mobile-app component (launcher, deep link, push, broadcast, background work, service, content provider)

/**
 * `ALL` is the method WILDCARD: one handler serves every verb and the served set
 * is not statically declared — Next.js pages-router API files (a single default
 * export switching on `req.method`) are the canonical case. It is a real value a
 * consumer must handle, not "unknown": emitting per-verb entrypoints there would
 * fabricate endpoints the source never declares. Already the accepted spelling in
 * the profile-parser integrity validator's synthetic-handler method set.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ALL';

/**
 * The verbs a wildcard (`ALL`) handler actually serves. Canonical HERE so the
 * vocabulary is defined once: consumers that must expand or validate a wildcard
 * (the cross-repo descriptor matcher, the mapper schema, the MCP method comparison)
 * derive from this rather than re-listing the verbs and drifting apart.
 */
export const CONCRETE_HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

/** The method wildcard. See {@link HttpMethod}. */
export const WILDCARD_HTTP_METHOD = 'ALL' satisfies HttpMethod;

/** Every valid `HttpMethod` spelling, wildcard included. */
export const ALL_HTTP_METHODS: readonly HttpMethod[] = [...CONCRETE_HTTP_METHODS, WILDCARD_HTTP_METHOD];

/**
 * `ddl` is SCHEMA change, not row traffic: `CREATE TABLE` / `DROP TABLE` / `ALTER TABLE` /
 * `TRUNCATE` and the same verbs over views. It is additive to the CRUD set on purpose —
 * a migration or a schema-management surface (pg-meta-style builders, ClickHouse
 * `TRUNCATE TABLE`) folded into `create`/`delete` would answer "who creates rows in X?"
 * with statements that create the TABLE, which is a different blast radius.
 */
export type DbOperationType = 'create' | 'read' | 'update' | 'delete' | 'query' | 'transaction' | 'ddl';

// =============================================================================
// Location & Source Info
// =============================================================================

export interface SourceLocation {
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

// =============================================================================
// Git Version Info
// =============================================================================

export interface GitInfo {
  commitHash: string;
  commitShortHash: string;
  branch: string;
  isDirty: boolean;
  commitDate?: string;
  /** The `origin` remote URL (the "git link"), if a remote is configured. */
  remoteUrl?: string;
}

// =============================================================================
// Base Node Types
// =============================================================================

/**
 * Base interface for all parsed nodes
 */
export interface BaseNode {
  /** Stable ID (doesn't change when content changes) */
  id: string;
  /** Versioned ID (includes content checksum) */
  versionedId: string;
  /** Human-readable name */
  name: string;
  /** Source code location */
  location: SourceLocation;
  /** JSDoc/docstring if present */
  documentation?: string;
  /** Raw source code (optional, for detailed analysis) */
  sourceCode?: string;
}

// =============================================================================
// Package & File Nodes
// =============================================================================

export interface Package {
  id: string;
  name: string;
  /** Path relative to repo root */
  path: string;
  /** package.json, pyproject.toml, go.mod, etc. */
  manifestFile?: string;
  /** Package version if available */
  version?: string;
  /** Primary language (e.g., typescript, python, go) */
  language?: string;
  /** Package type (e.g., frontend, backend, mobile, library) */
  type?: RepoType;
  /** Package description from manifest or AI-generated summary */
  description?: string;
  /** Dependencies declared in manifest */
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  /** Entry points defined in package */
  mainEntry?: string;
  /** Export map if available */
  exports?: Record<string, string>;
}

export interface FileNode {
  id: string;
  versionedId: string;
  /** Path relative to repo root */
  path: string;
  /** File extension */
  extension: string;
  /** Package this file belongs to */
  packageId: string;
  /** Language detected */
  language: string;
  /** Multi-target parses only: name of the profile target that claimed this file. */
  target?: string;
  /** SHA256 hash of file content */
  contentHash: string;
  /** Last modified timestamp */
  lastModified?: string;
  /** Lines of code (excluding comments/blanks) */
  loc?: number;
}

// =============================================================================
// Code Element Nodes
// =============================================================================

export interface FunctionNode extends BaseNode {
  kind: 'function' | 'method';
  /**
   * Present on a node a substrate synthesized from a declaration convention rather than a
   * `def`/declaration; no parameters, no body, never an entrypoint. Consumers may hide or label
   * it; the literal names the convention.
   */
  synthesized?: 'ruby-association';
  /** File containing this function/method */
  fileId: string;

  // === Shared fields (always present) ===
  /** Async function/method */
  isAsync: boolean;
  /** Generator function/method */
  isGenerator: boolean;
  /** Function/method parameters */
  parameters: ParameterInfo[];
  /** Return type (if typed language) */
  returnType?: TypeInfo;
  /** Generic type parameters */
  typeParameters?: TypeParameterInfo[];
  /** Decorators/annotations */
  decorators?: DecoratorInfo[];
  /** Cyclomatic complexity (if computed) */
  complexity?: number;

  /**
   * SCIP package-moniker identity of an exported symbol in an SDK-source repo, so
   * the cross-repo symbol hop can join a consumer's ExternalCallEdge.moniker onto
   * this method's definition by (packageName, normalizedDescriptor). `descriptor`
   * is the raw SCIP descriptor tail (version excluded). Absent for non-exported or
   * non-SDK-source symbols.
   */
  moniker?: { packageName: string; descriptor: string };

  // === Function-specific fields (present when kind === 'function') ===
  /** If exported from module (functions only) */
  isExported?: boolean;

  // === Method-specific fields (present when kind === 'method') ===
  /** Parent class ID (methods only) */
  classId?: string;
  /** Visibility (methods only) */
  visibility?: Visibility;
  /** Static method (methods only) */
  isStatic?: boolean;
  /** Abstract method (methods only) */
  isAbstract?: boolean;
  /** Getter/setter (methods only) */
  accessor?: 'get' | 'set';
  /** Overrides method from parent (methods only) */
  overrides?: string;
}

export interface ClassNode extends BaseNode {
  kind: 'class';
  fileId: string;
  isExported: boolean;
  /** Abstract class */
  isAbstract: boolean;
  /** Extended class */
  extends?: TypeReference;
  /** Implemented interfaces */
  implements?: TypeReference[];
  /** Generic type parameters */
  typeParameters?: TypeParameterInfo[];
  /** Decorators/annotations */
  decorators?: DecoratorInfo[];
  /** Class method IDs (references to FunctionNode entries in ParsedRepo.functions) */
  methods: string[];
  /** Class properties */
  properties: PropertyNode[];
  /** Constructor info */
  constructor?: ConstructorNode;
}

export interface PropertyNode {
  id: string;
  name: string;
  classId: string;
  visibility: Visibility;
  isStatic: boolean;
  isReadonly: boolean;
  isOptional: boolean;
  type?: TypeInfo;
  /** Default value expression */
  defaultValue?: string;
  decorators?: DecoratorInfo[];
  location: SourceLocation;
  documentation?: string;
}

export interface ConstructorNode {
  id: string;
  classId: string;
  parameters: ParameterInfo[];
  visibility: Visibility;
  location: SourceLocation;
  documentation?: string;
}

export interface InterfaceNode extends BaseNode {
  kind: 'interface';
  fileId: string;
  isExported: boolean;
  /** Extended interfaces */
  extends?: TypeReference[];
  typeParameters?: TypeParameterInfo[];
  /** Interface members */
  members: InterfaceMember[];
}

export interface InterfaceMember {
  name: string;
  kind: 'property' | 'method' | 'index';
  type?: TypeInfo;
  isOptional: boolean;
  isReadonly: boolean;
  /** For methods */
  parameters?: ParameterInfo[];
  returnType?: TypeInfo;
  location: SourceLocation;
  documentation?: string;
}

export interface TypeAliasNode extends BaseNode {
  kind: 'type-alias';
  fileId: string;
  isExported: boolean;
  typeParameters?: TypeParameterInfo[];
  /** The aliased type */
  aliasedType: TypeInfo;
}

export interface EnumNode extends BaseNode {
  kind: 'enum';
  fileId: string;
  isExported: boolean;
  /** Const enum (TS) */
  isConst: boolean;
  members: EnumMember[];
}

export interface EnumMember {
  name: string;
  value?: string | number;
  documentation?: string;
}

/**
 * A VALUE-position reference to one enum member from inside a function/method
 * body (`if (state === Status.Locked)`), as opposed to a TYPE-position use of
 * the enum (`(s: Status) => …`), which travels as a type annotation.
 *
 * The member is carried as edge data, not as a node: downstream this becomes a
 * `USES_TYPE` edge to the ENUM with `useKind: 'value'` and the member name, so
 * one query answers both "who consumes this enum" and "who branches on this
 * member" without growing the node vocabulary.
 *
 * `enumName` is the name the enum is EXPORTED under (an `import { X as Y }`
 * alias is unwrapped), and `importedFrom` carries the module it was imported
 * from, so downstream resolution can check symbol identity instead of trusting
 * a bare name. Emitted by the TS/JS substrate only — a substrate that does not
 * detect these simply emits none.
 */
export interface EnumMemberReferenceEdge {
  id: string;
  /** Referencing function/method ID */
  sourceId: string;
  /** Enum name as exported by its declaring module (import aliases unwrapped) */
  enumName: string;
  /**
   * Raw module specifier the name was imported from at the reference site.
   * Absent when the enum is declared in the same file as the reference.
   */
  importedFrom?: string;
  /**
   * Repo-relative file that DECLARES the enum, resolved at parse time through the
   * module graph (specifier resolution plus `export … from` re-export hops), so a
   * barrel or path alias names the declaration rather than the module it was written
   * as. For a same-file reference (no import) this is the referencing file itself —
   * identity is already proved. Absent only when resolution of an imported specifier
   * refused to answer — downstream then falls back to matching the raw specifier and
   * marks the weaker match ambiguous. A reference whose module is provably OUTSIDE the
   * repo is not emitted at all: that enum is not this repo's.
   */
  declaringFile?: string;
  /** Member name accessed in value position */
  member: string;
  /** First location of the reference (deduped by source + enum + member) */
  location: SourceLocation;
}

/**
 * A USE of a class that is not a type annotation: the code CONSTRUCTS it
 * (`new UserService(deps)`) or IMPORTS it. Both answer "who breaks if I change
 * this class", which a type-position-only graph leaves at zero even when the
 * neighbouring file instantiates it on every request.
 *
 * The two site kinds ride one edge, discriminated by `refKind`, because they are
 * the same relation at two strengths: downstream both become a `USES_TYPE` edge
 * to the CLASS, so one query answers "who uses this class" while the `usage`
 * property still says how.
 *
 * `className` is the name the class is EXPORTED under (an `import { X as Y }`
 * alias is unwrapped) and `importedFrom` carries the module specifier written at
 * the site, so downstream resolution checks symbol identity instead of trusting a
 * bare name. Emitted by the TS/JS substrate only — a substrate that does not
 * detect these simply emits none.
 */
export interface ClassReferenceEdge {
  id: string;
  /**
   * Referencing node: the enclosing function/method for a `construction` site,
   * the importing FILE for an `import` site (an import belongs to the module, not
   * to any function in it). A construction at MODULE scope
   * (`export const client = new Client()`) has no enclosing function, so it is
   * sourced at the constructing FILE — the module is what constructs it.
   */
  sourceId: string;
  /** Which use this is: `new X(...)` versus an import of `X`. */
  refKind: 'construction' | 'import';
  /** Class name as exported by its declaring module (import aliases unwrapped). */
  className: string;
  /**
   * Local name the referencing module binds the class under, set ONLY when it differs from
   * `className` (`import { UserService as Svc }`). It is the name a reader greps for in that file,
   * so the storage layer carries it onto the edge for rendering; identity still travels on
   * `className` + `declaringFile`.
   */
  localName?: string;
  /**
   * Raw module specifier the name was imported from at the site. Absent when the
   * class is declared in the same file as the reference.
   */
  importedFrom?: string;
  /**
   * Repo-relative file that DECLARES the class, resolved at parse time through the
   * module graph (specifier resolution plus `export … from` re-export hops), so a
   * barrel or path alias names the declaration rather than the module it was written
   * as. Absent only when resolution refused to answer — downstream then falls back to
   * matching the raw specifier and marks the weaker match ambiguous. A reference whose
   * module is provably OUTSIDE the repo is not emitted at all: that class is not this
   * repo's.
   */
  declaringFile?: string;
  /** First location of the reference (deduped by source + class + refKind + module). */
  location: SourceLocation;
}

export interface VariableNode extends BaseNode {
  kind: 'variable';
  fileId: string;
  isExported: boolean;
  /** const, let, var */
  declarationKind: 'const' | 'let' | 'var';
  type?: TypeInfo;
  /** Initial value expression (if simple) */
  initialValue?: string;
}

// =============================================================================
// Type Information
// =============================================================================

export interface TypeInfo {
  /** String representation of the type */
  text: string;
  /** Parsed type structure (for complex types) */
  structure?: TypeStructure;
}

export type TypeStructure =
  | { kind: 'primitive'; name: string }
  | { kind: 'reference'; name: string; typeArguments?: TypeInfo[] }
  | { kind: 'array'; elementType: TypeInfo }
  | { kind: 'tuple'; elements: TypeInfo[] }
  | { kind: 'union'; types: TypeInfo[] }
  | { kind: 'intersection'; types: TypeInfo[] }
  | { kind: 'function'; parameters: ParameterInfo[]; returnType: TypeInfo }
  | { kind: 'object'; properties: { name: string; type: TypeInfo; optional: boolean }[] }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'unknown' };

export interface TypeReference {
  name: string;
  /** ID of the referenced type (if resolved) */
  resolvedId?: string;
  /**
   * The referenced declaration is PROVEN to live outside this repo (the parser resolved the
   * specifier to a declared dependency or an installed package). Set only on that proof — an
   * unresolved reference stays unmarked, because "identity unknown" is a different claim.
   *
   * Consumers must not name-match such a reference against an in-repo declaration: a same-named
   * local class is a different symbol, so any edge to it would be fabricated.
   */
  external?: true;
  typeArguments?: TypeInfo[];
}

export interface TypeParameterInfo {
  name: string;
  constraint?: TypeInfo;
  default?: TypeInfo;
}

export interface ParameterInfo {
  name: string;
  type?: TypeInfo;
  isOptional: boolean;
  isRest: boolean;
  defaultValue?: string;
  decorators?: DecoratorInfo[];
}

export interface DecoratorInfo {
  name: string;
  /** Decorator arguments as strings */
  arguments?: string[];
  /** Full decorator expression */
  expression: string;
}

// =============================================================================
// Entrypoints
// =============================================================================

export interface Entrypoint {
  id: string;
  versionedId: string;
  type: EntrypointType;
  /** Handler function/method ID */
  handlerId: string;
  location: SourceLocation;
  documentation?: string;
  /** Type-specific details */
  details: EntrypointDetails;
  /** Request schema if available */
  requestSchema?: SchemaInfo;
  /** Response schema if available */
  responseSchema?: SchemaInfo;
}

export type EntrypointDetails =
  | HttpEntrypointDetails
  | GraphQLEntrypointDetails
  | GrpcEntrypointDetails
  | WebSocketEntrypointDetails
  | CronEntrypointDetails
  | QueueEntrypointDetails
  | EventEntrypointDetails
  | CliEntrypointDetails
  | MobileEntrypointDetails;

export interface HttpEntrypointDetails {
  type: 'http';
  method: HttpMethod;
  path: string;
  /** Full path including base path */
  fullPath: string;
  /** Path parameters */
  pathParams?: string[];
  /** Query parameters */
  queryParams?: ParameterInfo[];
  /** Middleware/guards applied */
  middleware?: string[];
  /** Authentication required */
  auth?: {
    required: boolean;
    type?: string;
    roles?: string[];
  };
  /** Swagger/OpenAPI documentation */
  swagger?: SwaggerOperationInfo;
}

// =============================================================================
// Swagger/OpenAPI Types
// =============================================================================

/**
 * Swagger/OpenAPI operation metadata extracted from decorators
 */
export interface SwaggerOperationInfo {
  /** Unique operation identifier */
  operationId?: string;
  /** Short summary of the operation */
  summary?: string;
  /** Detailed description */
  description?: string;
  /** Tags for API grouping */
  tags?: string[];
  /** Whether the operation is deprecated */
  deprecated?: boolean;
  /** Path, query, header parameters */
  parameters?: SwaggerParameterInfo[];
  /** Request body definition */
  requestBody?: SwaggerRequestBody;
  /** Response definitions */
  responses?: SwaggerResponseInfo[];
  /** Security requirements */
  security?: SwaggerSecurityRequirement[];
  /** External documentation link */
  externalDocs?: {
    url: string;
    description?: string;
  };
}

/**
 * Parameter info from @ApiParam, @ApiQuery, @ApiHeader decorators
 */
export interface SwaggerParameterInfo {
  /** Parameter name */
  name: string;
  /** Parameter location */
  in: 'path' | 'query' | 'header' | 'cookie';
  /** Parameter description */
  description?: string;
  /** Whether parameter is required */
  required: boolean;
  /** Parameter type info */
  type?: TypeInfo;
  /** Example value */
  example?: unknown;
  /** Whether parameter is deprecated */
  deprecated?: boolean;
  /** Allowed values (enum) */
  enum?: (string | number)[];
  /** Default value */
  default?: unknown;
  /** JSON Schema for complex types */
  schema?: object;
}

/**
 * Request body from @ApiBody decorator
 */
export interface SwaggerRequestBody {
  /** Body description */
  description?: string;
  /** Whether body is required */
  required: boolean;
  /** DTO class name */
  type?: string;
  /** Reference to type ID in parsed output */
  typeId?: string;
  /** Content type definitions */
  content?: SwaggerMediaType[];
}

/**
 * Media type content definition
 */
export interface SwaggerMediaType {
  /** MIME type (e.g., 'application/json') */
  mediaType: string;
  /** Schema definition */
  schema?: SchemaInfo;
  /** Example value */
  example?: unknown;
  /** Multiple examples */
  examples?: Record<string, { value: unknown; summary?: string }>;
}

/**
 * Response info from @ApiResponse decorators
 */
export interface SwaggerResponseInfo {
  /** HTTP status code or 'default' */
  statusCode: number | 'default';
  /** Response description */
  description?: string;
  /** Response DTO type name */
  type?: string;
  /** Reference to type ID in parsed output */
  typeId?: string;
  /** Response schema */
  schema?: SchemaInfo;
  /** Example value */
  example?: unknown;
  /** Response headers */
  headers?: Record<string, SwaggerParameterInfo>;
  /** Content type definitions */
  content?: SwaggerMediaType[];
}

/**
 * Security requirement from @ApiSecurity, @ApiBearerAuth, etc.
 */
export interface SwaggerSecurityRequirement {
  /** Security scheme name */
  name: string;
  /** Security scheme type */
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  /** Scopes required (for oauth2) */
  scopes?: string[];
  /** Where the API key is sent (for apiKey) */
  in?: 'query' | 'header' | 'cookie';
  /** Scheme (for http, e.g., 'bearer') */
  scheme?: string;
}

export interface GraphQLEntrypointDetails {
  type: 'graphql';
  operationType: 'query' | 'mutation' | 'subscription';
  fieldName: string;
  parentType: string;
  arguments?: ParameterInfo[];
}

export interface GrpcEntrypointDetails {
  type: 'grpc';
  serviceName: string;
  methodName: string;
  /** Streaming type */
  streaming: 'unary' | 'server' | 'client' | 'bidirectional';
  /** Proto file reference */
  protoFile?: string;
}

export interface WebSocketEntrypointDetails {
  type: 'websocket';
  event: string;
  /** Namespace (Socket.io) */
  namespace?: string;
  /** Room if applicable */
  room?: string;
}

export interface CronEntrypointDetails {
  type: 'cron';
  /** Cron expression */
  schedule: string;
  /** Human-readable schedule description */
  scheduleDescription?: string;
  /** Timezone */
  timezone?: string;
}

export interface QueueEntrypointDetails {
  type: 'queue';
  /** Queue system (kafka, rabbitmq, sqs, etc.) */
  system: string;
  /** Topic/queue token as written at the registration site. */
  topic: string;
  /** Runtime topic string when the token is statically resolvable. */
  topicValue?: string;
  /** Consumer group */
  consumerGroup?: string;
  /** Subscription pattern */
  pattern?: string;
}

export interface EventEntrypointDetails {
  type: 'event';
  eventName: string;
  /** Runtime event string when `eventName` is a source-level token. */
  eventValue?: string;
  /** Event emitter/bus name */
  emitter?: string;
}

export interface CliEntrypointDetails {
  type: 'cli';
  command: string;
  subcommands?: string[];
  arguments?: ParameterInfo[];
  options?: ParameterInfo[];
}

/**
 * A mobile-app component the PLATFORM triggers from outside the app — the mobile analogue of
 * an HTTP route or a queue consumer. A screen reached by in-app navigation is a component, not
 * an entrypoint: the test is whether control enters from outside the process.
 *
 * Platform-neutral on purpose. Android is the first emitter, but an iOS shell (scene delegate,
 * notification service, URL type) and a React-Native shell (headless task, linking handler)
 * carry the same triggers, so they land on this type rather than forcing a second one.
 *
 * `className` is the entrypoint's ADDRESS — the token an agent actually types — so it is
 * carried through the address-token lists, `EntrypointInfo`, and the SQL/Cypher address
 * prefilters. Dropping it at any hop makes these entrypoints unfindable by name.
 */
export interface MobileEntrypointDetails {
  type: 'mobile';
  platform: 'android' | 'ios' | 'react-native';
  trigger: 'launcher' | 'deep-link' | 'push' | 'broadcast' | 'background-work' | 'service' | 'content-provider';
  /** Component class simple name; also the stored address property. */
  className: string;
  /** Intent/notification actions this component is registered for. */
  actions?: string[];
  /** Deep-link or authority patterns (`scheme://host/path`, a provider authority). */
  uriPatterns?: string[];
  /** Whether the platform exposes it to other apps, when the manifest declares it. */
  exported?: boolean;
}

export interface SchemaInfo {
  /** Schema type/name */
  name?: string;
  /** Reference to type ID */
  typeId?: string;
  /** JSON Schema representation */
  jsonSchema?: object;
  /** Example value */
  example?: unknown;
}

// =============================================================================
// Data Layer
// =============================================================================

export interface EntityNode extends BaseNode {
  kind: 'entity';
  fileId: string;
  /** ORM type (typeorm, prisma, sequelize, etc.) */
  ormType: string;
  /** Database table name */
  tableName: string;
  /** Schema name */
  schema?: string;
  /** Entity fields/columns */
  fields: EntityField[];
  /** Relations to other entities */
  relations: EntityRelation[];
  /** Indexes defined */
  indexes?: EntityIndex[];
}

export interface EntityField {
  name: string;
  /** Column name in DB */
  columnName: string;
  type: TypeInfo;
  /** Database type */
  dbType?: string;
  isPrimaryKey: boolean;
  isNullable: boolean;
  isUnique: boolean;
  isGenerated: boolean;
  defaultValue?: string;
  documentation?: string;
}

export interface EntityRelation {
  name: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
  /** Target entity ID */
  targetEntityId?: string;
  /** Target entity name (if ID not resolved) */
  targetEntityName: string;
  /** Join column */
  joinColumn?: string;
  /** Inverse side property */
  inverseSide?: string;
  /** Cascade operations */
  cascade?: string[];
}

export interface EntityIndex {
  name?: string;
  columns: string[];
  isUnique: boolean;
  type?: string;
}

export interface DbOperation {
  id: string;
  versionedId: string;
  /** Function/method performing the operation */
  performerId: string;
  /** Entity being operated on */
  entityId?: string;
  entityName: string;
  operation: DbOperationType;
  /** Query/operation details */
  details?: string;
  location: SourceLocation;
}

// =============================================================================
// Relationships (Edges)
// =============================================================================

/**
 * How a resolved call edge's `calleeId` was determined — the resolution lineage. Lets consumers
 * (MCP, docs-gen, the authoring scorer) distinguish a compiler-grade SCIP edge from a heuristic
 * DI inference. Absent on an unresolved edge (no `calleeId`). Closed set — only the resolution
 * paths that actually exist; extend deliberately, never speculatively.
 */
export type CallProvenance =
  /** Callee resolved by scip-typescript's definition lookup (compiler-grade, name-verified). */
  | 'scip'
  /** Callee resolved via the constructor-DI map (`this.svc.m()` → svc's declared type → method by name). */
  | 'di'
  /** Ruby heuristic: constant receiver (`Foo.bar`) → class via constant index → method on class/ancestry. */
  | 'rb-const'
  /** Ruby heuristic: callee method name is globally unique in-repo; the sole possible target. */
  | 'rb-unique'
  /** Ruby heuristic: self/bare call resolved to a method on the enclosing class itself (direct, no ancestry). */
  | 'rb-self'
  /** Ruby heuristic: self/bare call resolved via the enclosing class's SYNTACTIC ancestry (superclass /
   *  include / extend / prepend, no MRO) — lower confidence than a direct same-class hit. */
  | 'rb-self-ancestry'
  /** Python heuristic: callee resolved through the file's import table (`from m import f; f()` or
   *  `import m as x; x.f()`) to a def in the imported module's in-repo file — precision-first. */
  | 'py-import'
  /** Python heuristic: same-class `self.m()` / `cls.m()` resolved to a method on the enclosing class. */
  | 'py-self'
  /** Python heuristic: bare `f()` resolved to a module-level def in the SAME file (no import needed). */
  | 'py-local'
  /** Rust heuristic: a QUALIFIED path call (`crate::a::f()`, `self::f()`, `super::f()`) resolved
   *  against the repo module index directly — no `use` binding needed, the path is absolute. */
  | 'rs-path'
  /** Rust heuristic: `f()` / `m::f()` resolved through the file's `use` table + module index to a
   *  fn in another in-repo file. Glob (`use m::*`) imports are never bound, so never this tier. */
  | 'rs-use'
  /** Rust heuristic: `self.m()` / `Self::m()` resolved to a method on the enclosing `impl`'s type,
   *  keyed file-qualified so same-named types in different files cannot collide. */
  | 'rs-self'
  /** Rust heuristic: bare `f()` resolved to a fn in the SAME module/file (no import needed). */
  | 'rs-local'
  /** Go heuristic: bare `f()` resolved to a package-scope func in the caller's OWN PACKAGE. Go's
   *  compilation unit is the DIRECTORY, so this legitimately crosses files within one package. */
  | 'go-local'
  /** Go heuristic: `pkg.F()` resolved through the file's import table to a package-scope func in
   *  one of this repo's own packages. A dot-imported package binds no qualifier, so never this tier. */
  | 'go-import'
  /** Go heuristic: `r.M()` where `r` is the enclosing method's own RECEIVER variable, resolved to a
   *  method on that receiver type in the same package. Read straight off the signature — no
   *  inference, so it is the strictly stronger sibling of `go-type`. */
  | 'go-recv'
  /** Go heuristic: `v.M()` on a value whose named TYPE was inferred from its declaration — a
   *  parameter, a `:=` composite literal or constructor result, a `var` with an explicit type, or a
   *  struct field — resolved to a method on that type in the package that DECLARES the type, which
   *  is routinely not the caller's. Distinct from `go-recv` because the type is inferred rather
   *  than read off the enclosing signature, and distinct from `go-import` because the selector
   *  names a value, not a package. In GO, an interface-typed value resolves to the interface,
   *  which declares no method bodies, so dispatch is dropped rather than bound to an
   *  implementation — the Go substrate models no implements relation to bind through
   *  (substrates that do bind through one use `iface-impl`). */
  | 'go-type'
  /** Zig heuristic: bare `f()` resolved to an emitted top-level function or file-struct method in
   *  the SAME file, or — when the call site sits inside an emitted container — to a method of
   *  that container. */
  | 'zig-local'
  /** Zig heuristic: `self.m()` / `Self.m()` / `@This().m()` resolved to a method of the enclosing
   *  container, the receiver typed per the Zig `self: *Self` idiom. */
  | 'zig-self'
  /** Zig heuristic: `T.m()` / `T.Inner.m()` where `T` is a container declared in the current file
   *  (a declared name, the file-struct name, or a `const T = <container>` chain) resolved to a
   *  method of that (possibly nested) container. */
  | 'zig-type'
  /** Zig heuristic: `a.f()` / `a.T.m()` / `A.m()` where the head is a per-file `@import` binding
   *  (a namespace or a specific member), following a target file's own `pub const X = @import(…)`
   *  re-exports up to 3 hops. */
  | 'zig-import'
  /** Zig heuristic: `self.<field>.m()` where `<field>` is a property of the enclosing container
   *  whose declared type text resolves — via the type/import rules above — to an emitted
   *  container, to a method `m` of that container. */
  | 'zig-field'
  /** `recv.m()` where `recv`'s DECLARED type names exactly one in-repo interface (read through
   *  generic arguments, so a mapped proxy type like `Proxy<IFoo>` counts), and exactly one
   *  in-scope class declares that interface as a supertype. The callee is that class's own `m` —
   *  derived from the implementing class's location, never from a repo-wide bare-name method
   *  index. Language-neutral: TS/JS reads `implements` on a parameter's annotated type, Kotlin
   *  reads the supertype list for a typed receiver (local, parameter, property, or a Koin
   *  accessor with an explicit type argument).
   *
   *  WEAKER THAN `scip`, weight it accordingly: this is a SOLE-IN-SCOPE-IMPLEMENTATION inference,
   *  not a compiler proof. The compiler binds the call to the interface member; which object the
   *  parameter actually holds at run time is a fact about the caller, not about this signature.
   *  It is right whenever the interface has one implementation in the analyzed scope and wrong if
   *  an unanalyzed (out-of-scope, dynamically registered, test-double) implementation is the one
   *  passed. Every ambiguity abstains — two implementations, an intersection naming two
   *  interfaces, a `typeof` query, a receiver that is not a parameter, a method the class does not
   *  implement — leaving the unresolved call plus the IMPLEMENTS_INTERFACE edge as the honest
   *  two-hop path. Consumers must render it as inferred (the storage layer stores it at reduced
   *  confidence). */
  | 'iface-impl'
  /** TS/JS: callee resolved through a destructured ACCESSOR-HOOK binding
   *  (`const { m } = useAccessor(ref); m()`). The compiler binds `m` to a generated property
   *  of the hook's return type, which SCIP cannot turn into a function — usually it resolves
   *  to a property definition sitting in no function span (the call is then reclassified as
   *  external), sometimes only to a document-`local`. The engine instead reads the hook's
   *  single identifier argument, resolves ITS defining file through SCIP, and takes the
   *  function of the destructured property's name in that file.
   *
   *  WEAKER THAN `scip`, weight it accordingly: only the argument's defining file is
   *  compiler-grade. The last step is NAME-COLLISION-TRUSTING — it binds to the uniquely
   *  same-named function in that file with no proof that the property is that function
   *  (no export check, no reachability). Every ambiguity abstains, so the failure mode is
   *  a missing edge, but a same-named unrelated function in the target file would be a
   *  wrong one. */
  | 'accessor-hook'
  /** Kotlin heuristic: bare `f()` resolved to a top-level function `f` declared in the SAME
   *  file, or — failing that — the uniquely named top-level `f` of the same Kotlin package. */
  | 'kt-local'
  /** Kotlin heuristic: bare `m()` or `this.m()` inside a class, resolved to a method of that
   *  class, then of its resolved supertypes, then of its companion object. */
  | 'kt-member'
  /** Kotlin heuristic: bare `f()` whose name an `import a.b.f` binds to a top-level function of
   *  the imported package, or `X.m()` where `X` resolves to a class and `m` is one of its
   *  static members (companion or `object` declaration). */
  | 'kt-import'
  /** Kotlin heuristic: `r.m()` where `r` is a local, parameter or property whose DECLARED type
   *  resolves to an emitted class, including a property delegated or initialised through a
   *  dependency-injection accessor carrying an explicit type (`by inject()`, `by viewModel()`,
   *  `get<T>()`). The callee is `m` on that type or its resolved supertypes.
   *
   *  WEAKER THAN `scip`: the declared type is the compile-time type, so an overridden `m` on
   *  the runtime instance is a fact about the caller. A factory-style receiver (`T.create()`)
   *  is NOT followed, and an inferred, generic, platform or duplicated-FQCN receiver abstains,
   *  so the failure mode is a missing edge rather than a wrong one. */
  | 'kt-type'
  /** Swift heuristic: bare `m()` or `self.m()` inside a type, resolved to a method of that type
   *  (any of its declarations and extensions), then of its syntactic supertypes and conformed
   *  protocols — so a protocol-extension default implementation is reached. */
  | 'swift-member'
  /** Swift heuristic: `r.m()` where `r`'s type is read from a declaration — a parameter or
   *  property annotation, a local initialised by construction (`Foo()`), a container lookup
   *  (`resolve(Foo.self)`), or a typed static singleton (`Foo.shared`). The callee is `m` on that
   *  type or its supertypes. WEAKER THAN `scip`: the declared type is the compile-time type. */
  | 'swift-type'
  /** Swift heuristic: `Foo.m()` where `Foo` is an in-repo type and `m` one of its static/class
   *  methods (or a protocol-extension static it inherits). */
  | 'swift-static'
  /** Swift heuristic: bare `f()` resolved to a free function in the SAME file, else to the
   *  uniquely named free function in the repo. */
  | 'swift-local'
  /** C# method selected on the enclosing type or an explicitly named base. */
  | 'cs-lexical'
  /** C# method selected through a declared receiver type and project visibility. */
  | 'cs-type';

export interface CallEdge {
  id: string;
  /** Caller function/method ID */
  callerId: string;
  /** Callee function/method ID (if resolved) */
  calleeId?: string;
  /** Resolution lineage of `calleeId` — absent when the call is unresolved. See {@link CallProvenance}. */
  provenance?: CallProvenance;
  /** Callee expression (for unresolved calls) */
  calleeExpression: string;
  /** Is this a method call on an object */
  isMethodCall: boolean;
  /** Is this an async/awaited call */
  isAsync?: boolean;
  /** Call arguments (simplified) */
  arguments?: string[];
  location: SourceLocation;
}

/**
 * Edge representing a function/method that references a non-callable target
 * (state_store, variable) by name in its body — without invoking it as `fn()`.
 *
 * Example: a React component calling `useValues(userLogic)` — `userLogic` is
 * passed as an argument, not invoked. CALLS doesn't fire because there's no
 * call expression on `userLogic` itself, but the component clearly depends on
 * it. REFERENCES_VARIABLE captures that consumer relationship so
 * `find_callers(userLogic)` can return the components that use it.
 *
 * Targets are restricted to known indexed names: state_store nodes and
 * top-level variable nodes that are either declared in the same file or
 * imported into the caller's file.
 */
export interface ReferencesVariableEdge {
  id: string;
  /** Referrer function/method ID */
  callerId: string;
  /** Referenced target ID (state_store or variable) */
  targetId: string;
  /** Target node kind — used by downstream filters/queries */
  targetKind: 'state-store' | 'variable';
  /** Identifier name as it appears in the caller's file (after import alias) */
  identifierName: string;
  /** First location of the reference in source (deduped by caller+target) */
  location: SourceLocation;
}

export interface ImportEdge {
  id: string;
  /** Source file ID (importing file) */
  sourceFileId: string;
  /** Raw module specifier as written in code (e.g., './user.service', '@nestjs/common') */
  moduleSpecifier: string;
  /**
   * Resolved target file ID for internal imports.
   * Set when moduleSpecifier resolves to a file within the repository.
   * Undefined for external package imports (npm packages, node builtins).
   * Enables import graph traversal and dependency analysis.
   */
  targetFileId?: string;
  /** Is this a type-only import (import type { ... }) */
  isTypeOnly: boolean;
  /** Import kind */
  importKind: 'named' | 'default' | 'namespace' | 'side-effect';
  /** Imported names with optional resolution to their definitions */
  importedNames?: ImportedName[];
}

export interface ImportedName {
  /** Original name of the import (e.g., 'UserService' in 'import { UserService }') */
  name: string;
  /** Alias if renamed (e.g., 'US' in 'import { UserService as US }') */
  alias?: string;
  /**
   * Resolved ID of the imported element (class, function, interface, etc.).
   * Links import usage to the actual definition in the target file.
   * Enables tracing from import to definition across the codebase.
   */
  resolvedId?: string;
}

export interface ExternalCallEdge {
  id: string;
  versionedId: string;
  /** Function/method making the call */
  callerId: string;
  /** External service/SDK name */
  serviceName: string;
  /** SDK/client being used */
  sdkName?: string;
  /** Method being called */
  method: string;
  /**
   * Dynamic-dispatch SDK method name, read from a positional string argument when
   * the call site dispatches the SDK method by NAME rather than statically (e.g.
   * `this.performApiRequest('listResources', […])`). In that shape `method`
   * holds the wrapper VERB ('PERFORMAPIREQUEST') and the real SDK method is here, so
   * the cross-repo sdkMapping fallback can resolve `(sdkName, dispatchMethod)` → route
   * when no static path exists at the call site. Unset for ordinary calls.
   */
  dispatchMethod?: string;
  /** Target URL/endpoint pattern */
  targetPattern?: string;
  /** Target entrypoint ID (if resolved cross-service) */
  targetEntrypointId?: string;
  /** Call details */
  details?: ExternalCallDetails;

  // === Cross-Service Tracing Fields ===

  /**
   * Structured target descriptor for cross-service resolution.
   * Contains protocol-specific details needed to match with target entrypoints.
   */
  targetDescriptor?: ExternalCallTarget;

  /**
   * Reference to the SDK method definition ID.
   * Enables lookup of full SDK method details including HTTP path mappings.
   */
  sdkMethodId?: string;

  /**
   * Resolved target entrypoint ID from cross-repo linking.
   * Set during post-processing when matching entrypoints are found across repos.
   */
  resolvedTargetId?: string;

  /**
   * Raw SCIP package moniker preserved at extraction for the symbol hop. Present
   * only on SDK-mediated / cross-package external calls whose call site SCIP
   * decoded to a package moniker. `packageName` e.g. '@sample/demo-api-client';
   * `descriptor` is the raw SCIP descriptor tail (everything after the version),
   * e.g. "src/`index.d.ts`/CalculationsClient#dailySummaries().". Normalization to
   * the (package, semantic-suffix) join key happens at link time, not here.
   */
  moniker?: { packageName: string; descriptor: string };

  location: SourceLocation;
}

export interface ExternalCallDetails {
  /** HTTP method if applicable */
  httpMethod?: HttpMethod;
  /** URL path */
  path?: string;
  /** Headers being set */
  headers?: Record<string, string>;
  /** Request body type */
  requestType?: TypeInfo;
  /** Expected response type */
  responseType?: TypeInfo;
}

// =============================================================================
// Cross-Service Tracing Types
// =============================================================================

/**
 * Structured descriptor for external call targets.
 * Used to match external calls with entrypoints across services.
 */
export interface ExternalCallTarget {
  /** Protocol of the call */
  protocol: 'http' | 'messaging' | 'grpc' | 'graphql' | 'ipc' | 'subprocess' | 'internal';

  /** HTTP call details */
  http?: {
    method: HttpMethod;
    /** Path template with normalized params: /items/{id}/sub */
    pathTemplate: string;
    /** Original path from code (before normalization) */
    originalPath?: string;
  };

  /** Broker-agnostic messaging destination. Every queue/event producer emits this. */
  messaging?: {
    /** Normalized transport family/profile spelling (kafka, gcp-pubsub, sqs, etc.). */
    system: string;
    /** Destination token/reference as written at the call site. */
    destination: string;
    /** Runtime destination when the token is statically resolvable. */
    destinationValue?: string;
  };

  /** gRPC call details */
  grpc?: {
    service: string;
    method: string;
  };

  /** GraphQL call details */
  graphql?: {
    operationType: 'query' | 'mutation' | 'subscription';
    operationName: string;
  };

  /** IPC call details (Electron ipcRenderer/ipcMain, Worker postMessage) */
  ipc?: {
    channel: string;
    direction: 'send' | 'invoke' | 'on' | 'handle';
  };

  /** Subprocess call details (child_process spawn/exec/fork) */
  subprocess?: {
    method: 'spawn' | 'exec' | 'execFile' | 'fork' | 'execSync' | 'spawnSync';
    command?: string;
  };

  /** Hint about target service (e.g., "users", "core", "billing") */
  targetService?: string;
}

/**
 * SDK method definition that maps client methods to their underlying protocol calls.
 * Used by SDK/client library parsers to document what each method actually calls.
 */
export interface SdkMethodDefinition {
  /** Unique identifier for this SDK method */
  id: string;
  versionedId: string;

  /** SDK package name (e.g., "@acme-corp/api-client") */
  packageName: string;

  /** Client class name (e.g., "Core", "Billing", "UsersClient") */
  className: string;

  /** Method name (e.g., "getDepartments", "createShift") */
  methodName: string;

  /** Inferred target service name (e.g., "core", "billing") */
  targetService?: string;

  /** Protocol used by this method */
  protocol: 'http' | 'grpc' | 'graphql';

  /** HTTP-specific details */
  httpDetails?: {
    method: HttpMethod;
    /** Path template with normalized params: /items/{id}/parts */
    pathTemplate: string;
    /** Extracted path parameters */
    pathParams?: string[];
  };

  /** gRPC-specific details */
  grpcDetails?: {
    serviceName: string;
    methodName: string;
    protoFile?: string;
  };

  /** GraphQL-specific details */
  graphqlDetails?: {
    operationType: 'query' | 'mutation' | 'subscription';
    operationName: string;
  };

  location: SourceLocation;
  documentation?: string;
}

// =============================================================================
// Frontend/Mobile Specific
// =============================================================================

export interface ComponentNode extends BaseNode {
  kind: 'component';
  fileId: string;
  /** Framework (react, vue, angular, svelte, etc.) */
  framework: string;
  /** Component type */
  componentType: 'functional' | 'class' | 'template';
  /** Props definition */
  props?: ComponentProp[];
  /** State definitions */
  state?: StateDefinition[];
  /** Child components used */
  childComponents?: ComponentUsage[];
  /** Hooks used (React) */
  hooks?: HookUsage[];
  /** Lifecycle methods */
  lifecycle?: string[];
  /** Emitted events (Vue) */
  emits?: string[];
  /** Slots (Vue) */
  slots?: string[];
  /**
   * Markup file this component renders, when it lives outside the component's own source file
   * (an Android layout XML, a Vue SFC template, an Angular `templateUrl`). Repo-relative.
   * Absent when the markup is inline or could not be resolved — never a guessed path.
   */
  templateFile?: string;
}

export interface ComponentProp {
  name: string;
  type?: TypeInfo;
  isRequired: boolean;
  defaultValue?: string;
  documentation?: string;
}

export interface StateDefinition {
  name: string;
  type?: TypeInfo;
  /** State management source (local, redux, zustand, etc.) */
  source: string;
  /** Selector/path for external state */
  selector?: string;
}

export interface ComponentUsage {
  componentId?: string;
  componentName: string;
  /** Props passed */
  props?: Record<string, string>;
  location: SourceLocation;
}

export interface HookUsage {
  hookName: string;
  /** Custom hook ID if applicable */
  hookId?: string;
  arguments?: string[];
  location: SourceLocation;
}

export interface RouteNode {
  id: string;
  /** Route path */
  path: string;
  /** Component handling this route */
  componentId?: string;
  componentName: string;
  /** Parent route (for nested routes) */
  parentRouteId?: string;
  /** Child routes */
  childRouteIds?: string[];
  /** Route guards/middleware */
  guards?: string[];
  /** Route metadata */
  meta?: Record<string, unknown>;
  /** Lazy loaded */
  isLazy: boolean;
  location?: SourceLocation;
}

export interface StateStoreNode extends BaseNode {
  kind: 'state-store';
  fileId: string;
  /** State management library */
  library: 'redux' | 'zustand' | 'mobx' | 'pinia' | 'vuex' | 'recoil' | 'jotai' | 'other';
  /** Store/slice name */
  storeName: string;
  /** State shape */
  stateShape?: TypeInfo;
  /** Actions/mutations */
  actions: StateAction[];
  /** Selectors/getters */
  selectors: StateSelector[];
  /** Effects/thunks */
  effects?: StateEffect[];
}

export interface StateAction {
  name: string;
  /** Parameters */
  parameters?: ParameterInfo[];
  /** Affected state keys */
  affectsKeys?: string[];
  location: SourceLocation;
}

export interface StateSelector {
  name: string;
  /** State keys accessed */
  accessedKeys?: string[];
  returnType?: TypeInfo;
  location: SourceLocation;
}

export interface StateEffect {
  name: string;
  /** Triggered by actions */
  triggeredBy?: string[];
  /** External calls made */
  externalCalls?: string[];
  location: SourceLocation;
}

// =============================================================================
// Top-Level Output
// =============================================================================

export interface ParsedRepo {
  /** Repo stable ID */
  id: string;
  /** Repo name from config */
  name: string;
  /** Repo path */
  path: string;
  /** Repo type */
  type?: RepoType;
  /** ISO timestamp of parse */
  parsedAt: string;
  /** Parser version used */
  parserVersion: string;
  /** Parser ID that generated this output */
  parserId: string;

  /** Git version info captured at parse time */
  git?: GitInfo;

  // Structure
  packages: Package[];
  files: FileNode[];

  // Code elements
  functions: FunctionNode[];
  classes: ClassNode[];
  interfaces: InterfaceNode[];
  typeAliases: TypeAliasNode[];
  enums: EnumNode[];
  variables: VariableNode[];

  // Entrypoints
  entrypoints: Entrypoint[];

  // Data layer
  entities: EntityNode[];
  dbOperations: DbOperation[];

  // Relationships
  calls: CallEdge[];
  imports: ImportEdge[];
  externalCalls: ExternalCallEdge[];
  /**
   * Edges representing functions/methods that reference a `state_store` or
   * top-level `variable` by name in their body (e.g. `useValues(userLogic)`).
   * Optional for backward-compatibility with older parser output files —
   * older outputs simply lack the field.
   */
  referencesVariables?: ReferencesVariableEdge[];
  /**
   * Value-position references to enum members (`Status.Locked`) from function
   * bodies. Optional for backward-compatibility with parser output produced
   * before the field existed — absent means "not detected", not "none exist"
   * (only the TS/JS substrate emits these).
   */
  enumMemberReferences?: EnumMemberReferenceEdge[];
  /**
   * Construction (`new X()`) and import references to classes. Optional for
   * backward-compatibility with parser output produced before the field existed —
   * absent means "not detected", not "none exist" (only the TS/JS substrate emits
   * these).
   */
  classReferences?: ClassReferenceEdge[];

  // SDK definitions (for SDK/client library repos)
  /** SDK method definitions mapping client methods to underlying protocol calls */
  sdkDefinitions?: SdkMethodDefinition[];

  // Frontend specific (optional)
  components?: ComponentNode[];
  routes?: RouteNode[];
  stateStores?: StateStoreNode[];

  // Metadata
  stats: ParseStats;
  errors?: ParseError[];

  /** SHA256 hash of parser.ts at the time this parse was run */
  parserHashAtParse?: string;
}

export interface ParseStats {
  /** Actual per-target analysis; absent means not reported, never implicitly enhanced. */
  analysis?: AnalysisRecord[];
  totalFiles: number;
  parsedFiles: number;
  skippedFiles: number;
  totalFunctions: number;
  totalClasses: number;
  totalEntrypoints: number;
  totalEntities: number;
  totalCalls: number;
  totalImports: number;
  totalExternalCalls: number;
  /** Number of SDK method definitions (for SDK/client repos) */
  totalSdkDefinitions?: number;
  parseTimeMs: number;
  /** Summary of the Python call-graph pass when `.py` files were parsed. */
  python?: PythonParseStats;
  /** Summary of the Kotlin pass when `.kt` files were parsed. */
  kotlin?: KotlinParseStats;
  /**
   * Language-neutral call-resolution record. Absent means the substrate did not measure it —
   * never write zeros for "unknown", because a consumer cannot tell those apart.
   */
  callResolution?: CallResolutionStats;
  /**
   * Language-neutral db-operation-resolution record, mirroring `callResolution` for db operations.
   * Absent means the substrate did not measure it.
   */
  dbOpResolution?: DbOpResolutionStats;
  /**
   * Referential-integrity summary computed when the output was assembled.
   * Absent on outputs produced before the validation pass existed; `danglingRefs: 0`
   * is the only value that means "checked and clean".
   */
  integrity?: ParseIntegrityStats;
}

/** Portable capability metadata; raw compiler diagnostics remain local parse errors/logs. */
export interface AnalysisRecord {
  language: string;
  target?: string;
  mode: 'basic' | 'enhanced';
  compilerReceiverTypes: boolean;
  fallback: boolean;
}

/**
 * Language-neutral call-resolution record every substrate fills (spec BR-1/BR-2/LIM-6).
 *
 * `callSites` counts the call sites the substrate ENUMERATED — not every call expression in the
 * source. Sites with no enclosing function node, and whatever else a substrate skips before
 * counting, are uncounted by construction, so the number reads "of the counted sites".
 *
 * `resolvedCalls` counts enumerated sites for which at least one `CALLS` edge was shipped.
 *
 * `outOfScopeCalls` counts enumerated sites whose bare callee name is declared by no function or
 * method in the repository: no node in this graph could be their target, so they are out of scope
 * rather than missed. The test is the bare name, so a platform call that shares a name with an
 * in-repo declaration stays IN scope and, unbound, counts against the extractor — the rate
 * understates and never flatters.
 *
 * Invariant: `resolvedCalls + outOfScopeCalls <= callSites`.
 */
export interface CallResolutionStats {
  callSites: number;
  resolvedCalls: number;
  outOfScopeCalls: number;
}

/**
 * Language-neutral db-operation-resolution record, mirroring `CallResolutionStats` for
 * db operations.
 *
 * `dbOpSites` counts the db-operation sites the substrate ENUMERATED before its
 * receiver/entity/SQL filter.
 *
 * `boundDbOps` counts enumerated sites whose emitted DbOperation carries a resolved `entityId` —
 * an op emitted with an unknown/fallback entity is NOT bound.
 *
 * `outOfScopeDbOps` counts enumerated sites whose receiver constant or table token names no
 * entity or table declared in the repository.
 *
 * Invariant: `boundDbOps + outOfScopeDbOps <= dbOpSites` (they need not sum to `dbOpSites`: e.g.
 * a known table without an entity is in scope and unbound).
 */
export interface DbOpResolutionStats {
  dbOpSites: number;
  boundDbOps: number;
  outOfScopeDbOps: number;
}

/**
 * Cross-collection reference health of a ParsedRepo (e.g. a `functions.fileId`
 * naming a file node that was never emitted). A non-zero count means part of the
 * graph is unjoinable — the signature of a partially-failed extraction pass that
 * would otherwise self-report green. Each entry is also present in `errors[]`.
 */
export interface ParseIntegrityStats {
  /** Total dangling references across all collections. */
  danglingRefs: number;
  /** Count per `<collection>.<field>` (e.g. `functions.fileId`). */
  byCollection: Record<string, number>;
}

/**
 * Per-pass summary emitted by the Kotlin/Android substrate. Surfaced on `ParseStats.kotlin` so
 * callers (CLI, MCP, dashboards) can see grammar health and the substrate-specific diagnostics
 * the neutral records deliberately do not carry (ambiguous call sites, unparsed DAO queries,
 * externally triggered classes with no lifecycle handler).
 */
export interface KotlinParseStats {
  filesParsed: number;
  /**
   * `.kt` files whose tree contains an ERROR node. MISSING nodes are deliberately excluded:
   * this grammar inserts `MISSING _automatic_semicolon` into entirely valid single-line
   * bodies, so counting them would bury a real grammar regression in constant noise.
   */
  filesWithSyntaxErrors: number;
  /** Call sites considered by the resolver. */
  callSites: number;
  /** Call sites that produced an edge. `resolvedCalls / callSites` is the resolution rate. */
  resolvedCalls: number;
  /** Sites dropped because the target name was declared by two included source sets. */
  ambiguousCalls: number;
  /**
   * Sites whose callee name is declared nowhere in the repository — a platform SDK, the
   * standard library, a third-party dependency or another language. No node in this graph
   * could be their target, so they are OUT OF SCOPE rather than missed.
   *
   * Subtracting them is what makes the resolution rate mean something: `resolvedCalls /
   * callSites` answers "what share of all call expressions did we bind", which is dominated by
   * calls into the platform and reads like a defect on a perfectly healthy graph;
   * `resolvedCalls / (callSites - outOfScopeCalls)` answers "what share of the calls that
   * could point somewhere here did we bind", which is the number worth acting on.
   */
  outOfScopeCalls: number;
  /** Resolved sites per provenance tier. */
  byTier: Record<string, number>;
  /** HTTP endpoint methods declared on client interfaces, whether or not they are called. */
  endpointsDefined: number;
  /** Call sites invoking one of those endpoints. */
  egressCallSites: number;
  /** Externally triggered classes that declared no lifecycle handler, so emitted no entrypoint. */
  entrypointsWithoutHandler: number;
  /** DAO queries whose SQL yielded no table, so emitted no operation. */
  unparsedDaoQueries: number;
}

/**
 * Per-pass summary emitted by the Python call-graph parser. Surfaced on
 * `ParseStats.python` so callers (CLI, MCP, dashboards) can detect partial
 * parses or noisy import resolution.
 */
export interface PythonParseStats {
  filesParsed: number;
  /** Number of `.py` files skipped because of tree-sitter parse errors. */
  syntaxErrors: number;
  /** Repo-relative paths of skipped files (also surfaced as ParseError entries). */
  skippedFiles: string[];
  /** Count of import names that could not be resolved to a tracked file. */
  unresolvedImports: number;
  /** Wall-clock time spent in the Python pass. */
  durationMs: number;
  /** Top unresolved module names, most-frequent first. */
  topUnresolvedModules: { module: string; count: number }[];
}

export interface ParseError {
  file: string;
  line?: number;
  message: string;
  severity: 'error' | 'warning';
}
