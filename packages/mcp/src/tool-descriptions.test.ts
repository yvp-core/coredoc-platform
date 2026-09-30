import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { NodeType, EdgeType } from '@coredoc/core/types';
import { TOOL_DESCRIPTIONS, buildCypherDescription } from './tool-descriptions.js';

// The skill ships as a small always-injected core plus reference files the agent loads on
// demand. Rules that must survive an isolated injection (where references may be
// unreachable) are asserted against the CORE; rules the agent can look up are asserted
// against the whole BUNDLE — a rule may move between files, but never disappear.
const SKILL_DIR = new URL('../../../skills/coredoc-mcp/', import.meta.url);
const COREDOC_MCP_CORE = readFileSync(new URL('SKILL.md', SKILL_DIR), 'utf8');
const COREDOC_MCP_SKILL = [
  COREDOC_MCP_CORE,
  ...readdirSync(new URL('references/', SKILL_DIR))
    .filter((f) => f.endsWith('.md'))
    .map((f) => readFileSync(new URL(`references/${f}`, SKILL_DIR), 'utf8')),
].join('\n');

describe('coredoc-mcp skill core', () => {
  it('stays small enough to inject whole (<= 6.75 KiB)', () => {
    // The core is spliced verbatim into the system prompt on every model call, so its size
    // is re-billed per turn — the cap is the point of the core/reference split. Raised 2026-09-15
    // for the DEC-4 gate sentence; the two verification sentences are the counterweight to the
    // gate and stay. Budget is 6912 B (6 KiB + 768), which also covers the repo-membership gate
    // (it prevents confidently answering about the WRONG project when the MCP is
    // workspace-scoped). Kept tight on purpose: a round 7 KiB would leave unpinned slack in a
    // per-turn-billed artifact, and that slack silently fills back up.
    expect(Buffer.byteLength(COREDOC_MCP_CORE, 'utf8')).toBeLessThanOrEqual(6912);
  });

  it('carries the MCP-first contract, anti-loop rule and basic-by-default rule standalone', () => {
    expect(COREDOC_MCP_CORE).toMatch(/MCP replaces discovery/i);
    expect(COREDOC_MCP_CORE).toMatch(/never run a repo-wide grep\/glob inventory/i);
    expect(COREDOC_MCP_CORE).toMatch(/do not re-issue overlapping discovery/i);
    expect(COREDOC_MCP_CORE).toMatch(/`basic` by default/);
    expect(COREDOC_MCP_CORE).toContain('detailLevel: "full"');
  });

  it('pins the affirmative-negative-claim rule in the bundle (issue-17 n=3 finding)', () => {
    // day-admin fp cell, n=3: the MCP arm twice AFFIRMED "no configVersion bump is needed"
    // while the source-reading baseline took the version-contract cluster clean both times.
    expect(COREDOC_MCP_SKILL).toMatch(/affirmative negative claim/i);
    expect(COREDOC_MCP_SKILL).toMatch(/not evidence\s+the bump is optional/i);
  });

  it('points at every reference file it moved detail into', () => {
    for (const ref of readdirSync(new URL('references/', SKILL_DIR)).filter((f) => f.endsWith('.md'))) {
      expect(COREDOC_MCP_CORE).toContain(ref);
    }
  });

  // A tool that exists but is not routed is a tool no agent calls. `get_intent_context`
  // shipped that way: permanent, local-only, a ~1.6 KB description authored at its
  // definition site in server.ts — and absent from every shipped skill doc, so the routing
  // table above never sent anyone to it. The registry tools are covered transitively by the
  // table, but a LOCALLY-defined tool has no registry entry to notice its absence, which is
  // exactly why this assertion enumerates them by hand.
  it('routes every locally-defined tool, not just the shared-registry ones', () => {
    // Tools defined in server.ts rather than in TOOL_DESCRIPTIONS (the registry the cloud
    // iterates). Absence from the registry is deliberate — it is what keeps them local —
    // so it must not also mean absence from the agent-facing docs.
    const locallyDefined = ['get_intent_context', 'run_cypher_query', 'semantic_search'];
    for (const name of locallyDefined) {
      expect(COREDOC_MCP_SKILL, `${name} is dispatchable but appears in no skill doc`).toContain(name);
    }
  });

  it('routes every shared-registry tool', () => {
    for (const name of Object.keys(TOOL_DESCRIPTIONS)) {
      expect(COREDOC_MCP_SKILL, `${name} is registered but appears in no skill doc`).toContain(name);
    }
  });
});

describe('graph-limitations guidance', () => {
  it('carries the blind-category and dispatch rules standalone in the core', () => {
    // An isolated agent must not read a green coverage report as "the graph saw everything":
    // both the declared-blind block and the any-density dispatch caveat ride the core.
    expect(COREDOC_MCP_CORE).toContain('get_extraction_coverage');
    expect(COREDOC_MCP_CORE).toMatch(/structurally blind categories/i);
    expect(COREDOC_MCP_CORE).toMatch(/statically resolvable dispatch only/i);
  });

  it('keeps the per-category shapes and recovery moves in the bundle', () => {
    expect(COREDOC_MCP_SKILL).toMatch(/test callbacks/i);
    expect(COREDOC_MCP_SKILL).toMatch(/proxies,\s+DI containers,\s+handler\s+registries or reflection/i);
    // The registry is declared server-side and retired as each gap closes, so the guide must
    // send the agent to the block the tool PRINTS rather than to a list frozen in prose.
    expect(COREDOC_MCP_SKILL).toMatch(/live list/i);
  });
});

describe('graph-schema reference', () => {
  const GRAPH_SCHEMA = readFileSync(new URL('references/graph-schema.md', SKILL_DIR), 'utf8');
  const workedExamples = GRAPH_SCHEMA.split('### Worked examples for real tasks')[1] ?? '';
  const exampleQueries = [...workedExamples.matchAll(/```cypher\n([\s\S]*?)```/g)].map((m) => m[1]!);

  it('lists the full node/edge vocabulary from the enums', () => {
    for (const type of Object.values(NodeType)) expect(GRAPH_SCHEMA).toContain(type);
    for (const type of Object.values(EdgeType)) expect(GRAPH_SCHEMA).toContain(type);
  });

  it('warns that a NODE properties/sourceCode mention is rejected, edge properties are not', () => {
    expect(GRAPH_SCHEMA).toMatch(/rejected before execution/i);
    expect(GRAPH_SCHEMA).toContain('r.properties');
  });

  it('works the hierarchy, enum-member and cross-repo-aggregate examples', () => {
    expect(exampleQueries.length).toBeGreaterThanOrEqual(3);
    expect(workedExamples).toContain('-[:IMPLEMENTS_INTERFACE]->');
    expect(workedExamples).toContain('-[:EXTENDS]->');
    // Value-position enum-member references live in the USES_TYPE edge payload.
    expect(workedExamples).toContain('-[r:USES_TYPE]->');
    expect(workedExamples).toContain('"member":"Locked"');
    expect(workedExamples).toContain('count(*)');
  });

  it('keeps every worked example in the Ladybug shape, scalar-projected and node-properties-free', () => {
    for (const query of exampleQueries) {
      expect(query).toContain('GraphNode');
      // `rows` rejects whole nodes/lists/maps — every RETURN item must be a projection.
      expect(query).not.toMatch(/RETURN\s+[A-Za-z_]+\s*(?:,|$)/m);
      // Only a relationship variable may carry `properties`; `r` is the one bound here.
      expect(query.replace(/\br\.properties\b/g, '')).not.toContain('.properties');
    }
  });
});

describe('cross-repo package impact guidance', () => {
  it.each([
    'find_dependents',
    'analyze_change_impact',
  ] as const)('%s requires project-wide scope to include external package importers', (tool) => {
    const description = TOOL_DESCRIPTIONS[tool];
    expect(description).toContain('project:<project-id>');
    expect(description).toMatch(/declaring repo/i);
    expect(description).toMatch(/excludes external importers/i);
  });

  it('pins package-impact routing and repo-qualified cross-repo citations in the skill', () => {
    // Scope token + citation form ride the core: both are needed in the very first call an
    // isolated agent makes.
    expect(COREDOC_MCP_CORE).toContain('project:<project-id>');
    expect(COREDOC_MCP_CORE).toContain('repo-name/repo-relative/path');
    // The "why" (declaring repo excludes external importers) is lookup detail.
    expect(COREDOC_MCP_SKILL).toMatch(/package\/npm exported symbol/i);
    expect(COREDOC_MCP_SKILL).toMatch(/declaring repo/i);
  });
});

describe('search_symbols description', () => {
  it('documents that default all includes exported variables', () => {
    const description = TOOL_DESCRIPTIONS.search_symbols;

    expect(description).toMatch(/default `type=all`[^.]*exported[^.]*variables/i);
    expect(description).not.toMatch(/variables[^.]*excluded from `all`/i);
    expect(COREDOC_MCP_SKILL).toMatch(/default `all`[^.]*exported[^.]*variables/i);
  });
});

describe('run_cypher_query descriptions', () => {
  it('has a surface-independent base entry (keyed like every shared tool)', () => {
    expect(TOOL_DESCRIPTIONS.run_cypher_query).toBeTypeOf('string');
    expect(TOOL_DESCRIPTIONS.run_cypher_query.length).toBeGreaterThan(0);
  });

  describe('base prose (both dialects inherit it)', () => {
    const description = buildCypherDescription({ dialects: ['ladybug'] });

    it('states the read-only, single-statement restriction', () => {
      expect(description).toMatch(/read-only/i);
      expect(description).toMatch(/single statement/i);
    });

    it('warns that properties is a JSON string', () => {
      expect(description).toMatch(/properties/);
      expect(description).toMatch(/JSON string/i);
    });

    it('states that Cypher is NOT repo-filtered within the selected graph', () => {
      expect(description).toMatch(/not repo-filtered/i);
    });

    it('documents the caps, the truncated flag and in-query pagination', () => {
      expect(description).toContain('200');
      expect(description).toContain('500');
      expect(description).toMatch(/truncated/);
      expect(description).toMatch(/SKIP/);
    });

    it('points at the graph-schema reference instead of dumping the vocabulary', () => {
      expect(description).toContain('references/graph-schema.md');
    });

    it('routes full-text search back to search_symbols', () => {
      expect(description).toContain('search_symbols');
    });

    it('names the source-in-graph caveat', () => {
      expect(description).toMatch(/source/i);
    });

    it('states source bodies are not stored, names queryable fields, and points at describe_db_schema', () => {
      expect(description).toMatch(/source bodies are not stored/i);
      expect(description).toContain('sourceCode');
      expect(description).toContain('startLine');
      expect(description).toContain('summary');
      expect(description).toContain('describe_db_schema');
    });

    it('lists the node and edge vocabulary compactly from the enums', () => {
      for (const type of Object.values(NodeType)) expect(description).toContain(type);
      for (const type of Object.values(EdgeType)) expect(description).toContain(type);
    });
  });

  it('renders the Ladybug query shape for the ladybug dialect', () => {
    const description = buildCypherDescription({ dialects: ['ladybug'] });
    expect(description).toContain('GraphNode');
    expect(description).toContain("n.type = 'function'");
    expect(description).not.toContain('CodeNode');
  });

  it('renders the label-based Neo4j query shape for the neo4j dialect', () => {
    const description = buildCypherDescription({ dialects: ['neo4j'] });
    expect(description).toContain('MATCH (n:function)');
    expect(description).toContain('CodeNode');
    expect(description).not.toContain('GraphNode');
  });

  it('composes one section per requested dialect', () => {
    const description = buildCypherDescription({ dialects: ['ladybug', 'neo4j'] });
    expect(description).toContain('GraphNode');
    expect(description).toContain('CodeNode');
  });
});
