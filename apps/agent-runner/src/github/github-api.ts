/** Server errors, rate limits and network failures retry in process, honouring Retry-After (capped). */
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type AssignedRepository,
  defaultRetryDelay,
  type RetryDelay,
  RunFailureCode,
  type RunnerFailureCode,
  RunnerStartupProblemCode,
} from '@coredoc/core/agent-runner';
import { GITHUB_ATTEMPTS, TurnFailure } from '../turn-failure.js';
import type { StartupProblem } from '../runner.js';

export interface ExistingPull {
  number: number;
  open: boolean;
}

/** `ambiguous`: look the pull request up before retrying. */
export type CreateResult = { kind: 'created'; number: number } | { kind: 'no_commits' } | { kind: 'ambiguous' };

const label = (repository: AssignedRepository) => `${repository.github.owner}/${repository.github.name}`;

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

  /** Catches a misconfigured bot account; it is not a control against a compromised agent. */
  async checkBotPermissions(repository: AssignedRepository): Promise<void> {
    const { owner, name } = repository.github;
    const label = `${owner}/${name}`;
    const response = await this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, repository);
    if (response.status >= 300 && response.status < 400) {
      throw new TurnFailure(
        RunFailureCode.RepositoryNotEligible,
        `GitHub reports that ${label} moved; update its remote.`,
      );
    }
    if (!response.ok) {
      throw new TurnFailure(
        RunFailureCode.RepositoryNotEligible,
        `${label} is not readable with the bot's token (GitHub answered ${response.status}).`,
      );
    }
    const body = (await response.json().catch(() => ({}))) as { permissions?: Record<string, unknown> };
    if (body.permissions?.admin === true || body.permissions?.maintain === true) {
      throw new TurnFailure(
        RunFailureCode.RepositoryNotEligible,
        `The bot account has admin or maintain permission on ${label}; agent runs need an account with the Write role only.`,
      );
    }
  }

  async defaultBranch(repository: AssignedRepository, failure: RunnerFailureCode): Promise<string> {
    const response = await this.ok(await this.get(this.repoPath(repository), repository, failure), repository, failure);
    const body = (await response.json().catch(() => ({}))) as { default_branch?: unknown };
    if (typeof body.default_branch !== 'string' || !body.default_branch) {
      throw new TurnFailure(failure, `GitHub did not report the default branch of ${label(repository)}.`);
    }
    return body.default_branch;
  }

  async findPullByHead(
    repository: AssignedRepository,
    branch: string,
    failure: RunnerFailureCode,
  ): Promise<ExistingPull | null> {
    const query = new URLSearchParams({ head: `${repository.github.owner}:${branch}`, state: 'all', per_page: '30' });
    const response = await this.ok(
      await this.get(`${this.repoPath(repository)}/pulls?${query}`, repository, failure),
      repository,
      failure,
    );
    const pulls = ((await response.json().catch(() => [])) as Array<{ number?: unknown; state?: unknown }>).filter(
      (pull): pull is { number: number; state: string } => typeof pull.number === 'number',
    );
    const pull = pulls.find((candidate) => candidate.state === 'open') ?? pulls[0];
    return pull ? { number: pull.number, open: pull.state === 'open' } : null;
  }

  /** Never retried here: after an ambiguous answer the caller looks the pull request up by head first. */
  async createDraftPull(
    repository: AssignedRepository,
    pull: { title: string; body: string; head: string; base: string },
  ): Promise<CreateResult> {
    const result = await this.attempt(`${this.base(repository)}${this.repoPath(repository)}/pulls`, 'POST', {
      ...pull,
      draft: true,
    });
    if (result.kind === 'retry') return { kind: 'ambiguous' };
    const { response } = result;
    if (response.status === 201) {
      const body = (await response.json().catch(() => ({}))) as { number?: unknown };
      return typeof body.number === 'number' ? { kind: 'created', number: body.number } : { kind: 'ambiguous' };
    }
    if (response.status === 422) {
      const body = (await response.json().catch(() => ({}))) as { message?: unknown; errors?: unknown };
      return /no commits between/i.test(JSON.stringify(body)) ? { kind: 'no_commits' } : { kind: 'ambiguous' };
    }
    await this.ok(response, repository, RunFailureCode.DeliveryFailed);
    return { kind: 'ambiguous' };
  }

  /** A repeated update is harmless, so it retries. */
  async updatePullBody(repository: AssignedRepository, number: number, body: string): Promise<void> {
    await this.ok(
      await this.send(
        'PATCH',
        `${this.repoPath(repository)}/pulls/${number}`,
        repository,
        RunFailureCode.DeliveryFailed,
        { body },
      ),
      repository,
      RunFailureCode.DeliveryFailed,
    );
  }

  private repoPath(repository: AssignedRepository): string {
    return `/repos/${encodeURIComponent(repository.github.owner)}/${encodeURIComponent(repository.github.name)}`;
  }

  private base(repository: AssignedRepository): string {
    return repository.github.apiBaseUrl.replace(/\/+$/, '');
  }

  /** A redirect means the repository moved; any other refusal is permanent for this turn. */
  private async ok(response: Response, repository: AssignedRepository, failure: RunnerFailureCode): Promise<Response> {
    if (response.ok) return response;
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400) {
      throw new TurnFailure(failure, `GitHub reports that ${label(repository)} moved; update its remote.`);
    }
    throw new TurnFailure(failure, `GitHub refused a request for ${label(repository)} (HTTP ${response.status}).`);
  }

  private get(path: string, repository: AssignedRepository, failure: RunnerFailureCode = RunFailureCode.GithubError) {
    return this.send('GET', path, repository, failure);
  }

  private send(
    method: 'GET' | 'PATCH',
    path: string,
    repository: AssignedRepository,
    failure: RunnerFailureCode,
    body?: unknown,
  ): Promise<Response> {
    return this.fetchWithRetries(`${this.base(repository)}${path}`, repository.key, method, failure, body);
  }

  /** An admin or maintainer could change branch protection or merge, so the bot must have the Write role only. */
  async botAccountProblem(apiBaseUrl: string): Promise<StartupProblem | null> {
    const base = apiBaseUrl.replace(/\/+$/, '');
    try {
      for (let page = 1; page <= BOT_CHECK_MAX_PAGES; page += 1) {
        const response = await this.fetchWithRetries(
          `${base}/user/repos?per_page=${BOT_CHECK_PAGE_SIZE}&page=${page}`,
          'the bot account',
        );
        if (!response.ok) return { code: RunnerStartupProblemCode.BotUnreadable, detail: `HTTP ${response.status}` };
        const repositories = (await response.json().catch(() => [])) as Array<{
          full_name?: string;
          permissions?: Record<string, unknown>;
        }>;
        const elevated = repositories.find(
          (repo) => repo.permissions?.admin === true || repo.permissions?.maintain === true,
        );
        if (elevated) {
          return {
            code: RunnerStartupProblemCode.BotAdmin,
            ...(elevated.full_name ? { detail: elevated.full_name } : {}),
          };
        }
        if (repositories.length < BOT_CHECK_PAGE_SIZE) return null;
      }
      return null;
    } catch (error) {
      return {
        code: RunnerStartupProblemCode.BotUnreadable,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async fetchWithRetries(
    url: string,
    label: string,
    method = 'GET',
    failure: RunnerFailureCode = RunFailureCode.GithubError,
    body?: unknown,
  ): Promise<Response> {
    let last = '';
    for (let attempt = 1; attempt <= GITHUB_ATTEMPTS; attempt += 1) {
      const result = await this.attempt(url, method, body);
      if (result.kind === 'ok') return result.response;
      last = result.reason;
      if (attempt < GITHUB_ATTEMPTS) await sleep(this.retryDelay(attempt, result.retryAfterMs));
    }
    throw new TurnFailure(failure, `GitHub kept failing for ${label}: ${last}`);
  }

  private async attempt(url: string, method = 'GET', body?: unknown): Promise<Attempt> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.options.token}`,
          'x-github-api-version': GITHUB_API_VERSION,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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
