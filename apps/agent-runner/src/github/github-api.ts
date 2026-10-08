/**
 * The runner's GitHub REST calls, made with the bot's token. Server errors,
 * rate limits and network failures retry in process up to three times,
 * honouring Retry-After (capped); a redirect is a moved repository.
 */
import type { AssignedRepository } from '@coredoc/core/agent-runner';
import { defaultRetryDelay, GITHUB_ATTEMPTS, type RetryDelay, sleep, TurnFailure } from '../turn-failure.js';

export const GITHUB_API_VERSION = '2022-11-28';

/** The start-up check reads at most this many repositories the bot can see. */
const BOT_CHECK_PAGE_SIZE = 100;
const BOT_CHECK_MAX_PAGES = 10;

export interface GithubApiOptions {
  token: string;
  fetchImpl?: typeof fetch;
  retryDelay?: RetryDelay;
}

type Attempt = { kind: 'ok'; response: Response } | { kind: 'retry'; reason: string; retryAfterMs: number | null };

function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export class GithubApi {
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelay: RetryDelay;

  constructor(private readonly options: GithubApiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  /**
   * Fails the run before any session starts when the bot is an admin or a
   * maintainer of the repository, or cannot read it. This catches a
   * misconfigured account; it is not a control against a compromised agent.
   */
  async checkBotPermissions(repository: AssignedRepository): Promise<void> {
    const { owner, name } = repository.github;
    const label = `${owner}/${name}`;
    const response = await this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, repository);
    if (response.status >= 300 && response.status < 400) {
      throw new TurnFailure('repository_not_eligible', `GitHub reports that ${label} moved; update its remote.`);
    }
    if (!response.ok) {
      throw new TurnFailure(
        'repository_not_eligible',
        `${label} is not readable with the bot's token (GitHub answered ${response.status}).`,
      );
    }
    const body = (await response.json().catch(() => ({}))) as { permissions?: Record<string, unknown> };
    if (body.permissions?.admin === true || body.permissions?.maintain === true) {
      throw new TurnFailure(
        'repository_not_eligible',
        `The bot account has admin or maintain permission on ${label}; agent runs need an account with the Write role only.`,
      );
    }
  }

  /**
   * The start-up check: why the bot account must not run, or null. An admin or
   * maintainer of any repository it can see could change branch protection
   * or merge, so the runner claims nothing until it has the Write role only.
   */
  async botAccountProblem(apiBaseUrl: string): Promise<string | null> {
    const base = apiBaseUrl.replace(/\/+$/, '');
    try {
      for (let page = 1; page <= BOT_CHECK_MAX_PAGES; page += 1) {
        const response = await this.fetchWithRetries(
          `${base}/user/repos?per_page=${BOT_CHECK_PAGE_SIZE}&page=${page}`,
          'the bot account',
        );
        if (!response.ok) return `GitHub refused to list the bot's repositories (HTTP ${response.status}).`;
        const repositories = (await response.json().catch(() => [])) as Array<{
          full_name?: string;
          permissions?: Record<string, unknown>;
        }>;
        const elevated = repositories.find(
          (repo) => repo.permissions?.admin === true || repo.permissions?.maintain === true,
        );
        if (elevated) {
          return `The bot account has admin or maintain permission on ${elevated.full_name ?? 'a repository'}; agent runs need an account with the Write role only.`;
        }
        if (repositories.length < BOT_CHECK_PAGE_SIZE) return null;
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private get(path: string, repository: AssignedRepository): Promise<Response> {
    return this.fetchWithRetries(`${repository.github.apiBaseUrl.replace(/\/+$/, '')}${path}`, repository.key);
  }

  private async fetchWithRetries(url: string, label: string): Promise<Response> {
    let last = '';
    for (let attempt = 1; attempt <= GITHUB_ATTEMPTS; attempt += 1) {
      const result = await this.attempt(url);
      if (result.kind === 'ok') return result.response;
      last = result.reason;
      if (attempt < GITHUB_ATTEMPTS) await sleep(this.retryDelay(attempt, result.retryAfterMs));
    }
    throw new TurnFailure('github_error', `GitHub kept failing for ${label}: ${last}`);
  }

  private async attempt(url: string): Promise<Attempt> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.options.token}`,
          'x-github-api-version': GITHUB_API_VERSION,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return { kind: 'retry', reason: error instanceof Error ? error.message : String(error), retryAfterMs: null };
    }
    const rateLimited =
      response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    if (rateLimited || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'retry', reason: `HTTP ${response.status}`, retryAfterMs: retryAfter(response) };
    }
    return { kind: 'ok', response };
  }
}
