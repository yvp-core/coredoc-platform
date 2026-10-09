import type { AssignedRepository } from '@coredoc/core/agent-runner';
import { type RetryDelay, TurnFailure } from '../turn-failure.js';
import { GithubApi } from './github-api.js';

/** The bot account the runner works as on GitHub: its token and the commit identity. */
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
  if (!options.bot) throw new TurnFailure('github_error', 'The runner has no GitHub bot token configured.');
  return options.bot;
}

/** GitHub's REST API as the bot. */
export function botGithub(options: BotGithubOptions): GithubApi {
  return new GithubApi({
    token: requireBot(options).token,
    fetchImpl: options.githubFetch,
    retryDelay: options.retryDelay,
  });
}

/** The bot must be neither admin nor maintainer where the run may work. */
export async function checkBotPermissions(
  options: BotGithubOptions,
  repositories: AssignedRepository[],
): Promise<void> {
  if (repositories.length === 0) return;
  const github = botGithub(options);
  for (const repository of repositories) await github.checkBotPermissions(repository);
}
