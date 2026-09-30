import { resolve } from 'node:path';
import { offendingBashToken, offendingToolPath } from './agent.js';
import type { ConfinementBreach } from './types.js';

/**
 * Post-hoc audit of the EXPLICIT out-of-root paths in a completed Claude
 * transcript.
 *
 * It re-reads the finished transcript and records typed path arguments
 * (Read/Grep/Glob) and Bash command-string tokens that name a location outside
 * the declared roots and whose tool call still returned successfully — i.e. the
 * cases the live envelope judged by the same rule but did not stop, so an answer
 * sourced from an unevaluated revision is visible in the report.
 *
 * RESIDUAL RISK (accepted, same as the live envelope's — see safeBashCommand in
 * agent.ts): it judges the recorded call by exactly the rule the live pass used,
 * so a path produced at runtime — variable expansion, command substitution,
 * base64/quoted paths, `cd` through a symlink, or an escape a child process
 * performs on its own — is not detectable from the transcript and passes both.
 * This is a breach *record*, not a proof of confinement, and that gap is the
 * accepted residual of worktree mode.
 */

interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

const PATH_ARG_TOOLS: Record<string, string> = {
  Read: 'file_path',
  Grep: 'path',
  Glob: 'path',
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageContent(value: unknown): unknown[] {
  const message = record(record(value)?.message);
  return Array.isArray(message?.content) ? message.content : [];
}

/** Defensive parse: a malformed or truncated transcript yields no breaches. */
function parseTranscript(transcriptText: string): {
  toolUses: ToolUse[];
  errorResultIds: Set<string>;
  resultIds: Set<string>;
} {
  let messages: unknown[] = [];
  try {
    const parsed = JSON.parse(transcriptText) as unknown;
    if (Array.isArray(parsed)) messages = parsed;
  } catch {
    messages = [];
  }
  const toolUses: ToolUse[] = [];
  const errorResultIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    for (const blockValue of messageContent(message)) {
      const block = record(blockValue);
      if (!block) continue;
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        toolUses.push({ id: block.id, name: block.name, input: record(block.input) ?? {} });
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        resultIds.add(block.tool_use_id);
        if (block.is_error === true) errorResultIds.add(block.tool_use_id);
      }
    }
  }
  return { toolUses, errorResultIds, resultIds };
}

export function auditTranscriptConfinement(opts: {
  transcriptText: string;
  roots: readonly string[];
}): ConfinementBreach[] {
  const roots = opts.roots.map((root) => resolve(root));
  if (roots.length === 0) return [];
  const { toolUses, errorResultIds, resultIds } = parseTranscript(opts.transcriptText);
  const breaches: ConfinementBreach[] = [];
  for (const use of toolUses) {
    const pathArg = PATH_ARG_TOOLS[use.name];
    const offending =
      pathArg !== undefined
        ? offendingToolPath(roots, use.input[pathArg])
        : use.name === 'Bash' && typeof use.input.command === 'string'
          ? offendingBashToken(roots, use.input.command)
          : null;
    if (offending === null) continue;
    // A denied attempt is the envelope working, not a breach. A call with no
    // result at all proves nothing either — the run may have been aborted
    // before it ran — so only a completed, non-error result counts.
    if (!resultIds.has(use.id) || errorResultIds.has(use.id)) continue;
    breaches.push({ toolName: use.name, path: offending, toolUseId: use.id });
  }
  return breaches;
}
