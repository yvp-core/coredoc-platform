import type { DbOperationType, HttpMethod } from '@coredoc/core/types';
import type { CallSite } from '../substrate/interface.js';
import type { BaseProfile } from './profile-base.js';
import type { DbOpRule } from './db-ops.js';
import type { EntityRule } from './entities.js';
import type { EntrypointRule, HandlerTable } from './entrypoints.js';
import type { ExternalClientMatcher } from './external-calls.js';
import type { ComponentRule, RouteRule, StateStoreRule } from './frontend.js';

// ─────────────────────────────────────────────────────────────────────────────
// Call-graph + DI + substrate toggles
// ─────────────────────────────────────────────────────────────────────────────

export type CallGraphRule = {
  resolveThis?: boolean;
  resolveDI?: boolean;
  resolveBare?: boolean;
  /**
   * Receiver patterns (regex sources) for name-only DI-container calls
   * (`ctx.services.X.m()`). The engine emits a call edge with no calleeId and
   * keeps the expression.
   */
  abstainReceiverPatterns?: string[];
  /**
   * Promote anonymous callbacks passed as a call argument (`router.get('/x', (req,res) => …)`,
   * `arr.forEach(x => …)`) to citable function nodes, so calls inside them attribute to the
   * callback instead of being dropped at module scope — closing the inline-callback recall hole
   * for functional/Express-style repos. Default off (golden parity stays byte-identical until a
   * profile opts in; promoting callbacks changes node counts).
   */
  resolveAnonCallbacks?: boolean;
  /**
   * Names of ACCESSOR HOOKS — functions whose returned object is destructured into bound
   * member functions:
   *
   *   const { doThing } = useAccessor(someRef);   // binding site
   *   doThing();                                  // ← resolves to `doThing` in someRef's file
   *
   * The compiler binds `doThing` to a generated property of the hook's return type, which SCIP
   * cannot turn into a function, so the call never resolves. For each listed hook the engine
   * reads the binding shape (object pattern = call to the hook with a SINGLE identifier
   * argument, alias form `{ a: b }` included), resolves that argument's DEFINING FILE through
   * SCIP, and binds each destructured name to the function of the same name in that file.
   *
   * PRECISION CONTRACT — weaker than a SCIP edge. Only the argument's defining file is
   * compiler-grade; the final step trusts NAME UNIQUENESS inside that file, with no proof that
   * the destructured property IS that function (no export check, no reachability). Resolved
   * edges carry provenance `accessor-hook` so consumers can weight them below `scip`.
   *
   * Fail-closed at every other step: a non-identifier / multi-argument call, an argument whose
   * defining file SCIP cannot name (including a purely local one, which no index can place), a
   * property with no same-named function in that file, more than one such function, or two
   * bindings of one name with the same scope and different targets — all abstain (the call
   * stays unresolved). A nested rebinding shadows an outer one (narrowest scope wins).
   *
   * Only list hooks that return CALLABLES; a value-reader hook produces no call edges and
   * gains nothing here.
   */
  accessorHooks?: string[];
};

export type DiRule = { style: 'constructor-type' | 'none'; stripGenerics?: boolean };

export type SynthesizeRule = {
  /** `module.exports = { m: () => {} }` → synthesized FunctionNodes. */
  objectLiteralExportMethods?: boolean;
  /** glob prefixes (relative path startsWith) limiting synthesis. */
  inPaths?: string[];
};

export type SubstrateRule = {
  language: 'ts' | 'js';
  untypedJsMode?: boolean;
  include: string[];
  exclude?: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// The profile
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractionProfile extends BaseProfile {
  parserId: string;
  substrate: SubstrateRule;
  synthesize?: SynthesizeRule;
  di?: DiRule;
  callGraph?: CallGraphRule;
  entrypoints?: EntrypointRule[];
  /** Cross-file require/alias registries referenced by entrypoint handler resolution. */
  handlerTables?: HandlerTable[];
  entities?: EntityRule[];
  dbOperations?: DbOpRule;
  externalCalls?: ExternalClientMatcher[];
  /** Frontend: React component + JSX render-edge extraction. */
  components?: ComponentRule;
  /** Frontend: route → component resolution. */
  routes?: RouteRule;
  /** Frontend: state-store (zustand/redux/…) extraction. */
  stateStores?: StateStoreRule[];
  /**
   * The constrained escape hatch for long-tail conventions no declarative primitive
   * covers (e.g. Electron `ipcMain.handle('ch', handler)`). A custom rule is a real
   * TS function in the profile module — but it is *facts-only*: the engine hands it
   * a READ-ONLY `CustomRuleFacts` view of already-extracted substrate facts and a
   * typed `CustomRuleEmit`, and nothing else (no fs, no network, no mutable engine
   * internals). The API surface — not a sandbox — is what bounds it. This is the
   * gated exception, not a return to imperative parsers: prefer a primitive, and a
   * convention that recurs across repos should graduate into one.
   */
  customRules?: CustomRule[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom rules — the facts-only escape hatch (see ExtractionProfile.customRules)
// ─────────────────────────────────────────────────────────────────────────────

/** One bespoke convention: read facts, emit nodes. Runs after the built-in passes. */
export interface CustomRule {
  name: string;
  run: (facts: CustomRuleFacts, emit: CustomRuleEmit) => void;
}

/**
 * Read-only view of already-extracted substrate facts a custom rule may read. This
 * is deliberately narrow — it is the whole bound on what a custom rule can do.
 */
export interface CustomRuleFacts {
  /** Repo-relative root (for resolving paths, never for fs access in the rule). */
  readonly repoRoot: string;
  /**
   * RAW-CST call-shape query (e.g. `ipcMain.handle`). Mirrors `Substrate.callShapes`:
   * exact callee, a `recv.*` glob, or `*.method`; undefined = every scoped call.
   */
  callShapes(calleePattern?: string): readonly CallSite[];
  /** Resolve a top-level function/handler node id by (file, name); undefined if none. */
  functionId(file: string, name: string): string | undefined;
  /**
   * Tightest function node whose span contains (file, line) — how a rule attributes a
   * caller for a call site it only knows by location (e.g. the enclosing preload wrapper
   * of an `ipcRenderer.invoke(…)`). Undefined at module top level.
   */
  enclosingFunctionId(file: string, line: number): string | undefined;
  /**
   * Resolve a `Obj.MEMBER` const-object reference (e.g. `IpcChannels.CHAT_SEND`) to
   * its string-literal value across scoped files. Undefined when it doesn't resolve —
   * the convention-config analogue of `resolveConst` for object-member channel maps.
   */
  resolveConstMember(qualifiedRef: string): string | undefined;
}

/** Where an emitted node lives. Every emitter carries one — a node with no site is not citable. */
export interface CustomRuleSite {
  file: string;
  startLine: number;
  endLine: number;
}

/**
 * An ingress a custom rule recognized. The two shapes mirror the built-in entrypoint
 * kinds a call-registration convention can express: an HTTP endpoint, or a channel on a
 * queue / message bus (which is also how IPC registrations are modelled).
 */
export type CustomEntrypointNode = CustomRuleSite &
  (
    | {
        type: 'http';
        method: HttpMethod;
        /** Route path; `:id` / `{id}` params are canonicalized by the engine. */
        path: string;
        /** Resolved handler node id; omit when the handler is anonymous. */
        handlerId?: string;
      }
    | {
        type: 'queue';
        /** Queue system tag, e.g. `electron-ipc`. */
        system?: string;
        /** Channel / topic name. */
        channel: string;
        handlerId?: string;
      }
  );

/** An outbound call to something outside the repo, recognized by a bespoke convention. */
export type CustomExternalCallNode = CustomRuleSite & {
  /** The function making the call. Must be a node the substrate already emitted. */
  callerId: string;
  /** Logical service being called, e.g. `billing-api`. */
  serviceName: string;
  /** The invoked method / verb, e.g. `GET` or `sendEmail`. */
  method: string;
  /** Client library name when the call goes through one. */
  sdkName?: string;
  /** URL or endpoint pattern, when the site names one. */
  targetPattern?: string;
  /** HTTP verb, for calls whose protocol is HTTP. */
  httpMethod?: HttpMethod;
  /**
   * IPC channel, for calls over an in-app IPC bridge (Electron `ipcRenderer`).
   * Builds an `ipc` targetDescriptor the linker's topic hop joins onto the queue
   * entrypoint registered for the same channel (`ipcMain.handle`).
   */
  ipc?: { channel: string; direction: 'send' | 'invoke' | 'on' | 'handle' };
};

/** A store access a custom rule recognized. */
export type CustomDbOperationNode = CustomRuleSite & {
  /** The function performing the operation. Must be a node the substrate already emitted. */
  performerId: string;
  /** Entity / table / collection operated on. */
  entityName: string;
  operation: DbOperationType;
  /** Free-form detail, e.g. the method that carried the query. */
  details?: string;
};

/**
 * Typed node emitters a custom rule may call.
 *
 * A rule never constructs graph nodes itself: it describes what it found and the engine
 * mints the ids, so `StableIdGenerator` stays the single source of ID logic. Ids a rule
 * *passes in* (`handlerId`, `callerId`, `performerId`) must name nodes the substrate
 * already emitted — the engine rejects the emission otherwise rather than letting a
 * dangling reference into the graph.
 */
export interface CustomRuleEmit {
  entrypoint(node: CustomEntrypointNode): void;
  externalCall(node: CustomExternalCallNode): void;
  dbOperation(node: CustomDbOperationNode): void;
  /**
   * Synthesize a FunctionNode for an inline/anonymous handler — the arrow or
   * function expression passed directly to a registration call
   * (`ipcMain.handle(channel, async () => …)`) — and return its node id. Use this
   * when the handler has no named reference for `functionId` to resolve, so an
   * entrypoint can still bind `handlerId` to a real node instead of dangling.
   * `name` should be a stable, human-readable label (e.g. the channel) and is
   * keyed with the file into the id, so the same site yields the same id.
   */
  handlerFunction(node: { name: string; file: string; startLine: number; endLine: number }): string;
}
