/**
 * The in-process run-control MCP server. Its name has no "coredoc" segment:
 * the plugin counts calls to any "coredoc" server as Coredoc MCP writes.
 * Each tool forwards to the runner API and returns the server's verdict.
 * `propose_scope` exists in scope turns, `submit_result` in implement turns.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { ProposeScopeRequestSchema, SubmitResultRequestSchema, type TurnKind } from '@coredoc/core/agent-runner';
import type { TurnIO } from '../runner.js';

export const RUN_CONTROL_SERVER = 'agent_run';

/** What the turn's run-control calls achieved; the end-of-turn classification reads it. */
export interface RunControlState {
  proposedVersion: number | null;
  /** True once the server recorded this turn's `submit_result`. */
  submitted: boolean;
  /**
   * Set by the session to end the turn: further tool calls are refused with
   * the reason, and the session is stopped if it does not end by itself.
   */
  endTurn?: (reason: string) => void;
}

export const TURN_OVER_AFTER_RESULT =
  'Your result is recorded and your turn is over: the runner now commits and pushes your changes. Do not call any more tools; end your turn now.';

function rejected(name: string, errors: string[]) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: `The call was not recorded. Fix these and call ${name} again:\n- ${errors.join('\n- ')}`,
      },
    ],
  };
}

export function runControlServer(io: TurnIO, state: RunControlState, kind: TurnKind = 'scope') {
  const proposeScope = tool(
    'propose_scope',
    'Propose the scope of this run: the specification and the repositories it affects. Errors list the rules to fix.',
    ProposeScopeRequestSchema.shape,
    async (args) => {
      const answer = await io.proposeScope(args);
      if (!answer.accepted) return rejected('propose_scope', answer.errors);
      state.proposedVersion = answer.version;
      return {
        content: [
          {
            type: 'text',
            text: `Scope version ${answer.version} is recorded and goes to reviewers when your turn ends. Close the plugin's spec run and end your turn; call propose_scope again only to replace this proposal.`,
          },
        ],
      };
    },
  );
  const submitResult = tool(
    'submit_result',
    'Finish the implementation: a summary, what changed per repository, assumptions, repositories that could not be built or tested here, and notes. It ends your turn.',
    SubmitResultRequestSchema.shape,
    async (args) => {
      const answer = await io.submitResult(args);
      if (!answer.accepted) return rejected('submit_result', answer.errors);
      state.submitted = true;
      state.endTurn?.(TURN_OVER_AFTER_RESULT);
      return { content: [{ type: 'text', text: TURN_OVER_AFTER_RESULT }] };
    },
  );
  return createSdkMcpServer({
    name: RUN_CONTROL_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    tools: kind === 'implement' ? [submitResult] : [proposeScope],
  });
}
