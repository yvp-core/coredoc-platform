import type { BaseProfile } from './profile-base.js';
import type { DbOperationType, HttpMethod } from '@coredoc/core/types';

/** C# source scope and framework selectors interpreted by the C# substrate. */
export interface CSharpProfile extends Pick<BaseProfile, 'parserId' | 'repoType'> {
  nominal?: NominalRules;
  substrate: {
    language: 'csharp';
    include: string[];
    exclude?: string[];
    defines?: string[];
    /** One repository-relative solution, or .csproj files sharing one index. Defaults to source-owning projects. */
    projects?: string[];
    /** Enhanced is attempted by default; an unavailable compiler tier falls back to basic. */
    analysis?: { mode?: 'basic' | 'enhanced'; fallback?: boolean };
  };
  /** External type identities available from a referenced package/framework or project SDK. */
  libraries?: {
    dependency?: string;
    projectSdk?: string;
    types: string[];
    /** Declared library member return types needed for receiver-chain resolution. */
    members?: Record<string, { methods?: Record<string, string>; properties?: Record<string, string> }>;
  }[];
}

/** Attribute-based rules over resolved nominal type identities. Names belong to profiles. */
export interface NominalRules {
  bindings?: {
    receiverTypes: string[];
    methods: string[];
    serviceTypeArgument: number;
    implementationTypeArgument: number;
  }[];
  externalCalls?: ({
    receiverTypes: string[];
    serviceName: string;
    sdkName?: string;
    /** Reviewed constant address for this declared client binding. */
    baseAddress?: string;
    factory?: { receiverTypes: string[]; methods: string[]; nameArg: number; name: string };
  } & (
    | { via: 'methods'; methods: Record<string, { verb?: HttpMethod; pathArg?: number }> }
    | { via: 'attributes'; verbAttributes: Record<string, HttpMethod>; pathArg: number }
  ))[];
  httpCalls?: {
    receiverTypes: string[];
    verbs: Record<string, HttpMethod>;
    pathArg: number;
    handlerArg: number;
    /** Group-builder type and method → prefix argument, for nested constant prefixes. */
    groups?: { receiverTypes: string[]; methods: Record<string, number> };
  }[];
  registrations?: {
    receiverTypes: string[];
    methods: string[];
    typeArgument: number;
    baseTypes?: string[];
    handlers?: string[];
    excludeHandlers?: string[];
    kind: 'event' | 'websocket';
    eventName?: string;
    pathArg?: number;
  }[];
  models?: {
    contextTypes: string[];
    setTypes: string[];
    orm: string;
    tableAttributes: string[];
    columnAttributes?: string[];
    keyAttributes?: string[];
    ignoreAttributes?: string[];
    operations: Record<string, DbOperationType>;
    chainMethods?: string[];
    /** Generic context accessor methods whose first type argument identifies the model. */
    setMethods?: string[];
    fluent?: {
      builderTypes: string[];
      entityBuilderTypes: string[];
      /** Method vocabulary over a proven builder chain. Arguments follow the selected role. */
      methods: Record<
        string,
        | 'entity'
        | 'table'
        | 'property'
        | 'column'
        | 'columnType'
        | 'key'
        | 'ignore'
        | 'reference'
        | 'collection'
        | 'inverseReference'
        | 'inverseCollection'
        | 'foreignKey'
      >;
      entityCallbackArg?: number;
    };
  }[];
  controllers?: {
    baseTypes: string[];
    routeAttributes: string[];
    verbAttributes: Record<string, HttpMethod>;
    ignoreAttributes?: string[];
    controllerSuffix?: string;
  }[];
}
