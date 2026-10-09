/**
 * The Claude Code executor: runs one turn's agent session through the pinned
 * Agent SDK with the plugin loaded by path, the run preamble, the tool policy,
 * the Coredoc MCP and the run-control server, then reports what happened.
 * Implement turns also clone the run's repositories before the session and
 * commit and push after it.
 */
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  type AssignedRepository,
  MAX_STATE_ARCHIVE_BYTES,
  type TurnAssignment,
  type TurnOutcome,
} from '@coredoc/core/agent-runner';
import { Git, gitEnvironment } from '../git/git.js';
import { SecretScanner } from '../git/secret-scan.js';
import { type Clone, TurnGit } from '../git/turn-git.js';
import { GithubApi } from '../github/github-api.js';
import type { RunnerApiClient } from '../runner-api.js';
import type { TurnExecutor, TurnIO, TurnResult } from '../runner.js';
import { defaultRetryDelay, type RetryDelay, TurnFailure } from '../turn-failure.js';
import { deliver } from '../delivery/deliver.js';
import { implementPrompt, runPreamble, scopePrompt } from './prompts.js';
import { QuestionBridge } from './question-bridge.js';
import { RUN_CONTROL_SERVER, type RunControlState, runControlServer } from './run-control.js';
import { sessionEnvironment } from './session-environment.js';
import { eventsFor } from './session-events.js';
import { extractStateArchive, packStateArchive } from './state-archive.js';
import { DENIED_TOOLS, evaluateToolUse } from './tool-policy.js';
import { createTurnDirectories, sessionExists, type TurnPaths, turnPaths, wipeScratch } from './turn-paths.js';

/** The SDK's `query`, injected so tests drive a scripted fake instead of a model. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/** A high fixed runaway guard, not a setting. */
const SDK_MAX_TURNS = 500;
/** Coredoc MCP tool calls are otherwise effectively unbounded. */
const MCP_TOOL_TIMEOUT_MS = 120_000;
/** setTimeout's ceiling; a longer turn limit is clamped to it. */
const MAX_TIMER_MS = 2_147_483_647;
/** Long enough for the plugin to suspend its run at session end, with several clones. */
const SESSION_END_HOOK_TIMEOUT_MS = 120_000;
/** How long a session told to end its turn may take to do so before it is stopped. */
const WIND_DOWN_GRACE_MS = 60_000;

const DURATION_REACHED =
  'This turn reached its duration limit. Stop now and end your turn without calling more tools: the runner pushes your work and the run continues in a new turn.';

/** The bot account the runner works as on GitHub: its token and the commit identity. */
export interface BotAccount {
  token: string;
  name: string;
  email: string;
}

export interface ClaudeExecutorOptions {
  query: QueryFn;
  /** Resolves the assignment's MCP path against the Coredoc API base. */
  api: Pick<RunnerApiClient, 'resolve'>;
  /** The only writable volume; wiped at the end of every turn. */
  scratchRoot: string;
  /** The pinned coredoc-workflows plugin, loaded by path. */
  pluginPath: string;
  modelApiKey: string;
  modelBaseUrl?: string;
  hostEnv: NodeJS.ProcessEnv;
  maxArchiveBytes?: number;
  /** The bot's GitHub token and commit identity; needed by turns that touch repositories. */
  bot?: BotAccount;
  githubFetch?: typeof fetch;
  retryDelay?: RetryDelay;
  windDownGraceMs?: number;
  log?: (message: string) => void;
}

interface SessionOutcome {
  failure: { code: 'plugin_missing' | 'session_mismatch' | 'agent_error'; reason: string } | null;
  result: Extract<SDKMessage, { type: 'result' }> | null;
  /** The session reached the turn's duration limit or the SDK turn cap. */
  checkpoint: boolean;
}

/** Limits one session invocation runs under; a re-invocation in the same turn shares them. */
interface SessionLimits {
  deadlineAt: number;
  budgetUsd: number;
}

type RepositoryReports = NonNullable<TurnResult['repositories']>;

/** The pinned SDK ends a session whose AskUserQuestion call the hook deferred with this reason. */
const TOOL_DEFERRED = 'tool_deferred';

export class ClaudeExecutor implements TurnExecutor {
  private readonly log: (message: string) => void;

  constructor(private readonly options: ClaudeExecutorOptions) {
    this.log = options.log ?? (() => undefined);
  }

  async run(turn: TurnAssignment, io: TurnIO): Promise<TurnResult> {
    if (turn.turn.kind === 'delivery') return this.deliveryTurn(turn, io);
    if (turn.turn.kind !== 'scope' && turn.turn.kind !== 'implement') {
      await io.emit([{ type: 'raw', text: `[runner] ${turn.turn.kind} turns are not supported by this runner yet` }]);
      return { spend: null };
    }
    // Fail closed: a session never starts without a spend budget and a duration limit to bound it.
    const unbounded = missingLimit(turn);
    if (unbounded) return { spend: null, outcome: unbounded };
    const paths = turnPaths(this.options.scratchRoot, turn.run.id, turn.turn.id);
    try {
      // Before any session, in every turn: the bot must be neither admin nor maintainer where the run may work.
      await this.checkBotPermissions(turn.repositories);
      await createTurnDirectories(paths);
      if (turn.hasStateArchive) await extractStateArchive(await io.downloadArchive(), paths.state);
      if (turn.turn.kind === 'implement') return await this.implementTurn(turn, io, paths);
      return await this.scopeTurn(turn, io, paths);
    } catch (error) {
      if (error instanceof TurnFailure) return { spend: null, outcome: failed(error) };
      throw error;
    } finally {
      await wipeScratch(this.options.scratchRoot);
    }
  }

  /** No agent session and no scratch: the bot check, then draft pull requests. */
  private async deliveryTurn(turn: TurnAssignment, io: TurnIO): Promise<TurnResult> {
    try {
      await this.checkBotPermissions(turn.repositories);
      const github = new GithubApi({
        token: this.requireBot().token,
        fetchImpl: this.options.githubFetch,
        retryDelay: this.options.retryDelay,
      });
      return await deliver(turn, io, github, this.options.retryDelay ?? defaultRetryDelay);
    } catch (error) {
      if (error instanceof TurnFailure) return { spend: null, outcome: failed(error) };
      throw error;
    }
  }

  private requireBot(): BotAccount {
    if (!this.options.bot) throw new TurnFailure('github_error', 'The runner has no GitHub bot token configured.');
    return this.options.bot;
  }

  private async checkBotPermissions(repositories: AssignedRepository[]): Promise<void> {
    if (repositories.length === 0) return;
    const github = new GithubApi({
      token: this.requireBot().token,
      fetchImpl: this.options.githubFetch,
      retryDelay: this.options.retryDelay,
    });
    for (const repository of repositories) await github.checkBotPermissions(repository);
  }

  /**
   * Clone and branch, run the session in the clones, then stage, scan,
   * commit and push. A blocked scan resumes the session once in the same
   * turn with the findings; a second block fails the run and pushes nothing.
   */
  private async implementTurn(turn: TurnAssignment, io: TurnIO, paths: TurnPaths): Promise<TurnResult> {
    const bot = this.requireBot();
    const git = new Git(gitEnvironment({ hostEnv: this.options.hostEnv, home: paths.home, author: bot }), bot.token);
    const turnGit = new TurnGit({
      git,
      scanner: new SecretScanner(this.options.pluginPath),
      issueKey: turn.run.issueKey,
      branch: turn.run.branch,
      turnNumber: turn.turn.ordinal,
      tmp: paths.tmp,
      reserveBranch: (repository) => io.reserveBranch(repository),
      stopped: () => io.signal.aborted,
      retryDelay: this.options.retryDelay,
    });
    const clones = await turnGit.prepare(turn.repositories, paths.work);
    const specPath = join(paths.work, 'SPEC.md');
    await writeFile(specPath, turn.acceptedSpec?.markdown ?? '(The server sent no accepted specification.)\n', 'utf8');

    const resume = sessionExists(paths, turn.run.sessionId);
    const firstPrompt = implementPrompt(turn, specPath, clones.map(promptClone));
    const prompt = resume
      ? resumeInput(turn, clones)
      : turn.turn.inputText
        ? `${firstPrompt}\n\n${turn.turn.inputText}`
        : firstPrompt;

    const control: RunControlState = { proposedVersion: null, submitted: false };
    // request_repo under automatic acceptance: the server added the repository, so clone it mid-turn.
    let cloneFailure: TurnFailure | null = null;
    control.cloneRepository = async (repository) => {
      const cloned = clones.find((clone) => clone.repository.key === repository.key);
      if (cloned) return cloned.dir;
      try {
        await this.checkBotPermissions([repository]);
        const [clone] = await turnGit.prepare([repository], paths.work);
        clones.push(clone!);
        return clone!.dir;
      } catch (error) {
        if (error instanceof TurnFailure) {
          cloneFailure ??= error;
          control.endTurn?.(`${error.message} The run cannot continue; end your turn now.`);
        }
        throw error;
      }
    };
    const limits: SessionLimits = {
      deadlineAt: Date.now() + turn.run.maxTurnDurationSeconds * 1000,
      budgetUsd: turn.run.remainingSpendUsd,
    };
    const questions = new QuestionBridge(turn, io);
    let session = await this.runSession(turn, io, paths, prompt, resume, control, questions, limits);
    let result = session.result;
    for (let invocation = 1; ; invocation += 1) {
      const spend = spendOf(result, turn);
      const lastMessage = lastMessageOf(result);
      if (io.signal.aborted) return { spend };
      if (cloneFailure) return { spend, outcome: failed(cloneFailure), repositories: turnGit.untouchedReports(clones) };
      // Classified from the runner's own state: a recorded result outlives a late SDK error.
      if (session.failure && (session.failure.code !== 'agent_error' || !control.submitted)) {
        return {
          spend,
          outcome: failed(new TurnFailure(session.failure.code, session.failure.reason)),
          repositories: turnGit.untouchedReports(clones),
        };
      }
      const published = await this.publish(turnGit, clones);
      if (published.kind === 'failed') return { spend, outcome: published.outcome, repositories: published.reports };
      if (published.kind === 'published') {
        // A parked question pauses the run with the work pushed; a checkpoint continues it.
        const checkpoint =
          !control.submitted &&
          !control.repositoryRequested &&
          questions.state.parkedQuestion === null &&
          session.checkpoint;
        const outcome: TurnOutcome = checkpoint ? { kind: 'checkpoint' } : { kind: 'ended' };
        const archived = await this.uploadState(paths, io);
        return { spend, outcome: archived ?? outcome, repositories: published.reports, lastMessage };
      }
      // Resuming a session that parked a question would re-run the deferred question, so it is not resumed.
      if (invocation === 2 || questions.state.parkedQuestion !== null) {
        const reason = `The secret scan blocked the push${invocation === 2 ? ' twice' : ' while a question was open'}, so nothing was pushed. Blocked: ${published.findings.join('; ')}`;
        return {
          spend,
          outcome: failed(new TurnFailure('secret_scan_blocked', reason)),
          repositories: turnGit.untouchedReports(clones),
        };
      }
      // Both invocations count toward the turn's spend and limits.
      const budgetUsd = Math.max(0.01, limits.budgetUsd - (spend?.costUsd ?? 0));
      session = await this.runSession(
        turn,
        io,
        paths,
        scanBlockedPrompt(published.findings),
        true,
        control,
        questions,
        {
          ...limits,
          budgetUsd,
        },
      );
      result = session.result ?? result;
    }
  }

  private async publish(
    turnGit: TurnGit,
    clones: Clone[],
  ): Promise<
    | { kind: 'published'; reports: RepositoryReports }
    | { kind: 'blocked'; findings: string[] }
    | { kind: 'failed'; outcome: TurnOutcome; reports: RepositoryReports }
  > {
    try {
      const outcome = await turnGit.publish(clones);
      if (outcome.kind === 'failed')
        return { kind: 'failed', outcome: failed(outcome.failure), reports: outcome.reports };
      return outcome.kind === 'published' ? outcome : { kind: 'blocked', findings: outcome.findings };
    } catch (error) {
      if (!(error instanceof TurnFailure)) throw error;
      return { kind: 'failed', outcome: failed(error), reports: turnGit.untouchedReports(clones) };
    }
  }

  /** Uploads the state archive; returns the failure instead when it is over the cap. */
  private async uploadState(paths: TurnPaths, io: TurnIO): Promise<TurnOutcome | null> {
    const archive = await packStateArchive(paths.state);
    const cap = this.options.maxArchiveBytes ?? MAX_STATE_ARCHIVE_BYTES;
    if (archive.length > cap) {
      return {
        kind: 'failed',
        code: 'archive_too_large',
        reason: `The session state archive is ${archive.length} bytes; the limit is ${cap}.`,
      };
    }
    await io.uploadArchive(archive);
    return null;
  }

  private async scopeTurn(turn: TurnAssignment, io: TurnIO, paths: TurnPaths): Promise<TurnResult> {
    const prdPath = join(paths.work, 'PRD.md');
    await writeFile(prdPath, turn.prd?.markdown ?? '(The server sent no PRD.)\n', 'utf8');

    const resume = sessionExists(paths, turn.run.sessionId);
    const firstPrompt = scopePrompt(turn, prdPath, join(paths.work, 'spec.md'));
    const prompt = resume
      ? (turn.turn.inputText ?? 'Continue where you stopped.')
      : turn.turn.inputText
        ? `${firstPrompt}\n\n${turn.turn.inputText}`
        : firstPrompt;

    const control: RunControlState = { proposedVersion: null, submitted: false };
    const questions = new QuestionBridge(turn, io);
    const session = await this.runSession(turn, io, paths, prompt, resume, control, questions);
    const spend = spendOf(session.result, turn);
    if (io.signal.aborted) return { spend };
    const lastMessage = lastMessageOf(session.result);

    if (session.failure && (session.failure.code !== 'agent_error' || control.proposedVersion === null)) {
      // Classified from the runner's own state: a recorded proposal outlives a late SDK error.
      const outcome: TurnOutcome = {
        kind: 'failed',
        code: session.failure.code,
        reason: session.failure.reason.slice(0, 2_000),
      };
      return { spend, outcome, lastMessage };
    }
    // Like an implement turn, a limit hit before any proposal or question continues the session.
    const checkpoint =
      session.checkpoint && control.proposedVersion === null && questions.state.parkedQuestion === null;
    const archived = await this.uploadState(paths, io);
    return { spend, outcome: archived ?? { kind: checkpoint ? 'checkpoint' : 'ended' }, lastMessage };
  }

  private async runSession(
    turn: TurnAssignment,
    io: TurnIO,
    paths: TurnPaths,
    prompt: string,
    resume: boolean,
    control: RunControlState,
    questions: QuestionBridge,
    limits: SessionLimits = {
      deadlineAt: Date.now() + turn.run.maxTurnDurationSeconds * 1000,
      budgetUsd: turn.run.remainingSpendUsd,
    },
  ): Promise<SessionOutcome> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    io.signal.addEventListener('abort', stop, { once: true });
    // A stop that arrived before the session (while cloning, say) never fires the listener.
    if (io.signal.aborted) stop();
    const outcome: SessionOutcome = { failure: null, result: null, checkpoint: false };

    // Ending a turn refuses further tools, so the session ends by itself and
    // reports its spend; one that does not is stopped after a grace period.
    let windDown: string | null = null;
    let grace: NodeJS.Timeout | undefined;
    control.endTurn = (reason) => {
      if (windDown) return;
      windDown = reason;
      grace = setTimeout(stop, this.options.windDownGraceMs ?? WIND_DOWN_GRACE_MS);
    };
    // Reaching the turn's duration limit is a checkpoint: the work is pushed and the run continues.
    const deadline = setTimeout(
      () => {
        outcome.checkpoint = true;
        control.endTurn?.(DURATION_REACHED);
      },
      Math.min(Math.max(0, limits.deadlineAt - Date.now()), MAX_TIMER_MS),
    );

    const fail = (failure: NonNullable<SessionOutcome['failure']>) => {
      outcome.failure ??= failure;
      stop();
    };
    try {
      for await (const message of this.options.query({
        prompt,
        options: this.sessionOptions(
          turn,
          io,
          paths,
          resume,
          control,
          questions,
          abort,
          () => windDown,
          limits.budgetUsd,
        ),
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          const problem = this.initProblem(message, turn.run.sessionId);
          if (problem) {
            fail(problem);
            break;
          }
        }
        if (message.type === 'result') {
          outcome.result = message;
          // A parked question ends the session by design, whatever subtype the SDK gives it.
          const parked = message.terminal_reason === TOOL_DEFERRED && questions.state.parkedQuestion !== null;
          // The SDK turn cap is a runaway guard, not a failure: a checkpoint like the duration limit.
          if (message.subtype === 'error_max_turns') outcome.checkpoint = true;
          else if (!parked && (message.subtype !== 'success' || message.is_error)) {
            const errors = 'errors' in message ? message.errors : [];
            fail({ code: 'agent_error', reason: errors?.join('; ') || `The session ended with ${message.subtype}` });
          }
        }
        const events = eventsFor(message);
        if (message.type === 'result') {
          events.push({
            type: 'done',
            ok: outcome.failure === null,
            costUsd: spendOf(message, turn)?.costUsd,
            numTurns: message.num_turns,
            durationMs: message.duration_ms,
          });
        }
        await io.emit(events);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        fail({ code: 'agent_error', reason: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      clearTimeout(deadline);
      clearTimeout(grace);
      control.endTurn = undefined;
      io.signal.removeEventListener('abort', stop);
    }
    return outcome;
  }

  /** The plugin and its skills must be listed with no plugin errors, and the session must be the phase's. */
  private initProblem(
    init: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>,
    sessionId: string,
  ): SessionOutcome['failure'] {
    if (init.session_id !== sessionId) {
      return {
        code: 'session_mismatch',
        reason: `Claude Code reported session ${init.session_id}; the run expects ${sessionId}.`,
      };
    }
    const problem = pluginProblem(init, this.options.pluginPath);
    return problem ? { code: 'plugin_missing', reason: problem } : null;
  }

  private sessionOptions(
    turn: TurnAssignment,
    io: TurnIO,
    paths: TurnPaths,
    resume: boolean,
    control: RunControlState,
    questions: QuestionBridge,
    abortController: AbortController,
    windDown: () => string | null,
    budgetUsd: number,
  ): Options {
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      // A turn that is ending refuses every further tool, questions included.
      const ending = windDown();
      if (ending) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: ending,
          },
        };
      }
      const bridged = await questions.preToolUse(input);
      if (bridged) return bridged;
      const verdict = evaluateToolUse(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      if (verdict.decision === 'allow') return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      };
    };
    const mcpServers: Options['mcpServers'] = {
      [RUN_CONTROL_SERVER]: runControlServer(io, control, turn.turn.kind),
    };
    if (turn.mcp) {
      // Under the key `coredoc`: the plugin recognises Coredoc tools by that name segment.
      mcpServers.coredoc = {
        type: 'http',
        url: this.options.api.resolve(turn.mcp.path),
        headers: { Authorization: `Bearer ${turn.mcp.token}` },
        timeout: MCP_TOOL_TIMEOUT_MS,
      };
    }
    return {
      cwd: paths.work,
      ...(resume ? { resume: turn.run.sessionId } : { sessionId: turn.run.sessionId }),
      ...(turn.run.model ? { model: turn.run.model } : {}),
      env: sessionEnvironment({
        hostEnv: this.options.hostEnv,
        paths,
        sessionId: turn.run.sessionId,
        modelApiKey: this.options.modelApiKey,
        modelBaseUrl: this.options.modelBaseUrl,
        sessionEndHookTimeoutMs: SESSION_END_HOOK_TIMEOUT_MS,
      }),
      // The target repositories' own Claude settings and hooks are never loaded.
      settingSources: [],
      plugins: [{ type: 'local', path: this.options.pluginPath }],
      mcpServers,
      strictMcpConfig: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: runPreamble(turn) },
      permissionMode: 'default',
      // AskUserQuestion is offered only when a permission callback is set; the policy lives in the hook.
      canUseTool: questions.canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      disallowedTools: [...DENIED_TOOLS],
      maxTurns: SDK_MAX_TURNS,
      // Positive and finite: checked before the session starts (missingLimit).
      maxBudgetUsd: budgetUsd,
      abortController,
      stderr: (line) => this.log(`[claude] ${line.trimEnd()}`),
    };
  }
}

/** Why the init message says the plugin did not load, or null when it did. */
export function pluginProblem(
  init: {
    plugins?: Array<{ name: string; path: string }>;
    plugin_errors?: Array<{ plugin: string; message: string }>;
    skills?: string[];
  },
  pluginPath: string,
): string | null {
  if (init.plugin_errors?.length) {
    return `Plugin errors: ${init.plugin_errors.map((error) => `${error.plugin}: ${error.message}`).join('; ')}`;
  }
  const plugin = init.plugins?.find((candidate) => resolve(candidate.path) === resolve(pluginPath));
  if (!plugin) return `The plugin at ${pluginPath} is not listed by Claude Code.`;
  if (!init.skills?.some((skill) => skill.startsWith(`${plugin.name}:`))) {
    return `The plugin ${plugin.name} loaded without its skills.`;
  }
  return null;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The failure to report instead of starting a session whose spend or duration nothing would bound. */
function missingLimit(turn: TurnAssignment): TurnOutcome | null {
  if (!isPositiveFinite(turn.run.remainingSpendUsd)) {
    return {
      kind: 'failed',
      code: 'budget_exhausted',
      reason: `No spend remains for this run (remaining: ${String(turn.run.remainingSpendUsd)} USD).`,
    };
  }
  if (!isPositiveFinite(turn.run.maxTurnDurationSeconds)) {
    return {
      kind: 'failed',
      code: 'agent_error',
      reason: 'The turn carries no valid duration limit, so no session was started.',
    };
  }
  return null;
}

/** The agent's final message, when the session produced one. */
function lastMessageOf(result: SessionOutcome['result']): string | null {
  const text = result?.subtype === 'success' && typeof result.result === 'string' ? result.result.trim() : '';
  return text || null;
}

/** The pinned SDK reports a resumed session's cost cumulatively; this turn's spend is the difference. */
function spendOf(result: SessionOutcome['result'], turn: TurnAssignment): TurnResult['spend'] {
  if (!result) return null;
  return {
    costUsd: Math.max(0, Math.round((result.total_cost_usd - turn.run.priorSessionSpendUsd) * 1e6) / 1e6),
    sdkTurns: result.num_turns,
  };
}

function failed(error: TurnFailure): TurnOutcome {
  return { kind: 'failed', code: error.code, reason: error.message };
}

function promptClone(clone: Clone) {
  return {
    key: clone.repository.key,
    path: clone.dir,
    mergeOrder: clone.repository.mergeOrder,
    withheldPaths: clone.repository.withheldPaths,
  };
}

/** A resumed implement turn's message: after a person added a repository, where its clone is. */
function resumeInput(turn: TurnAssignment, clones: Clone[]): string {
  const decision = turn.repositoryDecision;
  const clone = decision?.added ? clones.find((candidate) => candidate.repository.key === decision.key) : undefined;
  if (clone)
    return `Repository \`${clone.repository.key}\` is now cloned at \`${clone.dir}\`. Continue where you stopped.`;
  return turn.turn.inputText ?? 'Continue where you stopped.';
}

/** The re-invocation after a blocked scan: paths and rule ids only, never the matched text. */
function scanBlockedPrompt(findings: string[]): string {
  return [
    'The secret scan blocked the push of your changes, so nothing was pushed. It flagged:',
    ...findings.map((finding) => `- ${finding}`),
    '',
    'Remove the secrets from these files (use configuration or placeholders, or delete files that must not be committed), then end your turn. You need not call submit_result again unless your result changed. A second block fails the run.',
  ].join('\n');
}
