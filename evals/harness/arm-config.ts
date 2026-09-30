// evals/harness/arm-config.ts
import type { Arm } from './types.js';
import type { ArmSpec } from './planning-types.js';

const PLAN_SYSTEM = `You are a senior engineer operating in PLAN MODE on a multi-repo codebase.
Investigate the code thoroughly (read-only — you cannot modify anything), then produce a COMPLETE
implementation spec for the requested change. Your FINAL message MUST be that spec, in markdown, and
nothing else. Cite concrete file paths in backticks and name the exact functions/classes/types to
change. You are running autonomously: do NOT ask the user any questions — state any assumptions
explicitly inline and proceed.`;

const SUPERPOWERS_SYSTEM = `You are a senior engineer. Use the superpowers brainstorming skill to turn
the task below into a complete implementation spec. You are running AUTONOMOUSLY: you cannot ask the
user questions and you cannot write files — instead, state assumptions inline, act as your own approval
gate at every step, and EMIT THE FINAL SPEC AS YOUR LAST MESSAGE in markdown (do not write it to a file,
do not proceed to code). Cite concrete file paths in backticks and name exact functions/classes/types.`;

const MCP_HINT = `

The coredoc MCP tools (mcp__coredoc-eval__*) and the coredoc-mcp skill are available. Use them to ground your
plan in the actual parsed code graph — especially for cross-repo / cross-service call paths.`;

export interface ArmRunConfig {
  systemPrompt: string;
  runAgentArm: Arm;
  skills?: string[];
  pluginPaths?: string[];
}

export function armToRunConfig(
  arm: ArmSpec,
  ctx: { coredocPluginDir: string; superpowersPluginDir: string },
): ArmRunConfig {
  const base = arm.workflow === 'plan' ? PLAN_SYSTEM : SUPERPOWERS_SYSTEM;
  const systemPrompt = arm.mcp ? base + MCP_HINT : base;

  const skills: string[] = [];
  const pluginPaths: string[] = [];

  if (arm.workflow === 'superpowers') {
    pluginPaths.push(ctx.superpowersPluginDir);
    skills.push('superpowers:using-superpowers', 'superpowers:brainstorming');
  }
  if (arm.mcp) {
    pluginPaths.push(ctx.coredocPluginDir);
    skills.push('coredoc-eval-skills:coredoc-mcp');
  }

  return {
    systemPrompt,
    runAgentArm: arm.mcp ? 'withMcp' : 'withoutMcp',
    skills: skills.length ? skills : undefined,
    pluginPaths: pluginPaths.length ? pluginPaths : undefined,
  };
}
