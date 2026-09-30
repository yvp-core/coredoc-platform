// evals/harness/planning-types.ts
import type { Usage } from './types.js';

export type PlanningWorkflow = 'plan' | 'superpowers';
export type ArmId = 'A' | 'B' | 'C' | 'D';

export interface ArmSpec {
  id: ArmId;
  workflow: PlanningWorkflow;
  mcp: boolean;
}

/** The 2×2 factorial. Order is stable for report columns. */
export const ARMS: readonly ArmSpec[] = [
  { id: 'A', workflow: 'plan', mcp: false },
  { id: 'B', workflow: 'superpowers', mcp: false },
  { id: 'C', workflow: 'plan', mcp: true },
  { id: 'D', workflow: 'superpowers', mcp: true },
];

export interface PlanningTask {
  id: string;
  title: string;
  /** The brief given to every arm verbatim — NO MCP/tool hints. */
  prompt: string;
  /** Workspace repoKeys this task legitimately spans (for the judge's cwd context). */
  repos: string[];
  primaryRepo: string;
}

export interface PlanningTarget {
  /** Common parent of all workspace repos — the agents' and judge's cwd. */
  workspaceRoot: string;
  dbUrl: string;
  mcpConfigPath: string;
  mcpServerCommand: string;
  /** MCP project scope passed as COREDOC_SCOPE to the server process (e.g. 'project:acme'). Optional until set in cases-planning/target.ts. */
  scope?: string;
}

/** On-disk grounding precision — sourced from the filesystem, never the graph. */
export interface GroundingResult {
  pathRefs: number;
  pathsExisting: number;
  symbolRefs: number;
  symbolsExisting: number;
  /** (pathsExisting + symbolsExisting) / (pathRefs + symbolRefs); 1 = no hallucination. */
  precision: number;
  /** Concrete refs named in the spec that do NOT exist on disk. */
  missing: string[];
}

export interface PairwiseVerdict {
  taskId: string;
  left: ArmId;
  right: ArmId;
  rep: number;
  /** 'LR' = left presented as Spec A; 'RL' = swapped (position-bias control). */
  order: 'LR' | 'RL';
  /**
   * Winner normalised back to the true arm id, or 'tie'. 'invalid' marks a
   * verdict the judge could not produce (unparseable/empty/timed-out output);
   * it is counted separately and excluded from win-rate — never scored as a tie.
   */
  winner: ArmId | 'tie' | 'invalid';
  reason: string;
}

export interface PlanningRunRecord {
  taskId: string;
  arm: ArmId;
  rep: number;
  specPath: string;
  specChars: number;
  usage: Usage;
  grounding: GroundingResult;
  mcpCalls: number;
  mcpEmpty: number;
  toolCalls: number;
  error: string | null;
}
