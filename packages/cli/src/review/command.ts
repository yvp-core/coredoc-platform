import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import { createOpenRouter, type OpenRouterChatSettings } from '@openrouter/ai-sdk-provider';
import { createModel } from '../ci/llm-config.js';
import {
  requestSchema,
  repoSchema,
  shaSchema,
  ReviewError,
  ReviewAuthMode,
  ReviewProvider,
  authModeFor,
  type ReviewRequest,
  type Finding,
} from './contracts.js';
import { GithubReadClient, GithubSourceReader, GitSourceReader } from './source.js';
import { McpGraphReader } from './graph.js';
import { runReview } from './engine.js';
import { claudeCodeEnv, type ClaudeQuery } from './claude-code-runtime.js';
import { renderEarlyFailure, renderReview, safeText, writePrivate } from './report.js';
import { GithubPublishClient, previousFindings, publishReview } from './publish.js';
import { openrouterBudget, openrouterProvider } from './openrouter-budget.js';

export const settingsSchema = z
  .object({
    policy: requestSchema.shape.policy,
    model: requestSchema.shape.model,
    limits: requestSchema.shape.limits,
    exclude: requestSchema.shape.exclude,
    arm: requestSchema.shape.arm.default('A'),
    graph: requestSchema.shape.graph,
  })
  .strict();
export type ReviewSettings = z.infer<typeof settingsSchema>;

// Keep the paid request's PR identity identical to the workflow concurrency key.
export function eventPullNumber(value: unknown): number {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  const number = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(number) || String(number) !== raw)
    throw new ReviewError('PR_NUMBER_INVALID');
  return number;
}

// Only the machine-readable code or error class is printed; messages may carry source or credentials.
export function errorCode(error: unknown): string {
  return error instanceof ReviewError ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
}

// The kill switch reads one named workflow file. Deriving the name from the running workflow
// would fail open: renaming the file would register a new active workflow and publication would
// continue. Renaming .github/workflows/pr-review.yml therefore requires changing this constant.
const REVIEW_WORKFLOW_FILE = 'pr-review.yml';
/**
 * Per-model reasoning requests. Both listed models spent the whole 16k output allowance on
 * reasoning with no text or tool call (GLM: GitHub run 35165841071, 9 minutes for one step).
 * DeepSeek supports a non-thinking mode; GLM's endpoints reject `enabled: false`
 * ("Reasoning is mandatory") but accept `effort: minimal` (~30 reasoning tokens per call).
 */
const REASONING_BY_MODEL: Record<string, { enabled: false } | { effort: 'minimal' | 'low' }> = {
  '~deepseek/deepseek-pro-latest': { enabled: false },
  'z-ai/glm-5.3-flash': { effort: 'minimal' },
};

export async function readJson(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.byteLength > 1_000_000) throw new ReviewError('REQUEST_FILE_LIMIT');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ReviewError('REQUEST_JSON_INVALID');
  }
}

const pullSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  draft: z.boolean(),
  user: z.object({ login: z.string() }),
  base: z.object({ sha: shaSchema, ref: z.string(), repo: z.object({ id: z.number(), full_name: repoSchema }) }),
  head: z.object({ sha: shaSchema, repo: z.object({ id: z.number(), full_name: repoSchema }).nullable() }),
});

export async function capturePull(client: GithubReadClient, number: number, settings: ReviewSettings) {
  if (!Number.isSafeInteger(number) || number < 1) throw new ReviewError('PR_NUMBER_INVALID');
  const pull = pullSchema.parse(await client.get(`/pulls/${number}`));
  const repository = z.object({ default_branch: z.string(), full_name: repoSchema }).parse(await client.get(''));
  if (
    pull.number !== number ||
    pull.base.repo.full_name.toLowerCase() !== client.repository.toLowerCase() ||
    repository.full_name.toLowerCase() !== client.repository.toLowerCase()
  )
    throw new ReviewError('PR_REPOSITORY_MISMATCH');
  const skipReason =
    pull.state !== 'open'
      ? 'PR_NOT_OPEN'
      : pull.draft
        ? 'PR_DRAFT'
        : pull.head.repo?.id !== pull.base.repo.id
          ? 'PR_FORK'
          : pull.base.ref !== repository.default_branch
            ? 'PR_NON_DEFAULT_BASE'
            : pull.user.login.toLowerCase() === 'dependabot[bot]'
              ? 'PR_DEPENDABOT'
              : undefined;
  if (skipReason) return { skipReason };
  const comparison = z
    .object({ merge_base_commit: z.object({ sha: shaSchema }) })
    .parse(await client.compare(pull.base.sha, pull.head.sha));
  return {
    request: requestSchema.parse({
      ...settings,
      schemaVersion: 1,
      repository: client.repository,
      pullNumber: number,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      mergeBaseSha: comparison.merge_base_commit.sha,
      mode: 'prospective',
    }),
  };
}

/**
 * Exactly one credential, and it must match the provider: the action exports an unset input as
 * the empty string, so "absent" is empty or whitespace. No fallback between the two runtimes.
 */
export function resolveModelCredential(provider: string, env: NodeJS.ProcessEnv): ReviewAuthMode {
  const apiKey = (env.COREDOC_REVIEW_LLM_API_KEY ?? '').trim();
  const oauth = (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
  const mode = authModeFor(provider);
  const [wanted, other] = mode === ReviewAuthMode.Subscription ? [oauth, apiKey] : [apiKey, oauth];
  if (!wanted || other) throw new ReviewError('MODEL_CREDENTIAL_MISCONFIGURED');
  return mode;
}

export async function executeReview(
  request: ReviewRequest,
  options: {
    repoDir?: string;
    output: string;
    markdown?: string;
    previousFindings?: Finding[];
    /** Test seam: a fake `query` so tests never spawn the Claude runtime or touch a credential. */
    claudeCodeQuery?: ClaudeQuery;
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const started = Date.now();
  const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(request.limits.maxSeconds * 1000)]);
  try {
    const key = env.COREDOC_REVIEW_LLM_API_KEY ?? '';
    const token = env.GITHUB_TOKEN ?? '';
    const graphToken = env.COREDOC_REVIEW_GRAPH_TOKEN ?? '';
    const budget =
      request.model.provider === 'openrouter' && request.model.maxUsd !== undefined
        ? openrouterBudget(request.model, undefined, {
            // Transient retries may wait, but never past the run's own time limit.
            deadline: () => started + request.limits.maxSeconds * 1000,
            signal,
          })
        : undefined;
    // OpenRouter pins sticky routing to one provider endpoint for this session from the first
    // request, so every later call reads the cached prefix instead of writing it again
    // (measured: 27 calls, all cache writes, zero reads).
    const sessionId = randomUUID();
    // Gemini tool continuations require OpenRouter reasoning_details to round-trip unchanged.
    // The generic OpenAI chat adapter drops that provider metadata.
    // The Claude runtime holds the subscription token itself; there is no AI SDK model to build.
    const claudeCode = request.model.provider === ReviewProvider.ClaudeCode;
    const model = claudeCode
      ? undefined
      : request.model.provider === 'openrouter'
        ? createOpenRouter({ apiKey: key, fetch: budget?.fetch }).chat(request.model.id, {
            // OpenRouter's own type requires effort/max_tokens alongside enabled; the request body
            // itself only needs `enabled: false`, so the extra field is cast away here.
            reasoning: (REASONING_BY_MODEL[request.model.id] ?? {
              effort: 'low',
            }) as OpenRouterChatSettings['reasoning'],
            // Pin the price ceiling and parameter support; fallbacks between qualifying endpoints stay on.
            // This is independent of maxUsd: it routes every OpenRouter call the same way whether or
            // not a per-run reservation guard is active.
            ...(request.model.inputUsdPerMillion !== undefined && request.model.outputUsdPerMillion !== undefined
              ? { provider: openrouterProvider(request.model.inputUsdPerMillion, request.model.outputUsdPerMillion) }
              : {}),
            extraBody: { session_id: sessionId },
          })
        : createModel({ provider: request.model.provider, model: request.model.id, apiKey: key });
    if (request.model.provider === 'openrouter') console.log(`OpenRouter session: ${sessionId}`);
    const github = new GithubReadClient(request.repository, token, signal);
    const source = options.repoDir
      ? new GitSourceReader(resolve(options.repoDir), request, github, signal)
      : new GithubSourceReader(request, github);
    const graph = request.graph ? new McpGraphReader(request.graph, request.repository, graphToken, signal) : undefined;
    const result = await runReview(request, {
      model,
      source,
      graph,
      signal: ctrl.signal,
      ...(claudeCode
        ? {
            claudeCode: {
              model: request.model.id,
              env: claudeCodeEnv(env),
              ...(options.claudeCodeQuery ? { query: options.claudeCodeQuery } : {}),
            },
          }
        : {}),
      secrets: [key, token, graphToken, ...(claudeCode ? [env.CLAUDE_CODE_OAUTH_TOKEN ?? ''] : [])],
      runnerVersion: env.COREDOC_REVIEW_RUNNER_SHA ?? 'development',
      previousFindings: options.previousFindings,
      onModelCall: (event) => console.log(`Review model call: ${JSON.stringify(event)}`),
      ...(budget ? { settledUsd: () => budget.usage.actualUsd } : {}),
    });
    if (budget) result.billing = { ...budget.usage, maxUsd: request.model.maxUsd! };
    await writePrivate(resolve(options.output), `${JSON.stringify(result, null, 2)}\n`);
    if (options.markdown) await writePrivate(resolve(options.markdown), renderReview(result));
    return result;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

export function registerReviewCommand(program: Command): void {
  const review = program.command('review').description('Bounded PR analysis with GitHub Actions publication');
  review
    .command('capture')
    .description('Capture immutable SHAs for an eligible live PR; makes no model calls')
    .requiredOption('--repository <owner/repo>')
    .requiredOption('--pr <number>')
    .requiredOption('--settings <file>')
    .requiredOption('--output <file>')
    .action(async (options) => {
      try {
        const repo = repoSchema.parse(options.repository);
        const capture = await capturePull(
          new GithubReadClient(repo, process.env.GITHUB_TOKEN),
          Number(options.pr),
          settingsSchema.parse(await readJson(options.settings)),
        );
        if (!capture.request) {
          console.log(`Skipped: ${capture.skipReason}`);
          process.exitCode = 2;
          return;
        }
        await writePrivate(resolve(options.output), `${JSON.stringify(capture.request, null, 2)}\n`);
      } catch (error) {
        console.error(
          `Review capture failed (${errorCode(error)}); check settings, repository access and PR metadata.`,
        );
        process.exitCode = 1;
      }
    });
  review
    .command('run')
    .description('Review recorded revisions; writes a validated JSON report')
    .requiredOption('--request <file>')
    .requiredOption('--output <file>')
    .option('--markdown <file>')
    .option('--repo-dir <directory>', 'Read Git objects locally; worktree contents are never reviewed')
    .action(async (options) => {
      try {
        const result = await executeReview(requestSchema.parse(await readJson(options.request)), options);
        console.log(`Review ${result.status}; findings=${result.findings.length}; run=${result.runId}`);
        if (result.coverage.gaps.length) console.log(`Review limitations: ${result.coverage.gaps.join(', ')}`);
        // An `incomplete` report is a reported limitation, not a failed job; only a cancelled run is.
        if (result.status === 'cancelled') process.exitCode = 1;
      } catch (error) {
        console.error(
          `Review failed before report creation (${errorCode(error)}); check the request and host credentials.`,
        );
        process.exitCode = 1;
      }
    });
  review
    .command('event')
    .description('Capture and review the current supported GitHub Actions event')
    .requiredOption('--settings <file>')
    .requiredOption('--output <file>')
    .option('--markdown <file>')
    .action(async (options) => {
      // A failure before the report's Markdown is written gets an early-failure report instead;
      // a report already written is never overwritten.
      let markdownWritten = false;
      try {
        const event = z
          .object({
            number: z.number().optional(),
            inputs: z.object({ pr: z.union([z.string(), z.number()]) }).optional(),
          })
          .passthrough()
          .parse(await readJson(process.env.GITHUB_EVENT_PATH ?? ''));
        if (!['pull_request', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME ?? ''))
          throw new ReviewError('EVENT_UNSUPPORTED');
        const repo = repoSchema.parse(process.env.GITHUB_REPOSITORY);
        const settings = settingsSchema.parse(await readJson(options.settings));
        // Before any GitHub read: a misconfigured pair must cost nothing and reach no model.
        resolveModelCredential(settings.model.provider, process.env);
        if (settings.graph?.local) throw new ReviewError('LOCAL_GRAPH_REQUIRES_LOCAL_RUN');
        const captured = await capturePull(
          new GithubReadClient(repo, process.env.GITHUB_TOKEN),
          eventPullNumber(event.inputs?.pr ?? event.number),
          settings,
        );
        if (!captured.request) {
          const report = { schemaVersion: 1, status: 'skipped', reason: captured.skipReason };
          await writePrivate(resolve(options.output), `${JSON.stringify(report)}\n`);
          if (options.markdown)
            await writePrivate(
              resolve(options.markdown),
              `# Coredoc review — skipped\n\n${safeText(captured.skipReason ?? 'PR_EXCLUDED')}\n`,
            );
          markdownWritten = true;
          return;
        }
        const publisher = new GithubPublishClient(repo, process.env.GITHUB_TOKEN ?? '');
        const prior = await previousFindings(publisher, captured.request.pullNumber);
        // One controller spans analysis and publication: a signal arriving after the model
        // work must still stop the writes, which executeReview's own listeners no longer cover.
        const ctrl = new AbortController();
        const stop = () => ctrl.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        let result: Awaited<ReturnType<typeof executeReview>>;
        try {
          result = await executeReview(captured.request, { ...options, previousFindings: prior });
          // executeReview already wrote the report for --markdown; publication only adds to it.
          if (options.markdown) markdownWritten = true;
          // A cancelled run has no verified state to reconcile against; publishing would
          // reinterpret prior comments from an analysis that never finished.
          result.publication =
            result.status === 'cancelled'
              ? { status: 'superseded', commentIds: [], reason: 'CANCELLED' }
              : await publishReview(
                  captured.request,
                  result,
                  publisher,
                  async () => {
                    // Disabling the workflow is the live kill switch supported by GITHUB_TOKEN's actions:read.
                    const workflow = z
                      .object({ state: z.string() })
                      .parse(await publisher.get(`/actions/workflows/${REVIEW_WORKFLOW_FILE}`));
                    return workflow.state === 'active';
                  },
                  ctrl.signal,
                );
        } finally {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
        }
        await writePrivate(resolve(options.output), `${JSON.stringify(result, null, 2)}\n`);
        if (options.markdown) {
          await writePrivate(resolve(options.markdown), renderReview(result));
          markdownWritten = true;
        }
        // Exit 1 marks infrastructure outcomes only: a publication that failed or wrote part of its
        // comments, or a cancelled run. An `incomplete` report is a published, labelled result, and
        // `superseded`/`disabled` are correct outcomes of a moved head or the kill switch.
        if (['failed', 'partial'].includes(result.publication.status) || result.status === 'cancelled')
          process.exitCode = 1;
        console.log(
          `Review ${result.status}; publication=${result.publication?.status ?? 'disabled'}; findings=${result.findings.length}`,
        );
        if (result.coverage.gaps.length) console.log(`Review limitations: ${result.coverage.gaps.join(', ')}`);
        if (result.graph)
          console.log(
            `Review graph: ${JSON.stringify({ status: result.graph.status, admissibility: result.graph.admissibility, reason: result.graph.reason, commit: result.graph.commit, distance: result.graph.distance })}`,
          );
        if (result.billing) console.log(`OpenRouter accounting: ${JSON.stringify(result.billing)}`);
      } catch (error) {
        if (options.markdown && !markdownWritten)
          // A failing report write must not mask the code the run actually failed with.
          try {
            await writePrivate(resolve(options.markdown), renderEarlyFailure(errorCode(error)));
          } catch {
            // The early-failure report is best effort.
          }
        console.error(`Review event failed (${errorCode(error)}); no successful review is recorded.`);
        process.exitCode = 1;
      }
    });
}
