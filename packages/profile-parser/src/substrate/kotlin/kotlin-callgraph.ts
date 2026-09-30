/**
 * Kotlin internal call graph — the four precision-first tiers of §Calls plus `iface-impl`.
 *
 * There is no semantic index for Kotlin, so a wrong edge is worse than a missing one: a reader
 * cannot tell the two apart. Tiers are tried in this order, FIRST HIT WINS, and anything else is
 * DROPPED — never emitted as a placeholder row:
 *
 *   - `kt-member` — bare `m()` / `this.m()` inside class `C` → `m` on `C`, then on its resolved
 *                   supertypes, then on its companion. FIRST, because Kotlin resolves a bare name
 *                   against the enclosing class's members before any top-level function.
 *   - `kt-local`  — bare `f()` → a file-level function `f` of the same file, else the uniquely
 *                   named file-level `f` of the same Kotlin package.
 *   - `kt-import` — bare `f()` bound by an `import a.b.f`, or `X.m()` where `X` resolves to a
 *                   class and `m` is one of its static (companion / `object`) members.
 *   - `kt-type`   — `r.m()` where `r` is a local, parameter or property with a resolvable
 *                   DECLARED type, including one delegated or initialised through a DI accessor
 *                   with an explicit type (`by inject()`, `by viewModel()`, `get<T>()`), and
 *                   `R.p.m()` where the root `R` is such a value OR an emitted type (`object Api`,
 *                   a class reached for its companion) and each intermediate member is a property
 *                   of the type reached so far. At most two intermediate hops; every link must
 *                   resolve or the call is dropped.
 *   - `iface-impl`— that `kt-type` target is an INTERFACE with exactly ONE in-scope
 *                   implementation, so the edge targets the implementation's `m`. Two or more
 *                   implementations ABSTAIN: the edge stays on the interface member and the
 *                   implements edge is the honest second hop.
 *
 * A `T.create()`-style factory receiver is not followed. Receivers typed by inference, view
 * bindings, `it`, collection generics and Java classes never resolve, and a resolution landing on
 * a DUPLICATED FQCN (a flavour duplicate) drops the edge and increments `ambiguousCalls`.
 * Constructor invocations of emitted classes and the stdlib scope functions are not candidates.
 *
 * EXACTLY ONE edge per call site: `callEdgeId(callerId, calleeExpression, location)` is fully
 * determined by the site, so a second edge from one site would silently overwrite the first.
 */
import type { CallEdge, CallProvenance, FunctionNode, StableIdGenerator } from '@coredoc/core';
import { SIMPLE_IDENTIFIER, calleeChain } from './kotlin-cst.js';
import {
  SCOPE_FUNCTIONS,
  type KotlinCallSite,
  type KotlinFileFacts,
  type KotlinTypeDecl,
} from './kotlin-declarations.js';
import type { KotlinResolution, KotlinTypeIndex } from './kotlin-resolve.js';

/** The counters `stats.kotlin` carries (§Stats). */
export interface KotlinCallStats {
  /** Call candidates attributed to an emitted function (scope functions and constructors excluded). */
  callSites: number;
  /** Of those, the ones a tier resolved. */
  resolvedCalls: number;
  /** Of those, the ones dropped because the target FQCN is declared by two in-scope files. */
  ambiguousCalls: number;
  /**
   * Of those, the ones whose callee name is declared NOWHERE in this repository — a platform
   * SDK, the standard library, a third-party dependency or Java. No in-repo node could be
   * their target, so they are out of scope rather than missed, and reporting them as misses
   * makes a healthy graph look broken.
   *
   * Deliberately conservative: it keys on the name alone, so a framework call that happens to
   * share a name with something declared here (`getString`, `toString`, `show`) still counts
   * as in scope. The in-scope resolution rate therefore UNDERSTATES how well the tiers did and
   * never flatters them, which is the safe direction for a precision-first extractor.
   */
  outOfScopeCalls: number;
  /** Provenance → count. */
  byTier: Record<string, number>;
}

export interface KotlinCallResolution {
  calls: CallEdge[];
  stats: KotlinCallStats;
}

export function emptyKotlinCallStats(): KotlinCallStats {
  return { callSites: 0, resolvedCalls: 0, ambiguousCalls: 0, outOfScopeCalls: 0, byTier: {} };
}

/** Repo-wide lookup state the tiers share. */
interface Ctx {
  index: KotlinTypeIndex;
  fnById: Map<string, FunctionNode>;
  /**
   * Every simple name this repository declares as a function or method. A callee name absent
   * from it cannot have an in-repo target, which is what separates "out of scope" from
   * "missed" when a site does not resolve. An extension contributes its bare name, since that
   * is what a call site writes.
   */
  callableNames: Set<string>;
  /** File path → file-level function name → id. */
  topLevelByFile: Map<string, Map<string, string>>;
  /** Kotlin package → file-level function name → id, absent when the name is not unique. */
  topLevelByPackage: Map<string, Map<string, string>>;
  /** File path → its facts, so a property's type resolves in the file that DECLARES it. */
  byFile: Map<string, KotlinFileFacts>;
}

type Hit = { calleeId: string; provenance: CallProvenance };
/** A tier landed on a duplicated FQCN: drop the edge, count it (D-7). */
const AMBIGUOUS = 'ambiguous' as const;

function buildCtx(allFacts: readonly KotlinFileFacts[], index: KotlinTypeIndex): Ctx {
  const ctx: Ctx = {
    index,
    fnById: new Map(),
    callableNames: new Set(),
    topLevelByFile: new Map(),
    topLevelByPackage: new Map(),
    byFile: new Map(),
  };
  const packageDuplicates = new Map<string, Set<string>>();
  for (const facts of allFacts) {
    ctx.byFile.set(facts.relPath, facts);
    const byName = new Map<string, string>();
    for (const fn of facts.functions) {
      ctx.fnById.set(fn.id, fn);
      // An extension is named `Receiver.name`; a call site writes the bare name.
      ctx.callableNames.add(fn.name.includes('.') ? (fn.name.split('.').pop() as string) : fn.name);
      if (fn.kind !== 'function') continue;
      if (!byName.has(fn.name)) byName.set(fn.name, fn.id);

      let pkg = ctx.topLevelByPackage.get(facts.packageName);
      if (!pkg) {
        pkg = new Map();
        ctx.topLevelByPackage.set(facts.packageName, pkg);
      }
      let dups = packageDuplicates.get(facts.packageName);
      if (!dups) {
        dups = new Set();
        packageDuplicates.set(facts.packageName, dups);
      }
      if (pkg.has(fn.name) && pkg.get(fn.name) !== fn.id) dups.add(fn.name);
      else pkg.set(fn.name, fn.id);
    }
    ctx.topLevelByFile.set(facts.relPath, byName);
  }
  // A package-level name declared twice is not unique, so it resolves to nothing.
  for (const [pkgName, dups] of packageDuplicates) {
    const pkg = ctx.topLevelByPackage.get(pkgName);
    for (const name of dups) pkg?.delete(name);
  }
  return ctx;
}

/** A declared type text reduced to the simple name it can be resolved by, or nothing. */
function bareTypeName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = text.trim().replace(/\?+$/, '');
  // Generics, function types and platform types carry no resolvable single name.
  if (/[<>()[\]]/.test(cleaned)) return undefined;
  return /^[A-Za-z_][\w.]*$/.test(cleaned) ? cleaned : undefined;
}

/** Every VALUE of `name` visible at the site: locals of the enclosing function, its parameters, the class's properties. */
function valueBindingsOf(name: string, site: KotlinCallSite, facts: KotlinFileFacts, ctx: Ctx) {
  const locals = facts.localBindings.filter(
    (b) => b.enclosingFunctionId === site.enclosingFunctionId && b.name === name,
  );
  const param = ctx.fnById.get(site.enclosingFunctionId)?.parameters.find((p) => p.name === name);
  const decl = site.enclosingClassFqcn ? facts.declarations.get(site.enclosingClassFqcn) : undefined;
  const hasProperty = !!decl && (decl.propertyTypes.has(name) || decl.diProperties.has(name));
  const propertyType = decl ? (decl.propertyTypes.get(name) ?? decl.diProperties.get(name)?.typeName) : undefined;
  return { locals, param, hasProperty, propertyType };
}

/**
 * Whether a VALUE of that name is in scope at the site. A receiver naming a value is never read
 * as the TYPE of the same name, however capitalised it is: in `fun run(Client: Other)` the
 * receiver `Client` is the parameter, so `Client.send()` is `Other.send`, never `object Client`.
 */
function hasValueBinding(name: string, site: KotlinCallSite, facts: KotlinFileFacts, ctx: Ctx): boolean {
  const { locals, param, hasProperty } = valueBindingsOf(name, site, facts, ctx);
  return locals.length > 0 || param !== undefined || hasProperty;
}

/**
 * The DECLARED type of a receiver name: a local binding of the enclosing function, then a
 * parameter of it, then a property (or DI-delegated property) of the enclosing class. Order is
 * shadowing order. A receiver with no written type — an inferred `val`, `it`, a view binding —
 * yields nothing, which is the whole point.
 *
 * A local SHADOWS an outer binding only from its own declaration onward and only inside its own
 * block, and `localBindings` carries neither offset: a site cannot be placed against it. So a
 * local that collides with a parameter or a property of the same name ABSTAINS rather than
 * claiming the whole function — reading `val x: B` back over the `x: A` calls above it types
 * every one of them wrongly. Two locals of one name disagreeing on their type abstain likewise.
 */
function declaredTypeOf(name: string, site: KotlinCallSite, facts: KotlinFileFacts, ctx: Ctx): string | undefined {
  const { locals, param, hasProperty, propertyType } = valueBindingsOf(name, site, facts, ctx);
  if (locals.length > 0) {
    if (param !== undefined || hasProperty) return undefined;
    const types = new Set(locals.map((b) => bareTypeName(b.typeName)));
    return types.size === 1 ? [...types][0] : undefined;
  }
  if (param) return bareTypeName(param.type?.text);
  return bareTypeName(propertyType);
}

/** Whether the site is a constructor invocation of a type this repository declares. */
function isConstructorOfEmittedClass(site: KotlinCallSite, kind: SiteKind, facts: KotlinFileFacts, ctx: Ctx): boolean {
  if (kind !== 'bare' || !/^[A-Z]/.test(site.name)) return false;
  return ctx.index.resolve(site.name, facts).status !== 'external';
}

/**
 * What the callee chain's ROOT is, which `KotlinCallSite` alone cannot say: `calleeText` keeps
 * only the member names when the root is not a plain identifier, so `this.m()`, `a.b().c()` and
 * `x!!.d()` all arrive looking like a bare `m()`. Binding any of the latter two to a file-level
 * function would be a fabricated edge.
 */
type SiteKind = 'bare' | 'this' | 'receiver' | 'inferred';

/** The callee chain of a site, computed once and shared by the kind, the key and the tiers. */
type CalleeChain = ReturnType<typeof calleeChain>;

function siteKind(chain: CalleeChain): SiteKind {
  if (!chain) return 'inferred';
  // Only `this.m()` is a direct member call. `this.a.b.m()` names a property chain whose hops
  // this tier does not walk, and reading its last member as a member of the enclosing class
  // binds `this.child.save()` to `Parent.save`: a fabricated edge, so it abstains.
  if (chain.root.type === 'this_expression') return chain.members.length === 1 ? 'this' : 'inferred';
  if (chain.root.type !== SIMPLE_IDENTIFIER) return 'inferred';
  return chain.members.length === 0 ? 'bare' : 'receiver';
}

/**
 * The identity of a call SITE, which its start offset alone does not give.
 *
 * `f(a) { … }` is one call the grammar records TWICE (an outer and an inner `call_expression`);
 * `a.b().c()` is TWO calls that also share a start offset, because the inner call is the outer
 * one's chain root. The two shapes are told apart by the CALLEE span: the duplicate pair share
 * one callee node, while the chain pair do not (`make` vs `make().trim`). Keying on the offset
 * alone erased one real site per chain and flattered the resolution rate it is the denominator of.
 */
function siteKey(site: KotlinCallSite, chain: CalleeChain): string {
  if (!chain) return `${site.node.startIndex}:${site.node.endIndex}:${site.name}`;
  return `${chain.root.startIndex}:${chain.root.endIndex}:${chain.members.join('.')}`;
}

/**
 * Intermediate property hops a QUALIFIED receiver may cross: `Api.nodeApi.m()` is one hop,
 * `Api.a.b.m()` is the deepest shape followed. Beyond that the chain abstains.
 */
const MAX_RECEIVER_HOPS = 2;

/**
 * The type a receiver ROOT denotes: the declared type of a value binding of that name, else — when
 * no value of that name is in scope — an emitted TYPE the name itself names (`object Api`, or a
 * class reached for its companion). A value whose declared type is EXTERNAL stops here rather than
 * falling through to the type reading: `foo` the value is not `Foo` the class.
 */
function resolveReceiverRoot(
  name: string,
  site: KotlinCallSite,
  facts: KotlinFileFacts,
  ctx: Ctx,
): { decl: KotlinTypeDecl; isType: boolean } | typeof AMBIGUOUS | undefined {
  const typeName = declaredTypeOf(name, site, facts, ctx);
  // A value of that name is in scope but carries no readable type: it is still a VALUE, so the
  // type reading below would name something the source never referred to.
  if (typeName === undefined && hasValueBinding(name, site, facts, ctx)) return undefined;
  const hit = ctx.index.resolve(typeName ?? name, facts);
  if (hit.status === AMBIGUOUS) return AMBIGUOUS;
  if (hit.status !== 'resolved') return undefined;
  return { decl: hit.decl, isType: typeName === undefined };
}

/**
 * One hop of a qualified receiver: a PROPERTY `member` of `decl` whose declared type resolves.
 *
 * `propertyTypes` does not distinguish an instance property from a companion one, and it does not
 * need to: source that compiles only reaches a companion property through the class name and an
 * instance property through an instance, so the shape of the chain already decided which it is.
 * The type is resolved in the file that DECLARES the property, not in the calling file.
 */
function hopThroughProperty(decl: KotlinTypeDecl, member: string, ctx: Ctx): KotlinResolution | undefined {
  const propType = bareTypeName(decl.propertyTypes.get(member) ?? decl.diProperties.get(member)?.typeName);
  if (!propType) return undefined;
  const file = ctx.byFile.get(decl.filePath);
  return file ? ctx.index.resolve(propType, file) : undefined;
}

/**
 * `kt-type` over a whole receiver chain: resolve the root, walk each intermediate member as a
 * property of the type reached so far, and take the last member as the method. Every link must
 * resolve — a failed link DROPS the call rather than falling back to a bare-name method index —
 * and a link landing on a duplicated FQCN is the ambiguous case, dropped and counted.
 */
function resolveReceiverChain(
  site: KotlinCallSite,
  kind: SiteKind,
  chain: CalleeChain,
  facts: KotlinFileFacts,
  ctx: Ctx,
): Hit | typeof AMBIGUOUS | undefined {
  if (kind !== 'receiver') return undefined;
  if (!chain || chain.root.type !== SIMPLE_IDENTIFIER || chain.members.length === 0) return undefined;
  const hops = chain.members.slice(0, -1);
  if (hops.length > MAX_RECEIVER_HOPS) return undefined;

  const root = resolveReceiverRoot(chain.root.text as string, site, facts, ctx);
  if (root === AMBIGUOUS) return AMBIGUOUS;
  if (!root) return undefined;
  // A bare `X.m()` on a type is the `kt-import` tier's static lookup, already tried: reading it
  // here as an instance member of `X` would fabricate an edge.
  if (root.isType && hops.length === 0) return undefined;

  let decl = root.decl;
  for (const hop of hops) {
    const next = hopThroughProperty(decl, hop, ctx);
    if (!next) return undefined;
    if (next.status === AMBIGUOUS) return AMBIGUOUS;
    if (next.status !== 'resolved') return undefined;
    decl = next.decl;
  }

  if (decl.kind === 'interface') {
    const impl = ctx.index.soleImplementation(decl);
    const onImpl = impl ? ctx.index.findMethod(impl, site.name) : undefined;
    if (onImpl) return { calleeId: onImpl, provenance: 'iface-impl' };
  }
  const method = ctx.index.findMethod(decl, site.name);
  return method ? { calleeId: method, provenance: 'kt-type' } : undefined;
}

function resolveSite(
  site: KotlinCallSite,
  kind: SiteKind,
  chain: CalleeChain,
  facts: KotlinFileFacts,
  ctx: Ctx,
): Hit | typeof AMBIGUOUS | undefined {
  if (kind === 'inferred') return undefined;
  const bare = kind === 'bare';
  const onThis = kind === 'this';

  // kt-member FIRST: Kotlin resolves a bare name against the members of the enclosing class (and
  // its supertypes and companion) BEFORE any top-level function, so a class declaring `save()`
  // calls its own `save()` even where the file also declares a top-level one.
  if (bare || onThis) {
    const decl = site.enclosingClassFqcn ? facts.declarations.get(site.enclosingClassFqcn) : undefined;
    const method = decl ? ctx.index.findMethod(decl, site.name) : undefined;
    if (method) return { calleeId: method, provenance: 'kt-member' };
  }

  // kt-local: same file, then the uniquely named function of the same Kotlin package.
  if (bare) {
    const sameFile = ctx.topLevelByFile.get(facts.relPath)?.get(site.name);
    if (sameFile) return { calleeId: sameFile, provenance: 'kt-local' };
    const samePackage = ctx.topLevelByPackage.get(facts.packageName)?.get(site.name);
    if (samePackage) return { calleeId: samePackage, provenance: 'kt-local' };
  }

  // kt-import: an import binds the bare name, or `X.m()` on a resolved class's static member.
  if (bare) {
    for (const imp of facts.imports) {
      if (imp.isWildcard || imp.localName !== site.name) continue;
      const dot = imp.path.lastIndexOf('.');
      if (dot < 0) continue;
      const hit = ctx.topLevelByPackage.get(imp.path.slice(0, dot))?.get(imp.path.slice(dot + 1));
      if (hit) return { calleeId: hit, provenance: 'kt-import' };
    }
  } else if (site.receiverName && !hasValueBinding(site.receiverName, site, facts, ctx)) {
    // A receiver that names a VALUE in scope is that value, not the type sharing its name: the
    // static reading is tried only when nothing of that name is bound.
    const receiverType = ctx.index.resolve(site.receiverName, facts);
    if (receiverType.status === AMBIGUOUS) return AMBIGUOUS;
    if (receiverType.status === 'resolved') {
      // Members of an `object` declaration are indexed as INSTANCE members, yet `Registry.m()` is
      // how every caller reaches them, so an object's own members are static members here.
      const staticMember =
        receiverType.decl.kind === 'object'
          ? ctx.index.findMethod(receiverType.decl, site.name)
          : receiverType.decl.staticMethodsByName.get(site.name);
      if (staticMember) return { calleeId: staticMember, provenance: 'kt-import' };
    }
  }

  // kt-type: a receiver chain whose every link resolves, with the sole-implementation retarget.
  if (onThis) return undefined;
  return resolveReceiverChain(site, kind, chain, facts, ctx);
}

/**
 * Resolve every call site of every file into at most one `CallEdge` each.
 *
 * Unresolved sites emit nothing and are visible only as the gap between `callSites` and
 * `resolvedCalls` (LIM-2: the rate is recorded, not gated).
 */
export function resolveKotlinCalls(
  allFacts: readonly KotlinFileFacts[],
  index: KotlinTypeIndex,
  idGen: StableIdGenerator,
): KotlinCallResolution {
  const ctx = buildCtx(allFacts, index);
  const stats = emptyKotlinCallStats();
  const calls: CallEdge[] = [];
  const byId = new Set<string>();

  for (const facts of allFacts) {
    // `f(a) { … }` yields an outer and an inner `call_expression` for ONE call; `siteKey` keys on
    // the callee span, which those two share and two chained calls at one offset do not.
    const seenSites = new Set<string>();
    for (const site of facts.calls) {
      if (SCOPE_FUNCTIONS.has(site.name)) continue;
      const chain = calleeChain(site.node);
      const kind = siteKind(chain);
      if (isConstructorOfEmittedClass(site, kind, facts, ctx)) continue;
      const key = siteKey(site, chain);
      if (seenSites.has(key)) continue; // the duplicate node of one call: already counted, already resolved
      seenSites.add(key);
      stats.callSites++;

      const hit = resolveSite(site, kind, chain, facts, ctx);
      if (hit === AMBIGUOUS) {
        stats.ambiguousCalls++;
        continue;
      }
      if (!hit) {
        // Separate "nothing here could have been the target" from "we failed to bind it".
        if (!ctx.callableNames.has(site.name)) stats.outOfScopeCalls++;
        continue;
      }

      const calleeExpression = site.calleeText ?? site.name;
      const id = idGen.callEdgeId(
        site.enclosingFunctionId,
        calleeExpression,
        `${facts.relPath}:${site.location.startLine}`,
      );
      // One site, one edge: a second edge on this id would silently overwrite the first.
      if (byId.has(id)) continue;
      byId.add(id);

      stats.resolvedCalls++;
      stats.byTier[hit.provenance] = (stats.byTier[hit.provenance] ?? 0) + 1;
      calls.push({
        id,
        callerId: site.enclosingFunctionId,
        calleeId: hit.calleeId,
        provenance: hit.provenance,
        calleeExpression,
        isMethodCall: site.isMethodCall,
        arguments: site.args.map((a) => a.text as string),
        location: site.location,
      });
    }
  }
  return { calls, stats };
}
