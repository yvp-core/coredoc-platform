import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import {
  SHIPPABLE_PROVENANCE,
  collectRubyDefs,
  countResolvedRubySites,
  emptyRubyCallSiteMeasurement,
  indexRubyDefs,
  resolveRubyCalls,
} from './ruby-callgraph.js';
import { unionRubyCalls } from './ruby-scip.js';

const REL = 'a.rb';
const mkGen = () => new StableIdGenerator('/repo', 'repo');

/** Parse one inline source, build the index, resolve, return { edges, index, idGen }. */
async function run(source: string) {
  return runFiles({ [REL]: source });
}

/** Same, over several named files — the repo-wide indexes only misbehave across file boundaries. */
async function runFiles(sources: Record<string, string>) {
  const idGen = mkGen();
  const files = Object.entries(sources).map(([relPath, source]) => ({ relPath, source }));
  const index = await indexRubyDefs(files, idGen);
  const edges = await resolveRubyCalls(files, index, idGen);
  return { edges, index, idGen };
}

const edgeFor = (edges: Awaited<ReturnType<typeof run>>['edges'], exprIncludes: string) =>
  edges.find((e) => e.calleeExpression.includes(exprIncludes));

describe('collectRubyDefs — sourceCode', () => {
  it('captures the full def source on each FunctionNode (matching the TS structural path)', async () => {
    const idGen = mkGen();
    const source = `class Foo
  def greet(name)
    "hello #{name}"
  end
end`;
    const defs = await collectRubyDefs([{ relPath: REL, source }], idGen);
    const greet = defs.find((d) => d.name === 'greet');
    expect(greet?.sourceCode).toBe(`def greet(name)
    "hello #{name}"
  end`);
  });

  it('caps a pathologically large def body at 20000 chars (matching to-nodes.ts)', async () => {
    const idGen = mkGen();
    const body = '  x = 1\n'.repeat(5000); // ~40k chars of body
    const source = `def big\n${body}end`;
    const defs = await collectRubyDefs([{ relPath: REL, source }], idGen);
    const big = defs.find((d) => d.name === 'big');
    expect(big?.sourceCode?.length).toBe(20000);
  });
});

describe('resolveRubyCalls — tiers', () => {
  it('rb-const: a constant receiver resolves to the class (singleton) method', async () => {
    const { edges, idGen } = await run(`class Foo
  def self.bar; end
  def go; Foo.bar; end
end`);
    const e = edgeFor(edges, 'Foo.bar');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'Foo', 'self.bar'));
  });

  it('rb-unique: a globally-unique method name resolves via an ivar receiver', async () => {
    const { edges, idGen } = await run(`class A
  def uniquexyz; end
end
class B
  def go; @a.uniquexyz; end
end`);
    const e = edgeFor(edges, 'uniquexyz');
    expect(e?.provenance).toBe('rb-unique');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'A', 'uniquexyz'));
  });

  it('rb-self: a self call resolves to an enclosing-class method', async () => {
    const { edges, idGen } = await run(`class C
  def helper; end
  def run; self.helper; end
end`);
    const e = edgeFor(edges, 'self.helper');
    expect(e?.provenance).toBe('rb-self');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'C', 'helper'));
  });

  it('rb-self-ancestry: resolves through the syntactic superclass ancestry (lower-confidence, held)', async () => {
    const { edges, idGen } = await run(`class Base
  def shared; end
end
class Child < Base
  def run; self.shared; end
end`);
    const e = edgeFor(edges, 'self.shared');
    // Ancestry-walk hits are tagged distinctly so they can be gated out of the shipped
    // set (P3 measured ~0% precision on real code — see SHIPPABLE_PROVENANCE).
    expect(e?.provenance).toBe('rb-self-ancestry');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'Base', 'shared'));
  });

  it('singleton vs instance of the same name get DISTINCT ids and resolve correctly', async () => {
    const { edges, index, idGen } = await run(`class D
  def x; end
  class << self
    def x; end
  end
  def call_instance; self.x; end
end`);
    const instanceId = idGen.methodId(REL, 'D', 'x');
    const singletonId = idGen.methodId(REL, 'D', 'self.x');
    expect(instanceId).not.toBe(singletonId);
    expect(index.byId.has(instanceId)).toBe(true);
    expect(index.byId.has(singletonId)).toBe(true);
    // `self.x` inside an instance method resolves to the INSTANCE method, not the singleton.
    const e = edgeFor(edges, 'self.x');
    expect(e?.calleeId).toBe(instanceId);
  });

  it('KNOWN LIMITATION: a bare no-arg call (identifier node) is not collected → no edge', async () => {
    // tree-sitter-ruby parses `helper` (no args/parens) as an `identifier`, not a call —
    // so it is invisible to collectCalls. Resolving these needs local-variable scope
    // analysis (is `helper` a call or a local var?) — deferred (caps rb-self recall).
    const { edges } = await run(`class E
  def helper; end
  def run; helper; end
end`);
    expect(edges.some((e) => e.calleeExpression === 'helper')).toBe(false);
  });

  it('unresolvable: an ambiguous name on a var receiver yields no resolved edge', async () => {
    const { edges } = await run(`class P
  def ambig; end
end
class Q
  def ambig; end
end
class R
  def go; @thing.ambig; end
end`);
    const e = edgeFor(edges, '@thing.ambig');
    expect(e).toBeDefined();
    expect(e?.calleeId).toBeUndefined();
    expect(e?.provenance).toBeUndefined();
  });

  it('Tier 0: a builtin with no in-repo def produces no edge', async () => {
    const { edges } = await run(`class S
  def go; [1, 2].map; end
end`);
    expect(edgeFor(edges, '.map')).toBeUndefined();
  });
});

// The resolver's class-keyed indexes are REPO-WIDE. They used to key on the bare class name, so
// two namespaces declaring one name shared a bucket and the last file parsed silently won — a
// wrong callee emitted at rb-const/rb-self confidence, which reads to a consumer as fact.
describe('resolveRubyCalls — namespace identity', () => {
  const BILLING = `module Billing
  class Client
    def self.charge; end
  end
end`;
  const GITHUB = `module Github
  class Client
    def self.charge; end
  end
end`;

  it('a qualified receiver reaches ITS OWN namespace, not whichever file was parsed last', async () => {
    const { edges, idGen } = await runFiles({
      'billing.rb': BILLING,
      'github.rb': GITHUB,
      'callers.rb': `class Runner
  def bill; Billing::Client.charge; end
  def sync; Github::Client.charge; end
end`,
    });

    expect(edgeFor(edges, 'Billing::Client.charge')?.calleeId).toBe(
      idGen.methodId('billing.rb', 'Billing::Client', 'self.charge'),
    );
    expect(edgeFor(edges, 'Github::Client.charge')?.calleeId).toBe(
      idGen.methodId('github.rb', 'Github::Client', 'self.charge'),
    );
  });

  it('a BARE receiver two namespaces both claim abstains rather than picking one', async () => {
    const { edges } = await runFiles({
      'billing.rb': BILLING,
      'github.rb': GITHUB,
      'callers.rb': `class Runner
  def go; Client.charge; end
end`,
    });

    const e = edgeFor(edges, 'Client.charge');
    expect(e).toBeDefined();
    expect(e?.calleeId).toBeUndefined();
    expect(e?.provenance).toBeUndefined();
  });

  it('a BARE receiver with exactly one claimant still resolves (the fallback is gated, not gone)', async () => {
    const { edges, idGen } = await runFiles({
      'billing.rb': BILLING,
      'callers.rb': `class Runner
  def go; Client.charge; end
end`,
    });

    const e = edgeFor(edges, 'Client.charge');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId('billing.rb', 'Billing::Client', 'self.charge'));
  });

  it('a QUALIFIED receiver naming a namespace the repo does not declare stays unresolved', async () => {
    const { edges } = await runFiles({
      'billing.rb': BILLING,
      'callers.rb': `class Runner
  def go; Aws::Client.charge; end
end`,
    });

    // `Aws::Client` is a gem constant. Retrying on its last segment would bind it to
    // `Billing::Client` — repo-wide name-only matching emitted under rb-const.
    const e = edgeFor(edges, 'Aws::Client.charge');
    expect(e).toBeDefined();
    expect(e?.calleeId).toBeUndefined();
    expect(e?.provenance).toBeUndefined();
  });

  it('a top-level def does not become a resolution target for another file top-level def', async () => {
    const { edges } = await runFiles({
      'a.rb': 'def helper_alpha; end\ndef caller_alpha; self.helper_beta; end',
      'b.rb': 'def helper_beta; end',
    });

    // Both files' defs used to share one synthetic `'Object'` bucket — a container that names no
    // emitted ClassNode and no `classId`, pooling every top-level def in the repo.
    const e = edgeFor(edges, 'self.helper_beta');
    expect(e?.provenance).not.toBe('rb-self');
  });
});

// A constant receiver names the class OBJECT. Falling through to the instance method of the same
// name binds a def that call cannot reach: in Ruby such a call is a gem class method,
// `method_missing`, or delegation.
describe('resolveRubyCalls — constant receiver is singleton-only', () => {
  it('does not fall back to the instance method when the class declares no class method', async () => {
    const { edges } = await run(`class Mailer
  def deliver; end
end
class Runner
  def go; Mailer.deliver; end
end`);

    const e = edgeFor(edges, 'Mailer.deliver');
    expect(e).toBeDefined();
    expect(e?.calleeId).toBeUndefined();
    expect(e?.provenance).toBeUndefined();
  });

  it('still binds when the class method really exists', async () => {
    const { edges, idGen } = await run(`class Mailer
  def self.deliver; end
end
class Runner
  def go; Mailer.deliver; end
end`);

    const e = edgeFor(edges, 'Mailer.deliver');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'Mailer', 'self.deliver'));
  });
});

// `indexRubyDefs` documents "first occurrence wins" for a class reopened in one file. Nothing
// pinned it, so a rewrite could have flipped the collapse (two ClassNodes, or the later
// occurrence's superclass leaking onto the first) without a single test noticing.
describe('indexRubyDefs — same-file class reopening', () => {
  it('collapses both openings onto ONE class node, with every method bound to it', async () => {
    const { index, idGen } = await run(`class Base
  def inherited_thing; end
end

class Widget
  def alpha; end
end

class Widget < Base
  def beta; end
end`);

    const widgets = index.classes.filter((c) => c.name === 'Widget');
    expect(widgets).toHaveLength(1);

    const widgetId = idGen.classId(REL, 'Widget');
    expect(widgets[0].id).toBe(widgetId);
    expect(index.byId.get(idGen.methodId(REL, 'Widget', 'alpha'))?.classId).toBe(widgetId);
    expect(index.byId.get(idGen.methodId(REL, 'Widget', 'beta'))?.classId).toBe(widgetId);
    expect([...widgets[0].methods].sort()).toEqual(
      [idGen.methodId(REL, 'Widget', 'alpha'), idGen.methodId(REL, 'Widget', 'beta')].sort(),
    );
  });

  it('pins WHICH occurrence wins: the emitted node is the first, so the later superclass is dropped', async () => {
    const { index } = await run(`class Base
  def inherited_thing; end
end

class Widget
  def alpha; end
end

class Widget < Base
  def beta; end
end`);

    // Documented collapse, asserted either way so a change to it is a deliberate one: the FIRST
    // occurrence is the emitted node, and it carries no `extends` because it declared none.
    expect(index.classes.find((c) => c.name === 'Widget')?.extends).toBeUndefined();
    // The ancestry index is keyed separately and DOES see the reopening's superclass, so a
    // `self.` call still resolves through it — the two are not expected to agree.
    expect(index.ancestry.get('Widget')?.superclass).toBe('Base');
  });
});

describe('namespace identity — same file', () => {
  // The resolution indexes were qualified, but the STABLE IDS still hashed the
  // immediate bare class name. Two namespaced `Client.fetch` definitions in one
  // file therefore minted the same id: the second def was dropped by the by-id
  // de-dup, `Github::Client` got no method bucket at all, and its calls bound to
  // Billing's method at full confidence. The existing tests missed it only
  // because their namespaces sat in separate files, where `relPath` incidentally
  // separated the ids.
  const TWO_NAMESPACES = [
    'module Billing',
    '  class Client',
    '    def fetch; 1; end',
    '  end',
    'end',
    'module Github',
    '  class Client',
    '    def fetch; 2; end',
    '  end',
    'end',
  ].join('\n');

  it('mints a distinct id for each namespaced class and method in one file', async () => {
    const { index } = await runFiles({ 'app/clients.rb': TWO_NAMESPACES });

    expect([...index.byId.keys()].filter((id) => id.includes('fetch'))).toHaveLength(2);
    expect([...index.methodsByClass.keys()].sort()).toEqual(['Billing::Client', 'Github::Client']);
  });

  it('binds a qualified call to its own namespace, not the first one parsed', async () => {
    const { edges, index } = await runFiles({
      'app/clients.rb': TWO_NAMESPACES,
      'app/caller.rb': ['class Caller', '  def go', '    Github::Client.new.fetch', '  end', 'end'].join('\n'),
    });

    const githubFetch = [...index.byId.keys()].find((id) => id.includes('Github::Client.fetch'));
    expect(githubFetch).toBeDefined();

    const edge = edgeFor(edges, 'fetch');
    // Either it resolves to Github's method or it abstains — binding to Billing's
    // would be the wrong-target edge this test exists to prevent.
    if (edge?.calleeId) expect(edge.calleeId).toBe(githubFetch);
  });

  it('keeps ClassNode.name bare so search and exact-name lookup still work', async () => {
    const { index } = await runFiles({ 'app/clients.rb': TWO_NAMESPACES });

    const classes = index.classes.filter((c) => c.name === 'Client');
    expect(classes.map((c) => c.name)).toEqual(['Client', 'Client']);
    // …while their IDS carry the namespace, so they are two nodes, not one.
    expect(new Set(classes.map((c) => c.id)).size).toBe(2);
  });
});

describe('resolveRubyCalls — call-site measurement (BR-1/BR-2, LIM-6/LIM-7)', () => {
  /** Resolve with a measurement attached — the out-param is pure observation (BR-5). */
  async function measure(sources: Record<string, string>) {
    const idGen = mkGen();
    const files = Object.entries(sources).map(([relPath, source]) => ({ relPath, source }));
    const index = await indexRubyDefs(files, idGen);
    const m = emptyRubyCallSiteMeasurement();
    const edges = await resolveRubyCalls(files, index, idGen, m);
    return { edges, index, idGen, m };
  }

  it('counts enumerated sites with resolvedCalls + outOfScopeCalls <= callSites', async () => {
    const { edges, m } = await measure({
      'a.rb': `class Svc
  def run
    self.helper
    puts "hi"
    Other.ping
  end
  def helper; end
end
class Other
  def self.ping; end
end`,
    });
    const resolved = countResolvedRubySites(m, edges);
    expect(m.callSites).toBe(3);
    expect(resolved + m.outOfScopeCalls).toBeLessThanOrEqual(m.callSites);
    // every in-scope site is accounted for exactly once: shipped by tier B, or still keyed
    expect(m.resolvedByTierB + m.inScopeSiteKeys.size).toBe(m.callSites - m.outOfScopeCalls);
  });

  it('MUST NOT count a call site outside any def — module scope is uncounted by construction (LIM-6)', async () => {
    const { m } = await measure({
      'a.rb': `class Svc
  Other.ping

  def run
    Other.ping
  end
end
class Other
  def self.ping; end
end`,
    });

    // Two syntactic `Other.ping` sites, one of them in the class body: only the in-def one counts.
    expect(m.callSites).toBe(1);
  });

  it('counts a built-in-list name with no in-repo def in callSites and outOfScopeCalls though it emits no edge', async () => {
    const { edges, m } = await measure({
      'a.rb': `class Svc
  def run
    puts "hi"
  end
end`,
    });
    expect(edges).toHaveLength(0); // built-in site is dropped before any edge is built
    expect(m.callSites).toBe(1);
    expect(m.outOfScopeCalls).toBe(1);
    expect(m.resolvedByTierB + m.inScopeSiteKeys.size).toBe(0);
  });

  it('keeps a platform call IN scope when the repo declares a def of the same bare name (BR-1)', async () => {
    const { m } = await measure({
      'a.rb': `class Logger
  def puts(msg); end
end
class Svc
  def run
    puts "hi"
  end
end`,
    });
    expect(m.callSites).toBe(1);
    expect(m.outOfScopeCalls).toBe(0); // `puts` is declared in this repository
    expect(m.resolvedByTierB + m.inScopeSiteKeys.size).toBe(1);
  });

  it('counts two shipped sites on ONE line separately (a site key cannot tell them apart)', async () => {
    const { edges, m } = await measure({
      'a.rb': `class Svc
  def run
    self.helper; self.other
  end
  def helper; end
  def other; end
end`,
    });
    const tierB = edges.filter((e) => e.provenance === 'rb-self');
    expect(tierB).toHaveLength(2); // two shipped edges on the same line
    expect(m.resolvedByTierB).toBe(2); // …and two resolved sites, not one
    expect(countResolvedRubySites(m, tierB)).toBe(2);
  });

  it('leaves the counters untouched for a scip edge at a site the walk never enumerated (LIM-7)', async () => {
    const { edges, m } = await measure({
      'a.rb': `class Svc
  def run
    self.helper
  end
  def helper; end
end`,
    });
    const scipOnly = {
      id: 'scip-1',
      callerId: 'module-scope-caller',
      calleeId: 'x',
      calleeExpression: 'sym',
      isMethodCall: true,
      provenance: 'scip' as const,
      location: { filePath: './a.rb', startLine: 99, endLine: 99 },
    };
    const before = countResolvedRubySites(m, edges);
    expect(countResolvedRubySites(m, edges, [scipOnly])).toBe(before);
    expect(m.callSites).toBe(1);
  });

  it('keeps both tier-B sites of a pair resolved when a scip edge shadows one in the union (LIM-7)', async () => {
    const { edges, m } = await measure({
      'a.rb': `class Svc
  def run
    self.helper
    self.helper
  end
  def helper; end
end`,
    });
    const tierB = edges.filter((e) => e.calleeId !== undefined && e.provenance === 'rb-self');
    expect(tierB).toHaveLength(2);
    // scip binds the first site; unionRubyCalls drops BOTH tier-B edges (it keys on the pair).
    const scipEdge = { ...tierB[0], id: 'scip-1', provenance: 'scip' as const };
    const union = unionRubyCalls([scipEdge], tierB);
    expect(union).toHaveLength(1);
    expect(countResolvedRubySites(m, union)).toBe(2); // clause (i) rescues the shadowed site
  });
});

// `Klass.new` is `Class#new`, so no `def self.new` exists to bind to and 296 constructor sites on
// acme-web stayed unresolved. The constant still pins the class, so the def the site actually
// reaches is that class's `initialize` (D-6.1). Every emitting case below has a MUST-NOT twin.
describe('resolveRubyCalls — constant receiver `.new` binds the constructor (D-6.1)', () => {
  it('binds Foo.new to Foo#initialize under rb-const', async () => {
    const { edges, idGen } = await run(`class Foo
  def initialize; end
end
class Runner
  def go; Foo.new; end
end`);

    const e = edgeFor(edges, 'Foo.new');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'Foo', 'initialize'));
    expect(e?.calleeExpression.endsWith('.new')).toBe(true);
  });

  it('walks the ancestry: Sub.new binds to Base#initialize', async () => {
    const { edges, idGen } = await run(`class Base
  def initialize; end
end
class Sub < Base
end
class Runner
  def go; Sub.new; end
end`);

    const e = edgeFor(edges, 'Sub.new');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'Base', 'initialize'));
  });

  it('a user-defined `def self.new` still wins over initialize', async () => {
    const { edges, idGen } = await run(`class Foo
  def self.new; end
  def initialize; end
end
class Runner
  def go; Foo.new; end
end`);

    const e = edgeFor(edges, 'Foo.new');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'Foo', 'self.new'));
  });

  it('MUST NOT bind when the constant is not an in-repo class (gem/stdlib)', async () => {
    const { edges } = await run(`class Foo
  def initialize; end
end
class Runner
  def go
    Time.new
    Set.new
  end
end`);

    expect(edgeFor(edges, 'Time.new')).toBeUndefined();
    expect(edgeFor(edges, 'Set.new')).toBeUndefined();
  });

  it('MUST NOT bind when the in-repo class declares no initialize anywhere in its ancestry', async () => {
    const { edges } = await run(`class Base
  def run; end
end
class Foo < Base
  def work; end
end
class Runner
  def go; Foo.new; end
end`);

    expect(edgeFor(edges, 'Foo.new')).toBeUndefined();
  });

  it('MUST NOT bind a variable or chain receiver `.new`', async () => {
    const { edges } = await run(`class Foo
  def initialize; end
end
class Runner
  def go(foo)
    foo.new
    foo.bar.new
  end
end`);

    expect(edgeFor(edges, 'foo.new')).toBeUndefined();
    expect(edgeFor(edges, 'foo.bar.new')).toBeUndefined();
  });

  it('MUST NOT bind when the constant is a module (a module cannot be instantiated)', async () => {
    const { edges } = await run(`module Foo
  def initialize; end
end
class Runner
  def go; Foo.new; end
end`);

    expect(edgeFor(edges, 'Foo.new')).toBeUndefined();
  });

  it('MUST NOT bind through an `extend`ed module: extend installs singleton, not instance, methods', async () => {
    const { edges } = await run(`module H
  def initialize; end
end
class Foo
  extend H
end
class Runner
  def go; Foo.new; end
end`);

    expect(edgeFor(edges, 'Foo.new')).toBeUndefined();
  });

  it('binds through an `include`d module: include installs instance methods', async () => {
    const { edges, idGen } = await run(`module H
  def initialize; end
end
class Foo
  include H
end
class Runner
  def go; Foo.new; end
end`);

    const e = edgeFor(edges, 'Foo.new');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'H', 'initialize'));
  });

  it('MUST NOT bind a bare `Bar.new` to a same-named class in an unrelated namespace', async () => {
    const { edges } = await runFiles({
      'deep.rb': `module Deep
  module Nested
    class Bar
      def initialize; end
    end
  end
end`,
      'other.rb': `class Runner
  def go; Bar.new; end
end`,
    });

    expect(edgeFor(edges, 'Bar.new')).toBeUndefined();
  });

  it('binds `Bar.new` when the lexical scope qualifies it, and when it is written out in full', async () => {
    const { edges, idGen } = await runFiles({
      'deep.rb': `module Deep
  module Nested
    class Bar
      def initialize; end
    end
    class Runner
      def go; Bar.new; end
    end
  end
end`,
      'other.rb': `class Outsider
  def go; Deep::Nested::Bar.new; end
end`,
    });

    const target = idGen.methodId('deep.rb', 'Deep::Nested::Bar', 'initialize');
    const lexical = edges.find((e) => e.calleeExpression === 'Bar.new');
    const qualified = edgeFor(edges, 'Deep::Nested::Bar.new');
    expect(lexical?.provenance).toBe('rb-const');
    expect(lexical?.calleeId).toBe(target);
    expect(qualified?.provenance).toBe('rb-const');
    expect(qualified?.calleeId).toBe(target);
  });

  it('`::Bar.new` takes the top-level class, while a bare `Bar.new` in the same scope takes the nearer one', async () => {
    const { edges, idGen } = await run(`class Bar
  def initialize; end
end
module Deep
  class Bar
    def initialize; end
  end
  def self.f; ::Bar.new; end
  def self.g; Bar.new; end
end`);

    const rooted = edges.find((e) => e.calleeExpression === '::Bar.new');
    const bare = edges.find((e) => e.calleeExpression === 'Bar.new');
    expect(rooted?.provenance).toBe('rb-const');
    expect(rooted?.calleeId).toBe(idGen.methodId(REL, 'Bar', 'initialize'));
    expect(bare?.provenance).toBe('rb-const');
    expect(bare?.calleeId).toBe(idGen.methodId(REL, 'Deep::Bar', 'initialize'));
  });

  it('the lexically nearer constant wins over a same-named top-level one', async () => {
    const { edges, idGen } = await run(`class Error
  def initialize; end
end
module Api
  class Error
    def initialize; end
  end
  class C
    def go; Error.new; end
  end
end`);

    const e = edgeFor(edges, 'Error.new');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'Api::Error', 'initialize'));
  });

  it('counts a `.new` on an in-repo class with no initialize as in scope and unbound (BR-1)', async () => {
    const idGen = mkGen();
    const files = [
      {
        relPath: REL,
        source: `class Foo
  def work; end
end
class Runner
  def go; Foo.new; end
end`,
      },
    ];
    const index = await indexRubyDefs(files, idGen);
    const m = emptyRubyCallSiteMeasurement();
    const edges = await resolveRubyCalls(files, index, idGen, m);

    expect(edgeFor(edges, 'Foo.new')).toBeUndefined();
    expect(m.callSites).toBe(1);
    expect(m.outOfScopeCalls).toBe(0);
    expect(m.resolvedByTierB).toBe(0);
  });

  it('MRO: an included module beats the SUPERCLASS initialize (include sits nearer the class)', async () => {
    const { edges, idGen } = await run(`module M
  def initialize; end
end
class Base
  def initialize; end
end
class Sub < Base
  include M
end
class Runner
  def go; Sub.new; end
end`);

    const e = edgeFor(edges, 'Sub.new');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'M', 'initialize'));
  });

  it('MRO: a PREPENDED module beats the class’s own initialize', async () => {
    const { edges, idGen } = await run(`module P
  def initialize; end
end
class Sub
  prepend P
  def initialize; end
end
class Runner
  def go; Sub.new; end
end`);

    const e = edgeFor(edges, 'Sub.new');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'P', 'initialize'));
  });

  it('MRO: the LAST include wins over an earlier one', async () => {
    const { edges, idGen } = await run(`module First
  def initialize; end
end
module Second
  def initialize; end
end
class Sub
  include First
  include Second
end
class Runner
  def go; Sub.new; end
end`);

    expect(edgeFor(edges, 'Sub.new')?.calleeId).toBe(idGen.methodId(REL, 'Second', 'initialize'));
  });

  it('terminates on a cyclic include and still finds the initialize in the cycle', async () => {
    const { edges, idGen } = await run(`module A
  include B
end
module B
  include A
  def initialize; end
end
class Sub
  include A
end
class Runner
  def go; Sub.new; end
end`);

    expect(edgeFor(edges, 'Sub.new')?.calleeId).toBe(idGen.methodId(REL, 'B', 'initialize'));
  });

  it('MUST NOT bind through a cyclic include that declares no initialize at all', async () => {
    const { edges } = await run(`module A
  include B
end
module B
  include A
end
class Sub
  include A
end
class Runner
  def go; Sub.new; end
end`);

    expect(edgeFor(edges, 'Sub.new')).toBeUndefined();
  });

  it('MUST NOT bind when `extend Mod` installs a user `new` (a module’s INSTANCE method)', async () => {
    const { edges } = await run(`module Factory
  def new(*args); allocate; end
end
class C
  extend Factory
  def initialize; end
end
class Runner
  def go; C.new; end
end`);

    // The site is enumerated (the repo declares a `new`), but its callee is not decidable:
    // `Factory#new` may never run `initialize`. No RESOLVED edge.
    const e = edgeFor(edges, 'C.new');
    expect(e?.calleeId).toBeUndefined();
    expect(e?.provenance).toBeUndefined();
  });

  it('binds the same class WITHOUT the extend — the abstention is the extend’s doing', async () => {
    const { edges, idGen } = await run(`module Factory
  def new(*args); allocate; end
end
class C
  def initialize; end
end
class Runner
  def go; C.new; end
end`);

    const e = edgeFor(edges, 'C.new');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'C', 'initialize'));
  });

  it('resolves the SUPERCLASS in the declaring class’s lexical scope, not repo-wide', async () => {
    const { edges, idGen } = await run(`class Base
  def initialize; end
end
module N
  class Base
    def initialize; end
  end
  class Child < Base
  end
end
class Runner
  def go; N::Child.new; end
end`);

    const e = edgeFor(edges, 'N::Child.new');
    expect(e?.provenance).toBe('rb-const');
    expect(e?.calleeId).toBe(idGen.methodId(REL, 'N::Base', 'initialize'));
  });

  it('honours a ROOTED `< ::Base` written in the same namespace', async () => {
    const { edges, idGen } = await run(`class Base
  def initialize; end
end
module N
  class Base
    def initialize; end
  end
  class Child < ::Base
  end
end
class Runner
  def go; N::Child.new; end
end`);

    expect(edgeFor(edges, 'N::Child.new')?.calleeId).toBe(idGen.methodId(REL, 'Base', 'initialize'));
  });

  it('resolves an `include`d MIXIN in the declaring class’s lexical scope', async () => {
    const { edges, idGen } = await run(`module M
  def initialize; end
end
module N
  module M
    def initialize; end
  end
  class Child
    include M
  end
end
class Runner
  def go; N::Child.new; end
end`);

    expect(edgeFor(edges, 'N::Child.new')?.calleeId).toBe(idGen.methodId(REL, 'N::M', 'initialize'));
  });

  it('counts the bound `.new` site as resolved in the call-site measurement', async () => {
    const idGen = mkGen();
    const files = [
      {
        relPath: REL,
        source: `class Foo
  def initialize; end
end
class Runner
  def go; Foo.new; end
end`,
      },
    ];
    const index = await indexRubyDefs(files, idGen);
    const m = emptyRubyCallSiteMeasurement();
    const edges = await resolveRubyCalls(files, index, idGen, m);

    expect(m.callSites).toBe(1);
    expect(m.outOfScopeCalls).toBe(0);
    expect(m.resolvedByTierB).toBe(1);
    expect(countResolvedRubySites(m, edges)).toBe(1);
  });
});

// A site key is caller + line, so two call sites on ONE line share it. Clause (ii) used to match
// such an unshipped site against tier B's OWN edge on that line and count it a second time —
// 1784 "resolved" sites against 1356 shipped edges on acme-web.
describe('resolveRubyCalls — a line holding both a shipped and an unshipped site', () => {
  it('counts the line once, so resolvedByTierB (and clause ii) equals the shipped edge count', async () => {
    const idGen = mkGen();
    const files = [
      {
        relPath: REL,
        source: `class Svc
  def initialize(x); end
end
class Other
  def thing; end
end
class Runner
  def go(arg)
    Svc.new(arg.thing)
  end
end`,
      },
    ];
    const index = await indexRubyDefs(files, idGen);
    const m = emptyRubyCallSiteMeasurement();
    const edges = await resolveRubyCalls(files, index, idGen, m);
    const shipped = edges.filter(
      (e) =>
        e.calleeId !== undefined && e.callerId !== e.calleeId && e.provenance && SHIPPABLE_PROVENANCE.has(e.provenance),
    );

    // `Svc.new(...)` ships; `arg.thing` is in scope but resolves only to the unshippable rb-unique
    expect(shipped).toHaveLength(1);
    expect(m.resolvedByTierB).toBe(shipped.length);
    expect(countResolvedRubySites(m, shipped)).toBe(shipped.length);
  });
});

/**
 * Association readers (UC-1, BR-1, BR-2): a `has_many :employees` makes `employees` a callable
 * target on the model although no `def` exists, so `self.employees` inside the model binds. The
 * node is marked `synthesized` and is only minted where no declared method answers the name.
 */
describe('indexRubyDefs — association readers', () => {
  const assoc = (name: string, macro = 'has_many', filePath = 'app/models/company.rb', line = 2) => ({
    name,
    macro,
    filePath,
    line,
  });
  /** Index + resolve with an association map, the way parseRubyRepo wires the entity pass in. */
  async function runAssoc(
    sources: Record<string, string>,
    associations: Record<string, Array<ReturnType<typeof assoc>>>,
  ) {
    const idGen = mkGen();
    const files = Object.entries(sources).map(([relPath, source]) => ({ relPath, source }));
    const index = await indexRubyDefs(files, idGen, new Map(Object.entries(associations)));
    const measurement = emptyRubyCallSiteMeasurement();
    const edges = await resolveRubyCalls(files, index, idGen, measurement);
    return { edges, index, idGen, measurement };
  }

  const MODEL = 'app/models/company.rb';
  const withDef = (body: string) => `class Company < ApplicationRecord
  has_many :employees

${body}
end`;
  const CALLER = withDef(`  def headcount
    self.employees.size
  end`);

  it('mints a marked reader node for the association and binds the in-model self send', async () => {
    const { edges, index, idGen } = await runAssoc({ [MODEL]: CALLER }, { Company: [assoc('employees')] });

    const readerId = idGen.methodId(MODEL, 'Company', 'employees');
    const reader = index.byId.get(readerId);
    expect(reader?.synthesized).toBe('ruby-association');
    expect(reader?.kind).toBe('method');
    expect(reader?.name).toBe('employees');
    expect(reader?.parameters).toEqual([]);
    expect(reader?.classId).toBe(idGen.classId(MODEL, 'Company'));
    expect(reader?.location).toEqual({ filePath: MODEL, startLine: 2, endLine: 2 });
    // Linked to its model exactly like a def is.
    expect(index.classes.find((c) => c.name === 'Company')?.methods).toContain(readerId);

    const edge = edgeFor(edges, 'self.employees');
    expect(edge?.calleeId).toBe(readerId);
    expect(edge?.provenance).toBe('rb-self');
    expect(SHIPPABLE_PROVENANCE.has(edge?.provenance as never)).toBe(true);
  });

  it('counts the bound reader site as a resolved in-scope call site', async () => {
    const { edges, measurement } = await runAssoc({ [MODEL]: CALLER }, { Company: [assoc('employees')] });
    const shipped = edges.filter(
      (e) => e.calleeId && e.callerId !== e.calleeId && e.provenance && SHIPPABLE_PROVENANCE.has(e.provenance),
    );

    // Two enumerated sites on `self.employees.size`: the reader (in scope, resolved) and the
    // builtin `.size`, whose name no def declares — out of scope, exactly as before.
    expect(measurement.callSites).toBe(2);
    expect(measurement.outOfScopeCalls).toBe(1);
    expect(countResolvedRubySites(measurement, shipped)).toBe(1);
  });

  it('mints ONE reader when two files reopening the class declare the same association', async () => {
    const OTHER = 'app/models/company_part2.rb';
    const { index, idGen } = await runAssoc(
      {
        [MODEL]: `class Company < ApplicationRecord
  has_many :items
end`,
        [OTHER]: `class Company < ApplicationRecord
  has_many :items
end`,
      },
      { Company: [assoc('items'), assoc('items', 'has_many', OTHER, 2)] },
    );

    const synthesized = [...index.byId.values()].filter((f) => f.synthesized);
    // The node id carries the declaring FILE, so the second declaration used to mint a second
    // node for one method. The FIRST declaration wins, like the first def of a redefined method.
    expect(synthesized.map((f) => f.id)).toEqual([idGen.methodId(MODEL, 'Company', 'items')]);
    expect(synthesized[0]?.location.filePath).toBe(MODEL);
    expect(index.byName.get('items')).toHaveLength(1);
  });

  it('mints no reader when the class declares the method itself — the def is the target', async () => {
    const source = withDef(`  def employees
    []
  end

  def headcount
    self.employees.size
  end`);
    const { edges, index, idGen } = await runAssoc({ [MODEL]: source }, { Company: [assoc('employees')] });

    expect([...index.byId.values()].filter((f) => f.synthesized)).toEqual([]);
    expect(edgeFor(edges, 'self.employees')?.calleeId).toBe(idGen.methodId(MODEL, 'Company', 'employees'));
    expect(index.byName.get('employees')).toHaveLength(1);
  });

  it('mints no reader when a SECOND file reopens the class and declares the method', async () => {
    const { index } = await runAssoc(
      {
        [MODEL]: CALLER,
        'app/models/concerns/company_extra.rb': `class Company
  def employees
    []
  end
end`,
      },
      { Company: [assoc('employees')] },
    );

    expect([...index.byId.values()].filter((f) => f.synthesized)).toEqual([]);
  });

  it('mints no reader when the method is declared on the superclass or an included module', async () => {
    const superclass = await runAssoc(
      {
        [MODEL]: `class Company < Base
  has_many :employees
end`,
        'app/models/base.rb': `class Base
  def employees
    []
  end
end`,
      },
      { Company: [assoc('employees')] },
    );
    expect([...superclass.index.byId.values()].filter((f) => f.synthesized)).toEqual([]);

    const mixin = await runAssoc(
      {
        [MODEL]: `class Company < ApplicationRecord
  include Staffed
  has_many :employees
end`,
        'app/models/concerns/staffed.rb': `module Staffed
  def employees
    []
  end
end`,
      },
      { Company: [assoc('employees')] },
    );
    expect([...mixin.index.byId.values()].filter((f) => f.synthesized)).toEqual([]);
  });

  it('keys a namespaced model under its qualified name and leaves a top-level namesake untouched', async () => {
    const NESTED = 'app/models/billing/invoice.rb';
    const { edges, index, idGen } = await runAssoc(
      {
        [NESTED]: `module Billing
  class Invoice < ApplicationRecord
    has_many :lines

    def total
      self.lines.sum
    end
  end
end`,
        'app/models/invoice.rb': `class Invoice < ApplicationRecord
  def total
    0
  end
end`,
      },
      { 'Billing::Invoice': [assoc('lines', 'has_many', NESTED, 3)] },
    );

    const readerId = idGen.methodId(NESTED, 'Billing::Invoice', 'lines');
    expect(index.byId.get(readerId)?.synthesized).toBe('ruby-association');
    expect(edgeFor(edges, 'self.lines')?.calleeId).toBe(readerId);
    // The top-level Invoice gets nothing: the reader is keyed on the qualified name only.
    expect(index.methodsByClass.get('Invoice')?.instance.has('lines')).toBe(false);
  });

  it('does not bind a reader through a variable receiver (tier 3 is not shipped)', async () => {
    const { edges } = await runAssoc(
      {
        [MODEL]: withDef(`  def noop
  end`),
        'app/services/report.rb': `class Report
  def run(company)
    company.employees.size
  end
end`,
      },
      { Company: [assoc('employees')] },
    );

    // The variable receiver reaches the reader only through the unique-name tier, which is
    // NOT shippable — so no edge on this site reaches the graph (LIM-2).
    const edge = edgeFor(edges, 'company.employees');
    expect(edge?.provenance).toBe('rb-unique');
    expect(SHIPPABLE_PROVENANCE.has(edge?.provenance as never)).toBe(false);
  });

  it('does not bind a reader declared on a DIFFERENT model', async () => {
    const OTHER = 'app/models/agency.rb';
    const { edges, index, idGen } = await runAssoc(
      {
        [OTHER]: `class Agency < ApplicationRecord
  has_many :employees
end`,
        [MODEL]: `class Company < ApplicationRecord
  def headcount
    self.employees.size
  end
end`,
      },
      { Agency: [assoc('employees', 'has_many', OTHER, 2)] },
    );

    expect(index.byId.get(idGen.methodId(OTHER, 'Agency', 'employees'))?.synthesized).toBe('ruby-association');
    // Company declares no `employees`; the only node with that name belongs to Agency, and the
    // unique-name tier is not shippable — so the site stays unbound rather than crossing models.
    const edge = edgeFor(edges, 'self.employees');
    expect(edge?.provenance).not.toBe('rb-self');
    expect(index.methodsByClass.get('Company')?.instance.has('employees')).toBe(false);
  });

  it('mints a reader for a polymorphic belongs_to and names a class_name: association after the macro name', async () => {
    const { index, idGen } = await runAssoc(
      {
        [MODEL]: `class Company < ApplicationRecord
  belongs_to :owner, polymorphic: true
  has_many :items, class_name: 'LineItem'
end`,
      },
      { Company: [assoc('owner', 'belongs_to', MODEL, 2), assoc('items', 'has_many', MODEL, 3)] },
    );

    expect(index.byId.get(idGen.methodId(MODEL, 'Company', 'owner'))?.synthesized).toBe('ruby-association');
    const items = index.byId.get(idGen.methodId(MODEL, 'Company', 'items'));
    expect(items?.name).toBe('items');
    expect(index.byName.has('LineItem')).toBe(false);
  });

  it('gives a subclass its OWN reader when the superclass declares the same association', async () => {
    const SUB = 'app/models/invoice.rb';
    const { index, idGen } = await runAssoc(
      {
        'app/models/document.rb': `class Document < ApplicationRecord
  has_many :items
end`,
        [SUB]: `class Invoice < Document
  has_many :items
end`,
      },
      {
        Document: [assoc('items', 'has_many', 'app/models/document.rb', 2)],
        Invoice: [assoc('items', 'has_many', SUB, 2)],
      },
    );

    // A reader is synthesized, never declared: it must not suppress another one through the
    // ancestry walk, or the subclass silently loses the method it really has.
    expect(index.byId.get(idGen.methodId('app/models/document.rb', 'Document', 'items'))?.synthesized).toBe(
      'ruby-association',
    );
    expect(index.byId.get(idGen.methodId(SUB, 'Invoice', 'items'))?.synthesized).toBe('ruby-association');
  });

  it('mints nothing at all without an association map (no entity config)', async () => {
    const { index } = await run(CALLER);

    expect([...index.byId.values()].filter((f) => f.synthesized)).toEqual([]);
  });
});

/**
 * Mixin directives (UC-2, BR-3): `helpers <Const, …>` installs a module's instance methods the
 * way `include` does, and EVERY constant argument counts — `include A, B` used to drop B.
 */
describe('indexRubyDefs — mixin directives', () => {
  const HELPER_MODULES = {
    'app/api/helpers/auth.rb': `module AuthHelpers
  def current_user(params)
    nil
  end
end`,
    'app/api/helpers/pagination.rb': `module PaginationHelpers
  def page_size
    25
  end
end`,
  };

  it('records every constant argument of `helpers` and binds a bare send from a helpers-block def', async () => {
    const { edges, index, idGen } = await runFiles({
      ...HELPER_MODULES,
      'app/api/base.rb': `class API < Grape::API
  helpers AuthHelpers, PaginationHelpers

  helpers do
    def scoped(params)
      current_user(params)
    end
  end
end`,
    });

    expect(index.ancestry.get('API')?.mixins).toEqual([
      { kind: 'include', name: 'AuthHelpers' },
      { kind: 'include', name: 'PaginationHelpers' },
    ]);
    const edge = edgeFor(edges, 'current_user(params)');
    expect(edge?.calleeId).toBe(idGen.methodId('app/api/helpers/auth.rb', 'AuthHelpers', 'current_user'));
    // A mixin hit is an ANCESTRY hit, so the provenance is the held `rb-self-ancestry` tier —
    // the mixin is now indexed, but shipping that tier is a separate (non-goal) decision.
    expect(edge?.provenance).toBe('rb-self-ancestry');
  });

  it('records both constants of a multi-argument include', async () => {
    const { index } = await runFiles({
      ...HELPER_MODULES,
      'app/api/base.rb': `class API
  include AuthHelpers, PaginationHelpers
end`,
    });

    expect(index.ancestry.get('API')?.mixins).toEqual([
      { kind: 'include', name: 'AuthHelpers' },
      { kind: 'include', name: 'PaginationHelpers' },
    ]);
  });

  it('binds a constant-receiver call through the SECOND constant of a multi-argument include', async () => {
    const { edges, idGen } = await runFiles({
      'app/api/helpers/auth.rb': `module AuthHelpers
  def self.audit(x)
    x
  end
end`,
      'app/api/helpers/pagination.rb': `module PaginationHelpers
  def self.page_size
    25
  end
end`,
      'app/api/base.rb': `class API
  include AuthHelpers, PaginationHelpers

  def limit
    API.page_size
  end
end`,
    });

    // Previously the second constant was dropped, so this site had no ancestor to walk.
    const edge = edgeFor(edges, 'API.page_size');
    expect(edge?.calleeId).toBe(idGen.methodId('app/api/helpers/pagination.rb', 'PaginationHelpers', 'self.page_size'));
    expect(edge?.provenance).toBe('rb-const');
  });

  it('binds nothing when the mixin names a namespace member the repo does not declare', async () => {
    const { edges } = await runFiles({
      'app/models/concerns.rb': `module Concerns
  def audit(x)
    x
  end
end`,
      // A second declaration of the name, so the unique-name tier cannot bind the site either —
      // what is under test is the ancestry, and it must find nothing.
      'app/services/logger.rb': `class Logger
  def audit(x)
    x
  end
end`,
      'app/models/invoice.rb': `class Invoice
  include Concerns::Auditable

  def run(x)
    audit(x)
  end
end`,
    });

    // The old first-constant-DESCENDANT read recorded `Concerns` and bound `audit` to it.
    expect(edgeFor(edges, 'audit(x)')?.calleeId).toBeUndefined();
  });

  // The stored form used to be NORMALISED (the `::` stripped). It is kept now: the ancestry hop is
  // resolved in the declaring class's lexical scope, and `::` is exactly what says "the top-level
  // constant, not the one this namespace also declares".
  it('keeps a root-scope `::` qualifier on a mixin constant, and binds past the nearer namesake', async () => {
    const { edges, index, idGen } = await runFiles({
      'app/api/base.rb': `module AuthHelpers
  def initialize; end
end
module Api
  module AuthHelpers
    def initialize; end
  end
  class Base
    include ::AuthHelpers
  end
end
class Runner
  def go; Api::Base.new; end
end`,
    });

    expect(index.ancestry.get('Api::Base')?.mixins).toEqual([{ kind: 'include', name: '::AuthHelpers' }]);
    expect(edgeFor(edges, 'Api::Base.new')?.calleeId).toBe(
      idGen.methodId('app/api/base.rb', 'AuthHelpers', 'initialize'),
    );
  });

  it('adds no mixin for a bare `helpers do … end` block, even when its body names constants', async () => {
    const { index } = await runFiles({
      'app/api/base.rb': `class API
  helpers do
    def scoped
      AuthHelpers.build
    end
  end
end`,
    });

    expect(index.ancestry.get('API')?.mixins ?? []).toEqual([]);
  });

  it('ignores a `helpers` call inside a def — a call, not a class-body directive', async () => {
    const { index } = await runFiles({
      ...HELPER_MODULES,
      'app/api/base.rb': `class API
  def configure
    helpers AuthHelpers
  end
end`,
    });

    expect(index.ancestry.get('API')?.mixins ?? []).toEqual([]);
  });

  it('MUST NOT read a class-body call named after an Object.prototype member as a mixin', async () => {
    const { index } = await runFiles({
      ...HELPER_MODULES,
      'app/api/base.rb': `class API
  constructor AuthHelpers
  toString PaginationHelpers
end`,
    });

    // A plain-object directive table answered `constructor`/`toString` from the prototype chain,
    // so both calls injected their argument as an ancestor.
    expect(index.ancestry.get('API')?.mixins ?? []).toEqual([]);
  });

  it('binds nothing through a constant the repo does not declare', async () => {
    const { edges, index } = await runFiles({
      'app/api/base.rb': `class API
  helpers Grape::DSL::Helpers

  def scoped(params)
    current_user(params)
  end
end`,
    });

    // The qualified reference is kept WHOLE — taking it apart would invent three ancestors.
    expect(index.ancestry.get('API')?.mixins).toEqual([{ kind: 'include', name: 'Grape::DSL::Helpers' }]);
    expect(edgeFor(edges, 'current_user(params)')?.calleeId).toBeUndefined();
  });
});
