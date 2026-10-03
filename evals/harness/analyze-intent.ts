// evals/harness/analyze-intent.ts
/**
 * AC-10 verdicts from OBSERVED tool events — never from artifact text (D6).
 *
 * Reads the transcript through the shared {@link extractToolEvents} primitive,
 * decodes every `get_intent_context` interaction (MCP tool call or the
 * equivalent `coredoc intent context` CLI invocation run through Bash), and
 * applies the two bounds BR-8/ADR-3 promise:
 *
 *   routed ids  → fetch exactly those ids (all of them), no broad lookup at all
 *   no ids      → at most ONE broad lookup per stage
 *
 * A lookup is BROAD unless it is a pure exact-id fetch or the payload-free
 * index. Discovery (`query` / `nodeIds`) is broad; so is a SELECTOR-LESS
 * context call, which is in fact the broadest request the engine serves — with
 * no selector at all it returns every accepted item up to the limit; so is a
 * call that mixes `intentIds` with a `query`/`nodeIds`, because the engine runs
 * the discovery half regardless of the exact ids riding along.
 *
 * `mode: "list"` is EXEMPT from the broad-lookup bound (issue 10, BR-23/BR-26):
 * it is not a lookup at all but the orientation index — id, title, kind, domain
 * and authority, with no payloads, no sources, no anchors and no relations — so
 * it costs strictly less than the `query` call it replaces and is the intended
 * first step before an exact-ID fetch. Counting it as broad would penalise
 * exactly the cheap-then-exact navigation BR-8/ADR-3 ask for. It is counted
 * separately ({@link IntentRunAnalysis.indexCalls}) so "exempt" never means
 * "invisible".
 *
 * A judge is deliberately not involved: a model that misjudged a plan must not
 * be able to mask a tool-protocol violation, and a protocol violation must not
 * need a paid call to detect.
 */

import { extractToolEvents } from './analyze-mcp.js';
import type { IntentPromptShape } from '../cases-intent/tasks.js';

/** The MCP tool name under the harness-owned server key (see agent.ts). */
export const INTENT_MCP_TOOL = 'mcp__coredoc-eval__get_intent_context';

/** Path fragment that identifies the overlay file itself. */
const OVERLAY_PATH_FRAGMENT = '.coredoc/intent.json';

export enum IntentToolShape {
  Mcp = 'mcp',
  Cli = 'cli',
}

/** The tool's `mode` argument (issue 10, BR-28). Absent means `context`. */
export const INTENT_LIST_MODE = 'list';

/** How a single interaction asks for intent — {@link Exact} and {@link Index} are not broad. */
export enum IntentLookupKind {
  /** `intentIds` only: the bounded, routed-id fetch BR-8 asks for. */
  Exact = 'exact',
  /** `query` and/or `nodeIds` with no `intentIds`: ordinary discovery. */
  Discovery = 'discovery',
  /** No selector at all: the engine returns every accepted item up to the limit. */
  SelectorLess = 'selector-less',
  /** `intentIds` AND a `query`/`nodeIds`: exact fetch plus a discovery pass. */
  Mixed = 'mixed',
  /** `mode: "list"`: the payload-free id+title index (BR-23) — orientation, not a lookup. */
  Index = 'index',
}

/**
 * Classify one interaction.
 *
 * `mode: "list"` is its own kind ONLY when it carries no context selector: the
 * MCP tool rejects a list call that also names `intentIds`/`query`/`nodeIds`
 * (BR-28), so a call in that shape never reached the index and is judged by the
 * selectors it did carry rather than being silently exempted.
 */
export function classifyLookup(call: {
  intentIds: readonly string[];
  query?: string;
  nodeIds: readonly string[];
  mode?: string;
}): IntentLookupKind {
  const hasIds = call.intentIds.length > 0;
  const hasDiscovery = call.query !== undefined || call.nodeIds.length > 0;
  if (call.mode === INTENT_LIST_MODE && !hasIds && !hasDiscovery) return IntentLookupKind.Index;
  if (hasIds && hasDiscovery) return IntentLookupKind.Mixed;
  if (hasIds) return IntentLookupKind.Exact;
  if (hasDiscovery) return IntentLookupKind.Discovery;
  return IntentLookupKind.SelectorLess;
}

/** Kinds that do NOT consume the one broad lookup a stage is allowed. */
function isBroadKind(kind: IntentLookupKind): boolean {
  return kind !== IntentLookupKind.Exact && kind !== IntentLookupKind.Index;
}

/**
 * Ids the SESSION already learned, harvested from a tool response.
 *
 * D9 (2026-08-27): an id that a previous response handed the agent — a returned
 * item's id, or the far endpoint of a returned relation — is a legitimate next
 * exact-ID hop, not an id conjured out of nowhere. Only ids that were never
 * routed AND never returned are "unrouted".
 *
 * Collection is POSITIONAL, not shape-guessing: only `items[].id` and
 * `relations[].from/to` count, so the node ids other coredoc tools return (which
 * are not overlay ids and could never be a legitimate `intentIds` argument) do
 * not silently widen the allowance. The shape guard is a second filter for the
 * same reason.
 */
const OVERLAY_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function collectOverlayIdsFrom(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectOverlayIdsFrom(entry, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === 'items' && Array.isArray(child)) {
      for (const item of child) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && OVERLAY_ID_SHAPE.test(id)) into.add(id);
      }
    } else if (key === 'relations' && Array.isArray(child)) {
      for (const relation of child) {
        const edge = relation as { from?: unknown; to?: unknown } | null;
        for (const endpoint of [edge?.from, edge?.to]) {
          if (typeof endpoint === 'string' && OVERLAY_ID_SHAPE.test(endpoint)) into.add(endpoint);
        }
      }
    }
    collectOverlayIdsFrom(child, into);
  }
}

/**
 * Overlay ids visible in one tool RESULT. Defensive by construction: a result
 * that is not the tool's JSON payload (prose, an error message, a truncated
 * body) yields nothing rather than throwing — a single unparseable response
 * must not take the whole analysis down with it.
 */
export function extractOverlayIdsFromResult(text: string): string[] {
  const ids = new Set<string>();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  collectOverlayIdsFrom(parsed, ids);
  return [...ids];
}

export interface IntentToolInteraction {
  shape: IntentToolShape;
  toolUseId: string;
  intentIds: string[];
  query?: string;
  nodeIds: string[];
  includeCandidates: boolean;
  kind: IntentLookupKind;
  /** True for every kind except {@link IntentLookupKind.Exact} and {@link IntentLookupKind.Index}. */
  broad: boolean;
  /**
   * The subset of {@link intentIds} that a STRICTLY earlier tool response had
   * already returned (D9) — the session derived them, nobody invented them.
   */
  derivedIds: string[];
  /**
   * True when the call never reached the tool — a permission denial (the
   * baseline arm CAN see `get_intent_context` in the server's tool list even
   * though it is absent from the allowlist) or a tool error. A refused call
   * delivered no intent, so it counts as neither adoption nor a lookup; it is
   * reported separately.
   */
  denied: boolean;
}

export enum IntentAc10Verdict {
  Pass = 'pass',
  Violation = 'violation',
  /** The arm had the capability and never used it — a vacuous "within bounds". */
  NoAdoption = 'no-adoption',
  /** The arm was not given the capability; nothing to gate. */
  NotApplicable = 'not-applicable',
  /**
   * A control arm that WAS reached by intent — an answered `get_intent_context`
   * call or a direct read of the overlay file. The comparison it anchors is
   * invalid, so the record is excluded from the AC-12 populations and the gate
   * fails rather than crediting the overlay with a difference it did not cause.
   */
  ContaminatedControl = 'contaminated-control',
  /** The run produced no transcript at all (crash / infrastructure error). */
  NoTranscript = 'no-transcript',
}

export type IntentArmId = 'baseline' | 'intent';

/**
 * How a single AC-10 finding weighs on the RUN-LEVEL gate.
 *
 * Maintainer decision, 2026-08-28, taken while reading three consecutive full
 * gate runs. A zero-tolerance protocol gate over 24 stochastic agent sessions
 * does not measure "does the guidance work" — it measures "was the model
 * perfectly disciplined in 24 independent samples", and those are different
 * claims. The evidence: three runs, each failed by ONE session, each a
 * different low-harm slip.
 *
 *   run 2026-08-27T23-37-25-865Z  review-bulk-discount/intent/rep-1
 *                                 nodeIds-as-paths then a query — two broad
 *                                 lookups in one stage.
 *   run 2026-08-28T00-37-03-522Z  investigate-cent-shortfall/intent/rep-2
 *                                 a direct read of `.coredoc/intent.json`.
 *   run 2026-08-28T01-05-14-108Z  review-bulk-discount/intent/rep-0
 *                                 query then query — two broad lookups again.
 *
 * AC-12 held 12/12 twice across those runs, so the artifacts were right while
 * the protocol ledger read red. The split below is what separates the two:
 *
 *   {@link Hard} — the finding invalidates the measurement or the bound itself.
 *     Reading the overlay file bypasses the bounded read surface entirely (the
 *     session no longer demonstrates anything about `get_intent_context`); a
 *     selector-less call is the broadest request the engine serves and defeats
 *     the premise of a bounded context; an id nobody routed and no response
 *     returned means the session was not navigating the overlay at all; and
 *     ignoring routed ids means the routed working set was not honoured. One
 *     of these anywhere in the run fails the gate.
 *
 *   {@link Soft} — the finding is a BUDGET overrun: the session did the right
 *     kind of lookup, just one more time than the stage allows. It costs tokens
 *     and it is a real protocol slip, but it neither contaminates the arm nor
 *     invalidates the artifact, and it is exactly the shape that recurs at a
 *     low per-session rate across stochastic samples. Rate-bounded at the run
 *     level rather than zero-tolerance; always reported per session.
 *
 *   {@link Info} — context for a reader, never a violation: refused calls,
 *     D9-derived ids, and the explanatory line for a mixed exact+discovery call
 *     (whose cost is already carried by the broad-lookup budget finding).
 *
 * Per-session AC-10 semantics are UNCHANGED by this split: the same shapes
 * produce the same `pass`/`violation` verdicts and the same `reasons`. Only the
 * run-level aggregation (the intent runner, being rebuilt on cloud intent)
 * reads the severities. One
 * consequence is deliberate and stays visible: a session can be per-session
 * `pass` and still carry a hard finding — one selector-less lookup on an open
 * task sits inside the one-broad-lookup budget, so the session passes, but the
 * call is zero-tolerance at the gate.
 */
export enum IntentViolationSeverity {
  Hard = 'hard',
  Soft = 'soft',
  Info = 'info',
}

/** One AC-10 finding: the reader-facing sentence plus its gate weight. */
export interface IntentFinding {
  severity: IntentViolationSeverity;
  text: string;
}

export interface IntentTaskShapeInput {
  shape: IntentPromptShape;
  routedIntentIds: string[];
}

export interface IntentRunAnalysis {
  arm: IntentArmId;
  verdict: IntentAc10Verdict;
  interactions: number;
  broadLookups: number;
  exactIdCalls: number;
  fetchedIds: string[];
  /**
   * Fetched ids the brief did not route but an earlier tool response returned
   * (D9) — exact-ID-first navigation along the overlay, not an unrouted fetch.
   */
  derivedIds: string[];
  /** Ids fetched on a routed task that the brief never routed and no response ever returned. */
  unroutedIds: string[];
  /** Routed ids no answered call ever fetched through `intentIds`. */
  missingRoutedIds: string[];
  /**
   * Payload-free `mode: "list"` calls (BR-23/BR-26). Reported on its own because
   * it is exempt from {@link broadLookups}: the number must stay visible so a
   * reader can see how a run oriented itself before its exact-ID fetches.
   */
  indexCalls: number;
  /** Answered calls by kind — the totals behind {@link broadLookups}, plus the exempt kinds. */
  broadByKind: Record<IntentLookupKind, number>;
  /** Calls the host refused (permission denial or tool error) — no intent was delivered. */
  deniedInteractions: number;
  /** Direct reads of `.coredoc/intent.json` through Read/Grep/Glob/Bash. */
  overlayFileReads: number;
  reasons: string[];
  /**
   * The subset of {@link reasons} classified {@link IntentViolationSeverity.Hard} —
   * zero tolerance: one anywhere in a run fails the gate.
   */
  hardViolations: string[];
  /**
   * The subset of {@link reasons} classified {@link IntentViolationSeverity.Soft} —
   * broad-lookup budget overruns, rate-bounded at the run level.
   */
  softViolations: string[];
  calls: IntentToolInteraction[];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Split a shell command into tokens, honouring single and double quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/**
 * Decode a `coredoc intent context` invocation. The CLI is the second sanctioned
 * read surface (issue 05 methodology), so an arm that uses it is adopting the
 * capability just as much as one calling the MCP tool — counting only MCP calls
 * would report `no-adoption` for a compliant run.
 */
function decodeCliInvocation(
  command: string,
  toolUseId: string,
  seenIds: ReadonlySet<string>,
): IntentToolInteraction | null {
  if (!/\bintent\s+context\b/.test(command)) return null;
  const tokens = tokenize(command);
  const intentIds: string[] = [];
  const nodeIds: string[] = [];
  let query: string | undefined;
  let includeCandidates = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    if (token === '--id' && next) intentIds.push(next);
    else if (token === '--node-id' && next) nodeIds.push(next);
    else if ((token === '--query' || token === '-q') && next) query = next;
    else if (token === '--include-candidates') includeCandidates = true;
  }
  const kind = classifyLookup({ intentIds, ...(query !== undefined ? { query } : {}), nodeIds });
  return {
    shape: IntentToolShape.Cli,
    toolUseId,
    intentIds,
    ...(query !== undefined ? { query } : {}),
    nodeIds,
    includeCandidates,
    kind,
    broad: isBroadKind(kind),
    derivedIds: intentIds.filter((id) => seenIds.has(id)),
    denied: false,
  };
}

export function extractIntentInteractions(transcript: unknown[]): IntentToolInteraction[] {
  const events = extractToolEvents(transcript);
  const failedByUseId = new Set<string>();
  for (const event of events) {
    if (event.kind === 'result' && event.isError) failedByUseId.add(event.toolUseId);
  }
  const interactions: IntentToolInteraction[] = [];
  // Grows as the session progresses: every call is judged against what the
  // agent had already been TOLD, which is why the walk is ordered (D9).
  const seenIds = new Set<string>();
  // Results can contain arbitrary JSON from Read/Bash/other MCP tools. Only a
  // successful response to the sanctioned intent reader may establish an id
  // for a later D9 hop.
  const intentUseIds = new Set<string>();
  for (const event of events) {
    if (event.kind === 'result') {
      if (intentUseIds.has(event.toolUseId) && !event.isError) {
        for (const id of extractOverlayIdsFromResult(event.text)) seenIds.add(id);
      }
      continue;
    }
    if (event.toolName === INTENT_MCP_TOOL) {
      intentUseIds.add(event.toolUseId);
      const input = (event.input ?? {}) as Record<string, unknown>;
      const intentIds = asStringArray(input.intentIds);
      const nodeIds = asStringArray(input.nodeIds);
      const query = typeof input.query === 'string' && input.query.trim() !== '' ? input.query : undefined;
      const mode = typeof input.mode === 'string' ? input.mode : undefined;
      const kind = classifyLookup({
        intentIds,
        ...(query !== undefined ? { query } : {}),
        nodeIds,
        ...(mode !== undefined ? { mode } : {}),
      });
      interactions.push({
        shape: IntentToolShape.Mcp,
        toolUseId: event.toolUseId,
        intentIds,
        ...(query !== undefined ? { query } : {}),
        nodeIds,
        includeCandidates: input.includeCandidates === true,
        kind,
        broad: isBroadKind(kind),
        derivedIds: intentIds.filter((id) => seenIds.has(id)),
        denied: failedByUseId.has(event.toolUseId),
      });
      continue;
    }
    const command = commandTextOf(event.toolName, event.input);
    if (command === null) continue;
    const decoded = decodeCliInvocation(command, event.toolUseId, seenIds);
    if (decoded) {
      intentUseIds.add(event.toolUseId);
      interactions.push({ ...decoded, denied: failedByUseId.has(event.toolUseId) });
    }
  }
  return interactions;
}

/** Bash input is `{command}` for the Claude SDK and a bare string for codex. */
function commandTextOf(toolName: string, input: unknown): string | null {
  if (toolName !== 'Bash') return null;
  if (typeof input === 'string') return unwrapShellCommand(input);
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? unwrapShellCommand(command) : null;
}

const SHELL_BINARY = /^(?:.*\/)?(?:ba|z|da|k)?sh$/;

/**
 * Unwrap codex's shell envelope.
 *
 * Codex reports every command as `/bin/zsh -lc '<script>'`, so the script the
 * agent actually ran is ONE quoted token — {@link tokenize} would hand
 * `decodeCliInvocation` a single blob and every `--id` flag would vanish, i.e.
 * a compliant codex session that used `coredoc intent context` would be
 * reported as `no-adoption`. Claude's Bash input carries the bare command and
 * is returned untouched.
 */
export function unwrapShellCommand(command: string): string {
  const tokens = tokenize(command);
  if (tokens.length < 2) return command;
  const [binary, ...rest] = tokens as [string, ...string[]];
  if (!SHELL_BINARY.test(binary)) return command;
  const script = rest.at(-1)!;
  // Everything between the shell and the script must be a flag; anything else
  // (a filename, a redirect) means this is not the `-c <script>` shape.
  if (!rest.slice(0, -1).every((token) => token.startsWith('-'))) return command;
  if (!rest.slice(0, -1).some((token) => /^-[a-z]*c$/.test(token))) return command;
  return script;
}

/**
 * Direct reads of the overlay file.
 *
 * The pilot overlay is repo-local, so it sits inside the agent's cwd and a
 * baseline arm CAN read it with an ordinary file tool. That is contamination,
 * not adoption: it is reported per run so a baseline artifact grounded in the
 * overlay is never mistaken for evidence that intent context is unnecessary.
 */
export function detectOverlayFileReads(transcript: unknown[]): number {
  let count = 0;
  for (const event of extractToolEvents(transcript)) {
    if (event.kind !== 'use') continue;
    const input = event.input;
    const haystacks: string[] = [];
    if (typeof input === 'string') haystacks.push(input);
    else if (input && typeof input === 'object') {
      for (const value of Object.values(input as Record<string, unknown>)) {
        if (typeof value === 'string') haystacks.push(value);
      }
    }
    if (haystacks.some((text) => text.includes(OVERLAY_PATH_FRAGMENT))) count += 1;
  }
  return count;
}

export interface AnalyzeIntentRunInput {
  arm: IntentArmId;
  task: IntentTaskShapeInput;
  transcript: unknown[];
}

export function analyzeIntentRun(input: AnalyzeIntentRunInput): IntentRunAnalysis {
  const calls = extractIntentInteractions(input.transcript);
  const overlayFileReads = detectOverlayFileReads(input.transcript);
  const routed = new Set(input.task.routedIntentIds);
  // A refused call delivered nothing, so it is neither adoption nor a lookup:
  // counting it would report a "baseline leak" for an allowlist that actually
  // held (the server still ADVERTISES the tool to every arm), and would spend
  // the intent arm's one permitted broad lookup on a call it never received.
  const delivered = calls.filter((call) => !call.denied);
  const deniedInteractions = calls.length - delivered.length;
  // Mixed calls still return their exact ids, so they DO count as fetched.
  const fetchedIds = [...new Set(delivered.flatMap((call) => call.intentIds))];
  const broadByKind: Record<IntentLookupKind, number> = {
    [IntentLookupKind.Exact]: 0,
    [IntentLookupKind.Discovery]: 0,
    [IntentLookupKind.SelectorLess]: 0,
    [IntentLookupKind.Mixed]: 0,
    [IntentLookupKind.Index]: 0,
  };
  for (const call of delivered) broadByKind[call.kind] += 1;
  const broadLookups = delivered.filter((call) => call.broad).length;
  const exactIdCalls = broadByKind[IntentLookupKind.Exact];
  const indexCalls = broadByKind[IntentLookupKind.Index];
  // D9: an id an earlier response already returned was navigated to, not
  // invented — it is exact-ID-first behavior even though the brief never named
  // it. Only ids from nowhere remain unrouted.
  const derived = new Set(delivered.flatMap((call) => call.derivedIds));
  const derivedIds = fetchedIds.filter((id) => !routed.has(id) && derived.has(id));
  const unroutedIds = routed.size > 0 ? fetchedIds.filter((id) => !routed.has(id) && !derived.has(id)) : [];
  const missingRoutedIds = [...routed].filter((id) => !fetchedIds.includes(id));
  // Every reason is emitted WITH its gate weight at the point it is written, so
  // the mapping cannot drift away from the sentence it classifies (no
  // after-the-fact string matching over `reasons`).
  const findings: IntentFinding[] = [];
  const note = (severity: IntentViolationSeverity, text: string): void => {
    findings.push({ severity, text });
  };
  const reasons = {
    get all(): string[] {
      return findings.map((finding) => finding.text);
    },
    of(severity: IntentViolationSeverity): string[] {
      return findings.filter((finding) => finding.severity === severity).map((finding) => finding.text);
    },
  };
  const verdictFields = (): Pick<IntentRunAnalysis, 'reasons' | 'hardViolations' | 'softViolations'> => ({
    reasons: reasons.all,
    hardViolations: reasons.of(IntentViolationSeverity.Hard),
    softViolations: reasons.of(IntentViolationSeverity.Soft),
  });
  const base = {
    interactions: delivered.length,
    broadLookups,
    exactIdCalls,
    indexCalls,
    fetchedIds,
    derivedIds,
    unroutedIds,
    missingRoutedIds,
    broadByKind,
    deniedInteractions,
    overlayFileReads,
    calls,
  };
  if (deniedInteractions > 0) {
    note(
      IntentViolationSeverity.Info,
      `${deniedInteractions} intent-context call(s) were refused by the host and delivered no intent`,
    );
  }

  if (input.arm === 'baseline') {
    if (delivered.length > 0) {
      note(
        IntentViolationSeverity.Hard,
        `baseline leak: ${delivered.length} intent-context interaction(s) answered in an arm that was not given the capability`,
      );
    }
    if (overlayFileReads > 0) {
      note(
        IntentViolationSeverity.Hard,
        `overlay contamination: ${overlayFileReads} direct read(s) of ${OVERLAY_PATH_FRAGMENT}`,
      );
    }
    // A control that was reached by intent cannot serve as the control: every
    // AC-12 population it feeds (pass rate, judge sensitivity) would compare the
    // intent arm against a dirty baseline. Detection is best-effort — substring
    // matching on tool inputs is a LOWER BOUND on overlay reads — so this flags
    // contamination it can see and never claims the absence of any.
    const contaminated = delivered.length > 0 || overlayFileReads > 0;
    return {
      arm: input.arm,
      verdict: contaminated ? IntentAc10Verdict.ContaminatedControl : IntentAc10Verdict.NotApplicable,
      ...base,
      ...verdictFields(),
    };
  }

  if (delivered.length === 0) {
    note(
      IntentViolationSeverity.Hard,
      'no intent-context interaction was answered: the arm had the capability and never used it',
    );
    return {
      arm: input.arm,
      verdict: IntentAc10Verdict.NoAdoption,
      ...base,
      interactions: 0,
      broadLookups: 0,
      exactIdCalls: 0,
      ...verdictFields(),
    };
  }

  if (broadByKind[IntentLookupKind.SelectorLess] > 0) {
    note(
      IntentViolationSeverity.Hard,
      `${broadByKind[IntentLookupKind.SelectorLess]} selector-less call(s) (no intentIds, query or nodeIds) — ` +
        'the engine answers those with every accepted item up to the limit, the broadest lookup there is',
    );
  }
  if (broadByKind[IntentLookupKind.Mixed] > 0) {
    // Informational: the COST of a mixed call is already carried by the
    // broad-lookup budget finding below, which is where it is weighed.
    note(
      IntentViolationSeverity.Info,
      `${broadByKind[IntentLookupKind.Mixed]} call(s) combined intentIds with a query/nodeIds — ` +
        'the engine still runs the discovery half, so this is a broad lookup, not an exact fetch',
    );
  }

  if (routed.size > 0) {
    if (broadLookups > 0) {
      // A routed stage's broad-lookup budget is zero, so any broad lookup is an
      // overrun of it — the same class of slip as the second lookup on an open
      // stage, and rate-bounded for the same reason.
      note(
        IntentViolationSeverity.Soft,
        `${broadLookups} broad lookup(s) on a task that routed exact ids (${[...routed].join(', ')}) — BR-8 requires reusing them`,
      );
    }
    if (missingRoutedIds.length > 0) {
      note(
        IntentViolationSeverity.Hard,
        `routed ids never fetched: ${missingRoutedIds.join(', ')} — the brief handed them over and no call asked for them`,
      );
    }
    if (unroutedIds.length > 0) {
      note(
        IntentViolationSeverity.Hard,
        `fetched id(s) nobody routed and no response returned: ${unroutedIds.join(', ')}`,
      );
    }
    if (derivedIds.length > 0) {
      note(
        IntentViolationSeverity.Info,
        `fetched id(s) derived from earlier responses: ${derivedIds.join(', ')} — ` +
          'exact-ID navigation along the overlay, allowed by D9',
      );
    }
  } else if (broadLookups > 1) {
    note(
      IntentViolationSeverity.Soft,
      `${broadLookups} broad lookups in one stage — at most one is allowed (ADR-3)`,
    );
  }

  if (overlayFileReads > 0) {
    note(
      IntentViolationSeverity.Hard,
      `overlay contamination: ${overlayFileReads} direct read(s) of ${OVERLAY_PATH_FRAGMENT} bypassing the bounded read surface`,
    );
  }

  const violated =
    (routed.size > 0
      ? broadLookups > 0 || unroutedIds.length > 0 || missingRoutedIds.length > 0
      : broadLookups > 1) || overlayFileReads > 0;

  return {
    arm: input.arm,
    verdict: violated ? IntentAc10Verdict.Violation : IntentAc10Verdict.Pass,
    ...base,
    ...verdictFields(),
  };
}

/**
 * The analysis for a run that never produced a transcript (the agent call threw
 * before one was written). Its own verdict, so a crash is neither a silent
 * omission from the denominators nor a fake AC-10 violation.
 */
export function noTranscriptAnalysis(arm: IntentArmId, error: string): IntentRunAnalysis {
  return {
    arm,
    verdict: IntentAc10Verdict.NoTranscript,
    interactions: 0,
    broadLookups: 0,
    exactIdCalls: 0,
    indexCalls: 0,
    fetchedIds: [],
    derivedIds: [],
    unroutedIds: [],
    missingRoutedIds: [],
    broadByKind: {
      [IntentLookupKind.Exact]: 0,
      [IntentLookupKind.Discovery]: 0,
      [IntentLookupKind.SelectorLess]: 0,
      [IntentLookupKind.Mixed]: 0,
      [IntentLookupKind.Index]: 0,
    },
    deniedInteractions: 0,
    overlayFileReads: 0,
    reasons: [`the run produced no transcript: ${error}`],
    // A crash is not an observed protocol violation of either weight: it
    // degrades the run through its own verdict, it is not classified here.
    hardViolations: [],
    softViolations: [],
    calls: [],
  };
}
