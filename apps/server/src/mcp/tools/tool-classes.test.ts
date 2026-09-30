/**
 * Every tool this cloud surface registers must have a declared read/write class
 * in `@coredoc/mcp`'s `COREDOC_TOOL_CLASSES` — the fact the workflow gates and
 * the shipped `coredoc-tool-classes.json` fixture are built on — and no class
 * may outlive the tool it describes.
 *
 * The names come from the REAL composition: the providers `McpModule` declares,
 * read back through their `@Tool()` decorator metadata (`mcp:tool`, set by
 * @rekog/mcp-nest). A tool class that is never provided contributes nothing
 * here, and a newly provided one fails until it is classified.
 */
import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { COREDOC_TOOL_CLASSES, LOCAL_TOOL_NAMES, ToolAccess } from '@coredoc/mcp';
import type { ToolClass } from '@coredoc/mcp';
import { McpModule } from '../mcp.module.js';
import { IntentAnchorAction } from './intent.tools.js';
import { IntentReleaseToolSchema } from '../../modules/intent/intent-release.operations.js';
import { IntentHandoffToolSchema } from '../../modules/intent/intent-handoff.operations.js';

/** Set by @rekog/mcp-nest's `@Tool()` decorator; it exports no constant for it. */
const MCP_TOOL_METADATA_KEY = 'mcp:tool';

/**
 * The real action set each `byAction` tool validates against, so a new action
 * fails this suite until it is classified read or write.
 */
const REAL_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  intent_anchor: Object.values(IntentAnchorAction),
  intent_release: IntentReleaseToolSchema.shape.action.options,
  intent_handoff: IntentHandoffToolSchema.shape.action.options,
};

type ByActionClass = Exclude<ToolClass, ToolAccess>;

function byActionEntries(): [string, ByActionClass][] {
  return Object.entries(COREDOC_TOOL_CLASSES).flatMap(([name, value]) =>
    typeof value === 'object' ? [[name, value] as [string, ByActionClass]] : [],
  );
}

function cloudTools(): Array<{ name: string; annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } }> {
  const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, McpModule) ?? []) as unknown[];
  const tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } }> = [];
  for (const provider of providers) {
    const proto = (provider as { prototype?: object } | undefined)?.prototype;
    if (typeof provider !== 'function' || !proto) continue;
    for (const key of Object.getOwnPropertyNames(proto)) {
      const method = Object.getOwnPropertyDescriptor(proto, key)?.value;
      if (typeof method !== 'function') continue;
      const meta = Reflect.getMetadata(MCP_TOOL_METADATA_KEY, method) as
        | { name: string; annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } }
        | undefined;
      if (typeof meta?.name === 'string') tools.push(meta);
    }
  }
  return tools;
}

function cloudToolNames(): string[] {
  return [...new Set(cloudTools().map(({ name }) => name))].sort();
}

describe('cloud tool classes', () => {
  it('advertises read-only effects only for tools whose every action is a read', () => {
    const tools = cloudTools();
    expect(tools.map(({ name }) => name)).toContain('get_intent_context');
    expect(tools.map(({ name }) => name)).toContain('intent_handoff');
    for (const { name, annotations } of tools) {
      expect(annotations?.readOnlyHint, name).toBe(COREDOC_TOOL_CLASSES[name] === ToolAccess.Read);
      expect(annotations?.openWorldHint, name).toBe(false);
    }
  });

  it('classifies every registered @Tool', () => {
    const names = cloudToolNames();
    // Guard against a vacuous pass: an empty or truncated scan must not look
    // like "everything is classified".
    expect(names).toContain('explain');
    expect(names).toContain('intent_handoff');
    expect(names).toContain('submit_session_feedback');
    const unclassified = names.filter((name) => !(name in COREDOC_TOOL_CLASSES));
    expect(unclassified).toEqual([]);
  });

  it('classifies every action each byAction tool accepts', () => {
    const entries = byActionEntries();
    // Guard against a vacuous pass if the map ever loses its byAction tools.
    expect(entries.map(([name]) => name).sort()).toEqual(Object.keys(REAL_ACTIONS).sort());
    for (const [name, value] of entries) {
      const classified = [...value.byAction[ToolAccess.Read], ...value.byAction[ToolAccess.Write]];
      expect(new Set(classified).size, `${name} classifies an action twice`).toBe(classified.length);
      expect(classified.sort(), `${name} action coverage`).toEqual([...REAL_ACTIONS[name]].sort());
    }
  });

  it('keeps no class for a tool neither surface registers', () => {
    const registered = new Set([...LOCAL_TOOL_NAMES, ...cloudToolNames()]);
    const stale = Object.keys(COREDOC_TOOL_CLASSES).filter((name) => !registered.has(name));
    expect(stale).toEqual([]);
  });
});
