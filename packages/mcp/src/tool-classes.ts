/**
 * Read/write class of every Coredoc MCP tool — the single declared fact both
 * surfaces answer to.
 *
 * A workflow gate ("this stage closed on an observed Coredoc *read*") can only
 * be enforced if the class of each tool is a checked fact rather than a list
 * someone maintained by hand in a consuming plugin. So it is declared once here
 * and enforced at both registration sites:
 *   - local stdio server: `LOCAL_TOOL_NAMES` in `server.ts`, asserted by
 *     `tool-classes.test.ts` in this package;
 *   - hosted server: the `@Tool({ name })` decorators under
 *     `apps/server/src/mcp/tools/`, asserted by `tool-classes.test.ts` there.
 * A tool registered on either surface with no entry below fails that test.
 *
 * `scripts/gen-coredoc-tool-classes.mjs` renders this map into the fixture the
 * workflow plugin ships (`plugins/coredoc/resources/coredoc-tool-classes.json`);
 * a plugin test regenerates it and fails on drift.
 *
 * Class is about the graph/overlay effect of the call, not about permissions:
 * `read` answers questions, `write` changes recorded state. A tool whose effect
 * depends on its `action` argument declares `byAction` instead.
 */

export enum ToolAccess {
  Read = 'read',
  Write = 'write',
}

/** Per-action classes for a tool whose effect depends on its `action` argument. */
export interface ToolActionClasses {
  readonly [ToolAccess.Read]: readonly string[];
  readonly [ToolAccess.Write]: readonly string[];
}

export type ToolClass = ToolAccess | { readonly byAction: ToolActionClasses };

// The fixture's `version` (FIXTURE_VERSION in scripts/gen-coredoc-tool-classes.mjs)
// tracks the JSON SHAPE — a new key or changed semantics — not this map's contents:
// adding, removing or reclassifying a tool never bumps it.
export const COREDOC_TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
  // Graph and intent reads.
  analyze_change_impact: ToolAccess.Read,
  describe_db_schema: ToolAccess.Read,
  describe_repository: ToolAccess.Read,
  explain: ToolAccess.Read,
  find_callers: ToolAccess.Read,
  find_dependents: ToolAccess.Read,
  find_entity_usage: ToolAccess.Read,
  get_extraction_coverage: ToolAccess.Read,
  get_intent_context: ToolAccess.Read,
  intent_read: ToolAccess.Read,
  list_entrypoints: ToolAccess.Read,
  list_file_symbols: ToolAccess.Read,
  list_service_dependencies: ToolAccess.Read,
  // Read-only by construction: the repository is opened read-only and the
  // dialect refuses mutations.
  run_cypher_query: ToolAccess.Read,
  search_symbols: ToolAccess.Read,
  semantic_search: ToolAccess.Read,
  trace_cross_repo_call: ToolAccess.Read,

  // State-changing.
  intent_propose: ToolAccess.Write,
  intent_review: ToolAccess.Write,
  intent_source_update: ToolAccess.Write,
  intent_tree: ToolAccess.Write,
  submit_session_feedback: ToolAccess.Write,

  // `action` decides. Members mirror the action enums the hosted tools validate
  // against (`IntentAnchorAction` / the handoff envelope in intent.tools.ts /
  // `IntentReleaseToolSchema` in intent-release.operations.ts).
  intent_anchor: {
    byAction: {
      [ToolAccess.Read]: ['preview'],
      [ToolAccess.Write]: ['add', 'refresh', 'remove'],
    },
  },
  // `preview`/`list` return release evidence behind the read permission gate;
  // every other action is a reviewer-gated write.
  intent_release: {
    byAction: {
      [ToolAccess.Read]: ['preview', 'list'],
      [ToolAccess.Write]: ['record', 'rollback', 'plan', 'withdraw', 'reinstate'],
    },
  },
  // `save` authors a handoff, `get`/`list` only read one back.
  intent_handoff: {
    byAction: {
      [ToolAccess.Read]: ['get', 'list'],
      [ToolAccess.Write]: ['save'],
    },
  },
};

export function toolAnnotations(name: string) {
  return COREDOC_TOOL_CLASSES[name] === ToolAccess.Read
    ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    : { readOnlyHint: false, openWorldHint: false };
}
