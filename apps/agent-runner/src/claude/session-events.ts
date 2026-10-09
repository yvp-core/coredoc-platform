/**
 * SDK messages to run-page events. Started from a copy of desktop's mapping
 * (apps/desktop/src/main/agent-run/claude-adapter.ts); desktop keeps its own.
 *
 * The agent's activity is reported as structured events: each tool call is
 * held until its result arrives and then reported once, with what it acted on
 * and a summary of its result, so the run page needs no parsing. Credentials
 * are masked by the runner on the way out, like every other event.
 */
import { relative, isAbsolute } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  AGENT_TODO_STATUSES,
  MAX_AGENT_MESSAGE_CHARS,
  MAX_TOOL_ERROR_OUTPUT_CHARS,
  MAX_TOOL_INTENT_IDS,
  MAX_TOOL_SUMMARY_CHARS,
  MAX_TOOL_TARGET_CHARS,
  type RunnerEvent,
} from '@coredoc/core/agent-runner';
import { RUN_CONTROL_SERVER } from './run-control.js';

type ToolEvent = Extract<RunnerEvent, { type: 'tool' }>;

/** Truncate a value to a compact one-line summary. */
function summarize(value: unknown, max = 160): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const oneLine = (s ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }
        return JSON.stringify(item) ?? '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(value) ?? '';
}

function parseTodos(input: Record<string, unknown>): Extract<RunnerEvent, { type: 'todos' }>['items'] {
  let raw = input.todos as unknown;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).map((todo) => {
    const item = (todo ?? {}) as Record<string, unknown>;
    const status = String(item.status ?? '');
    return {
      text: String(item.content ?? item.task ?? item.text ?? '').slice(0, 2_000),
      status: (AGENT_TODO_STATUSES as readonly string[]).includes(status)
        ? (status as (typeof AGENT_TODO_STATUSES)[number])
        : 'pending',
    };
  });
}

/** `mcp__<server>__<tool>`; server names may themselves contain underscores, tool names do not start with one. */
function mcpName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__([^_].*)$/.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : null;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? '';
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

interface PendingTool {
  name: string;
  input: Record<string, unknown>;
}

/** Turns one session's SDK messages into run-page events; one instance per session invocation. */
export class SessionEvents {
  private readonly pending = new Map<string, PendingTool>();
  private cwd: string | null = null;

  /** The events one SDK message produces (the result's `done` event is built by the executor). */
  eventsFor(message: SDKMessage): RunnerEvent[] {
    const events: RunnerEvent[] = [];
    switch (message.type) {
      case 'assistant':
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text') {
            const text = block.text.trim();
            if (text) events.push({ type: 'message', text: clip(text, MAX_AGENT_MESSAGE_CHARS) });
          } else if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>;
            if (block.name === 'TodoWrite') events.push({ type: 'todos', items: parseTodos(input) });
            else this.pending.set(block.id, { name: block.name, input });
          }
        }
        break;
      case 'user': {
        const content = message.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'tool_result')
            continue;
          const result = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
          const call = result.tool_use_id ? this.pending.get(result.tool_use_id) : undefined;
          if (!call) continue;
          this.pending.delete(result.tool_use_id!);
          events.push(...this.completed(call, toolResultText(result.content), result.is_error === true));
        }
        break;
      }
      case 'system':
        if (message.subtype === 'init') {
          this.cwd = typeof message.cwd === 'string' ? message.cwd : null;
          events.push({ type: 'raw', text: `[init] model=${message.model ?? 'unknown'}` });
        }
        break;
      default:
        break;
    }
    return events;
  }

  /** Tool calls the session ended without answering, reported with no result. */
  flush(): RunnerEvent[] {
    const events = [...this.pending.values()].map((call) => ({ ...this.toolEvent(call), summary: 'no result' }));
    this.pending.clear();
    return events;
  }

  private completed(call: PendingTool, output: string, isError: boolean): RunnerEvent[] {
    if (call.name === 'Skill' && !isError) {
      const skill = str(call.input.skill);
      if (skill) return [{ type: 'skill', name: clip(skill, 200) }];
    }
    const event: ToolEvent = { ...this.toolEvent(call), isError };
    const summary = isError ? summarize(firstLine(output), MAX_TOOL_SUMMARY_CHARS) : this.resultSummary(call, output);
    if (summary) event.summary = summary;
    if (isError && output.trim()) event.errorOutput = clip(output.trim(), MAX_TOOL_ERROR_OUTPUT_CHARS);
    const mcp = mcpName(call.name);
    const intentIds = !isError && mcp?.server === COREDOC_SERVER ? intentIdsOf(mcp.tool, output) : [];
    if (intentIds.length) event.intentIds = intentIds;
    const events: RunnerEvent[] = [event];
    if (!isError && mcp?.server === RUN_CONTROL_SERVER && mcp.tool === 'submit_result') {
      events.push(resultEvent(call.input));
    }
    return events;
  }

  private toolEvent(call: PendingTool): ToolEvent {
    const mcp = mcpName(call.name);
    const event: ToolEvent = { type: 'tool', name: clip(mcp?.tool ?? call.name, 200), isError: false };
    if (mcp) event.server = clip(mcp.server, 200);
    const target = this.target(call);
    if (target) event.target = target;
    return event;
  }

  /** What a call acted on: a path relative to the working directory, a command's first line, a query. */
  private target(call: PendingTool): string | null {
    const { input } = call;
    const path = str(input.file_path) ?? str(input.notebook_path);
    if (path) return clip(this.relativePath(path), MAX_TOOL_TARGET_CHARS);
    const command = str(input.command);
    if (command) return summarize(firstLine(command), MAX_TOOL_TARGET_CHARS);
    const named =
      str(input.pattern) ?? str(input.url) ?? str(input.query) ?? str(input.description) ?? str(input.skill);
    if (named && !mcpName(call.name)) return summarize(named, MAX_TOOL_TARGET_CHARS);
    // MCP tools and anything else: the input's plain values, in order.
    const values = Object.values(input).filter((value): value is string | number | boolean =>
      ['string', 'number', 'boolean'].includes(typeof value),
    );
    return values.length ? summarize(values.join(' '), MAX_TOOL_TARGET_CHARS) : null;
  }

  private relativePath(path: string): string {
    if (!this.cwd || !isAbsolute(path)) return path;
    const inside = relative(this.cwd, path);
    return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path;
  }

  private resultSummary(call: PendingTool, output: string): string {
    if (call.name === 'Read') {
      const lines = output.split('\n').length;
      return `${lines} ${lines === 1 ? 'line' : 'lines'}`;
    }
    return summarize(firstLine(output), MAX_TOOL_SUMMARY_CHARS);
  }
}

/** The workspace MCP server's key in the session's `mcpServers` (claude-executor.ts). */
const COREDOC_SERVER = 'coredoc';

/** Where each intent tool's answer lists its item ids: the items read, or the items proposed. */
const INTENT_ID_FIELDS: Record<string, Array<{ list: string; id: string }>> = {
  get_intent_context: [
    { list: 'matches', id: 'id' },
    { list: 'entries', id: 'id' },
  ],
  intent_propose: [{ list: 'items', id: 'itemId' }],
};

/**
 * The intent item ids in an intent tool's JSON answer, for the run page's
 * product intent drawer. A text answer, a state such as `not_configured`, or
 * any shape it does not recognise yields none.
 */
function intentIdsOf(tool: string, output: string): string[] {
  const fields = INTENT_ID_FIELDS[tool];
  if (!fields) return [];
  let answer: unknown;
  try {
    answer = JSON.parse(output);
  } catch {
    return [];
  }
  if (typeof answer !== 'object' || answer === null) return [];
  const ids = new Set<string>();
  for (const { list, id } of fields) {
    const items = (answer as Record<string, unknown>)[list];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const value = typeof item === 'object' && item !== null ? str((item as Record<string, unknown>)[id]) : null;
      if (value && value.length <= 200) ids.add(value);
    }
  }
  return [...ids].slice(0, MAX_TOOL_INTENT_IDS);
}

/** The `result` event of an accepted `submit_result`: its summary and one point per repository. */
function resultEvent(input: Record<string, unknown>): RunnerEvent {
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      : [];
  const points = [
    ...list(input.repositories).map((repo) => `${String(repo.key ?? '')}: ${String(repo.summary ?? '')}`),
    ...list(input.notBuiltOrTested).map(
      (repo) => `${String(repo.key ?? '')}: not built or tested here (${String(repo.reason ?? '')})`,
    ),
  ];
  return {
    type: 'result',
    summary: clip(String(input.summary ?? ''), 4_000),
    points: points.slice(0, 100).map((point) => clip(point, 2_000)),
  };
}
