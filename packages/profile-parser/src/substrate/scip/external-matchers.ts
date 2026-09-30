/**
 * External-egress free helpers: receiver matching, ts-morph traversal parity,
 * import maps, and registry-anchored SDK detection.
 */
import { type SdkPackage, lookupSdkByPackage } from '@coredoc/core/base-parser/sdk-registry';
import type { StructuralCall, StructuralFile } from '../../facts/index.js';
import { regexFromSource } from '../regex-util.js';
import type { ExternalCallFact, SubstrateLoc } from '../interface.js';

export function externalReceiverMatches(
  receiver: string,
  propName: string,
  m: { receiver?: string; receiverPattern?: string },
): boolean {
  if (m.receiver !== undefined && (receiver === m.receiver || propName === m.receiver)) return true;
  if (m.receiverPattern !== undefined) {
    const re = regexFromSource(m.receiverPattern);
    if (re.test(propName) || re.test(receiver)) return true;
  }
  return m.receiver === undefined && m.receiverPattern === undefined;
}

/**
 * Whether the egress pass should attribute this call to its enclosing function. We traverse
 * class non-constructor methods, function declarations, top-level function-variables, AND
 * object-literal-property methods — the last so object-literal egress (the react-admin
 * dataProvider pattern `const dp = { getList: () => fetchJson(url) }`) is captured, matching
 * what the internal call graph already attributes for the same callers. Constructors stay
 * excluded: their calls are construction-time wiring, not request-time service egress.
 */
export function egressTraversableCaller(call: StructuralCall): boolean {
  if (call.enclosingKind === 'method' && call.enclosingName === 'constructor') return false;
  return true;
}

/**
 * Bare third-party import map for a file: localName → {modulePath, kind}. Mirrors the
 * ts-morph base parser's `bareImports` — only non-relative module specifiers (real
 * packages), keyed by the imported/aliased local name. Used by the SDK registry detector.
 */
export function buildBareImports(
  f: StructuralFile,
): Map<string, { modulePath: string; kind: 'default' | 'named' | 'namespace' }> {
  const out = new Map<string, { modulePath: string; kind: 'default' | 'named' | 'namespace' }>();
  for (const imp of f.imports) {
    const spec = imp.moduleSpecifier;
    if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue; // bare third-party only
    if (imp.kind === 'side-effect') continue;
    const kind = imp.kind; // 'named' | 'default' | 'namespace'
    for (const n of imp.names) out.set(n.alias ?? n.name, { modulePath: spec, kind });
  }
  return out;
}

/**
 * All-imports map for a file: imported local/aliased name → module specifier
 * (relative and bare alike). Used for DI-param import provenance (imported-sdk).
 */
/** True when a resolved import module satisfies an imported-sdk matcher's provenance. */
export function moduleMatchesProvenance(
  module: string,
  m: { fromModule?: string | string[]; fromModulePattern?: string },
): boolean {
  if (m.fromModule !== undefined) {
    const mods = Array.isArray(m.fromModule) ? m.fromModule : [m.fromModule];
    if (mods.includes(module)) return true;
  }
  if (m.fromModulePattern !== undefined) {
    const src = m.fromModulePattern.startsWith('/')
      ? m.fromModulePattern.replace(/^\/(.*)\/[a-z]*$/, '$1')
      : m.fromModulePattern;
    if (new RegExp(src).test(module)) return true;
  }
  return false;
}

/** First member segment after the DI root prop in a chained receiver propName. */
export function importedSdkSegment(propName: string, rootProp: string): string | undefined {
  if (!propName.startsWith(`${rootProp}.`)) return undefined;
  const rest = propName.slice(rootProp.length + 1);
  return rest.split('.')[0] || undefined;
}

export function importNameToModule(f: StructuralFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const imp of f.imports) {
    const spec = imp.moduleSpecifier;
    if (!spec || imp.kind === 'side-effect') continue;
    for (const n of imp.names) out.set(n.alias ?? n.name, spec);
  }
  return out;
}

/**
 * Registry-anchored SDK egress for a call site (non-constructor): `Sentry.init(…)`
 * (namespace — receiver imported as default/namespace from a known package) or
 * `loadStripe(…)` (factory — bare callee imported from a known package). Returns
 * undefined when no import provenance resolves to a recognized SDK package.
 */
export function matchRegistrySdk(
  call: StructuralCall,
  callerId: string,
  file: string,
  bareImports: Map<string, { modulePath: string; kind: 'default' | 'named' | 'namespace' }>,
): ExternalCallFact | undefined {
  if (!call.methodName) return undefined;
  const loc: SubstrateLoc = { filePath: file, startLine: call.startLine, endLine: call.endLine };
  const make = (pkg: SdkPackage, sdkName: string, method: string): ExternalCallFact => ({
    callerId,
    serviceName: pkg.service,
    sdkName,
    method,
    location: loc,
    protocol: pkg.protocol,
    targetService: pkg.protocol === 'http' || pkg.protocol === 'grpc' ? pkg.service : undefined,
  });

  if (call.receiver) {
    // Namespace method: `Sentry.addBreadcrumb(…)` — receiver must be the default/namespace
    // binding (a named import → `init()` is a factory call, not a namespace call).
    const imp = bareImports.get(call.receiver.split('.')[0]);
    if (!imp || imp.kind === 'named') return undefined;
    const pkg = lookupSdkByPackage(imp.modulePath);
    if (!pkg) return undefined;
    // Edge `method` is the bare method name (`addBreadcrumb`), mirroring the ts-morph
    // base parser's `method = ctx.methodName ?? match.callee` for namespace calls.
    return make(pkg, imp.modulePath, call.methodName);
  }
  // Factory: bare `loadStripe(…)` — the callee was imported from a known package.
  const imp = bareImports.get(call.methodName);
  if (!imp) return undefined;
  const pkg = lookupSdkByPackage(imp.modulePath);
  if (!pkg) return undefined;
  return make(pkg, imp.modulePath, call.methodName);
}
