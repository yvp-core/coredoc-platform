/** No "coredoc" segment in the server name: the plugin counts calls to any "coredoc" server as Coredoc MCP writes. */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  type AssignedRepository,
  ProposeScopeRequestSchema,
  RequestRepoRequestSchema,
  SubmitResultRequestSchema,
  TurnKind,
} from '@coredoc/core/agent-runner';
import type { TurnIO } from '../runner.js';

export const RUN_CONTROL_SERVER = 'agent_run';

export interface RunControlState {
  proposedVersion: number | null;
  submitted: boolean;
  repositoryRequested?: boolean;
  /** Implement turns only; throws when the repository cannot be used, which fails the turn. */
  cloneRepository?: (repository: AssignedRepository) => Promise<string>;
  /** Further tool calls are refused with the reason; a session that does not then end itself is stopped. */
  endTurn?: (reason: string) => void;
}

export const TURN_OVER_AFTER_RESULT =
  'Your result is recorded and your turn is over: the runner now commits and pushes your changes. Do not call any more tools; end your turn now.';

export const TURN_OVER_AFTER_REQUEST =
  'Your repository request is recorded and a person decides whether to add it; your turn is over. The runner now commits and pushes your changes, and the decision arrives when your session resumes. Do not call any more tools; end your turn now.';

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

export function runControlServer(io: TurnIO, state: RunControlState, kind: TurnKind = TurnKind.Scope) {
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
  const requestRepo = tool(
    'request_repo',
    'Ask for a repository the accepted scope left out, by its durable repository key, with the reason. It answers with the path of its clone, or says a person decides (which ends your turn), or lists the rules the request broke.',
    RequestRepoRequestSchema.shape,
    async (args) => {
      const answer = await io.requestRepo(args);
      if (answer.state === 'rejected') return rejected('request_repo', answer.errors);
      if (answer.state === 'requested') {
        state.repositoryRequested = true;
        state.endTurn?.(TURN_OVER_AFTER_REQUEST);
        return { content: [{ type: 'text', text: TURN_OVER_AFTER_REQUEST }] };
      }
      let path: string;
      try {
        path = await state.cloneRepository!(answer.repository);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text', text: `${reason} Your turn is over; end it now.` }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Repository ${answer.repository.key} is in this run and cloned at ${path}, on the run branch. Set it up and work in it like the other repositories.`,
          },
        ],
      };
    },
  );
  return createSdkMcpServer({
    name: RUN_CONTROL_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    tools: kind === TurnKind.Implement ? [requestRepo, submitResult] : [proposeScope],
  });
}
