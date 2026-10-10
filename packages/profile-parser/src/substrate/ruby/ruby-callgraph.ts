/**
 * Ruby internal call graph.
 *
 * Emits a `FunctionNode` for EVERY Ruby `def` (method + singleton_method) so the
 * graph has a real node for every potential caller/callee.
 *
 * The def index (`indexRubyDefs`) + the tier-ordered, provenance-tagged
 * resolver (`resolveRubyCalls`) are MEASURED (tests + scripts/_measure-ruby-calls.ts)
 * but their edges are NOT wired into the Ruby substrate (`calls: []`) until the >=0.90 tiers ship.
 *
 * Ids are canonical via StableIdGenerator (idGen.methodId), so a def's node id matches
 * the same def's db-op performer id — the two are merged by id in the Ruby substrate.
 */
import type {
  CallEdge,
  CallProvenance,
  ClassNode,
  FunctionNode,
  ParameterInfo,
  StableIdGenerator,
} from '@coredoc/core';
import { rubyClassNode } from './ruby-classes.js';
import type { RubyAssociationReader } from './ruby-entities.js';
import {
  CLASS_TYPES,
  DEF_TYPES,
  type TsNode,
  collectCalls,
  defOrClassName,
  isSingletonDef,
  methodName,
  nearestAncestor,
  qualifiedClassName,
  rubyMethodId,
  withParsedRuby,
} from './ruby-cst.js';

/** Best-effort parameter NAMES from a def's `parameters` (method_parameters) child. */
function paramInfos(def: TsNode): ParameterInfo[] {
  const params = def.childForFieldName?.('parameters');
  if (!params) return [];
  const out: ParameterInfo[] = [];
  for (let i = 0; i < params.childCount; i++) {
    const c = params.child(i);
    if (!c || c.type === '(' || c.type === ')' || c.type === ',') continue;
    const nameNode =
      c.childForFieldName?.('name') ?? (c.type === 'identifier' ? c : c.descendantsOfType?.('identifier')?.[0]);
    const name = (nameNode?.text ?? c.text) as string | undefined;
    if (!name) continue;
    const isRest = c.type === 'splat_parameter' || c.type === 'hash_splat_parameter' || c.type === 'block_parameter';
    const isOptional = c.type === 'optional_parameter' || c.type === 'keyword_parameter';
    out.push({ name, isOptional, isRest });
  }
  return out;
}

/**
 * The two container names a `def` has. They are deliberately DIFFERENT, and this is the one place
 * that says so — three sites used to derive them ad hoc and disagree:
 *
 *  - `idName` — the IMMEDIATE enclosing class/module's own `name` text. `rubyClassNode` hashes it
 *    into `ClassNode.id` and `rubyMethodId` hashes it into the method id, so `method.classId ===
 *    class.id` holds only while both use exactly this.
 *  - `resolutionName` — the NESTING-QUALIFIED name (`module A; class B` → 'A::B'). The call
 *    resolver's indexes are REPO-WIDE, and keying them on the bare name put `Billing::Client` and
 *    `Github::Client` in one bucket where the last file parsed won — at `rb-const`/`rb-self`
 *    confidence, which is a wrong edge presented as fact.
 *
 * Both are undefined when the def has no enclosing class/module (a top-level `def`) or that
 * container is unnamed. Unnamed containers are SKIPPED, the same way `classId` already skips them:
 * the synthetic `'Object'` bucket they used to share named no emitted node and no `classId`, and
 * being repo-wide it pooled EVERY top-level def in the repo into one resolution target. Those defs
 * stay reachable through the unique-name tier, which is honest about what it knows.
 */
function containerNames(def: TsNode): { idName?: string; resolutionName?: string } {
  const cls = nearestAncestor(def, CLASS_TYPES);
  if (!cls) return {};
  // Both are now the qualified name: identity and resolution have to agree, or a
  // `classId` computed from the bare name points at a ClassNode whose id carries
  // the namespace. Kept as two fields because the two CONCERNS remain distinct —
  // one feeds stable ids, the other feeds the repo-wide resolution indexes.
  const qualified = qualifiedClassName(cls);
  return { idName: qualified, resolutionName: qualified };
}

/** Build a `FunctionNode` for one `def` node (canonical singleton-aware id). */
function defToFunctionNode(def: TsNode, relPath: string, idGen: StableIdGenerator): FunctionNode {
  const defName = defOrClassName(def) ?? '(anonymous)';
  const clsName = containerNames(def).idName;
  const id = rubyMethodId(idGen, relPath, def);
  // The def node's own source slice (`def …; end`). Capped at 20000 chars to guard against
  // pathological method bodies bloating the output — matches the TS structural path (to-nodes.ts).
  const sourceCode = (def.text as string).slice(0, 20000);
  return {
    id,
    versionedId: idGen.versionedId(id, def.text as string),
    name: defName,
    kind: 'method',
    fileId: idGen.fileId(relPath),
    location: { filePath: relPath, startLine: def.startPosition.row + 1, endLine: def.endPosition.row + 1 },
    isAsync: false,
    isGenerator: false,
    parameters: paramInfos(def),
    classId: clsName ? idGen.classId(relPath, clsName) : undefined,
    isStatic: isSingletonDef(def),
    visibility: 'public',
    sourceCode,
  };
}

// =============================================================================
// Def index + tiered call resolver (measured; not yet wired into the parse)
// =============================================================================

/** A class's method def ids, split by instance vs class/singleton scope. */
export interface ClassMethods {
  instance: Map<string, string>; // bare method name → def id
  singleton: Map<string, string>;
}

/**
 * Repo-wide def index that the call resolver reads. Every class-keyed map here is keyed on the
 * NESTING-QUALIFIED class name (see `containerNames`), never the bare one — these maps are
 * repo-wide, and a bare key silently merges same-named classes from different namespaces.
 */
export interface RubyDefIndex {
  /** def id → FunctionNode (every def). */
  byId: Map<string, FunctionNode>;
  /** bare method name → def ids (unique-name tier + ambiguity detection). */
  byName: Map<string, string[]>;
  /** qualified class name → its methods. */
  methodsByClass: Map<string, ClassMethods>;
  /**
   * Qualified class name → syntactic ancestry (no MRO): superclass + include/extend/prepend
   * mixins, each kept AS WRITTEN. The written form is resolved through `resolveConstantReference`
   * at walk time, so a namespaced base (`< Billing::Base`) reaches its own class rather than
   * whatever else happens to be called `Base`.
   *
   * The DIRECTIVE is kept with the name because the three are not interchangeable: `extend M`
   * installs M's instance methods on the class's SINGLETON, so it must not be walked when the
   * question is which instance method an object has (see `resolveInstanceInitialize`).
   */
  ancestry: Map<string, RubyAncestry>;
  /** EXACT constant reference (the qualified class name) → itself. A miss here is not a fallback. */
  constants: Map<string, string>;
  /**
   * Bare (demodulized) constant name → every qualified class declaring it. Consulted only when the
   * exact key misses, and only when the set holds exactly ONE class: a name two namespaces both
   * claim has no decidable owner, and `Foo::Bar.call` binding to any class named `Bar` is a
   * fabricated edge at the highest Ruby confidence.
   */
  constantsByBareName: Map<string, Set<string>>;
  /**
   * Qualified names declared with `module`, not `class`. Only consulted to refuse `Mod.new`:
   * a module cannot be instantiated, so its `initialize` (written for its includers) is not a
   * def that site reaches.
   */
  moduleNames: Set<string>;
  /**
   * One node per `class`/`module` definition — the container every method's `classId` names.
   * Built on the walk that already visits those nodes, so no file is parsed a second time.
   */
  classes: ClassNode[];
}

/**
 * Class-body directives that install another module's methods, and the ancestry kind each one
 * means. `helpers` is Grape's spelling of `include` (the module's instance methods become the
 * endpoint's) — matched on the CODE SHAPE (a class-body call naming constants), not on the class
 * being recognised as a Grape API.
 */
/**
 * A `Map`, not an object literal: the key is a method NAME read out of Ruby source, and a plain
 * object answers `constructor` / `toString` / `valueOf` from `Object.prototype` — a truthy
 * non-directive that passed the `!kind` guard and injected the call's arguments as ancestors.
 */
const MIXIN_DIRECTIVES = new Map<string, RubyMixin['kind']>([
  ['include', 'include'],
  ['extend', 'extend'],
  ['prepend', 'prepend'],
  ['helpers', 'include'],
]);

/** A class-body mixin directive, kept with the constant it names. */
interface RubyMixin {
  kind: 'include' | 'extend' | 'prepend';
  name: string;
}

interface RubyAncestry {
  superclass?: string;
  mixins: RubyMixin[];
}

const demodulize = (c: string): string => {
  const i = c.lastIndexOf('::');
  return i >= 0 ? c.slice(i + 2) : c;
};
const normName = (n: string): string => n.replace(/^self\./, '');

/**
 * The class a constant reference names, as a `methodsByClass` key — or undefined when the repo
 * does not decide it. Two refusals, both of which used to be silent binds:
 *
 *  - a QUALIFIED reference that matched nothing exactly names a namespace this repo does not
 *    declare — overwhelmingly a gem (`Aws::S3::Client`, `Faraday::Connection`). Retrying on its
 *    last segment is repo-wide name-only matching, and it made `Foo::Bar.call` bind to any class
 *    named `Bar` under `rb-const`, the highest-confidence Ruby provenance;
 *  - a BARE reference is a lexical constant lookup, so falling back on the bare name is sound —
 *    but only while exactly ONE class carries it. Two claimants have no decidable owner.
 *
 * A leading `::` is a root-scope qualifier, not a namespace segment, so it is stripped first.
 */
function resolveConstantReference(index: RubyDefIndex, reference: string): string | undefined {
  const ref = reference.replace(/^::/, '');
  const exact = index.constants.get(ref);
  if (exact) return exact;
  if (ref.includes('::')) return undefined;
  const candidates = index.constantsByBareName.get(ref);
  return candidates?.size === 1 ? [...candidates][0] : undefined;
}

/**
 * Ruby's constant lookup from ONE lexical scope outward: a rooted `::X` names the top-level
 * constant and nothing else; otherwise the enclosing scopes nearest-first (`A::B` → `A::B::X`,
 * then `A::X`), then top level. EXACT matches only — the unique-bare-name fallback lives in
 * `resolveConstantReference`, and each caller decides whether it may have it.
 */
function lookupLexicalConstant(index: RubyDefIndex, reference: string, scopeName?: string): string | undefined {
  if (reference.startsWith('::')) return index.constants.get(reference.slice(2));
  const parts = (scopeName ?? '').split('::').filter(Boolean);
  for (let i = parts.length; i > 0; i--) {
    const hit = index.constants.get(`${parts.slice(0, i).join('::')}::${reference}`);
    if (hit) return hit;
  }
  return index.constants.get(reference);
}

/**
 * One ancestry hop (`< Base`, `include M`) resolved in the DECLARING class's lexical context, the
 * way Ruby reads the constant where it is WRITTEN: `module N; class Child < Base` names `N::Base`
 * when the repo declares one. The bare written name used to go straight to `resolveConstantReference`,
 * which is exact-then-repo-wide, so a top-level `Base` won over the namespace's own.
 *
 * A rooted `::Base` stops at the top level — the whole point of writing it — and therefore never
 * reaches the unique-bare-name fallback the unrooted form keeps.
 */
function resolveAncestorReference(index: RubyDefIndex, written: string, declaringClass: string): string | undefined {
  if (written.startsWith('::')) return index.constants.get(written.slice(2));
  return lookupLexicalConstant(index, written, declaringClass) ?? resolveConstantReference(index, written);
}

/**
 * Curated Ruby/Kernel/Enumerable/ActiveRecord/Rails builtins. A call to one of these is
 * treated as external (no edge) UNLESS the repo also defines a method of that name —
 * mirrors the engine's `isLanguageBuiltinCall` intent. Keeps Tier 3 (unique-name) from
 * fabricating edges to language/stdlib methods that happen to be unique in-repo.
 */
const BUILTINS = new Set<string>([
  // Enumerable / Array / Hash
  'each',
  'each_with_index',
  'each_with_object',
  'each_pair',
  'each_slice',
  'map',
  'flat_map',
  'collect',
  'select',
  'filter',
  'reject',
  'find',
  'detect',
  'find_all',
  'reduce',
  'inject',
  'group_by',
  'partition',
  'sort',
  'sort_by',
  'min',
  'max',
  'min_by',
  'max_by',
  'sum',
  'count',
  'tally',
  'uniq',
  'flatten',
  'compact',
  'reverse',
  'zip',
  'take',
  'drop',
  'first',
  'last',
  'sample',
  'shuffle',
  'include?',
  'any?',
  'all?',
  'none?',
  'one?',
  'empty?',
  'push',
  'pop',
  'shift',
  'unshift',
  'concat',
  'join',
  'slice',
  'fetch',
  'dig',
  'keys',
  'values',
  'merge',
  'merge!',
  'key?',
  'has_key?',
  'value?',
  'delete',
  'clear',
  'index',
  'find_index',
  'pluck',
  // String
  'to_s',
  'to_a',
  'to_h',
  'to_i',
  'to_f',
  'to_sym',
  'to_json',
  'to_param',
  'gsub',
  'sub',
  'match',
  'match?',
  'scan',
  'split',
  'strip',
  'chomp',
  'chars',
  'bytes',
  'downcase',
  'upcase',
  'capitalize',
  'titleize',
  'length',
  'size',
  'start_with?',
  'end_with?',
  'include?',
  'present?',
  'blank?',
  'presence',
  'squish',
  // Kernel / Object
  'new',
  'nil?',
  'dup',
  'clone',
  'freeze',
  'frozen?',
  'tap',
  'then',
  'itself',
  'send',
  'public_send',
  '__send__',
  'respond_to?',
  'is_a?',
  'kind_of?',
  'instance_of?',
  'class',
  'name',
  'puts',
  'print',
  'p',
  'pp',
  'raise',
  'throw',
  'catch',
  'require',
  'require_relative',
  'load',
  'loop',
  'lambda',
  'proc',
  'block_given?',
  'yield',
  'format',
  'sprintf',
  'Integer',
  'Float',
  'String',
  'Array',
  'Hash',
  'rand',
  'sleep',
  'caller',
  'binding',
  'instance_variable_get',
  'instance_variable_set',
  'instance_variables',
  'define_method',
  'method',
  'methods',
  'attr_accessor',
  'attr_reader',
  'attr_writer',
  'private',
  'protected',
  'public',
  'module_function',
  // Numeric / range / control
  'times',
  'upto',
  'downto',
  'step',
  'round',
  'floor',
  'ceil',
  'abs',
  'zero?',
  'positive?',
  'negative?',
  'even?',
  'odd?',
  // ActiveRecord / Rails (read side that isn't a domain method)
  'where',
  'find_by',
  'find_each',
  'all',
  'order',
  'limit',
  'includes',
  'joins',
  'group',
  'having',
  'pluck',
  'exists?',
  'present?',
  'try',
  'reload',
  'save',
  'save!',
  'update',
  'update!',
  'create',
  'create!',
  'destroy',
  'transaction',
  'validates',
  'validate',
  'before_save',
  'after_save',
  'before_create',
  'after_create',
  'has_many',
  'has_one',
  'belongs_to',
  'has_and_belongs_to_many',
  'scope',
  'delegate',
  'enum',
]);

/** Classify a call's receiver from the CST (no types). */
function receiverInfo(call: TsNode): { kind: 'self' | 'constant' | 'var' | 'chain'; text?: string } {
  const recv = call.childForFieldName?.('receiver');
  if (!recv) return { kind: 'self' }; // bare command call
  const t = recv.type as string;
  if (t === 'self') return { kind: 'self' };
  if (t === 'constant' || t === 'scope_resolution') return { kind: 'constant', text: recv.text as string };
  if (t === 'identifier' || t === 'instance_variable' || t === 'class_variable' || t === 'global_variable') {
    return { kind: 'var', text: recv.text as string };
  }
  return { kind: 'chain', text: recv.text as string };
}

/**
 * Walk a class + its syntactic ancestry for a method by name; prefer singleton/instance
 * per the call. `viaAncestry` is false when the hit is on the class itself (direct), true
 * when it came from a superclass/mixin walk — so rb-self can tag the lower-confidence
 * ancestry hits distinctly (`visited.size > 1` ⇒ we recursed past the original class).
 *
 * `crossScope` decides whether a miss in the preferred map may fall through to the OTHER one, and
 * is per-tier rather than always-on. For a constant receiver (`Foo.bar`) it must be off: falling
 * through to the instance method `Foo#bar` names a def that call cannot reach — in Ruby such a
 * call is a gem class method, `method_missing`, or delegation, and binding it to the instance def
 * is a confident wrong answer.
 */
function resolveOnClass(
  index: RubyDefIndex,
  className: string,
  name: string,
  preferSingleton: boolean,
  crossScope: boolean,
  visited: Set<string> = new Set(),
): { id: string; viaAncestry: boolean } | undefined {
  if (visited.has(className)) return undefined;
  visited.add(className);
  const cm = index.methodsByClass.get(className);
  if (cm) {
    const first = preferSingleton ? cm.singleton : cm.instance;
    const second = preferSingleton ? cm.instance : cm.singleton;
    const hit = first.get(name) ?? (crossScope ? second.get(name) : undefined);
    if (hit) return { id: hit, viaAncestry: visited.size > 1 };
  }
  const anc = index.ancestry.get(className);
  if (anc) {
    // Ancestry is stored as WRITTEN, so each hop is resolved in the declaring class's lexical
    // context — nearest enclosing scope outward, then top level, then unique bare name.
    const mixinNames = anc.mixins.map((mx) => mx.name);
    for (const written of anc.superclass ? [anc.superclass, ...mixinNames] : mixinNames) {
      const ancestor = resolveAncestorReference(index, written, className);
      if (!ancestor) continue;
      const h = resolveOnClass(index, ancestor, name, preferSingleton, crossScope, visited);
      if (h) return h;
    }
  }
  return undefined;
}

/**
 * The instance method an object of `className` actually runs, in Ruby's METHOD RESOLUTION ORDER:
 *
 *   prepended modules (last `prepend` wins) → the class itself → included modules (last `include`
 *   wins) → the superclass, which contributes its own prepends/self/includes before ITS superclass.
 *
 * Each module is walked the same way, so a module that itself includes another is followed. An
 * `extend`ed module is NEVER walked: `extend M` installs M's instance methods as SINGLETON methods
 * of the class, so `Foo.new` cannot reach `M#initialize` — walking it through `resolveOnClass`
 * (which cannot tell the three directives apart) minted a wrong edge at the highest Ruby
 * confidence. Instance map only, for the same reason.
 *
 * Source order is insertion order, so each directive list is walked in REVERSE: the last `include`
 * sits nearest the class. `visited` makes a cyclic `include` (A includes B includes A) terminate.
 */
function resolveInstanceMethod(
  index: RubyDefIndex,
  className: string,
  name: string,
  visited: Set<string> = new Set(),
): { id: string } | undefined {
  if (visited.has(className)) return undefined;
  visited.add(className);
  const anc = index.ancestry.get(className);
  const walk = (written: string): { id: string } | undefined => {
    const ancestor = resolveAncestorReference(index, written, className);
    return ancestor ? resolveInstanceMethod(index, ancestor, name, visited) : undefined;
  };
  const written = (kind: RubyMixin['kind']): string[] =>
    (anc?.mixins ?? [])
      .filter((mx) => mx.kind === kind)
      .map((mx) => mx.name)
      .reverse();

  for (const p of written('prepend')) {
    const hit = walk(p);
    if (hit) return hit;
  }
  const own = index.methodsByClass.get(className)?.instance.get(name);
  if (own) return { id: own };
  for (const i of written('include')) {
    const hit = walk(i);
    if (hit) return hit;
  }
  return anc?.superclass ? walk(anc.superclass) : undefined;
}

/**
 * Whether the class's SINGLETON ancestry declares `new` itself — a `def self.new` on the class or
 * inherited from a superclass, or (the case a singleton-map walk cannot see) a module's INSTANCE
 * `new` installed by `extend Mod`. Such a `new` may allocate something else, memoize, or never run
 * `initialize` at all, so the site's callee is not statically decidable and the constructor rule
 * ABSTAINS. A module's own `def self.new` is NOT installed by `extend` and does not count.
 */
function hasUserDefinedNew(index: RubyDefIndex, className: string, visited: Set<string> = new Set()): boolean {
  if (visited.has(className)) return false;
  visited.add(className);
  if (index.methodsByClass.get(className)?.singleton.has('new')) return true;
  const anc = index.ancestry.get(className);
  if (!anc) return false;
  for (const mx of anc.mixins) {
    if (mx.kind !== 'extend') continue;
    const mod = resolveAncestorReference(index, mx.name, className);
    if (mod && resolveInstanceMethod(index, mod, 'new')) return true;
  }
  const sup = anc.superclass ? resolveAncestorReference(index, anc.superclass, className) : undefined;
  return sup ? hasUserDefinedNew(index, sup, visited) : false;
}

/**
 * The class a `.new` receiver names — EXACT qualified resolution only, in Ruby's own order: the
 * lexical scopes enclosing the call site from the nearest outward, then the reference as written
 * (top level). No bare-name fallback (unlike `resolveConstantReference`): `.new` is by far the
 * most common constant-receiver shape, so a gem `Bar.new` colliding with the repo's single
 * `Deep::Nested::Bar` would mint a wrong constructor edge on every such site. The singleton tier
 * keeps the fallback.
 *
 * A leading `::` is an explicit root-scope qualifier — it skips the lexical candidates outright,
 * which is the whole reason it is written.
 *
 * Known gap (follow-up): the compact form `class A::B` contributes its written segments as one
 * scope, so nesting introduced that way is not expanded here.
 */
function resolveCtorConstant(index: RubyDefIndex, reference: string, call: TsNode): string | undefined {
  const scope = nearestAncestor(call, CLASS_TYPES);
  return lookupLexicalConstant(index, reference, scope ? qualifiedClassName(scope) : undefined);
}

/**
 * The `FunctionNode` for an association reader (`has_many :employees` → `Company#employees`).
 * Id and `classId` are derived exactly like a `def`'s in the same class, so the node is stable
 * and lands in the model's `ClassNode.methods`; `synthesized` is what keeps it distinguishable
 * from a declared method (BR-1) — no parameters, no body, never an entrypoint.
 */
function associationReaderNode(
  reader: RubyAssociationReader,
  qualifiedClass: string,
  idGen: StableIdGenerator,
): FunctionNode {
  const id = idGen.methodId(reader.filePath, qualifiedClass, reader.name);
  return {
    id,
    versionedId: idGen.versionedId(id, `${reader.macro} :${reader.name}`),
    name: reader.name,
    kind: 'method',
    fileId: idGen.fileId(reader.filePath),
    location: { filePath: reader.filePath, startLine: reader.line, endLine: reader.line },
    isAsync: false,
    isGenerator: false,
    parameters: [],
    classId: idGen.classId(reader.filePath, qualifiedClass),
    isStatic: false,
    visibility: 'public',
    synthesized: 'ruby-association',
  };
}

/** Build the repo-wide def index (one walk per file). */
export async function indexRubyDefs(
  files: Array<{ relPath: string; source: string }>,
  idGen: StableIdGenerator,
  /**
   * Association readers per QUALIFIED model class (from the entity pass). Given, the index also
   * carries a synthesized reader node for every association no declared method already answers —
   * the callable target `self.employees` has in Rails but no `def` for. Omitted (no entity config)
   * → the index is defs only, exactly as before.
   */
  associationsByClass?: Map<string, RubyAssociationReader[]>,
): Promise<RubyDefIndex> {
  const byId = new Map<string, FunctionNode>();
  const byName = new Map<string, string[]>();
  const methodsByClass = new Map<string, ClassMethods>();
  const ancestry = new Map<string, RubyAncestry>();
  const constants = new Map<string, string>();
  const constantsByBareName = new Map<string, Set<string>>();
  const moduleNames = new Set<string>();
  const classesById = new Map<string, ClassNode>();
  const methodIdsByClassId = new Map<string, string[]>();

  const classMethods = (cls: string): ClassMethods => {
    let m = methodsByClass.get(cls);
    if (!m) {
      m = { instance: new Map(), singleton: new Map() };
      methodsByClass.set(cls, m);
    }
    return m;
  };
  const ancestryOf = (cls: string): RubyAncestry => {
    let a = ancestry.get(cls);
    if (!a) {
      a = { mixins: [] };
      ancestry.set(cls, a);
    }
    return a;
  };

  for (const { relPath, source } of files) {
    await withParsedRuby(source, (root) => {
      // classes/modules → constants + superclass
      for (const ct of CLASS_TYPES) {
        for (const cnode of root.descendantsOfType(ct) as TsNode[]) {
          const qualified = qualifiedClassName(cnode);
          if (!qualified) continue;
          // A class reopened in the same file collapses onto one node; first occurrence wins,
          // the same documented collapse the def index applies to redefinitions.
          const classNode = rubyClassNode(cnode, relPath, idGen);
          if (classNode && !classesById.has(classNode.id)) classesById.set(classNode.id, classNode);
          // The exact key is the qualified name itself, so a class reopened across files maps to
          // one entry and two same-named classes in different namespaces stay distinct. The bare
          // name is a SET, not a second exact key — that is where the ambiguity is decided.
          constants.set(qualified, qualified);
          if (cnode.type === 'module') moduleNames.add(qualified);
          const bare = demodulize(qualified);
          const claimants = constantsByBareName.get(bare) ?? new Set<string>();
          claimants.add(qualified);
          constantsByBareName.set(bare, claimants);
          const sup = cnode.childForFieldName?.('superclass')?.text as string | undefined;
          if (sup) ancestryOf(qualified).superclass = sup.replace(/^<\s*/, '').trim();
        }
      }

      // class-body include/extend/prepend/helpers → mixins
      for (const call of collectCalls(root)) {
        const m = methodName(call);
        const kind = m ? MIXIN_DIRECTIVES.get(m) : undefined;
        if (!kind) continue;
        if (nearestAncestor(call, DEF_TYPES)) continue; // a real call inside a method, not a mixin directive
        const cls = nearestAncestor(call, CLASS_TYPES);
        const clsName = cls ? qualifiedClassName(cls) : undefined;
        if (!clsName) continue;
        // EVERY constant ARGUMENT, not just the first: `include A, B` silently dropped B, so
        // B's methods were unreachable through the ancestry walk. Direct children of the
        // `arguments` node only — a descendant scan would take `Grape::DSL::Helpers` apart into
        // three phantom ancestors and would read constants out of a `helpers do … end` body.
        const argsNode = call.childForFieldName?.('arguments');
        if (!argsNode) continue;
        for (let i = 0; i < argsNode.childCount; i++) {
          const arg = argsNode.child(i);
          if (!arg || (arg.type !== 'constant' && arg.type !== 'scope_resolution')) continue;
          // A leading `::` is KEPT: it is what says "the top-level constant, not the one this
          // namespace also declares", and the ancestry hop is now resolved lexically
          // (`resolveAncestorReference`), which needs that distinction. Stripping it here made
          // `include ::Foo` inside `module N` reachable by `N::Foo`.
          const name = arg.text as string;
          if (name) ancestryOf(clsName).mixins.push({ kind, name });
        }
      }

      // defs → byId, byName, methodsByClass
      for (const dt of DEF_TYPES) {
        for (const def of root.descendantsOfType(dt) as TsNode[]) {
          const fn = defToFunctionNode(def, relPath, idGen);
          if (byId.has(fn.id)) continue;
          byId.set(fn.id, fn);
          const list = byName.get(fn.name) ?? [];
          list.push(fn.id);
          byName.set(fn.name, list);
          if (fn.classId) {
            const ids = methodIdsByClassId.get(fn.classId) ?? [];
            ids.push(fn.id);
            methodIdsByClassId.set(fn.classId, ids);
          }
          // A def outside any named class/module is indexed by id and name only — see
          // `containerNames` for why it gets no class bucket instead of a synthetic one.
          const clsName = containerNames(def).resolutionName;
          if (!clsName) continue;
          const cm = classMethods(clsName);
          (isSingletonDef(def) ? cm.singleton : cm.instance).set(fn.name, fn.id);
        }
      }
    });
  }

  const index: RubyDefIndex = {
    byId,
    byName,
    methodsByClass,
    ancestry,
    constants,
    constantsByBareName,
    moduleNames,
    classes: [],
  };

  // Association readers — minted AFTER every file's defs are indexed, so a `def` in a second
  // file reopening the class (a concern, a `Model.rb` split) still wins. First-wins, like defs.
  //
  // DECIDED before anything is written: a reader is a synthesized node, never a declaration, so
  // it must not suppress another one. Writing them as they were decided let `B < A` lose its own
  // `items` reader to A's — the ancestry walk found a node that exists only because this loop
  // had just put it there.
  const minted: Array<{ cls: string; fn: FunctionNode }> = [];
  // One reader per (class, association name). The node id carries the DECLARING FILE, so a class
  // reopened in two files that both declare `has_many :items` slipped past the id-keyed guard
  // below and minted two nodes for one method. First declaration wins, like a def.
  const mintedNames = new Set<string>();
  for (const [cls, readers] of associationsByClass ?? []) {
    for (const reader of readers) {
      // Declared anywhere in this class's ancestry (own def, superclass, included module) → the
      // real def is the callable target and no reader exists. Instance scope first, cross-scope
      // ON: a `def self.employees` in the ancestry is still a declaration of that name, and
      // suppressing the reader there is the precision-first answer.
      if (classMethods(cls).instance.has(reader.name)) continue;
      if (resolveOnClass(index, cls, reader.name, false, true)) continue;
      const key = `${cls}|${reader.name}`;
      if (mintedNames.has(key)) continue;
      mintedNames.add(key);
      minted.push({ cls, fn: associationReaderNode(reader, cls, idGen) });
    }
  }
  for (const { cls, fn } of minted) {
    if (byId.has(fn.id)) continue;
    byId.set(fn.id, fn);
    const list = byName.get(fn.name) ?? [];
    list.push(fn.id);
    byName.set(fn.name, list);
    if (fn.classId) {
      const ids = methodIdsByClassId.get(fn.classId) ?? [];
      ids.push(fn.id);
      methodIdsByClassId.set(fn.classId, ids);
    }
    classMethods(cls).instance.set(fn.name, fn.id);
  }

  for (const [classId, ids] of methodIdsByClassId) classesById.get(classId)?.methods.push(...ids);

  index.classes = [...classesById.values()];
  return index;
}

/**
 * The provenance tiers whose measured precision cleared the >=0.90 gate on real code
 * and are therefore SHIPPED as resolved graph edges:
 * rb-const (~0.95) + rb-self (~0.93). rb-unique (~0.55 — gem/stdlib var/chain receivers
 * + builtin-shadowing) is deliberately EXCLUDED; the Ruby substrate drops non-shippable edges
 * so they never reach the graph. Revisit when a receiver-type model raises rb-unique.
 */
/**
 * Per-site measurement of the tier-B walk (BR-2 / LIM-6 / LIM-7). Pure observation: filling it
 * never changes an emitted edge. `callSites` counts every site the walk ENUMERATES (inside a
 * `def`, with a method name) — including the built-in-list sites that emit no edge; sites with no
 * enclosing `def` and nameless sites stay uncounted by construction (LIM-6).
 */
export interface RubyCallSiteMeasurement {
  /** Enumerated sites. */
  callSites: number;
  /** Enumerated sites whose bare callee name is declared by no def in the repo (BR-1). */
  outOfScopeCalls: number;
  /**
   * In-scope enumerated sites the tier-B walk itself bound with an edge that SHIPS (LIM-7
   * clause i). Counted per site rather than per key: two sites can share one line, and a site
   * key (caller + path + line) cannot tell them apart without widening the emitted location.
   */
  resolvedByTierB: number;
  /**
   * Site key of every in-scope enumerated site tier B did NOT ship, MINUS every key tier B did
   * ship. A key is a caller + line, so several sites on one line collapse onto it: without the
   * subtraction, an unshipped site sharing a line with a shipped one matched clause (ii) against
   * tier B's OWN edge and was counted a second time (`Svc.new(x.y)` — the `.new` ships, the
   * chained `x.y` does not). Subtracting keeps the collapse in the only safe direction — a
   * scip-only resolution on such a line goes uncounted rather than inflating the rate.
   */
  inScopeSiteKeys: Set<string>;
}

/** Empty measurement, ready to be passed into `resolveRubyCalls`. */
export const emptyRubyCallSiteMeasurement = (): RubyCallSiteMeasurement => ({
  callSites: 0,
  outOfScopeCalls: 0,
  resolvedByTierB: 0,
  inScopeSiteKeys: new Set(),
});

/**
 * Identity of a call SITE across both producers: caller + normalised path + line. scip
 * normalises `./a.rb` → `a.rb` (ruby-scip.ts) while the tier-B walk uses the raw relative path,
 * so both are normalised here.
 */
export const rubySiteKey = (callerId: string, filePath: string, startLine: number): string =>
  `${callerId}|${filePath.replace(/^\.\//, '')}:${startLine}`;

/**
 * How many enumerated in-scope sites are RESOLVED (LIM-7 / D-8a): every site tier B itself
 * shipped (clause i, counted in the walk — so a site whose edge the union's (caller,callee)
 * de-duplication let a scip edge shadow still counts), plus the remaining in-scope sites for
 * which one of the given shipped sets carries an edge at the site key (clause ii). Callers pass
 * the final shipped union. A scip edge for a site the walk never enumerated matches no key and is
 * therefore shipped but uncounted.
 */
export function countResolvedRubySites(m: RubyCallSiteMeasurement, ...shippedSets: CallEdge[][]): number {
  const shipped = new Set<string>();
  for (const set of shippedSets)
    for (const e of set)
      if (e.location) shipped.add(rubySiteKey(e.callerId, e.location.filePath, e.location.startLine));
  let resolved = m.resolvedByTierB;
  for (const key of m.inScopeSiteKeys) if (shipped.has(key)) resolved++;
  return resolved;
}

export const SHIPPABLE_PROVENANCE = new Set<CallProvenance>(['rb-const', 'rb-self']);

/**
 * Resolve every in-`def` call site through the precision-ordered tiers (Tier 0 builtin
 * filter → rb-const → rb-self → rb-unique), first-match-wins, with a calleeTail name
 * check. Returns a CallEdge per site (resolved → calleeId+provenance; otherwise a bare
 * unresolved edge). The full set is for MEASUREMENT; the Ruby substrate ships only
 * SHIPPABLE_PROVENANCE.
 */
export async function resolveRubyCalls(
  files: Array<{ relPath: string; source: string }>,
  index: RubyDefIndex,
  idGen: StableIdGenerator,
  measurement?: RubyCallSiteMeasurement,
): Promise<CallEdge[]> {
  const edges: CallEdge[] = [];
  // Keys tier B shipped at, removed from `inScopeSiteKeys` once the walk is done: a line can
  // hold both a shipped and an unshipped site, and a key names the line, not the site.
  const shippedSiteKeys = new Set<string>();
  for (const { relPath, source } of files) {
    await withParsedRuby(source, (root) => {
      for (const call of collectCalls(root)) {
        const def = nearestAncestor(call, DEF_TYPES);
        if (!def) continue; // module-scope call site — skipped in v1
        const name = methodName(call);
        if (!name) continue;

        const recv = receiverInfo(call);
        // `Klass.new` is `Class#new` — there is no `new` def to find, so the def this site really
        // reaches is the class's `initialize`. Resolved up here because it decides the site's
        // EFFECTIVE callee name, which the builtin drop and the scope counters both key on.
        // A user-defined `new` anywhere in the singleton ancestry — including one installed by
        // `extend Mod` — makes the callee undecidable, so the rule abstains; a module is refused
        // (it cannot be instantiated), and a constant the repo does not declare stays external.
        const ctorClass =
          name === 'new' && recv.kind === 'constant' && recv.text
            ? resolveCtorConstant(index, recv.text, call)
            : undefined;
        const instantiable = ctorClass && !index.moduleNames.has(ctorClass) ? ctorClass : undefined;
        const ctorHit =
          instantiable && !hasUserDefinedNew(index, instantiable)
            ? resolveInstanceMethod(index, instantiable, 'initialize')
            : undefined;
        const calleeName = ctorHit ? 'initialize' : name;

        const inRepoDefs = index.byName.get(calleeName)?.length ?? 0;
        // Observation only — the enumerated site is counted BEFORE any drop or tier runs.
        if (measurement) {
          measurement.callSites++;
          // BR-1 keys scope on the repo declaring the callee. A `.new` on a class this repo
          // declares is in scope even when that class has no `initialize` to bind: the site is
          // unbound, not external, and counting it out would flatter the resolution rate.
          if (inRepoDefs === 0 && !instantiable) measurement.outOfScopeCalls++;
        }
        if (BUILTINS.has(name) && inRepoDefs === 0) continue; // external builtin — no edge

        const callerId = rubyMethodId(idGen, relPath, def);
        const startLine = call.startPosition.row + 1;
        const calleeExpression = (call.text as string).split('\n')[0].slice(0, 120);

        let calleeId: string | undefined;
        let provenance: CallProvenance | undefined;

        // Tier 1: constant receiver → class → SINGLETON method. The constant pins the class, so
        // an ancestry hit here is still sound → all rb-const. Singleton-only (`crossScope:
        // false`): `Foo.bar` cannot reach the instance method `Foo#bar`, so falling through to it
        // would mint a wrong edge at the highest Ruby confidence.
        if (recv.kind === 'constant' && recv.text) {
          const cls = resolveConstantReference(index, recv.text);
          const hit = cls ? resolveOnClass(index, cls, name, true, false) : undefined;
          if (hit) {
            calleeId = hit.id;
            provenance = 'rb-const';
          } else if (ctorHit) {
            calleeId = ctorHit.id;
            provenance = 'rb-const';
          }
        }
        // Tier 2: self/bare → enclosing class + ancestry. (Guard: only resolves to a real
        // in-repo def; a DSL macro / inherited-from-gem name simply stays unresolved.) A
        // direct same-class hit is rb-self; an ancestry-walk hit is the lower-confidence
        // rb-self-ancestry (gated separately — see SHIPPABLE_PROVENANCE). Cross-scope stays ON
        // here: `self.x` is written from inside the class, where the receiver's scope is what the
        // ENCLOSING def is, and both maps describe the same object.
        if (!calleeId && recv.kind === 'self') {
          const clsName = containerNames(def).resolutionName;
          const hit = clsName ? resolveOnClass(index, clsName, name, isSingletonDef(def), true) : undefined;
          if (hit) {
            calleeId = hit.id;
            provenance = hit.viaAncestry ? 'rb-self-ancestry' : 'rb-self';
          }
        }
        // Tier 3: globally unique method name → sole target. NOT for a constant receiver:
        // a constant names a specific type, so if it didn't resolve in rb-const it is
        // external (a gem/stdlib class — Time/I18n/Rails/Kaminari/…), and resolving by
        // unique name there fabricates an edge (`Time.current` → an in-repo `current`).
        // Restrict to self/bare/var/chain receivers, where the type is genuinely unknown.
        if (!calleeId && recv.kind !== 'constant') {
          const ids = index.byName.get(name);
          if (ids && ids.length === 1) {
            calleeId = ids[0];
            provenance = 'rb-unique';
          }
        }
        // Precision check (mirror TS calleeTail): resolved def's name must equal the call's.
        if (calleeId) {
          const target = index.byId.get(calleeId);
          if (!target || normName(target.name) !== normName(calleeName)) {
            calleeId = undefined;
            provenance = undefined;
          }
        }

        // Clause (i) of LIM-7, decided per SITE with exactly the Ruby substrate's shipping predicate:
        // this edge ships, so the site is resolved whatever the scip union later de-duplicates.
        // Only the sites tier B did not ship carry a key into clause (ii).
        if (measurement && inRepoDefs > 0) {
          const shipsFromTierB =
            calleeId !== undefined &&
            callerId !== calleeId &&
            provenance !== undefined &&
            SHIPPABLE_PROVENANCE.has(provenance);
          const key = rubySiteKey(callerId, relPath, startLine);
          if (shipsFromTierB) {
            measurement.resolvedByTierB++;
            shippedSiteKeys.add(key);
          } else measurement.inScopeSiteKeys.add(key);
        }

        edges.push({
          id: idGen.callEdgeId(callerId, calleeExpression, `${relPath}:${startLine}`),
          callerId,
          calleeId,
          provenance,
          calleeExpression,
          isMethodCall: recv.kind !== 'self',
          location: { filePath: relPath, startLine, endLine: call.endPosition.row + 1 },
        });
      }
    });
  }
  if (measurement) for (const key of shippedSiteKeys) measurement.inScopeSiteKeys.delete(key);
  return edges;
}
