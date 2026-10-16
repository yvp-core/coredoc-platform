import { defaultRetryDelay, type TurnAssignment } from '@coredoc/core/agent-runner';
import { type BotGithubOptions, botGithub, checkBotPermissions } from '../github/bot-github.js';
import type { TurnExecutor, TurnIO, TurnResult } from '../runner.js';
import { reportingFailures } from '../turn-failure.js';
import { deliver } from './deliver.js';

/** Delivery turns: no agent session and no scratch, only the bot check and draft pull requests. */
export class DeliveryExecutor implements TurnExecutor {
  constructor(private readonly options: BotGithubOptions) {}

  run(turn: TurnAssignment, io: TurnIO): Promise<TurnResult> {
    return reportingFailures(async () => {
      await checkBotPermissions(this.options, turn.repositories);
      return deliver(turn, io, botGithub(this.options), this.options.retryDelay ?? defaultRetryDelay);
    });
  }
}
