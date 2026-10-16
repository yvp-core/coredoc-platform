import { type AssignedRepository, type RetryDelay, RunFailureCode } from '@coredoc/core/agent-runner';
import { TurnFailure } from '../turn-failure.js';
import { GithubApi } from './github-api.js';

export interface BotAccount {
  token: string;
  name: string;
  email: string;
}

export interface BotGithubOptions {
  /** Needed by turns that touch repositories. */
  bot?: BotAccount;
  githubFetch?: typeof fetch;
  retryDelay?: RetryDelay;
}

export function requireBot(options: BotGithubOptions): BotAccount {
  if (!options.bot) throw new TurnFailure(RunFailureCode.GithubError, 'The runner has no GitHub bot token configured.');
  return options.bot;
}

export function botGithub(options: BotGithubOptions): GithubApi {
  return new GithubApi({
    token: requireBot(options).token,
    fetchImpl: options.githubFetch,
    retryDelay: options.retryDelay,
  });
}

export async function checkBotPermissions(
  options: BotGithubOptions,
  repositories: AssignedRepository[],
): Promise<void> {
  if (repositories.length === 0) return;
  const github = botGithub(options);
  for (const repository of repositories) await github.checkBotPermissions(repository);
}
