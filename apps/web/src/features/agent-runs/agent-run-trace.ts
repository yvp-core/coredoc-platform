/**
 * Payloads are free-form on the wire, so nothing here throws on a shape it does not recognise.
 * Runners that predate structured events reported `[tool]`, `[result]` and `[text]` lines;
 * those are read back into the same rows.
 */
import type { AgentRunActivity, AgentRunEvent, AgentRunQuestion, AgentRunTurnActivity, TurnKind } from './types.js';

export type TraceTone = 'edit' | 'bash' | 'mcp' | 'run' | 'plain';

export type TraceRow =
  | {
      kind: 'call';
      seq: number;
      at: string;
      label: string;
      tone: TraceTone;
      target: string | null;
      summary: string | null;
      failed: boolean;
      output: string | null;
      /** Only from an older runner's `[result]` line. */
      result?: string;
    }
  | { kind: 'message'; seq: number; at: string; text: string }
  | { kind: 'question'; seq: number; at: string; question: AgentRunQuestion }
  /** A `raw` line from a runner that predates structured events, or a truncated event. */
  | { kind: 'line'; seq: number; at: string; text: string };

interface TraceTurn {
  id: string;
  ordinal: number | null;
  title: string;
  startedAt: string | null;
  rows: TraceRow[];
}

const RUN_CONTROL_SERVER = 'agent_run';
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function skillLabel(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

function toolLook(name: string, server: string | null): { label: string; tone: TraceTone } {
  if (server === RUN_CONTROL_SERVER) return { label: 'Run', tone: 'run' };
  if (server) return { label: 'MCP', tone: 'mcp' };
  return { label: name, tone: EDIT_TOOLS.has(name) ? 'edit' : name === 'Bash' ? 'bash' : 'plain' };
}

function callRow(event: AgentRunEvent): TraceRow | null {
  const payload = event.payload ?? {};
  const base = { seq: event.seq, at: event.createdAt };
  switch (event.type) {
    case 'tool': {
      const name = text(payload.name) ?? 'tool';
      const server = text(payload.server);
      const target = text(payload.target);
      const failed = payload.isError === true;
      return {
        kind: 'call',
        ...base,
        ...toolLook(name, server),
        target: server ? [name, target].filter(Boolean).join(' ') : target,
        summary: text(payload.summary),
        failed,
        output: failed ? text(payload.errorOutput) : null,
      };
    }
    case 'skill':
      return {
        kind: 'call',
        ...base,
        label: 'Skill',
        tone: 'mcp',
        target: skillLabel(text(payload.name) ?? 'skill'),
        summary: null,
        failed: false,
        output: null,
      };
    case 'result':
      return {
        kind: 'call',
        ...base,
        label: 'Result',
        tone: 'run',
        target: text(payload.summary),
        summary: null,
        failed: false,
        output: null,
      };
    case 'done':
      return payload.ok === false
        ? {
            kind: 'call',
            ...base,
            label: 'Session',
            tone: 'plain',
            target: 'The agent session failed',
            summary: null,
            failed: true,
            output: text(payload.error),
          }
        : null;
    default:
      return null;
  }
}

function traceRow(event: AgentRunEvent): TraceRow | null {
  if (event.type === 'message') {
    const message = text(event.payload?.text);
    return message ? { kind: 'message', seq: event.seq, at: event.createdAt, text: message } : null;
  }
  if (event.type === 'raw') {
    const line = text(event.payload?.text) ?? (event.truncated ? '[truncated]' : null);
    return line ? { kind: 'line', seq: event.seq, at: event.createdAt, text: line } : null;
  }
  return callRow(event);
}

/** `mcp__<server>__<tool>`, as older runners named MCP calls. */
function mcpName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__([^_].*)$/.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : null;
}

const NAMED_INPUTS = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'skill'];

/** Older runners cut tool input JSON at 120 characters, so it may not parse. */
function legacyInput(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).flatMap(([key, value]) =>
          ['string', 'number', 'boolean'].includes(typeof value) ? [[key, String(value)]] : [],
        ),
      );
    }
  } catch {
    // Cut short: fall through to the key-by-key read.
  }
  const values: Record<string, string> = {};
  for (const match of raw.matchAll(/"(\w+)":\s*("((?:[^"\\]|\\.)*)"?|-?\d+(?:\.\d+)?|true|false)/g)) {
    values[match[1]!] = match[3] ?? match[2]!;
  }
  return values;
}

/** Paths inside the runner's work directory, relative to it. */
function workPath(value: string): string {
  return value.replace(/\/\S*?\/runs\/[^/\s]+\/work\//g, '').replace(/\/\S*?\/runs\/[^/\s]+\/work\b/g, '.');
}

function legacyCall(seq: number, at: string, line: string): Extract<TraceRow, { kind: 'call' }> {
  const space = line.indexOf(' ');
  const name = space < 0 ? line : line.slice(0, space);
  const input = legacyInput(space < 0 ? '' : line.slice(space + 1).trim());
  const base = { kind: 'call' as const, seq, at, summary: null, failed: false, output: null };
  if (name === 'Skill' && input.skill) {
    return { ...base, label: 'Skill', tone: 'mcp', target: skillLabel(input.skill) };
  }
  const mcp = mcpName(name);
  const named = NAMED_INPUTS.map((key) => input[key]).find(Boolean);
  const values = Object.values(input).map(workPath).join(' ');
  const target = mcp ? [mcp.tool, values].filter(Boolean).join(' ') : named ? workPath(named) : values || null;
  return { ...base, ...toolLook(mcp?.tool ?? name, mcp?.server ?? null), target };
}

const LEGACY_LINE = /^\[(init|text|tool|result|result:error)\] ?([\s\S]*)$/;

/**
 * Older runners' results carry no call id; Claude Code answers calls in the order it made
 * them, so each result goes to the oldest waiting call. An empty result left no line, so a
 * result with no call waiting shows on its own.
 */
class LegacyRows {
  private waiting: Array<Extract<TraceRow, { kind: 'call' }>> = [];

  constructor(private readonly rows: TraceRow[]) {}

  /** Adds a raw line's row; false when the line is not in the older runner's format. */
  add(event: AgentRunEvent, line: string): boolean {
    const match = LEGACY_LINE.exec(line);
    if (!match) return false;
    const [, tag, rest = ''] = match;
    const at = event.createdAt;
    if (tag === 'tool') {
      const call = legacyCall(event.seq, at, rest);
      this.waiting.push(call);
      this.rows.push(call);
    } else if (tag === 'result' || tag === 'result:error') {
      const failed = tag === 'result:error';
      const call = this.waiting.shift();
      if (call && failed) Object.assign(call, { failed: true, summary: 'failed', output: rest });
      else if (call) call.result = workPath(rest);
      else {
        this.rows.push({
          kind: 'call',
          seq: event.seq,
          at,
          label: 'Result',
          tone: 'plain',
          target: rest,
          summary: failed ? 'failed' : null,
          failed,
          output: null,
        });
      }
    } else {
      // A new session answers none of the previous one's calls.
      if (tag === 'init') this.flush();
      this.rows.push(
        tag === 'text'
          ? { kind: 'message', seq: event.seq, at, text: rest }
          : { kind: 'line', seq: event.seq, at, text: line },
      );
    }
    return true;
  }

  flush(): void {
    this.waiting = [];
  }
}

export function traceTurns(
  events: readonly AgentRunEvent[],
  turns: readonly AgentRunTurnActivity[],
  questions: readonly AgentRunQuestion[] = [],
): TraceTurn[] {
  const byId = new Map<string, TraceTurn>();
  for (const turn of turns) {
    byId.set(turn.id, {
      id: turn.id,
      ordinal: turn.ordinal,
      title: `${capitalize(turn.kind)} ${turn.ordinal}`,
      startedAt: turn.startedAt,
      rows: [],
    });
  }
  const legacy = new Map<string, LegacyRows>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!event.turnId) continue;
    let turn = byId.get(event.turnId);
    if (!turn) {
      const kind = event.type === 'turn_started' ? text(event.payload?.kind) : null;
      turn = {
        id: event.turnId,
        ordinal: null,
        title: kind ? `${capitalize(kind)} turn` : 'Turn',
        startedAt: null,
        rows: [],
      };
      byId.set(event.turnId, turn);
    }
    let lines = legacy.get(turn.id);
    if (!lines) {
      lines = new LegacyRows(turn.rows);
      legacy.set(turn.id, lines);
    }
    const line = event.type === 'raw' ? text(event.payload?.text) : null;
    if (line && lines.add(event, line)) continue;
    const row = traceRow(event);
    if (row) turn.rows.push(row);
  }
  // A question goes in the turn that asked it, after what that turn did before asking.
  const askedIn = new Map(
    events
      .filter((event) => event.type === 'question' && event.turnId && text(event.payload?.requestId))
      .map((event) => [String(event.payload.requestId), { turnId: event.turnId!, seq: event.seq }]),
  );
  for (const question of questions) {
    const event = askedIn.get(question.requestId);
    const turn = byId.get(question.askedInTurnId ?? event?.turnId ?? '');
    if (!turn) continue;
    let at = turn.rows.length;
    while (at > 0 && turn.rows[at - 1]!.at > question.askedAt) at -= 1;
    turn.rows.splice(at, 0, {
      kind: 'question',
      seq: event?.seq ?? -1,
      at: question.askedAt,
      question,
    });
  }
  return [...byId.values()];
}

export function transcriptPhases(activity: AgentRunActivity | undefined): Array<Exclude<TurnKind, 'delivery'>> {
  const phases: Array<Exclude<TurnKind, 'delivery'>> = [];
  for (const turn of activity?.turns ?? []) {
    if (turn.kind !== 'delivery' && !phases.includes(turn.kind)) phases.push(turn.kind);
  }
  return phases;
}

export function clockTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
