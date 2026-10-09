/**
 * What the agent did in a run, for the run page's turn lines and drawers:
 * per-turn timing, spend and tool calls, skill and tool counts, and the intent
 * items the agent read and proposed, all from the stored `tool` and `skill`
 * events; and the session transcript, streamed from the run's latest state archive.
 */
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PrismaService } from '../../database/prisma.service.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE, type CloudAgentRunArchiveStore } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunErrorCode, cloudAgentRunError, RunPhase } from './run-states.js';
import { findTranscript, MAX_TRANSCRIPT_BYTES, redactTranscript } from './run-transcript.js';

/** The agent phases with a Claude Code session; delivery runs none. */
export const TRANSCRIPT_PHASES = [RunPhase.Scope, RunPhase.Implement] as const;
export type TranscriptPhase = (typeof TRANSCRIPT_PHASES)[number];

interface ActivityRow {
  turn_id: string | null;
  type: string;
  server: string | null;
  name: string | null;
  is_error: boolean | null;
  count: number;
}

interface IntentIdRow {
  name: string;
  id: string;
}

/** Each list is capped; a run that read more shows the first ones it read. */
const MAX_INTENT_REFS = 100;

/** An intent item the agent read or proposed; an item deleted since keeps only its id. */
export interface IntentRef {
  id: string;
  title: string | null;
  kind: string | null;
  authority: 'candidate' | 'accepted' | 'rejected' | 'superseded' | null;
  /** Domain and feature titles; null for an item on the product root. */
  location: string | null;
}

export interface TranscriptDownload {
  filename: string;
  /** The transcript, masked line by line; its length is known only once it ends. */
  stream: Readable;
}

@Injectable()
export class CloudAgentRunActivityService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOUD_AGENT_RUN_ARCHIVE_STORE) private readonly archives: CloudAgentRunArchiveStore,
  ) {}

  async activity(workspaceId: string, runId: string) {
    const run = await this.prisma.cloudAgentRun.findFirst({ where: { id: runId, workspaceId }, select: { id: true } });
    if (!run) throw runNotFound();
    const turns = await this.prisma.cloudAgentRunTurn.findMany({
      where: { runId, workspaceId },
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        ordinal: true,
        kind: true,
        state: true,
        outcome: true,
        claimedAt: true,
        completedAt: true,
        spendUsd: true,
      },
    });
    // Truncated payloads keep only a preview, so they carry no name and are not counted.
    const rows = await this.prisma.$queryRaw<ActivityRow[]>`
      SELECT turn_id::text AS turn_id, type, payload->>'server' AS server, payload->>'name' AS name,
             (payload->>'isError')::boolean AS is_error, count(*)::int AS count
      FROM cloud_agent_run_events
      WHERE run_id = ${runId}::uuid AND workspace_id = ${workspaceId}::uuid
        AND type IN ('tool', 'skill') AND payload->>'name' IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5`;

    const perTurn = new Map<string, { toolCalls: number; failedToolCalls: number }>();
    const skills = new Map<string, number>();
    const tools = new Map<string, { name: string; server: string | null; count: number }>();
    for (const row of rows) {
      if (!row.name) continue;
      if (row.type === 'skill') {
        skills.set(row.name, (skills.get(row.name) ?? 0) + row.count);
        continue;
      }
      const key = `${row.server ?? ''}\u0000${row.name}`;
      const tool = tools.get(key) ?? { name: row.name, server: row.server, count: 0 };
      tool.count += row.count;
      tools.set(key, tool);
      if (!row.turn_id) continue;
      const turn = perTurn.get(row.turn_id) ?? { toolCalls: 0, failedToolCalls: 0 };
      turn.toolCalls += row.count;
      if (row.is_error) turn.failedToolCalls += row.count;
      perTurn.set(row.turn_id, turn);
    }
    const intent = await this.intentRefs(workspaceId, runId);
    const byCount = <T extends { name: string; count: number }>(a: T, b: T) =>
      b.count - a.count || a.name.localeCompare(b.name);

    return {
      turns: turns.map((turn) => ({
        id: turn.id,
        ordinal: turn.ordinal,
        kind: turn.kind,
        state: turn.state,
        outcome: turn.outcome,
        startedAt: turn.claimedAt?.toISOString() ?? null,
        endedAt: turn.completedAt?.toISOString() ?? null,
        durationSeconds:
          turn.claimedAt && turn.completedAt
            ? Math.max(0, Math.round((turn.completedAt.getTime() - turn.claimedAt.getTime()) / 1000))
            : null,
        spendUsd: turn.spendUsd,
        toolCalls: perTurn.get(turn.id)?.toolCalls ?? 0,
        failedToolCalls: perTurn.get(turn.id)?.failedToolCalls ?? 0,
      })),
      skills: [...skills].map(([name, count]) => ({ name, count })).sort(byCount),
      tools: [...tools.values()].sort(byCount),
      intent,
    };
  }

  /**
   * The intent items the agent's `get_intent_context` calls returned (read) and
   * its `intent_propose` calls created or updated (proposed), first seen first,
   * from the ids the runner reported on those calls. A proposed item is not
   * also listed as read.
   */
  private async intentRefs(workspaceId: string, runId: string): Promise<{ read: IntentRef[]; proposed: IntentRef[] }> {
    const rows = await this.prisma.$queryRaw<IntentIdRow[]>`
      SELECT e.payload->>'name' AS name, ids.id
      FROM cloud_agent_run_events e
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(e.payload->'intentIds') = 'array' THEN e.payload->'intentIds' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS ids(id, n)
      WHERE e.run_id = ${runId}::uuid AND e.workspace_id = ${workspaceId}::uuid AND e.type = 'tool'
        AND e.payload->>'name' IN ('get_intent_context', 'intent_propose')
      ORDER BY e.seq, ids.n`;
    const proposed = new Set<string>();
    const read = new Set<string>();
    for (const row of rows) {
      if (row.name === 'intent_propose' && proposed.size < MAX_INTENT_REFS) proposed.add(row.id);
    }
    for (const row of rows) {
      if (row.name === 'get_intent_context' && !proposed.has(row.id) && read.size < MAX_INTENT_REFS) read.add(row.id);
    }
    if (proposed.size === 0 && read.size === 0) return { read: [], proposed: [] };

    const items = await this.prisma.intentItem.findMany({
      where: { workspaceId, id: { in: [...proposed, ...read] } },
      select: {
        id: true,
        title: true,
        kind: true,
        authority: true,
        domain: { select: { title: true } },
        feature: { select: { title: true } },
      },
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    const ref = (id: string): IntentRef => {
      const item = byId.get(id);
      if (!item) return { id, title: null, kind: null, authority: null, location: null };
      const location = [item.domain?.title, item.feature?.title].filter(Boolean).join(' · ');
      return { id, title: item.title, kind: item.kind, authority: item.authority, location: location || null };
    };
    return { read: [...read].map(ref), proposed: [...proposed].map(ref) };
  }

  /**
   * The phase's Claude Code session transcript (JSONL) from the run's latest
   * state archive, streamed. Without a phase: the implement session once the
   * run has implement turns, the scope session before. Archives are stored
   * unredacted, so every line is masked with the event patterns on the way out.
   */
  async transcript(workspaceId: string, runId: string, phase?: TranscriptPhase): Promise<TranscriptDownload> {
    const run = await this.prisma.cloudAgentRun.findFirst({
      where: { id: runId, workspaceId },
      select: { issueKey: true, stateArchiveKey: true, scopeSessionId: true, implementSessionId: true },
    });
    if (!run) throw runNotFound();
    const chosen =
      phase ??
      ((await this.prisma.cloudAgentRunTurn.count({ where: { runId, workspaceId, kind: RunPhase.Implement } }))
        ? RunPhase.Implement
        : RunPhase.Scope);
    const sessionId = chosen === RunPhase.Implement ? run.implementSessionId : run.scopeSessionId;
    const abort = new AbortController();
    const body = run.stateArchiveKey ? await this.archives.getStream(run.stateArchiveKey, abort.signal) : null;
    if (!body) throw transcriptNotFound(chosen);

    const archive = Readable.from(body);
    archive.once('close', () => abort.abort());
    const found = await findTranscript(archive, sessionId);
    if (found.kind === 'missing') throw transcriptNotFound(chosen);
    if (found.kind === 'too_large') {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.TranscriptTooLarge,
        `The ${chosen} transcript is ${found.size} bytes; downloads are limited to ${MAX_TRANSCRIPT_BYTES} bytes`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const name = run.issueKey.replace(/[^A-Za-z0-9._-]/g, '_');
    const redacted = redactTranscript();
    // Ending or destroying the download releases the archive (see findTranscript).
    pipeline(found.stream, redacted).catch(() => undefined);
    return { filename: `${name}-${chosen}-transcript.jsonl`, stream: redacted };
  }
}

function runNotFound() {
  return cloudAgentRunError(CloudAgentRunErrorCode.RunNotFound, 'Agent run not found', HttpStatus.NOT_FOUND);
}

function transcriptNotFound(phase: TranscriptPhase) {
  return cloudAgentRunError(
    CloudAgentRunErrorCode.TranscriptNotFound,
    `This run has no saved ${phase} transcript`,
    HttpStatus.NOT_FOUND,
  );
}
