/**
 * The in-process run-control MCP server. Its name has no "coredoc" segment:
 * the plugin counts calls to any "coredoc" server as Coredoc MCP writes.
 * Each tool forwards to the runner API and returns the server's verdict.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { ProposeScopeRequestSchema } from '@coredoc/core/agent-runner';
import type { TurnIO } from '../runner.js';

export const RUN_CONTROL_SERVER = 'agent_run';

/** What the turn's run-control calls achieved; the end-of-turn classification reads it. */
export interface RunControlState {
  proposedVersion: number | null;
}

export function runControlServer(io: TurnIO, state: RunControlState) {
  return createSdkMcpServer({
    name: RUN_CONTROL_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool(
        'propose_scope',
        'Propose the scope of this run: the specification and the repositories it affects. Errors list the rules to fix.',
        ProposeScopeRequestSchema.shape,
        async (args) => {
          const answer = await io.proposeScope(args);
          if (!answer.accepted) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `The proposal was not recorded. Fix these and call propose_scope again:\n- ${answer.errors.join('\n- ')}`,
                },
              ],
            };
          }
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
      ),
    ],
  });
}
