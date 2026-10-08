/**
 * SDK messages to run-page events. Started from a copy of desktop's mapping
 * (apps/desktop/src/main/agent-run/claude-adapter.ts); desktop keeps its own.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_TODO_STATUSES, type RunnerEvent } from '@coredoc/core/agent-runner';

/** Truncate a value to a compact one-line summary for the raw log. */
export function summarize(value: unknown, max = 160): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const oneLine = (s ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
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

/** The timeline events one SDK message produces (the result's `done` event is built by the executor). */
export function eventsFor(message: SDKMessage): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  switch (message.type) {
    case 'assistant':
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text') {
          const text = block.text.trim();
          if (text) events.push({ type: 'raw', text: `[text] ${summarize(text)}` });
        } else if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (block.name === 'TodoWrite') events.push({ type: 'todos', items: parseTodos(input) });
          else events.push({ type: 'raw', text: `[tool] ${block.name} ${summarize(input, 120)}` });
        }
      }
      break;
    case 'user': {
      const content = message.message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
          const result = block as { content?: unknown; is_error?: boolean };
          const summary = summarize(toolResultText(result.content), 120);
          if (summary)
            events.push({ type: 'raw', text: `${result.is_error ? '[result:error]' : '[result]'} ${summary}` });
        }
      }
      break;
    }
    case 'system':
      if (message.subtype === 'init') events.push({ type: 'raw', text: `[init] model=${message.model ?? 'unknown'}` });
      break;
    default:
      break;
  }
  return events;
}
