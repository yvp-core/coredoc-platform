import { TreatmentAdherence } from './types.js';
import type {
  AgentStatus,
  JudgeStatus,
  RunRecord,
  RunnableLifecycle,
  ToolCallSummary,
} from './types.js';

export type NormalizedLifecycle = RunnableLifecycle | 'legacy';

/** Namespace prefix the Claude SDK and the codex runner both use for MCP tools. */
const MCP_TOOL_PREFIX = 'mcp__';

/** Treatment dose of one run: MCP tool calls completed. */
export function mcpDoseOf(toolCalls: readonly ToolCallSummary[] | undefined): number {
  return (toolCalls ?? [])
    .filter(({ name }) => name.startsWith(MCP_TOOL_PREFIX))
    .reduce((sum, { count }) => sum + count, 0);
}

export interface NormalizedRunRecord extends Omit<RunRecord, 'lifecycle'> {
  lifecycle: NormalizedLifecycle;
  agentStatus: AgentStatus;
  judgeStatus: JudgeStatus;
  treatmentAdherence: TreatmentAdherence;
  mcpDose: number;
  legacyInference: {
    agentStatus: boolean;
    judgeStatus: boolean;
    lifecycle: boolean;
  };
}

function inferAgentStatus(record: RunRecord): AgentStatus {
  const error = record.agent.error;
  if (!error) return 'completed';
  return /timeout|timed[_ -]?out|max[_ -]?turn|max[_ -]?budget|structured[_ -]?output/i.test(error)
    ? 'task_failed'
    : 'infrastructure_error';
}

function inferJudgeStatus(record: RunRecord, agentStatus: AgentStatus): JudgeStatus {
  if (agentStatus !== 'completed') return 'not_run';
  const raw = record.judge.raw?.trim() ?? '';
  const hasDimensions = (record.judge.dimensions?.length ?? 0) > 0;
  if (/^judge failed:/i.test(raw) || (!raw && !hasDimensions)) return 'missing';
  return typeof record.judge.score === 'number' ? 'completed' : 'missing';
}

/**
 * The single compatibility boundary for historical results.jsonl. New code
 * consumes this normalized shape instead of scattering legacy guesses across
 * reports and rejudge tooling.
 */
export function normalizeRunRecord(input: unknown): NormalizedRunRecord {
  const record = input as RunRecord;
  if (!record || typeof record !== 'object' || !record.agent || !record.judge) {
    throw new Error('Invalid RunRecord: agent and judge objects are required.');
  }
  const explicitAgent = record.agentStatus ?? record.agent.agentStatus;
  const agentStatus = explicitAgent ?? inferAgentStatus(record);
  const explicitJudge = record.judgeStatus ?? record.judge.judgeStatus;
  const judgeStatus =
    agentStatus === 'completed'
      ? (explicitJudge ?? inferJudgeStatus(record, agentStatus))
      : 'not_run';
  const lifecycle = record.lifecycle ?? 'legacy';
  // Records written before adherence was split from quality carry no field at
  // all; they are read as not_applicable rather than guessed from tool calls,
  // because those runs were already classified (and scored) under the old
  // treatment-integrity rule. Historical artifacts are never rewritten.
  const treatmentAdherence =
    record.treatmentAdherence ??
    record.agent.treatmentAdherence ??
    TreatmentAdherence.NotApplicable;
  return {
    ...record,
    lifecycle,
    agentStatus,
    judgeStatus,
    treatmentAdherence,
    // Unlike adherence, dose needs no guess for legacy records: it is plain
    // arithmetic over toolCalls the record already carries, so it is derived
    // rather than counted as a legacy inference.
    mcpDose: record.mcpDose ?? mcpDoseOf(record.agent.toolCalls),
    agent: { ...record.agent, agentStatus, treatmentAdherence },
    judge: {
      ...record.judge,
      judgeStatus,
      score: judgeStatus === 'completed' ? record.judge.score : null,
    },
    legacyInference: {
      agentStatus: explicitAgent === undefined,
      judgeStatus: explicitJudge === undefined,
      lifecycle: record.lifecycle === undefined,
    },
  };
}

export function normalizeRunRecords(inputs: readonly unknown[]): NormalizedRunRecord[] {
  return inputs.map(normalizeRunRecord);
}
