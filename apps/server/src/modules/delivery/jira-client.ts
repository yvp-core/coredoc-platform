// Thin typed fetch wrapper over the Jira Cloud REST v3 API (house pattern:
// native fetch, no SDK — mirrors github-client.ts). Uses the CURRENT search
// endpoint POST /rest/api/3/search/jql with nextPageToken pagination; the
// legacy /rest/api/3/search (startAt) is deprecated-for-removal by Atlassian
// and must not be used. Error taxonomy maps onto the job-queue classifier:
// JiraAuthError (401/403) is permanent, JiraRateLimitError (429) and plain
// Error are transient and ride the queue's BACKOFF_MS retries.

const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_BASE_URL_CHARS = 512;
const MAX_NEXT_PAGE_URL_CHARS = 4_096;

export class JiraAuthError extends Error {}
export class JiraRateLimitError extends Error {
  /** From `Retry-After` (seconds) when Jira sent one; callers cap the wait. */
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}
/**
 * 404 or 400: the issue is missing or invisible to the connector's user (Jira
 * answers these, not 401/403, for missing permission). Permanent for agent-run
 * reads; still a plain Error to the importer's classifier.
 */
export class JiraNotFoundError extends Error {}
/**
 * Any other non-2xx answer, with its status: 409, 413 and 422 are rejections,
 * 5xx are transient. Still a plain Error to the importer's classifier.
 */
export class JiraApiError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`Jira API ${status} for ${path}`);
  }
}

/** One comment as listed; the body is Atlassian Document Format. */
export interface JiraComment {
  id: string;
  body: unknown;
}

/** One available transition: its id, the status it leads to and whether it shows a screen. */
export interface JiraTransition {
  id: string;
  name?: string;
  hasScreen?: boolean;
  to?: { id?: string; name?: string };
}

export interface JiraIssue {
  [k: string]: unknown;
}

export interface JiraSearchOptions {
  maxPages?: number;
  nextPageToken?: string | null;
  /** Default true (the importer reads changelogs); false leaves `expand` out of the request. */
  expandChangelog?: boolean;
}

export interface JiraIssueSearchResult {
  items: JiraIssue[];
  nextPageToken: string | null;
}

export interface JiraChangelogOptions {
  maxPages?: number;
  startAt?: number;
}

export interface JiraChangelogResult {
  items: unknown[];
  total: number | null;
  nextStartAt: number | null;
  incomplete: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Validate the stored connector host before it can participate in an outbound
 * request. The returned value is safe to concatenate with a fixed REST path and
 * has no trailing slash, so live imports and generated browse URLs agree.
 */
export function normalizeJiraBaseUrl(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE_URL_CHARS) {
    throw new Error('Jira baseUrl must contain at most 512 characters');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('Jira baseUrl must not contain a query or fragment');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Jira baseUrl must be an absolute HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
    throw new Error('Jira baseUrl must be an absolute HTTPS URL with a host');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Jira baseUrl must not contain credentials');
  }

  const normalized = parsed.toString().replace(/\/+$/, '');
  if (normalized.length === 0 || normalized.length > MAX_BASE_URL_CHARS) {
    throw new Error('Jira baseUrl must contain at most 512 characters');
  }
  return normalized;
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(opts: { baseUrl: string; email: string; apiToken: string }) {
    this.baseUrl = normalizeJiraBaseUrl(opts.baseUrl);
    this.authHeader = `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`;
  }

  private async request(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (res.status === 401 || res.status === 403) {
      throw new JiraAuthError(`Jira auth/permission failure (${res.status}) for ${path}`);
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get('retry-after'));
      throw new JiraRateLimitError(
        `Jira rate limit (429) for ${path}`,
        Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null,
      );
    }
    if (res.status === 404 || res.status === 400) {
      throw new JiraNotFoundError(`Jira API ${res.status} for ${path}`);
    }
    if (!res.ok) {
      // Provider bodies may contain tenant/project details. Status + the fixed
      // request path are sufficient for retry classification and safe logging.
      throw new JiraApiError(res.status, path);
    }
    // A successful transition answers 204 with no body.
    if (res.status === 204) return undefined;
    return res.json();
  }

  async searchIssues(jql: string, fields: string[], options: JiraSearchOptions = {}): Promise<JiraIssueSearchResult> {
    const out: JiraIssue[] = [];
    const maxPages = Number.isInteger(options.maxPages) && (options.maxPages ?? 0) > 0 ? options.maxPages! : 20;
    let nextPageToken =
      typeof options.nextPageToken === 'string' && options.nextPageToken !== '' ? options.nextPageToken : undefined;
    for (let page = 0; page < maxPages; page++) {
      const body: Record<string, unknown> = {
        jql,
        maxResults: PAGE_SIZE,
        fields,
        // `expand` is a comma-separated STRING on /search/jql (the removed
        // /search endpoint took an array; live Jira Cloud 400s on the array).
        ...(options.expandChangelog === false ? {} : { expand: 'changelog' }),
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const res = asRecord(await this.request('/rest/api/3/search/jql', { method: 'POST', body }));
      const issues = Array.isArray(res.issues) ? (res.issues as JiraIssue[]) : [];
      out.push(...issues);
      nextPageToken = typeof res.nextPageToken === 'string' && res.nextPageToken !== '' ? res.nextPageToken : undefined;
      if (!nextPageToken) break;
    }
    return { items: out, nextPageToken: nextPageToken ?? null };
  }

  /** One issue with exactly the fields asked for. */
  async getIssue(issueIdOrKey: string, fields: string[]): Promise<JiraIssue> {
    const query = new URLSearchParams({ fields: fields.join(',') });
    return asRecord(await this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}?${query}`));
  }

  /** Adds a comment whose body is Atlassian Document Format; returns its id. */
  async addComment(issueIdOrKey: string, body: unknown): Promise<{ id: string }> {
    const res = asRecord(
      await this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`, {
        method: 'POST',
        body: { body },
      }),
    );
    if (typeof res.id !== 'string') throw new Error('Jira comment response is missing its id');
    return { id: res.id };
  }

  /**
   * An issue's comments, oldest first, up to `maxPages` pages. `complete` is
   * false when the cap stopped the listing before the last comment.
   */
  async listComments(issueIdOrKey: string, maxPages = 20): Promise<{ comments: JiraComment[]; complete: boolean }> {
    const out: JiraComment[] = [];
    let startAt = 0;
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(PAGE_SIZE),
        orderBy: 'created',
      });
      const res = asRecord(
        await this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment?${query}`),
      );
      const comments = (Array.isArray(res.comments) ? res.comments : []).map(asRecord);
      for (const comment of comments) {
        if (typeof comment.id === 'string') out.push({ id: comment.id, body: comment.body });
      }
      startAt += comments.length;
      const total = nonNegativeInteger(res.total);
      if (comments.length === 0 || (total === null ? comments.length < PAGE_SIZE : startAt >= total)) {
        return { comments: out, complete: true };
      }
    }
    return { comments: out, complete: false };
  }

  async listTransitions(issueIdOrKey: string): Promise<JiraTransition[]> {
    const res = asRecord(await this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`));
    return (Array.isArray(res.transitions) ? res.transitions : []) as JiraTransition[];
  }

  async transitionIssue(issueIdOrKey: string, transitionId: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`, {
      method: 'POST',
      body: { transition: { id: transitionId } },
    });
  }

  async listChangelog(issueIdOrKey: string, options: JiraChangelogOptions = {}): Promise<JiraChangelogResult> {
    const out: unknown[] = [];
    const maxPages = Number.isInteger(options.maxPages) && (options.maxPages ?? 0) > 0 ? options.maxPages! : 10;
    const initialStartAt = Number.isInteger(options.startAt) && (options.startAt ?? -1) >= 0 ? options.startAt! : 0;
    let total: number | null = null;
    let currentStartAt = initialStartAt;
    let nextStartAt: number | null = currentStartAt;
    let incomplete = false;
    const endpoint = `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/changelog`;
    for (let page = 0; page < maxPages; page++) {
      const res = asRecord(await this.request(`${endpoint}?startAt=${currentStartAt}&maxResults=${PAGE_SIZE}`));
      const values = Array.isArray(res.values) ? res.values : [];
      const returnedStartAt = nonNegativeInteger(res.startAt) ?? currentStartAt;
      if (returnedStartAt !== currentStartAt) {
        // A response for another offset cannot establish a contiguous history.
        nextStartAt = currentStartAt;
        incomplete = true;
        break;
      }
      out.push(...values);
      if (typeof res.total === 'number' && Number.isFinite(res.total) && res.total >= 0) total = res.total;
      const contiguousNext = returnedStartAt + values.length;
      // Jira changelog signals the final page via `isLast`; an empty page is the
      // terminal guard for degenerate/malformed responses so we never spin to the
      // page cap fetching nothing.
      if (res.isLast === true || (total !== null && contiguousNext >= total)) {
        nextStartAt = null;
        incomplete = false;
        break;
      }
      if (values.length === 0) {
        incomplete =
          res.isLast === false ||
          (total !== null && currentStartAt < total) ||
          (typeof res.nextPage === 'string' && res.nextPage.length > 0);
        nextStartAt = incomplete ? currentStartAt : null;
        break;
      }

      const advertisedNext = this.validatedNextStartAt(res.nextPage, endpoint, contiguousNext);
      const candidate = advertisedNext ?? contiguousNext;
      if (!Number.isSafeInteger(candidate) || candidate <= currentStartAt) {
        nextStartAt = currentStartAt;
        incomplete = true;
        break;
      }
      currentStartAt = candidate;
      nextStartAt = currentStartAt;
      incomplete = true;
    }
    return { items: out, total, nextStartAt, incomplete };
  }

  /** Accept only a continuation for this client origin and this exact issue endpoint. */
  private validatedNextStartAt(value: unknown, endpoint: string, contiguousNext: number): number | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NEXT_PAGE_URL_CHARS) return null;
    const expected = new URL(`${this.baseUrl}${endpoint}`);
    let candidate: URL;
    try {
      candidate = new URL(value, expected);
    } catch {
      // intentional: the continuation link comes from Jira's response body and
      // is untrusted. Unparseable → no next page, which ends the walk safely.
      return null;
    }
    if (
      candidate.origin !== expected.origin ||
      candidate.pathname !== expected.pathname ||
      candidate.username !== '' ||
      candidate.password !== '' ||
      candidate.hash !== ''
    ) {
      return null;
    }
    const rawOffsets = candidate.searchParams.getAll('startAt');
    if (rawOffsets.length !== 1 || !/^\d+$/.test(rawOffsets[0] ?? '')) return null;
    const startAt = Number(rawOffsets[0]);
    // A provider continuation may confirm the contiguous boundary, never jump
    // over values or send this bounded reader backwards into duplicate pages.
    return Number.isSafeInteger(startAt) && startAt === contiguousNext ? startAt : null;
  }

  async listStatuses(): Promise<unknown[]> {
    const body = await this.request('/rest/api/3/status');
    return Array.isArray(body) ? body : [];
  }

  /**
   * A single project's statuses. A fresh Jira site whose only project is
   * TEAM-MANAGED returns [] from the global GET /status (team-managed statuses are
   * project-scoped), so the status-map bootstrap must also read them here. The
   * response is an ARRAY of issue-type entries, each
   * `{ id, name, statuses: [{ id, name, statusCategory: { key } }] }`; returned RAW
   * (tolerant: non-array → []) — the caller flattens each entry's `statuses`. Same
   * auth/timeout/error taxonomy as the other GETs.
   */
  async listProjectStatuses(projectKeyOrId: string): Promise<unknown[]> {
    const body = await this.request(`/rest/api/3/project/${encodeURIComponent(projectKeyOrId)}/statuses`);
    return Array.isArray(body) ? body : [];
  }
}
