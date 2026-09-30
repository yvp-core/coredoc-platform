// Thin typed fetch wrapper over the GitHub REST v3 API (house pattern: native
// fetch, no octokit — see source.service.ts / github-allowlist.provider.ts).
// Error taxonomy maps onto the job-queue classifier: GithubAuthError is thrown
// for 401/404-auth cases (permanent), GithubRateLimitError and plain Error are
// transient and ride the queue's BACKOFF_MS retries.

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BASE_URL_CHARS = 512;

export class GithubRateLimitError extends Error {}
export class GithubAuthError extends Error {}
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`GitHub API ${status} for ${path}`);
  }
}

export interface GithubPr {
  [k: string]: unknown;
}

export interface GithubCommitList {
  items: unknown[];
  /** GitHub advertised another page beyond the retained one-page prefix. */
  incomplete: boolean;
}

/** Validate a GitHub API root before any bearer credential can reach it. */
export function normalizeGithubBaseUrl(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE_URL_CHARS) {
    throw new Error('GitHub baseUrl must contain at most 512 characters');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('GitHub baseUrl must not contain a query or fragment');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('GitHub baseUrl must be an absolute HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
    throw new Error('GitHub baseUrl must be an absolute HTTPS URL with a host');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('GitHub baseUrl must not contain credentials');
  }

  const normalized = parsed.toString().replace(/\/+$/, '');
  if (normalized.length === 0 || normalized.length > MAX_BASE_URL_CHARS) {
    throw new Error('GitHub baseUrl must contain at most 512 characters');
  }
  return normalized;
}

export class GithubClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(opts: { token: string; baseUrl?: string; userAgent?: string }) {
    this.token = opts.token;
    this.baseUrl = normalizeGithubBaseUrl(opts.baseUrl ?? 'https://api.github.com');
    this.userAgent = opts.userAgent ?? 'coredoc-server';
  }

  /**
   * One request builder for both media types — the JSON reads below and the raw contents
   * read. It returns the raw `Response`: the status taxonomy differs per media type (a 404
   * is an error for a JSON read and a named unavailability for a contents read), so it is
   * layered by each caller rather than decided here.
   */
  private async send(path: string, accept: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: accept, 'User-Agent': this.userAgent },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      redirect: 'error',
    });
  }

  private async getResponse(path: string): Promise<Response> {
    const res = await this.send(path, 'application/vnd.github+json');
    if (res.status === 401) throw new GithubAuthError(`GitHub auth failed (401) for ${path}`);
    if (
      res.status === 429 ||
      (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))
    ) {
      throw new GithubRateLimitError(`GitHub rate limit exhausted for ${path}`);
    }
    if (!res.ok) throw new GithubApiError(res.status, path);
    return res;
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.getResponse(path);
    return res.json();
  }

  private async getArray(path: string): Promise<unknown[]> {
    const body = await this.get(path);
    return Array.isArray(body) ? body : [];
  }

  async listPullsUpdatedSince(owner: string, repo: string, since: string | null, maxPages = 10): Promise<GithubPr[]> {
    const out: GithubPr[] = [];
    const sinceMs = since ? new Date(since).getTime() : null;
    for (let page = 1; page <= maxPages; page++) {
      const items = (await this.getArray(
        `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
      )) as GithubPr[];
      let sawOlder = false;
      for (const pr of items) {
        const updated = typeof pr.updated_at === 'string' ? new Date(pr.updated_at).getTime() : null;
        // Strict `<`: items updated exactly AT the cursor are re-included — the
        // boundary PR re-upserts harmlessly (idempotent), and same-second
        // siblings that a `<=` cutoff would silently miss are never lost.
        if (sinceMs !== null && updated !== null && updated < sinceMs) {
          sawOlder = true;
          break;
        }
        out.push(pr);
      }
      if (sawOlder || items.length < 100) break;
    }
    return out;
  }

  /**
   * Single-PR GET. Unlike the list endpoint ({@link listPullsUpdatedSince}), this
   * representation carries the diff-stat fields — additions, deletions, changed_files,
   * commits, review_comments — that the list omits.
   *
   * This is a SUPPLEMENTARY source: the normalizer falls back to deriving the counts
   * from the already-fetched files/commits when it is absent. So an HTTP failure here
   * must NOT abort a PR ingest whose sibling reads (reviews/files/commits) succeeded —
   * it degrades to {} and the fallback applies. Auth and rate-limit errors are the two
   * exceptions: they are meaningful queue-classification signals the siblings also
   * raise, so they propagate. A non-object body likewise degrades to {}.
   */
  async getPull(owner: string, repo: string, number: number): Promise<GithubPr> {
    let body: unknown;
    try {
      body = await this.get(`/repos/${owner}/${repo}/pulls/${number}`);
    } catch (err) {
      if (err instanceof GithubAuthError || err instanceof GithubRateLimitError) throw err;
      return {}; // transient/404 on a supplementary read → derive from files/commits instead
    }
    return (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as GithubPr;
  }

  /** Strict reads for server-owned handoffs; an absent fact must remain retryable. */
  async getPullMetadata(owner: string, repo: string, number: number): Promise<unknown> {
    return this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`);
  }

  async compareCommits(owner: string, repo: string, base: string, head: string): Promise<{ status: string }> {
    const body = await this.get(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
    );
    if (!body || typeof body !== 'object' || !('status' in body) || typeof body.status !== 'string')
      throw new Error('GitHub compare response is missing status');
    return { status: body.status };
  }

  async listReviews(owner: string, repo: string, number: number): Promise<unknown[]> {
    return this.getArray(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`);
  }

  async listFiles(owner: string, repo: string, number: number, maxPages = 3): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.getArray(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  async listCommits(owner: string, repo: string, number: number): Promise<GithubCommitList> {
    const path = `/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`;
    const res = await this.getResponse(path);
    const body: unknown = await res.json();
    const items = Array.isArray(body) ? body : [];
    const link = res.headers.get('link');
    return { items, incomplete: link?.includes('rel="next"') ?? false };
  }
}
