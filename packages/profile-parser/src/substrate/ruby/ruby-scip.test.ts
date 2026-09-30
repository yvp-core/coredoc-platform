import { type CallEdge, StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import type { LoadedScip } from '../../facts/scip/decode.js';
import { indexRubyDefs } from './ruby-callgraph.js';
import { buildRubyMappingHooks, rubyMethodNameFromMoniker, scipRubyToCallEdges, unionRubyCalls } from './ruby-scip.js';

const REL = 'a.rb';
const mkGen = () => new StableIdGenerator('/repo', 'repo');
const PKG = 'scip-ruby gem t 0.0.1';

/** A single-line occurrence: range = [row0, startChar, endChar]. */
const occ = (symbol: string, row1: number, def = false) => ({
  symbol,
  symbolRoles: def ? 0x1 : 0,
  range: [row1 - 1, 2, 10],
});

describe('rubyMethodNameFromMoniker — real scip-ruby descriptor tails', () => {
  it('extracts the method tail across the namespace `#` separators', () => {
    expect(rubyMethodNameFromMoniker(`${PKG} Mobile#DefaultHelper#current_session().`)).toBe('current_session');
  });
  it('keeps predicate/bang/setter sigils on backtick-wrapped names', () => {
    expect(rubyMethodNameFromMoniker(`${PKG} Mobile#DefaultHelper#\`session_present?\`().`)).toBe('session_present?');
    expect(rubyMethodNameFromMoniker(`${PKG} Mobile#DefaultHelper#\`unauthorized!\`().`)).toBe('unauthorized!');
    expect(rubyMethodNameFromMoniker(`${PKG} Foo#\`name=\`().`)).toBe('name=');
  });
  it('resolves a singleton (class) method through the <Class:X> mangling', () => {
    expect(rubyMethodNameFromMoniker(`${PKG} \`<Class:AppLogger>\`#info().`)).toBe('info');
  });
  it('does NOT yield a method-looking name for an ivar term descriptor', () => {
    // `Foo#`@current_session`.` is an instance-variable read, not a method call.
    expect(rubyMethodNameFromMoniker(`${PKG} Foo#\`@current_session\`.`).startsWith('@')).toBe(true);
  });
});

const SRC = `class Foo
  def helper
    42
  end

  def run
    helper
    @cache
  end
end`;
// 1:class Foo  2:def helper  3:42  4:end  5:(blank)  6:def run  7:helper  8:@cache  9:end  10:end

async function fixture(docOccs: ReturnType<typeof occ>[]) {
  const idGen = mkGen();
  const index = await indexRubyDefs([{ relPath: REL, source: SRC }], idGen);
  const scip: LoadedScip = { projectRoot: '/repo', documents: [{ relativePath: REL, occurrences: docOccs }] };
  const hooks = buildRubyMappingHooks(scip, index);
  const edges = scipRubyToCallEdges(scip, hooks, idGen);
  const nodeIdByName = (name: string) => [...index.byId.values()].find((f) => f.name === name)?.id;
  return { edges, index, idGen, hooks, nodeIdByName };
}

describe('buildRubyMappingHooks + scipRubyToCallEdges', () => {
  it('resolves a bare self-send (the exact Tier-B gap) to a scip-provenance edge', async () => {
    const { edges, nodeIdByName } = await fixture([
      occ(`${PKG} Foo#helper().`, 2, true), // def helper @ line 2
      occ(`${PKG} Foo#run().`, 6, true), // def run @ line 6
      occ(`${PKG} Foo#helper().`, 7), // call `helper` inside run @ line 7
    ]);
    expect(edges).toHaveLength(1);
    const e = edges[0];
    expect(e.provenance).toBe('scip');
    expect(e.isMethodCall).toBe(true);
    expect(e.callerId).toBe(nodeIdByName('run'));
    expect(e.calleeId).toBe(nodeIdByName('helper'));
  });

  it('drops ivar reads, locals, externals (no in-repo def), and self/trivial', async () => {
    const { edges } = await fixture([
      occ(`${PKG} Foo#helper().`, 2, true),
      occ(`${PKG} Foo#run().`, 6, true),
      occ(`${PKG} Foo#\`@cache\`.`, 8), // ivar read — no def occ, not a method
      occ('local 1$deadbeef', 7), // local var
      occ(`scip-ruby gem rails 6.1 ActiveRecord#where().`, 7), // external gem method — no in-repo def
      occ(`${PKG} Foo#run().`, 6), // self-reference of run at its own def line → caller==callee, trivial
    ]);
    expect(edges).toHaveLength(0);
  });

  it('precision guard: a name that does not match the def-node at its location yields no edge', async () => {
    // helper-symbol whose DEFINITION occurrence is (wrongly) placed inside `run` (line 6).
    // symbolToNodeId resolves the location to `run`, but the moniker tail is `helper` → reject.
    const { edges } = await fixture([
      occ(`${PKG} Foo#helper().`, 6, true), // def occ mislocated into run's span
      occ(`${PKG} Foo#run().`, 2, true), // (whatever) — run def occ inside helper span
      occ(`${PKG} Foo#helper().`, 3), // reference to helper from line 3 (inside helper span)
    ]);
    // The only reference (helper@3) resolves caller=helper, callee→location line6=run, name 'run'!='helper' → dropped.
    expect(edges).toHaveLength(0);
  });
});

describe('unionRubyCalls', () => {
  const edge = (caller: string, callee: string, provenance: string): CallEdge => ({
    id: `${caller}-${callee}`,
    callerId: caller,
    calleeId: callee,
    calleeExpression: 'x',
    isMethodCall: true,
    provenance: provenance as CallEdge['provenance'],
    location: { filePath: 'a.rb', startLine: 1, endLine: 1 },
  });

  it('keeps every scip edge and supplements only Tier-B pairs scip did not cover', () => {
    const scip = [edge('A', 'B', 'scip'), edge('A', 'C', 'scip')];
    const tierB = [edge('A', 'B', 'rb-const'), edge('A', 'D', 'rb-self')]; // A>B covered, A>D new
    const out = unionRubyCalls(scip, tierB);
    expect(out).toHaveLength(3);
    expect(out.filter((e) => e.provenance === 'scip')).toHaveLength(2);
    // A>B is shadowed by scip (authoritative) — only the scip edge survives for that pair.
    const ab = out.filter((e) => e.callerId === 'A' && e.calleeId === 'B');
    expect(ab).toHaveLength(1);
    expect(ab[0].provenance).toBe('scip');
    // A>D is the supplement, keeping its Tier-B provenance.
    expect(out.find((e) => e.calleeId === 'D')?.provenance).toBe('rb-self');
  });

  it('returns scip edges unchanged when Tier-B is empty, and Tier-B unchanged when scip is empty', () => {
    const scip = [edge('A', 'B', 'scip')];
    const tierB = [edge('A', 'C', 'rb-const')];
    expect(unionRubyCalls(scip, [])).toEqual(scip);
    expect(unionRubyCalls([], tierB)).toEqual(tierB);
  });
});
