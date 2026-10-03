/**
 * Contract: every tool description the local stdio server sends in tools/list
 * fits the client's description cap.
 *
 * Claude Code cuts a tool description at {@link TOOL_DESCRIPTION_CLIENT_CAP}
 * characters, and nothing tells the agent a tail was dropped — a refusal rule
 * past the cut simply stops existing for it. The cloud server's own tools are
 * held to the same cap in apps/server (tool-description-cap.test.ts).
 *
 * Measured on the REAL listing: `createServer()` under every gate combination
 * that changes what it lists (the env-gated `semantic_search`, and
 * `run_cypher_query` rendered per dialect), because a gated tool is exactly the
 * one a static scan of `TOOL_DESCRIPTIONS` would miss.
 */
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_DESCRIPTION_CLIENT_CAP } from './tool-descriptions.js';

interface ListedTool {
  name: string;
  description: string;
}

type ListHandler = (request: unknown) => Promise<{ tools: ListedTool[] }>;

/** The gate combinations that change the listing, labelled for failure messages. */
const CONFIGURATIONS: Array<[string, Record<string, string>]> = [
  ['sqlite', { COREDOC_DB_BACKEND: 'sqlite', ENABLE_SEMANTIC_SEARCH: 'true' }],
  ['ladybug', { COREDOC_DB_BACKEND: 'ladybug', ENABLE_SEMANTIC_SEARCH: 'true' }],
  ['neo4j', { COREDOC_DB_BACKEND: 'neo4j', COREDOC_ALLOW_CYPHER: 'true', ENABLE_SEMANTIC_SEARCH: 'true' }],
];

/** tools/list as a client sees it, with `env` in force from module load on. */
async function listTools(env: Record<string, string>): Promise<ListedTool[]> {
  // `semantic_search` is gated at module load, so the module must load under `env`.
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { createServer } = await import('./server.js');
  const server = createServer() as unknown as { _requestHandlers: Map<string, ListHandler> };
  const list = server._requestHandlers.get('tools/list');
  if (!list) throw new Error('createServer registered no tools/list handler');
  return (await list({ method: 'tools/list', params: {} })).tools;
}

async function allListings(): Promise<Array<{ label: string; tool: ListedTool }>> {
  const out: Array<{ label: string; tool: ListedTool }> = [];
  for (const [label, env] of CONFIGURATIONS) {
    for (const tool of await listTools(env)) out.push({ label, tool });
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('local MCP tool descriptions', () => {
  it(`fit the ${TOOL_DESCRIPTION_CLIENT_CAP}-character client cap in every configuration`, async () => {
    const listed = await allListings();
    // Guard against a vacuous pass: the gated tools must actually be measured.
    const names = new Set(listed.map(({ tool }) => tool.name));
    for (const name of ['explain', 'list_file_symbols', 'semantic_search', 'run_cypher_query']) {
      expect(names, `${name} was never listed`).toContain(name);
    }
    expect(listed.filter(({ tool }) => tool.name === 'run_cypher_query').map(({ label }) => label)).toEqual([
      'ladybug',
      'neo4j',
    ]);

    const over = listed
      .filter(({ tool }) => tool.description.length > TOOL_DESCRIPTION_CLIENT_CAP)
      .map(({ label, tool }) => `${tool.name} [${label}]: ${tool.description.length}`);
    expect(over, 'move field detail into the parameter .describe() and semantics into a skill reference').toEqual([]);
  });

  it('name only skill references that exist, in the canonical skill and the shipped plugin copy', async () => {
    const pointers = new Set<string>();
    for (const { tool } of await allListings()) {
      for (const match of tool.description.matchAll(/the ([a-z-]+) skill's (references\/[a-z-]+\.md)/g)) {
        pointers.add(`${match[1]}/${match[2]}`);
      }
    }
    expect(pointers.size, 'no description names a skill reference any more').toBeGreaterThan(0);
    for (const pointer of pointers) {
      expect(existsSync(new URL(`../../../skills/${pointer}`, import.meta.url)), pointer).toBe(true);
      expect(existsSync(new URL(`../../../plugins/coredoc/skills/${pointer}`, import.meta.url)), pointer).toBe(true);
    }
  });
});
