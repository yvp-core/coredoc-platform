/**
 * `?toolset=intent` on an MCP connection URL limits that connection to the
 * intent tools, so an agent that only works with product intent does not carry
 * every graph tool description in its context.
 *
 * MCP-Nest's only per-request tool filter is the per-tool `@ToolGuards`, and a
 * failing guard answers `tools/call` with a generic "access denied". The filter
 * therefore wraps the two tool handlers on the MCP server MCP-Nest creates per
 * connection (its `serverMutator` hook): `tools/list` drops tools outside the
 * toolset after MCP-Nest's guards ran, and `tools/call` refuses them, naming
 * the toolset, before MCP-Nest's guards run. The tool guards (is intent on for
 * this actor) apply exactly as without a toolset.
 *
 * McpRewriteMiddleware parses the parameter and runs the rest of the request
 * inside {@link mcpToolsetContext}; the hook reads it when the server is
 * created: once per POST for stateless Streamable HTTP, and once per stream for
 * SSE, so every message of an SSE session keeps the toolset of its stream URL.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpOptions } from '@rekog/mcp-nest';

export enum McpToolset {
  Intent = 'intent',
}

export const TOOLSET_QUERY_PARAM = 'toolset';

export const TOOLSET_TOOLS: Readonly<Record<McpToolset, ReadonlySet<string>>> = {
  [McpToolset.Intent]: new Set([
    'get_intent_context',
    'intent_read',
    'intent_propose',
    'intent_review',
    'intent_tree',
    'intent_anchor',
    'intent_handoff',
    'intent_release',
    'intent_source_update',
    'submit_session_feedback',
  ]),
};

const VALID_TOOLSETS: readonly string[] = Object.values(McpToolset);

export type ToolsetParam = { ok: true; toolset: McpToolset | undefined } | { ok: false; error: string };

/** Reads the toolset from a request URL. Absent means every tool; anything but one valid value is an error. */
export function parseToolsetParam(url: string): ToolsetParam {
  const queryStart = url.indexOf('?');
  const values = queryStart === -1 ? [] : new URLSearchParams(url.slice(queryStart + 1)).getAll(TOOLSET_QUERY_PARAM);
  if (values.length === 0) return { ok: true, toolset: undefined };
  const [value] = values;
  if (values.length === 1 && VALID_TOOLSETS.includes(value!)) return { ok: true, toolset: value as McpToolset };
  return {
    ok: false,
    error:
      `Unknown ${TOOLSET_QUERY_PARAM} '${values.join(',')}'. Valid values: ${VALID_TOOLSETS.join(', ')}. ` +
      `Omit the ${TOOLSET_QUERY_PARAM} parameter to get every tool.`,
  };
}

export const mcpToolsetContext = new AsyncLocalStorage<McpToolset>();

type ServerMutator = NonNullable<McpOptions['serverMutator']>;

export const restrictToToolset: ServerMutator = (server) => {
  const toolset = mcpToolsetContext.getStore();
  if (toolset === undefined) return server;
  const allowed = TOOLSET_TOOLS[toolset];

  const protocol = server.server;
  const register = protocol.setRequestHandler.bind(protocol);
  protocol.setRequestHandler = (schema, handler) => {
    // The schema objects come from MCP-Nest's CommonJS copy of the SDK, so they
    // are matched by their method literal, not by identity with our imports.
    const method = (schema as { shape?: { method?: { value?: unknown } } }).shape?.method?.value;
    if (method === 'tools/list') {
      return register(schema, async (request, extra) => {
        const result = (await handler(request, extra)) as { tools: Array<{ name: string }> };
        return { ...result, tools: result.tools.filter((tool) => allowed.has(tool.name)) };
      });
    }
    if (method === 'tools/call') {
      return register(schema, (request, extra) => {
        const { name } = (request as { params: { name: string } }).params;
        if (!allowed.has(name)) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Tool '${name}' is not in the '${toolset}' toolset this connection selected with ` +
              `?${TOOLSET_QUERY_PARAM}=${toolset}. Reconnect without the ${TOOLSET_QUERY_PARAM} parameter to use it.`,
          );
        }
        return handler(request, extra);
      });
    }
    return register(schema, handler);
  };
  return server;
};
