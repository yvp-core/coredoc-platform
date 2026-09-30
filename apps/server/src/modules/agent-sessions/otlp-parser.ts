// OTLP/HTTP JSON shapes we consume, per the OTLP spec.
//
// Payload-shape notes (reconciled against the Claude Code 2.1.198 binary; final
// confirmation against a LIVE capture is still on the spec §8 Task-9 checklist):
// - identity attrs (session.id, user.*, app.version, model) arrive on metric DATA
//   POINTS and LOG RECORDS, not only on the OTLP Resource — we merge both, with
//   the point/record level winning;
// - log-record bodies are prefixed ("claude_code.api_request") — we accept both
//   prefixed and bare names, and fall back to the event.name attribute;
// - tool_result carries tool_name ("mcp__coredoc__search_symbols"), not
//   mcp_server_name/mcp_tool_name at the top level — we detect coredoc by
//   tool_name prefix and keep the legacy attrs as a fallback.
interface AnyAttr {
  key: string;
  value: Record<string, unknown>;
}

export interface CoredocToolStat {
  calls: number;
  errors: number;
  totalDurationMs: number;
}

export type AgentSessionProvider = 'claude-code' | 'codex';

export interface SessionDelta {
  provider: AgentSessionProvider;
  sessionId: string;
  userId?: string;
  userEmail?: string;
  model?: string;
  appVersion?: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  tokensReasoning: number;
  costUsd: number;
  activeTimeSec: number;
  commitCount: number;
  prCount: number;
  coredocToolCalls: number;
  coredocTools: Record<string, number>;
  locAdded: number;
  locRemoved: number;
  coredocToolStats: Record<string, CoredocToolStat>;
  /**
   * Per-session plugin-event usage: skill name → count, agent dispatches under
   * `agent:<type>`. Keys and the map are bounded because attributes are supplied
   * by telemetry-token holders.
   */
  skillsUsed: Record<string, number>;
  maxEventNanos: bigint;
  /** Log records that survived the replay filter and were aggregated into this delta. */
  countedEvents: number;
}

/** One session's raw log records — aggregated later against the session's stored watermark. */
export interface SessionLogRecords {
  provider: AgentSessionProvider;
  sessionId: string;
  userId?: string;
  userEmail?: string;
  model?: string;
  appVersion?: string;
  records: LogRecordEvent[];
}

export interface LogRecordEvent {
  nanos: bigint;
  /** Normalized event name — the `claude_code.` prefix is stripped. */
  name: string;
  attrs: Record<string, string | number | boolean>;
}

function emptyDelta(provider: AgentSessionProvider, sessionId: string): SessionDelta {
  return {
    provider,
    sessionId,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensReasoning: 0,
    costUsd: 0,
    activeTimeSec: 0,
    commitCount: 0,
    prCount: 0,
    coredocToolCalls: 0,
    // Null-prototype, because the KEY is attacker-controlled: `tool_name` of
    // `mcp__coredoc____proto__` makes `map[tool]` on a plain object resolve to
    // Object.prototype, so `?? {}` never fires and the accumulate below writes
    // onto Object.prototype process-wide. Same hazard `skillsUsed` defends with
    // defineProperty; here the map itself carries the defence, so a new key
    // source cannot reintroduce it.
    coredocTools: Object.create(null) as Record<string, number>,
    locAdded: 0,
    locRemoved: 0,
    coredocToolStats: Object.create(null) as Record<string, CoredocToolStat>,
    skillsUsed: {},
    maxEventNanos: 0n,
    countedEvents: 0,
  };
}

function attrsToMap(attrs: AnyAttr[] | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const a of Array.isArray(attrs) ? attrs : []) {
    // Payloads are attacker-controllable by any telemetry-token holder: tolerate
    // primitive/missing `value` shapes instead of throwing on the `in` operator.
    if (!a || typeof a !== 'object' || typeof a.key !== 'string') continue;
    const v = a.value;
    if (!v || typeof v !== 'object') continue;
    if ('stringValue' in v) out[a.key] = v.stringValue as string;
    else if ('intValue' in v) {
      const parsed = Number(v.intValue);
      if (Number.isFinite(parsed)) out[a.key] = parsed;
    } else if ('doubleValue' in v) {
      const parsed = Number(v.doubleValue);
      if (Number.isFinite(parsed)) out[a.key] = parsed;
    } else if ('boolValue' in v) out[a.key] = v.boolValue as boolean;
  }
  return out;
}

/** Finite-number coercion — NaN/Infinity from garbage attrs must never reach the DB. */
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Tolerant nanosecond-timestamp parse — malformed values must not 500 the batch. */
function safeNanos(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return BigInt(Math.floor(v));
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}

function str(attrs: Record<string, string | number | boolean>, key: string): string | undefined {
  const v = attrs[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function sessionIdentityOf(
  attrs: Record<string, string | number | boolean>,
): { provider: AgentSessionProvider; sessionId: string } | undefined {
  const claudeSessionId = str(attrs, 'session.id');
  const codexSessionId = str(attrs, 'conversation.id');
  // Ambiguous identity is refused rather than guessed. The two providers use
  // distinct official keys, and a telemetry-token holder controls both values.
  if ((claudeSessionId && codexSessionId) || (!claudeSessionId && !codexSessionId)) {
    return undefined;
  }
  // Same cap the session-context endpoint applies — unbounded ids are a bloat vector.
  return codexSessionId
    ? { provider: 'codex', sessionId: codexSessionId.slice(0, 128) }
    : { provider: 'claude-code', sessionId: claudeSessionId!.slice(0, 128) };
}

function applyIdentity(
  target: { userId?: string; userEmail?: string; model?: string; appVersion?: string },
  attrs: Record<string, string | number | boolean>,
): void {
  const userId = str(attrs, 'user.id');
  const userEmail = str(attrs, 'user.email');
  const model = str(attrs, 'model');
  const appVersion = str(attrs, 'app.version');
  if (userId) target.userId = userId;
  if (userEmail) target.userEmail = userEmail;
  if (model) target.model = model;
  if (appVersion) target.appVersion = appVersion;
}

/** Strip only the two supported native provider namespaces. */
function normalizeEventName(raw: unknown, attrs: Record<string, string | number | boolean>): string {
  const attributeName = str(attrs, 'event.name');
  // Codex 0.146.0 puts a formatted log body in `body.stringValue`; the stable
  // event discriminator is the `event.name` attribute. Claude keeps its native
  // event name in the body, so its precedence remains unchanged.
  const name = attributeName?.startsWith('codex.')
    ? attributeName
    : typeof raw === 'string' && raw.length > 0
      ? raw
      : (attributeName ?? '');
  if (name.startsWith('claude_code.')) return name.slice('claude_code.'.length);
  return name.startsWith('codex.') ? name.slice('codex.'.length) : name;
}

/** Coredoc MCP call detection across payload shapes; returns the tool key or null. */
function coredocToolOf(attrs: Record<string, string | number | boolean>): string | null {
  const toolName = str(attrs, 'tool_name') ?? '';
  const prefixed = toolName.match(/^mcp__coredoc__(.+)$/);
  if (prefixed) return prefixed[1];
  // Legacy/assumed shape (also what tool_parameters would carry under OTEL_LOG_TOOL_DETAILS).
  if (attrs['mcp_server_name'] === 'coredoc') return str(attrs, 'mcp_tool_name') ?? 'unknown';
  return null;
}

export function parseOtlpMetrics(body: unknown): SessionDelta[] {
  const acc = new Map<string, SessionDelta>();
  const rms = (body as { resourceMetrics?: unknown[] })?.resourceMetrics;
  if (!Array.isArray(rms)) return [];
  for (const rm of rms as Array<Record<string, any>>) {
    const resAttrs = attrsToMap(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        const dps = (m.sum?.dataPoints ?? m.gauge?.dataPoints ?? []) as Array<Record<string, any>>;
        for (const dp of dps) {
          const dpAttrs = attrsToMap(dp.attributes);
          // Claude Code attaches session/identity attrs per data point; older/other
          // exporters put them on the resource — merge, point-level wins.
          const merged = { ...resAttrs, ...dpAttrs };
          const identity = sessionIdentityOf(merged);
          if (!identity) continue;
          const key = `${identity.provider}:${identity.sessionId}`;
          let d = acc.get(key);
          if (!d) {
            d = emptyDelta(identity.provider, identity.sessionId);
            acc.set(key, d);
          }
          applyIdentity(d, merged);
          const val = pointValue(dp);
          const type = merged['type'];
          switch (m.name) {
            case 'claude_code.token.usage':
              if (type === 'input') d.tokensInput += val;
              else if (type === 'output') d.tokensOutput += val;
              else if (type === 'cacheRead') d.tokensCacheRead += val;
              else if (type === 'cacheCreation') d.tokensCacheCreation += val;
              break;
            case 'claude_code.cost.usage':
              d.costUsd += val;
              break;
            case 'claude_code.active_time.total':
              d.activeTimeSec += val;
              break;
            case 'claude_code.commit.count':
              d.commitCount += val;
              break;
            case 'claude_code.pull_request.count':
              d.prCount += val;
              break;
            case 'claude_code.lines_of_code.count':
              if (type === 'added') d.locAdded += val;
              else if (type === 'removed') d.locRemoved += val;
              break;
            default:
              break;
          }
        }
      }
    }
  }
  return [...acc.values()];
}

function pointValue(dp: Record<string, unknown>): number {
  if (dp.asInt !== undefined) return num(dp.asInt);
  if (dp.asDouble !== undefined) return num(dp.asDouble);
  return 0;
}

/** Walk the logs payload into per-session raw records (no aggregation yet). */
export function parseOtlpLogRecords(body: unknown): SessionLogRecords[] {
  const acc = new Map<string, SessionLogRecords>();
  const rls = (body as { resourceLogs?: unknown[] })?.resourceLogs;
  if (!Array.isArray(rls)) return [];
  for (const rl of rls as Array<Record<string, any>>) {
    const resAttrs = attrsToMap(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const attrs = attrsToMap(rec.attributes);
        const merged = { ...resAttrs, ...attrs };
        const identity = sessionIdentityOf(merged);
        if (!identity) continue;
        const key = `${identity.provider}:${identity.sessionId}`;
        let entry = acc.get(key);
        if (!entry) {
          entry = { ...identity, records: [] };
          acc.set(key, entry);
        }
        applyIdentity(entry, merged);
        entry.records.push({
          nanos: safeNanos(rec.timeUnixNano),
          name: normalizeEventName(rec.body?.stringValue, attrs),
          attrs,
        });
      }
    }
  }
  return [...acc.values()];
}

/**
 * Aggregate one session's records into a delta, skipping records at-or-below
 * `sinceNanos` (already counted per the stored watermark). Records with an
 * unknown timestamp (0n) are always counted — dropping them loses data.
 */
export function aggregateLogRecords(entry: SessionLogRecords, sinceNanos: bigint): SessionDelta {
  const d = emptyDelta(entry.provider, entry.sessionId);
  applyIdentity(d, {});
  d.userId = entry.userId;
  d.userEmail = entry.userEmail;
  d.model = entry.model;
  d.appVersion = entry.appVersion;
  for (const r of entry.records) {
    if (r.nanos !== 0n && r.nanos <= sinceNanos) continue; // replayed record — already counted
    if (r.nanos > d.maxEventNanos) d.maxEventNanos = r.nanos;
    const a = r.attrs;
    if (d.provider === 'codex' && r.name === 'sse_event') {
      if (str(a, 'event.kind') !== 'response.completed' || !str(a, 'model_reasoning_effort')) continue;
      d.countedEvents += 1;
      const model = str(a, 'model');
      if (model) d.model = model;
      d.tokensInput += num(a['input_token_count']);
      d.tokensOutput += num(a['output_token_count']);
      d.tokensCacheRead += num(a['cached_token_count']);
      d.tokensCacheCreation += num(a['cache_write_token_count']);
      d.tokensReasoning += num(a['reasoning_token_count']);
    } else if (r.name === 'api_request') {
      d.countedEvents += 1;
      const model = str(a, 'model');
      if (model) d.model = model;
      d.tokensInput += num(a['input_tokens']);
      d.tokensOutput += num(a['output_tokens']);
      d.tokensCacheRead += num(a['cache_read_tokens']);
      d.tokensCacheCreation += num(a['cache_creation_tokens']);
      d.costUsd += num(a['cost_usd']);
    } else if (r.name === 'tool_result') {
      const tool = coredocToolOf(a);
      if (!tool) continue;
      d.countedEvents += 1;
      d.coredocToolCalls += 1;
      d.coredocTools[tool] = (d.coredocTools[tool] ?? 0) + 1;
      const stat = d.coredocToolStats[tool] ?? { calls: 0, errors: 0, totalDurationMs: 0 };
      stat.calls += 1;
      // success arrives as boolValue true/false or stringValue 'true'/'false'
      if (!(a['success'] === true || a['success'] === 'true')) stat.errors += 1;
      stat.totalDurationMs += num(a['duration_ms']);
      d.coredocToolStats[tool] = stat;
    }
  }
  return d;
}

/** Back-compat aggregate-everything view (no watermark filtering). */
export function parseOtlpLogs(body: unknown): SessionDelta[] {
  return parseOtlpLogRecords(body).map((entry) => aggregateLogRecords(entry, -1n));
}
