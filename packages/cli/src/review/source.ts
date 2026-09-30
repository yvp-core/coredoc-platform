import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  ReviewError,
  isSourcePath,
  shaSchema,
  type ChangedFile,
  type Collection,
  type GraphDistance,
  type ReviewRequest,
  type Revision,
  type SourceReader,
  type TreeEntry,
} from './contracts.js';

const exec = promisify(execFile);
export const unknownDistance = (): GraphDistance => ({
  relation: 'unknown',
  ahead: null,
  behind: null,
  source: 'unknown',
});
const comparisonSchema = z.object({
  status: z.enum(['identical', 'ahead', 'behind', 'diverged']),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
});

export function compareDistance(body: unknown): GraphDistance {
  const { status, ahead_by: ahead, behind_by: behind } = comparisonSchema.parse(body);
  const actual = ahead === 0 ? (behind === 0 ? 'identical' : 'behind') : behind === 0 ? 'ahead' : 'diverged';
  if (status !== actual) throw new ReviewError('COMPARE_INCONSISTENT');
  const relation = { identical: 'equal', behind: 'ancestor', ahead: 'descendant', diverged: 'diverged' } as const;
  return { relation: relation[status], ahead, behind, source: 'api' };
}

export function excluded(path: string, prefixes: string[]): boolean {
  return (
    !isSourcePath(path) ||
    /(?:^|\/)(?:node_modules|dist|build|vendor)\//.test(path) ||
    path.startsWith('.scratch/') ||
    path.startsWith('evals/pr-review/') ||
    /(?:\.min\.js|\.map|(?:^|\/)pnpm-lock\.yaml|(?:^|\/)package-lock\.json)$/.test(path) ||
    prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
  );
}

export class GithubReadClient {
  constructor(
    readonly repository: string,
    private readonly token = '',
    private readonly signal?: AbortSignal,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async get(path: string): Promise<unknown> {
    if (this.signal?.aborted) throw new ReviewError('CANCELLED');
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      redirect: 'error',
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new ReviewError(`GITHUB_HTTP_${response.status}`);
    if (!response.body) throw new ReviewError('GITHUB_EMPTY_BODY');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 20_000_000) throw new ReviewError('GITHUB_RESPONSE_LIMIT');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ReviewError('GITHUB_INVALID_JSON');
    }
  }

  compare(base: string, head: string): Promise<unknown> {
    shaSchema.parse(base);
    shaSchema.parse(head);
    return this.get(`/compare/${base}...${head}?per_page=1`);
  }
  async distance(base: string, graph: string): Promise<GraphDistance> {
    return compareDistance(await this.compare(base, graph));
  }
}

abstract class PinnedSource implements SourceReader {
  protected trees = new Map<Revision, Collection<TreeEntry>>();
  constructor(protected readonly request: ReviewRequest) {}
  protected sha(revision: Revision): string {
    if (revision !== 'base' && revision !== 'head') throw new ReviewError('INVALID_REVISION');
    return revision === 'base' ? this.request.mergeBaseSha : this.request.headSha;
  }
  abstract list(revision: Revision): Promise<Collection<TreeEntry>>;
  protected abstract blob(entry: TreeEntry): Promise<string>;
  abstract changes(): Promise<Collection<ChangedFile>>;
  async read(revision: Revision, path: string): Promise<string> {
    if (excluded(path, this.request.exclude)) throw new ReviewError('SOURCE_PATH_DENIED');
    const entry = (await this.list(revision)).items.find((e) => e.path === path);
    if (!entry) throw new ReviewError('SOURCE_NOT_FOUND');
    if (!['100644', '100755'].includes(entry.mode)) throw new ReviewError('SOURCE_NON_REGULAR');
    if ((entry.size ?? 0) > this.request.limits.maxFileBytes) throw new ReviewError('SOURCE_FILE_LIMIT');
    const content = await this.blob(entry);
    if (Buffer.byteLength(content) > this.request.limits.maxFileBytes) throw new ReviewError('SOURCE_FILE_LIMIT');
    if (content.includes('\0')) throw new ReviewError('SOURCE_BINARY');
    return content;
  }
}

export class GitSourceReader extends PinnedSource {
  constructor(
    private readonly directory: string,
    request: ReviewRequest,
    private readonly github?: GithubReadClient,
    private readonly signal?: AbortSignal,
  ) {
    super(request);
  }

  private async git(args: string[], maxBuffer = 20_000_000): Promise<string> {
    try {
      const { stdout } = await exec(
        'git',
        ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
        {
          cwd: this.directory,
          encoding: 'utf8',
          maxBuffer,
          timeout: 30_000,
          signal: this.signal,
        },
      );
      return stdout;
    } catch {
      throw new ReviewError(this.signal?.aborted ? 'CANCELLED' : 'GIT_READ_FAILED');
    }
  }
  async list(revision: Revision): Promise<Collection<TreeEntry>> {
    const sha = this.sha(revision);
    const cached = this.trees.get(revision);
    if (cached) return cached;
    const raw = await this.git(['ls-tree', '-r', '-l', '-z', sha]);
    const items = raw
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+) \w+ ([a-f0-9]{40})\s+([\d-]+)\t([\s\S]+)$/.exec(line);
        if (!match) throw new ReviewError('GIT_TREE_INVALID');
        return {
          mode: match[1]!,
          oid: match[2]!,
          path: match[4]!,
          ...(match[3] === '-' ? {} : { size: Number(match[3]) }),
        };
      });
    const result = { items, gaps: [] };
    this.trees.set(revision, result);
    return result;
  }
  protected blob(entry: TreeEntry): Promise<string> {
    return this.git(['cat-file', 'blob', entry.oid], this.request.limits.maxFileBytes + 1);
  }
  private async singleFilePatch(path: string, previousPath: string): Promise<string> {
    return this.git(
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--unified=4',
        '-M',
        this.request.mergeBaseSha,
        this.request.headSha,
        '--',
        ...new Set([path, previousPath]),
      ],
      this.request.limits.maxDiffBytes + 1,
    );
  }
  async changes(): Promise<Collection<ChangedFile>> {
    const raw = await this.git([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-z',
      '-M',
      this.request.mergeBaseSha,
      this.request.headSha,
      '--',
    ]);
    const parts = raw.split('\0');
    const entries: ChangedFile[] = [];
    for (let i = 0; i < parts.length && parts[i]; ) {
      const status = parts[i++]!;
      const first = parts[i++]!;
      const renamed = status.startsWith('R') || status.startsWith('C');
      const path = renamed ? parts[i++]! : first;
      entries.push({ path, status: status[0]!, ...(renamed ? { previousPath: first } : {}) });
    }

    // Batch every file's patch into one `git diff` call instead of one spawn per file. Chunks come back
    // in the same order as the name-status entries above (same args, same commits), so they line up by
    // index; each chunk's header is still verified against the expected path before it is trusted, and
    // any entry that fails that check (e.g. a quoted non-ASCII path) or an overall count mismatch falls
    // back to the old single-file `git diff -- path` call so a wrong patch is never attributed to a file.
    let batched: string[] | null = null;
    try {
      const fullDiff = await this.git(
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--unified=4',
          '-M',
          this.request.mergeBaseSha,
          this.request.headSha,
          '--',
        ],
        this.request.limits.maxDiffBytes + 1,
      );
      const chunks = fullDiff.length ? fullDiff.split(/(?=^diff --git )/m).filter((c) => c.length > 0) : [];
      if (chunks.length === entries.length) batched = chunks;
    } catch {
      batched = null;
    }

    const items: ChangedFile[] = [];
    const gaps: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const file = entries[i]!;
      const renamed = file.previousPath !== undefined;
      const first = file.previousPath ?? file.path;
      if (
        !excluded(file.path, this.request.exclude) &&
        (!renamed || !excluded(first, this.request.exclude)) &&
        items.length < this.request.limits.maxFiles
      ) {
        const chunk = batched?.[i];
        const headerEnd = chunk?.slice(0, chunk.indexOf('\n') === -1 ? chunk.length : chunk.indexOf('\n'));
        if (chunk && headerEnd?.endsWith(` b/${file.path}`)) {
          file.patch = chunk;
        } else {
          try {
            file.patch = await this.singleFilePatch(file.path, first);
          } catch {
            gaps.push('DIFF_UNAVAILABLE');
          }
        }
      }
      items.push(file);
    }
    return { items, gaps };
  }
  async distance(graphSha: string): Promise<GraphDistance> {
    shaSchema.parse(graphSha);
    if (this.github) {
      try {
        return await this.github.distance(this.request.mergeBaseSha, graphSha);
      } catch {
        /* Complete local history is the documented fallback. */
      }
    }
    try {
      if ((await this.git(['rev-parse', '--is-shallow-repository'])).trim() !== 'false') return unknownDistance();
      const [behind, ahead] = (
        await this.git(['rev-list', '--left-right', '--count', `${this.request.mergeBaseSha}...${graphSha}`])
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      const status = ahead === 0 ? (behind === 0 ? 'identical' : 'behind') : behind === 0 ? 'ahead' : 'diverged';
      return { ...compareDistance({ status, ahead_by: ahead, behind_by: behind }), source: 'local' };
    } catch {
      return unknownDistance();
    }
  }
}

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      sha: shaSchema,
      type: z.string(),
      size: z.number().optional(),
    }),
  ),
});
const fileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  patch: z.string().optional(),
});

export class GithubSourceReader extends PinnedSource {
  constructor(
    request: ReviewRequest,
    private readonly github: Pick<GithubReadClient, 'get' | 'compare' | 'distance'>,
  ) {
    super(request);
  }
  async list(revision: Revision): Promise<Collection<TreeEntry>> {
    const sha = this.sha(revision);
    const cached = this.trees.get(revision);
    if (cached) return cached;
    const body = treeSchema.parse(await this.github.get(`/git/trees/${sha}?recursive=1`));
    const result = {
      items: body.tree
        .filter((x) => x.type !== 'tree')
        .map((x) => ({ path: x.path, mode: x.mode, oid: x.sha, size: x.size })),
      gaps: body.truncated ? ['SOURCE_TREE_TRUNCATED'] : [],
    };
    this.trees.set(revision, result);
    return result;
  }
  protected async blob(entry: TreeEntry): Promise<string> {
    const blob = z
      .object({ encoding: z.literal('base64'), content: z.string(), size: z.number() })
      .parse(await this.github.get(`/git/blobs/${entry.oid}`));
    if (blob.size > this.request.limits.maxFileBytes) throw new ReviewError('SOURCE_FILE_LIMIT');
    return Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8');
  }
  async changes(): Promise<Collection<ChangedFile>> {
    const body = z
      .object({ files: z.array(fileSchema) })
      .parse(await this.github.compare(this.request.mergeBaseSha, this.request.headSha));
    return {
      items: body.files.map((f) => ({
        path: f.filename,
        previousPath: f.previous_filename,
        status: f.status,
        patch: f.patch,
      })),
      gaps: body.files.length >= 300 ? ['COMPARE_FILES_MAY_BE_TRUNCATED'] : [],
    };
  }
  async distance(graphSha: string): Promise<GraphDistance> {
    try {
      return await this.github.distance(this.request.mergeBaseSha, graphSha);
    } catch {
      return unknownDistance();
    }
  }
}
