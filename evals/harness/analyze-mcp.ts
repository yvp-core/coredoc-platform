import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Arm, CaseId } from './types.js';

// Result text patterns that indicate the MCP tool returned no useful data.
// Specific to coredoc MCP responses we have observed in transcripts; widen
// only when a real false-negative shows up. Generic substrings like "empty"
// would over-flag legitimate prose responses.
const EMPTY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'zero-of-zero', re: /\b0\s+of\s+0\b/i },
  { name: 'no-results', re: /\b(?:no\s+(?:matches|results|symbols|callers|dependents)\s+found)\b/i },
  { name: 'not-found-in-scope', re: /not\s+found\s+in\s+scope/i },
  { name: 'no-entrypoints', re: /no\s+entrypoints/i },
];

// A "not found"-shaped phrase can, in principle, sit inside an otherwise
// substantive response (e.g. one target resolved with real callers/entrypoints
// while a secondary lookup on the same call came back empty). None of the
// `not-found-in-scope` / `no-entrypoints` handlers in packages/mcp currently
// mix a not-found sentence into a substantive response — they return the
// not-found message as the ENTIRE payload — but the check is cheap and
// guards against that shape regardless of which handler produces it. Only
// gates the two patterns whose wording is generic prose (`not found in
// scope`, `no entrypoints`); `zero-of-zero` and `no-results` are already
// narrow enough (fixed phrasing tied to a genuinely empty result) that they
// don't need it.
const SUBSTANTIVE_CONTENT_MARKERS: RegExp[] = [
  /\b[1-9]\d*\s+direct\s+caller/i,
  /\b[1-9]\d*\s+transitive\s+caller/i,
  /\b[1-9]\d*\s+type\s+user/i,
  /\b[1-9]\d*\s+api\s+endpoint/i,
  /\b[1-9]\d*\s+consumer/i,
  /\b[1-9]\d*\s+test\s+file/i,
];
const GATED_PATTERN_NAMES = new Set(['not-found-in-scope', 'no-entrypoints']);

function hasSubstantiveContent(text: string): boolean {
  return SUBSTANTIVE_CONTENT_MARKERS.some((re) => re.test(text));
}

const BASE_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
const FALLBACK_LOOKAHEAD = 3;

interface ToolUseEvent {
  kind: 'use';
  toolName: string;
  input: unknown;
  toolUseId: string;
}
interface ToolResultEvent {
  kind: 'result';
  toolUseId: string;
  text: string;
  isError: boolean;
}
type ToolEvent = ToolUseEvent | ToolResultEvent;

export interface EmptyCheck {
  isEmpty: boolean;
  reason: string | null;
}

export function classifyMcpResult(text: string, isError: boolean): EmptyCheck {
  if (isError) return { isEmpty: true, reason: 'tool-error' };
  for (const { name, re } of EMPTY_PATTERNS) {
    if (!re.test(text)) continue;
    if (GATED_PATTERN_NAMES.has(name) && hasSubstantiveContent(text)) continue;
    return { isEmpty: true, reason: name };
  }
  return { isEmpty: false, reason: null };
}

/**
 * A codex transcript is the raw `codex exec --json` event stream (see
 * agent-codex.ts), not Claude SDK messages. Detect it by its event vocabulary
 * rather than faking the Claude shape, so both stay honest.
 */
function isCodexTranscript(transcript: unknown[]): boolean {
  return transcript.some((msg) => {
    const t = (msg as { type?: string }).type;
    return t === 'item.completed' || t === 'turn.completed' || t === 'thread.started';
  });
}

/**
 * Codex reports each tool call as a single `item.completed` carrying both the
 * arguments and the result, so one item expands into a use/result pair keyed by
 * the item id. Ordering is preserved, which is what the fallback-lookahead
 * (failed MCP call → base tool within N calls) relies on.
 */
export function extractCodexToolEvents(transcript: unknown[]): ToolEvent[] {
  const events: ToolEvent[] = [];
  for (const msg of transcript) {
    const ev = msg as {
      type?: string;
      item?: {
        id?: string;
        type?: string;
        server?: string;
        tool?: string;
        arguments?: unknown;
        result?: unknown;
        error?: { message?: string } | null;
        status?: string;
        command?: string;
        aggregated_output?: string;
        exit_code?: number | null;
      };
    };
    if (ev.type !== 'item.completed' || !ev.item) continue;
    const item = ev.item;
    const id = item.id ?? '';
    if (item.type === 'mcp_tool_call') {
      const toolName = `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'unknown'}`;
      events.push({ kind: 'use', toolName, input: item.arguments, toolUseId: id });
      events.push({
        kind: 'result',
        toolUseId: id,
        text: item.error?.message ?? codexResultText(item.result),
        isError: item.error != null || item.status === 'failed',
      });
    } else if (item.type === 'command_execution') {
      // codex funnels read/grep/glob through one shell tool; `Bash` is the name
      // the base-tool set already recognizes.
      events.push({ kind: 'use', toolName: 'Bash', input: item.command, toolUseId: id });
      events.push({
        kind: 'result',
        toolUseId: id,
        text: item.aggregated_output ?? '',
        isError: item.status === 'failed' || (item.exit_code ?? 0) !== 0,
      });
    }
  }
  return events;
}

/** MCP results arrive as `{content:[{type:'text',text}]}`; flatten to text. */
function codexResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return result == null ? '' : JSON.stringify(result);
  let text = '';
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') text += b.text;
  }
  return text;
}

export function extractToolEvents(transcript: unknown[]): ToolEvent[] {
  if (isCodexTranscript(transcript)) return extractCodexToolEvents(transcript);
  const events: ToolEvent[] = [];
  for (const msg of transcript) {
    const m = msg as { type?: string; message?: { content?: unknown } };
    if (m.type === 'assistant') {
      const content = m.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; name?: string; input?: unknown; id?: string };
        if (b.type === 'tool_use' && typeof b.name === 'string' && typeof b.id === 'string') {
          events.push({ kind: 'use', toolName: b.name, input: b.input, toolUseId: b.id });
        }
      }
    } else if (m.type === 'user') {
      const content = m.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as {
          type?: string;
          tool_use_id?: string;
          is_error?: boolean;
          content?: unknown;
        };
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          let text = '';
          if (Array.isArray(b.content)) {
            for (const c of b.content) {
              const cb = c as { type?: string; text?: string };
              if (cb.type === 'text' && typeof cb.text === 'string') text += cb.text;
            }
          } else if (typeof b.content === 'string') {
            text = b.content;
          }
          events.push({
            kind: 'result',
            toolUseId: b.tool_use_id,
            text,
            isError: b.is_error === true,
          });
        }
      }
    }
  }
  return events;
}

export interface McpCallRecord {
  target: string;
  case: CaseId;
  arm: Arm;
  runIndex: number;
  toolName: string;
  input: unknown;
  resultPreview: string;
  isError: boolean;
  isEmpty: boolean;
  emptyReason: string | null;
  followedByBase: { toolName: string; input: unknown }[];
}

export interface AnalyzeRunInput {
  target: string;
  case: CaseId;
  arm: Arm;
  runIndex: number;
  transcript: unknown[];
}

export function analyzeTranscript(input: AnalyzeRunInput): McpCallRecord[] {
  const events = extractToolEvents(input.transcript);
  // Index MCP tool_use events by id so we can pair with the matching result.
  const useByIdx = new Map<string, { event: ToolUseEvent; usePosition: number }>();
  let usePosition = 0;
  const usesInOrder: ToolUseEvent[] = [];
  for (const ev of events) {
    if (ev.kind === 'use') {
      useByIdx.set(ev.toolUseId, { event: ev, usePosition });
      usesInOrder.push(ev);
      usePosition += 1;
    }
  }

  const records: McpCallRecord[] = [];
  for (const ev of events) {
    if (ev.kind !== 'result') continue;
    const meta = useByIdx.get(ev.toolUseId);
    if (!meta) continue;
    if (!meta.event.toolName.startsWith('mcp__')) continue;
    const cls = classifyMcpResult(ev.text, ev.isError);
    if (!cls.isEmpty) continue;

    const followedByBase: { toolName: string; input: unknown }[] = [];
    for (
      let i = meta.usePosition + 1;
      i < usesInOrder.length && i <= meta.usePosition + FALLBACK_LOOKAHEAD;
      i += 1
    ) {
      const next = usesInOrder[i];
      if (!next) continue;
      if (BASE_TOOL_NAMES.has(next.toolName)) {
        followedByBase.push({ toolName: next.toolName, input: next.input });
      }
    }

    records.push({
      target: input.target,
      case: input.case,
      arm: input.arm,
      runIndex: input.runIndex,
      toolName: meta.event.toolName,
      input: meta.event.input,
      resultPreview: ev.text.slice(0, 200),
      isError: ev.isError,
      isEmpty: true,
      emptyReason: cls.reason,
      followedByBase,
    });
  }
  return records;
}

interface RunDirItem {
  target: string;
  caseId: CaseId;
  arm: Arm;
  runIndex: number;
  transcriptPath: string;
}

function discoverRuns(runDir: string): RunDirItem[] {
  const items: RunDirItem[] = [];
  const runsRoot = join(runDir, 'runs');
  if (!existsSync(runsRoot)) return items;
  for (const target of readdirSync(runsRoot)) {
    const tDir = join(runsRoot, target);
    for (const c of readdirSync(tDir)) {
      const cDir = join(tDir, c);
      for (const arm of readdirSync(cDir)) {
        const aDir = join(cDir, arm);
        for (const run of readdirSync(aDir)) {
          const m = run.match(/^run-(\d+)$/);
          if (!m) continue;
          const transcriptPath = join(aDir, run, 'transcript.json');
          if (!existsSync(transcriptPath)) continue;
          items.push({
            target,
            caseId: c as CaseId,
            arm: arm as Arm,
            runIndex: Number(m[1]),
            transcriptPath,
          });
        }
      }
    }
  }
  return items;
}

export interface McpGapAggregate {
  totalMcpCalls: number;
  emptyOrErrorCount: number;
  perTool: Map<string, { calls: number; empty: number }>;
  fallbackPatterns: Map<string, number>; // "mcp__X(input) → BaseTool" → count
}

export function aggregateGaps(
  allMcpCallCounts: Map<string, number>,
  records: McpCallRecord[],
): McpGapAggregate {
  let totalMcp = 0;
  for (const c of allMcpCallCounts.values()) totalMcp += c;
  const perTool = new Map<string, { calls: number; empty: number }>();
  for (const [name, calls] of allMcpCallCounts) {
    perTool.set(name, { calls, empty: 0 });
  }
  for (const r of records) {
    const cur = perTool.get(r.toolName) ?? { calls: 0, empty: 0 };
    cur.empty += 1;
    perTool.set(r.toolName, cur);
  }
  const fallbackPatterns = new Map<string, number>();
  for (const r of records) {
    for (const fb of r.followedByBase) {
      const inputSummary = summarizeInput(r.input);
      const key = `${r.toolName}(${inputSummary}) → ${fb.toolName}`;
      fallbackPatterns.set(key, (fallbackPatterns.get(key) ?? 0) + 1);
    }
  }
  return {
    totalMcpCalls: totalMcp,
    emptyOrErrorCount: records.length,
    perTool,
    fallbackPatterns,
  };
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input.slice(0, 60);
  if (typeof input !== 'object') return String(input);
  const obj = input as Record<string, unknown>;
  // Show the most identifying field — query/symbol/entityName are typical.
  for (const k of ['query', 'symbol', 'entityName', 'symbolName', 'functionName', 'path']) {
    const v = obj[k];
    if (typeof v === 'string') return `${k}=${v.slice(0, 60)}`;
  }
  return JSON.stringify(input).slice(0, 60);
}

export function renderGapSection(
  agg: McpGapAggregate,
  topFallbacks = 10,
): string[] {
  const lines: string[] = [];
  lines.push('## MCP gap signals', '');
  if (agg.totalMcpCalls === 0) {
    lines.push('_No MCP calls observed in this run._', '');
    return lines;
  }
  const failPct = Math.round((agg.emptyOrErrorCount / agg.totalMcpCalls) * 100);
  lines.push(
    `${agg.emptyOrErrorCount} of ${agg.totalMcpCalls} MCP calls (${failPct}%) returned empty / error / not-found.`,
    '',
  );
  lines.push('### Failure rate per MCP tool', '');
  lines.push('| Tool | Calls | Empty/Error | % Failed |');
  lines.push('|---|---:|---:|---:|');
  const toolRows = [...agg.perTool.entries()].sort((a, b) => b[1].calls - a[1].calls);
  for (const [name, info] of toolRows) {
    const pct = info.calls === 0 ? 0 : Math.round((info.empty / info.calls) * 100);
    lines.push(`| ${name} | ${info.calls} | ${info.empty} | ${pct}% |`);
  }
  lines.push('');
  if (agg.fallbackPatterns.size > 0) {
    lines.push(
      '### Top fallback patterns (failed MCP call → base tool within 3 turns)',
      '',
    );
    lines.push('| Pattern | Count |');
    lines.push('|---|---:|');
    const top = [...agg.fallbackPatterns.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topFallbacks);
    for (const [key, count] of top) {
      lines.push(`| ${key.replace(/\|/g, '\\|')} | ${count} |`);
    }
    lines.push('');
  }
  return lines;
}

export interface AnalyzeRunDirResult {
  records: McpCallRecord[];
  aggregate: McpGapAggregate;
  reportSection: string[];
  jsonlPath: string;
}

export function analyzeRunDir(runDir: string): AnalyzeRunDirResult {
  const items = discoverRuns(runDir);
  const allMcpCounts = new Map<string, number>();
  const records: McpCallRecord[] = [];
  for (const it of items) {
    const transcript = JSON.parse(readFileSync(it.transcriptPath, 'utf8')) as unknown[];
    const events = extractToolEvents(transcript);
    for (const ev of events) {
      if (ev.kind === 'use' && ev.toolName.startsWith('mcp__')) {
        allMcpCounts.set(ev.toolName, (allMcpCounts.get(ev.toolName) ?? 0) + 1);
      }
    }
    records.push(
      ...analyzeTranscript({
        target: it.target,
        case: it.caseId,
        arm: it.arm,
        runIndex: it.runIndex,
        transcript,
      }),
    );
  }
  const jsonlPath = join(runDir, 'mcp-gaps.jsonl');
  // Truncate any prior contents so re-analysis is deterministic.
  writeFileSync(jsonlPath, '');
  for (const r of records) appendFileSync(jsonlPath, `${JSON.stringify(r)}\n`);
  const aggregate = aggregateGaps(allMcpCounts, records);
  const reportSection = renderGapSection(aggregate);
  return { records, aggregate, reportSection, jsonlPath };
}
