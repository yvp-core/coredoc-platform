/**
 * Contract: every tool description this cloud surface sends in tools/list fits
 * the client's description cap.
 *
 * Claude Code cuts a tool description at `TOOL_DESCRIPTION_CLIENT_CAP`
 * characters, and nothing tells the agent a tail was dropped: the effectivity
 * rules of `get_intent_context` and the relation and condition rules of
 * `intent_tree` once sat past the cut. A description keeps what an agent needs
 * to call the tool correctly; field detail lives in the parameter `.describe()`
 * (the input schema is not cut) and longer semantics in a skill reference the
 * description names. The local stdio server is held to the same cap in
 * packages/mcp (tool-description-cap.test.ts).
 *
 * The descriptions come from the REAL composition, as `tool-classes.test.ts`
 * reads it: the providers `McpModule` declares, through their `@Tool()`
 * metadata (`mcp:tool`), whose `description` @rekog/mcp-nest lists verbatim.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import type { z } from 'zod';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { TOOL_DESCRIPTION_CLIENT_CAP } from '@coredoc/mcp';
import { McpModule } from '../mcp.module.js';
import { IntentTreeAction } from './intent.tools.js';

/** Set by @rekog/mcp-nest's `@Tool()` decorator; it exports no constant for it. */
const MCP_TOOL_METADATA_KEY = 'mcp:tool';

interface ToolMetadata {
  name: string;
  description: string;
  parameters?: z.ZodObject;
}

function cloudTools(): ToolMetadata[] {
  const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, McpModule) ?? []) as unknown[];
  const tools: ToolMetadata[] = [];
  for (const provider of providers) {
    const proto = (provider as { prototype?: object } | undefined)?.prototype;
    if (typeof provider !== 'function' || !proto) continue;
    for (const key of Object.getOwnPropertyNames(proto)) {
      const method = Object.getOwnPropertyDescriptor(proto, key)?.value;
      if (typeof method !== 'function') continue;
      const meta = Reflect.getMetadata(MCP_TOOL_METADATA_KEY, method) as ToolMetadata | undefined;
      if (typeof meta?.name === 'string') tools.push(meta);
    }
  }
  return tools;
}

describe('cloud MCP tool descriptions', () => {
  it(`fit the ${TOOL_DESCRIPTION_CLIENT_CAP}-character client cap`, () => {
    const tools = cloudTools();
    // Guard against a vacuous pass: an empty or truncated scan must not look like "all fit".
    const names = tools.map(({ name }) => name);
    for (const name of [
      'explain',
      'run_cypher_query',
      'get_intent_context',
      'intent_tree',
      'submit_session_feedback',
    ]) {
      expect(names, `${name} was never scanned`).toContain(name);
    }

    const over = tools
      .filter(({ description }) => description.length > TOOL_DESCRIPTION_CLIENT_CAP)
      .map(({ name, description }) => `${name}: ${description.length}`);
    expect(over, 'move field detail into the parameter .describe() and semantics into a skill reference').toEqual([]);
  });

  it('name only skill references that exist, in the canonical skill and the shipped plugin copy', () => {
    const pointers = new Set<string>();
    for (const { description } of cloudTools()) {
      for (const match of description.matchAll(/the ([a-z-]+) skill's (references\/[a-z-]+\.md)/g)) {
        pointers.add(`${match[1]}/${match[2]}`);
      }
    }
    // The intent semantics moved out of the descriptions must stay reachable.
    expect([...pointers].sort()).toEqual(
      expect.arrayContaining([
        'coredoc-mcp/references/graph-schema.md',
        'coredoc-mcp/references/workflows.md',
        'intent-capture/references/tree.md',
      ]),
    );
    for (const pointer of pointers) {
      expect(existsSync(new URL(`../../../../../skills/${pointer}`, import.meta.url)), pointer).toBe(true);
      expect(existsSync(new URL(`../../../../../plugins/coredoc/skills/${pointer}`, import.meta.url)), pointer).toBe(
        true,
      );
    }
  });

  it("lists every intent_tree action's body in its request parameter, now that the description does not", () => {
    const tree = cloudTools().find(({ name }) => name === 'intent_tree');
    const request = tree?.parameters?.shape.request?.description ?? '';
    for (const action of Object.values(IntentTreeAction)) {
      expect(request, `request does not list ${action}`).toContain(`${action} {`);
    }
  });
});
