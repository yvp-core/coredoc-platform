import { describe, it, expect } from 'vitest';
import { COREDOC_TOOL_CLASSES, ToolAccess } from './tool-classes.js';
import { DISPATCHABLE_TOOL_NAMES, LOCAL_TOOL_NAMES } from './server.js';

describe('tool classes', () => {
  it('classifies every tool this server can register', () => {
    const unclassified = LOCAL_TOOL_NAMES.filter((name) => !(name in COREDOC_TOOL_CLASSES));
    expect(unclassified).toEqual([]);
  });

  it('lists every tool the dispatcher can serve', () => {
    // A handler wired up under a name that never reached LOCAL_TOOL_NAMES would
    // be dispatchable and unclassified at once.
    const undeclared = DISPATCHABLE_TOOL_NAMES.filter((name) => !LOCAL_TOOL_NAMES.includes(name));
    expect(undeclared).toEqual([]);
    expect(DISPATCHABLE_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it('declares get_intent_context and the gated tools as reads', () => {
    expect(COREDOC_TOOL_CLASSES.get_intent_context).toBe(ToolAccess.Read);
    expect(COREDOC_TOOL_CLASSES.run_cypher_query).toBe(ToolAccess.Read);
    expect(COREDOC_TOOL_CLASSES.semantic_search).toBe(ToolAccess.Read);
  });

  it('gives every byAction tool disjoint, non-empty action lists', () => {
    for (const [name, value] of Object.entries(COREDOC_TOOL_CLASSES)) {
      if (typeof value === 'string') {
        expect([ToolAccess.Read, ToolAccess.Write]).toContain(value);
        continue;
      }
      const reads = value.byAction[ToolAccess.Read];
      const writes = value.byAction[ToolAccess.Write];
      expect(reads.length + writes.length, name).toBeGreaterThan(0);
      expect(
        reads.filter((action) => writes.includes(action)),
        name,
      ).toEqual([]);
    }
  });
});
