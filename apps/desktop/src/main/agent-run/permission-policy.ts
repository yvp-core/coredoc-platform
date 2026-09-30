/**
 * Permission policy for the profile-authoring agent run.
 *
 * Pure and synchronous — NO Electron / fs / SDK imports, so it is trivially unit-testable.
 * The Claude adapter calls `evaluateToolUse` from inside its `canUseTool` callback for every
 * tool except AskUserQuestion (which is interactive). This is the single decision point:
 * the SDK's `allowedTools` is left unset so nothing is auto-approved behind our back.
 *
 * Scope model (matches the old PTY run's trust level of cwd=repo + acceptEdits, but tighter):
 *   - read  within any `readDirs` root (target repo, authoring kit, schema refs, parser storage)
 *   - write within any `writeDirs` root (this repo's parser dir — profile.ts + scratch notes)
 *   - bash  denied except for the exact app-owned score command.
 * Everything else is denied with an INSTRUCTIVE message (never `interrupt`) so the agent can
 * self-correct or fall back to AskUserQuestion rather than dead-ending.
 */

import path from 'node:path';
import { canonicalPath, isCanonicalInside } from '../canonical-path.js';

export interface PolicyContext {
  /** Target repository = cwd. Read + bash scope. */
  repoDir: string;
  /** Subtrees the agent may write to (the repo's parser dir). */
  writeDirs: string[];
  /** Subtrees the agent may read (repo, kit, schema refs, parser storage). */
  readDirs: string[];
  /** Exact command prefixes that are always allowed (the profile score command). */
  safeCommandPrefixes: string[];
  /** App-owned credential/config files that must stay unreadable even when roots overlap. */
  deniedPaths?: string[];
  /**
   * Read-only roots the harness sandbox must allow so the app-owned score command can execute:
   * the Node runtime, the CLI bundle, and the module tree it resolves at runtime. Claude's
   * sandbox reads these through its permissive default; Codex's profile is deny-by-default, so
   * its adapter grants them explicitly. Deliberately NOT part of `readDirs` — the agent's
   * Read/Glob/Grep scope stays limited to the repo + authoring kit.
   */
  toolchainReadDirs?: string[];
}

export type PolicyDecision = { action: 'allow' } | { action: 'deny'; message: string };

const ALLOW: PolicyDecision = { action: 'allow' };

/** Tools that carry no path/host side effects worth gating. */
const ALWAYS_ALLOWED = new Set(['TodoWrite', 'Task', 'ExitPlanMode', 'ToolSearch']);

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'LS']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function isInsideAny(roots: string[], target: string): boolean {
  return roots.some((root) => isCanonicalInside(root, target));
}

function denyRead(ctx: PolicyContext, what: string): PolicyDecision {
  return {
    action: 'deny',
    message:
      `Denied by coredoc policy: this session may read only within the target repo (${ctx.repoDir}) ` +
      `and the authoring kit / schema references. "${what}" is outside that scope. ` +
      `Read a path inside the repo, or use AskUserQuestion if you need the user's help.`,
  };
}

function denyProtectedRead(what: string): PolicyDecision {
  return {
    action: 'deny',
    message:
      `Denied by coredoc policy: "${what}" could expose the workspace credential file. ` +
      "Inspect source files with a narrower path, or use AskUserQuestion if you need the user's help.",
  };
}

function denyWrite(ctx: PolicyContext, what: string): PolicyDecision {
  const writeDir = ctx.writeDirs[0] ?? '(the profile output directory)';
  return {
    action: 'deny',
    message:
      `Denied by coredoc policy: this session may write only within ${writeDir} ` +
      `(the profile output directory). "${what}" is outside that scope. ` +
      `Write the profile and any scratch notes there instead.`,
  };
}

function denyBash(ctx: PolicyContext, why: string): PolicyDecision {
  // The score command is the one tool outside the repo the agent is meant to run, and a denial is
  // usually it reaching for a hand-built variant (a different node binary, a different CLI copy).
  // Restating the allow-listed form is what lets the agent self-correct instead of retrying blind.
  const scoreHint = ctx.safeCommandPrefixes[0]
    ? ` To score a profile, run exactly: ${ctx.safeCommandPrefixes[0]} — that command is allow-listed; ` +
      'hand-built variants pointing at other binaries or copies are not.'
    : '';
  return {
    action: 'deny',
    message:
      `Denied by coredoc policy: this command was blocked (${why}). Only the exact app-owned ` +
      `profile score command is available; arbitrary shell execution is disabled.${scoreHint} ` +
      `Use Read/Glob/Grep for inspection, or AskUserQuestion if you need the user's help.`,
  };
}

export function evaluateToolUse(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): PolicyDecision {
  if (ALWAYS_ALLOWED.has(toolName)) return ALLOW;

  if (READ_TOOLS.has(toolName)) {
    const raw = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
    const target = raw ? (path.isAbsolute(raw) ? raw : path.resolve(ctx.repoDir, raw)) : ctx.repoDir;
    const deniedPaths = ctx.deniedPaths ?? [];
    const canonicalTarget = canonicalPath(target);
    if (!canonicalTarget) return denyRead(ctx, raw ?? ctx.repoDir);
    if (deniedPaths.some((denied) => isCanonicalInside(denied, canonicalTarget))) {
      return denyProtectedRead(raw ?? ctx.repoDir);
    }
    // Grep reads file contents recursively, so refuse a search root containing a protected file.
    if (toolName === 'Grep' && deniedPaths.some((denied) => isCanonicalInside(canonicalTarget, denied))) {
      return denyProtectedRead(raw ?? ctx.repoDir);
    }
    // No explicit path (e.g. a cwd-relative Glob pattern) → stays in cwd, which is the repo.
    if (!raw) return ALLOW;
    return isInsideAny(ctx.readDirs, canonicalTarget) ? ALLOW : denyRead(ctx, raw);
  }

  if (WRITE_TOOLS.has(toolName)) {
    const raw = (input.file_path ?? input.notebook_path) as string | undefined;
    if (!raw) return denyWrite(ctx, '(unspecified path)');
    const target = path.isAbsolute(raw) ? raw : path.resolve(ctx.repoDir, raw);
    return isInsideAny(ctx.writeDirs, target) ? ALLOW : denyWrite(ctx, raw);
  }

  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    if (ctx.safeCommandPrefixes.some((safeCommand) => command.trim() === safeCommand.trim())) return ALLOW;
    return denyBash(ctx, 'arbitrary shell execution is disabled');
  }

  // WebFetch, WebSearch, mcp__*, and anything unrecognized → deny.
  return {
    action: 'deny',
    message:
      `Denied by coredoc policy: the "${toolName}" tool is not available in this profile-authoring ` +
      `session. Work with the repo's files and the score command only, or use AskUserQuestion.`,
  };
}
