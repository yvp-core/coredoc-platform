/**
 * Noise filtering for graph edges.
 *
 * tree-sitter emits a call expression for EVERY call site (including built-in globals like
 * `console.log` / `Math.max`), and SCIP flags a reference for every npm symbol — including pure
 * runtime/type-system helpers. Neither is a meaningful graph edge. Filtering them keeps the call
 * and external-call sets usable downstream and de-noises the overlay residue, without dropping any
 * in-repo or real external (service/IO) edges.
 *
 * The sets here are deliberately ECMAScript / Node / TS-ecosystem-general — NOT specific to any
 * client, repo, or SDK (see the project rule against hardcoding client patterns in shared infra).
 * Callers that need repo-specific exclusions pass an `extra` set rather than editing these.
 */

/** ECMAScript / Node built-in global objects. A method call on one of these is never a graph edge. */
export const BUILTIN_GLOBALS = new Set<string>([
  'console',
  'Math',
  'JSON',
  'Object',
  'Array',
  'Promise',
  'Number',
  'String',
  'Boolean',
  'Symbol',
  'Reflect',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Error',
  'process',
  'Buffer',
  'globalThis',
]);

/** True if a method call's receiver is a built-in global (e.g. `console.log`, `Math.max`, `JSON.parse`). */
export function isBuiltinReceiverCall(receiver: string | undefined): boolean {
  if (!receiver) return false;
  // receiver may be a chain ("console", "Math", "process.env"); take the root identifier.
  const root = receiver.split(/[.?[(]/, 1)[0].trim();
  return BUILTIN_GLOBALS.has(root);
}

/**
 * npm packages that are pure runtime/type-system helpers — never a service/IO call boundary.
 * Kept intentionally tiny and ecosystem-general; real dependency packages (e.g. @mikro-orm/core,
 * @nestjs/axios) are NOT listed here because their calls represent genuine DB/HTTP boundaries.
 */
export const NOISE_EXTERNAL_PACKAGES = new Set<string>(['tslib', 'reflect-metadata']);

/** True if an external-call package should be dropped as noise (empty, a @types/* stub, or a helper). */
export function isNoiseExternalPackage(pkg: string, extra?: Set<string>): boolean {
  if (!pkg) return true;
  if (pkg.startsWith('@types/')) return true;
  if (NOISE_EXTERNAL_PACKAGES.has(pkg)) return true;
  return extra?.has(pkg) ?? false;
}
