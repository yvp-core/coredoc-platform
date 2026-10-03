// evals/harness/run-planning.ts
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { runAgent } from './agent.js';
import { armToRunConfig } from './arm-config.js';
import { parsePositiveIntegerFlag } from './cli-integers.js';
import { checkGrounding, groundingToHint } from './grounding.js';
import { judgePair } from './judge-pairwise.js';
import { aggregatePairwise } from './pairwise-aggregate.js';
import { renderPlanningReport } from './report-planning.js';
import { extractToolEvents, classifyMcpResult } from './analyze-mcp.js';
import { ARMS, type ArmId, type ArmSpec, type PairwiseVerdict, type PlanningRunRecord } from './planning-types.js';
import { planningTarget } from '../cases-planning/target.js';
import { PLANNING_TASKS, scopedTaskPrompt } from '../cases-planning/tasks.js';

const PLANNING_MODEL = 'claude-opus-5-5';
const ARM_TIMEOUT_MS = 15 * 60 * 1000;
const ARM_MAX_TURNS = 60;
const JUDGE_TIMEOUT_MS = 8 * 60 * 1000;
const JUDGE_MAX_TURNS = 30;

export function isTransientError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /\b(429|500|502|503|529)\b|overloaded|rate.?limit|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(msg);
}

const DEFAULT_BACKOFF_MS = [3_000, 12_000, 30_000];

export async function withRetry<T>(
  label: string,
  attempt: () => Promise<T>,
  isRetryable: (r: T) => string | null,
  maxAttempts = 3,
  backoffMs: number[] = DEFAULT_BACKOFF_MS,
): Promise<T> {
  for (let a = 0; a < maxAttempts; a++) {
    const isLast = a === maxAttempts - 1;
    try {
      const result = await attempt();
      const retryMsg = isRetryable(result);
      if (retryMsg !== null && !isLast) {
        const delay = backoffMs[a] ?? backoffMs[backoffMs.length - 1] ?? 3_000;
        console.warn(`[retry] ${label}: retryable result (${retryMsg}), attempt ${a + 1}/${maxAttempts}, backing off ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      // On last attempt, return even if still retryable (best-effort).
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isTransientError(msg) && !isLast) {
        const delay = backoffMs[a] ?? backoffMs[backoffMs.length - 1] ?? 3_000;
        console.warn(`[retry] ${label}: transient error (${msg}), attempt ${a + 1}/${maxAttempts}, backing off ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  // Unreachable — loop always returns or throws — but satisfies TS.
  return attempt();
}

function resolveSuperpowersPluginDir(): string {
  if (process.env.SUPERPOWERS_PLUGIN_DIR) return process.env.SUPERPOWERS_PLUGIN_DIR;
  const base = join(homedir(), '.claude/plugins/cache/claude-plugins-official/superpowers');
  if (!existsSync(base)) throw new Error(`superpowers plugin not found at ${base}; set SUPERPOWERS_PLUGIN_DIR`);
  const versions = readdirSync(base)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!versions.length) throw new Error(`no versioned superpowers plugin under ${base}`);
  return join(base, versions[0]!);
}

/**
 * Stage the in-repo coredoc-mcp skill into the eval's local plugin (mirrors run.ts).
 *
 * The WHOLE directory is generated, manifest included, so it can simply be
 * gitignored. This one used to generate only
 * `skills/` and keep a committed manifest beside it, which made the directory
 * half-tracked: a stale 24 KB copy of what is now a 6 KB skill sat in the repo
 * reading as authoritative, and every run left the working tree dirty. Writing the
 * manifest here is what lets the path be ignored outright.
 */
function stageCoredocPlugin(repoRoot: string, evalsRoot: string): string {
  const pluginDir = join(evalsRoot, '_skill-plugin');
  const src = join(repoRoot, 'skills', 'coredoc-mcp');
  const dst = join(pluginDir, 'skills', 'coredoc-mcp');
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        name: 'coredoc-eval-skills',
        description:
          'Eval-side plugin that loads the coredoc-mcp skill into agent sessions. Skill source lives under skills/coredoc-mcp — synced from <repo>/skills/coredoc-mcp by the harness at startup.',
      },
      null,
      2,
    )}\n`,
  );
  if (existsSync(src)) {
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
  } else {
    console.warn(`[warn] coredoc-mcp skill source missing at ${src}`);
  }
  return pluginDir;
}

function countMcp(transcriptPath: string): { calls: number; empty: number } {
  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as unknown[];
  const events = extractToolEvents(transcript);
  const useById = new Map<string, string>(); // id → toolName
  let calls = 0;
  for (const ev of events) {
    if (ev.kind === 'use' && ev.toolName.startsWith('mcp__')) {
      calls += 1;
      useById.set(ev.toolUseId, ev.toolName);
    }
  }
  let empty = 0;
  for (const ev of events) {
    if (ev.kind === 'result' && useById.has(ev.toolUseId)) {
      if (classifyMcpResult(ev.text, ev.isError).isEmpty) empty += 1;
    }
  }
  return { calls, empty };
}

async function main() {
  const { values } = parseArgs({
    options: {
      task: { type: 'string' },
      arm: { type: 'string' },
      arms: { type: 'string' },
      reps: { type: 'string' },
      concurrency: { type: 'string' },
      smoke: { type: 'boolean' },
    },
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const evalsRoot = resolve(here, '..');
  const repoRoot = resolve(evalsRoot, '..');

  process.env.COREDOC_SQLITE_URL = planningTarget.dbUrl;

  // Pre-flight: built MCP dist + populated db.
  if (!existsSync(planningTarget.mcpServerCommand)) {
    throw new Error(`MCP server not built at ${planningTarget.mcpServerCommand} — run \`pnpm build\` first.`);
  }
  if (!existsSync(planningTarget.mcpConfigPath)) {
    throw new Error(`coredoc config missing at ${planningTarget.mcpConfigPath}`);
  }

  const coredocPluginDir = stageCoredocPlugin(repoRoot, evalsRoot);
  const superpowersPluginDir = resolveSuperpowersPluginDir();
  const ctx = { coredocPluginDir, superpowersPluginDir };

  const tasks = PLANNING_TASKS.filter((t) => !values.task || t.id === values.task);
  let arms: ArmSpec[] = values.arms
    ? ARMS.filter((a) => values.arms!.split(',').map((s) => s.trim()).includes(a.id))
    : values.arm
      ? ARMS.filter((a) => a.id === (values.arm as ArmId))
      : [...ARMS];
  let reps = parsePositiveIntegerFlag(values.reps, '--reps', 3);
  if (values.smoke) {
    tasks.splice(1); // first task only
    reps = 1;
  }
  const concurrency = parsePositiveIntegerFlag(values.concurrency, '--concurrency', 4);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(evalsRoot, 'runs-planning', runId);
  mkdirSync(runDir, { recursive: true });
  const startedAt = Date.now();

  console.log(
    `Planning eval: ${tasks.length} tasks × ${arms.length} arms × ${reps} reps = ${tasks.length * arms.length * reps} sessions (concurrency=${concurrency})`,
  );

  // ---- Phase 1: produce specs (bounded concurrency over task×arm×rep) ----
  type Job = { task: (typeof tasks)[number]; arm: ArmSpec; rep: number };
  const jobs: Job[] = [];
  for (const task of tasks) for (const arm of arms) for (let rep = 0; rep < reps; rep++) jobs.push({ task, arm, rep });

  const records: PlanningRunRecord[] = [];
  async function runJob(job: Job): Promise<void> {
    const { task, arm, rep } = job;
    const cfg = armToRunConfig(arm, ctx);
    const artifactDir = join(runDir, task.id, arm.id, `rep-${rep}`);
    mkdirSync(artifactDir, { recursive: true });
    const transcriptPath = join(artifactDir, 'transcript.json');

    const result = await withRetry(
      `spec ${task.id}/${arm.id}`,
      () => runAgent({
        prompt: scopedTaskPrompt(task),
        systemPrompt: cfg.systemPrompt,
        model: PLANNING_MODEL,
        cwd: planningTarget.workspaceRoot,
        arm: cfg.runAgentArm,
        baseTools: ['Read', 'Grep', 'Glob'],
        extraTools: [],
        mcpServerCommand: planningTarget.mcpServerCommand,
        mcpServerEnv: {
          MCP_CONFIG_PATH: planningTarget.mcpConfigPath,
          ...(planningTarget.scope ? { COREDOC_SCOPE: planningTarget.scope } : {}),
        },
        maxTurns: ARM_MAX_TURNS,
        timeoutMs: ARM_TIMEOUT_MS,
        transcriptPath,
        ...(cfg.skills && { skills: cfg.skills }),
        ...(cfg.pluginPaths && { pluginPaths: cfg.pluginPaths }),
      }),
      (r) => isTransientError(r.error) ? r.error : null,
    );

    const specPath = join(artifactDir, 'spec.md');
    writeFileSync(specPath, result.responseText);
    writeFileSync(join(artifactDir, 'usage.json'), JSON.stringify(result.usage, null, 2));

    const grounding = checkGrounding(result.responseText, planningTarget.workspaceRoot);
    const mcp = arm.mcp ? countMcp(transcriptPath) : { calls: 0, empty: 0 };
    records.push({
      taskId: task.id, arm: arm.id, rep, specPath, specChars: result.responseText.length,
      usage: result.usage, grounding, mcpCalls: mcp.calls, mcpEmpty: mcp.empty,
      toolCalls: result.toolCalls.reduce((a, t) => a + t.count, 0), error: result.error,
    });
    console.log(
      `[spec] ${task.id}/${arm.id}/rep-${rep} → chars=${result.responseText.length} precision=${(grounding.precision * 100).toFixed(0)}% mcp=${mcp.calls} tokens=${result.usage.totalTokens}${result.error ? ` ERROR=${result.error}` : ''}`,
    );
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= jobs.length) return;
        await runJob(jobs[i]!).catch((e) => console.error(`[spec-error] ${jobs[i]!.task.id}/${jobs[i]!.arm.id}`, e));
      }
    }),
  );
  writeFileSync(join(runDir, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // ---- Phase 2: pairwise judging (per task, all arm-pairs, both orders) ----
  const recOf = (taskId: string, arm: ArmId, rep: number): PlanningRunRecord | undefined =>
    records.find((r) => r.taskId === taskId && r.arm === arm && r.rep === rep);
  // A spec is judgeable only if its arm completed without error and emitted text.
  const specReady = (rec: PlanningRunRecord | undefined): rec is PlanningRunRecord =>
    !!rec && !rec.error && rec.specChars > 0;
  type JudgeJob = { taskId: string; left: ArmId; right: ArmId; rep: number; order: 'LR' | 'RL' };
  const judgeJobs: JudgeJob[] = [];
  const armIds = arms.map((a) => a.id);
  for (const task of tasks) {
    for (let i = 0; i < armIds.length; i++) {
      for (let j = i + 1; j < armIds.length; j++) {
        for (let rep = 0; rep < reps; rep++) {
          judgeJobs.push({ taskId: task.id, left: armIds[i]!, right: armIds[j]!, rep, order: 'LR' });
          judgeJobs.push({ taskId: task.id, left: armIds[i]!, right: armIds[j]!, rep, order: 'RL' });
        }
      }
    }
  }

  const groundingHintOf = (taskId: string, arm: ArmId, rep: number) => {
    const rec = records.find((r) => r.taskId === taskId && r.arm === arm && r.rep === rep);
    return rec ? groundingToHint(rec.grounding) : undefined;
  };

  const verdicts: PairwiseVerdict[] = [];
  let jnext = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, judgeJobs.length) }, async () => {
      while (true) {
        const i = jnext++;
        if (i >= judgeJobs.length) return;
        const jb = judgeJobs[i]!;
        const leftRec = recOf(jb.taskId, jb.left, jb.rep);
        const rightRec = recOf(jb.taskId, jb.right, jb.rep);
        // Fail-loud: a missing/errored spec is a LOSS for that arm, not a silently
        // dropped pair. Dropping it would let an arm be judged only on the reps it
        // survived, inflating the win-rate of arms that fail more often.
        if (!specReady(leftRec) || !specReady(rightRec)) {
          const leftOk = specReady(leftRec);
          const rightOk = specReady(rightRec);
          const winner: ArmId | 'tie' = leftOk ? jb.left : rightOk ? jb.right : 'tie';
          const reason = leftOk
            ? `${jb.right} spec failed/empty`
            : rightOk
              ? `${jb.left} spec failed/empty`
              : 'both specs failed/empty';
          verdicts.push({ taskId: jb.taskId, left: jb.left, right: jb.right, rep: jb.rep, order: jb.order, winner, reason });
          console.warn(`[judge] ${jb.taskId} ${jb.left}vs${jb.right} rep${jb.rep} ${jb.order} → ${winner} (auto: ${reason})`);
          continue;
        }
        const leftSpec = readFileSync(leftRec.specPath, 'utf8');
        const rightSpec = readFileSync(rightRec.specPath, 'utf8');
        // Presentation order: LR shows left as Spec A; RL swaps to control position bias.
        const specA = jb.order === 'LR' ? leftSpec : rightSpec;
        const specB = jb.order === 'LR' ? rightSpec : leftSpec;
        const presentedAArm = jb.order === 'LR' ? jb.left : jb.right;
        const presentedBArm = jb.order === 'LR' ? jb.right : jb.left;
        const task = tasks.find((t) => t.id === jb.taskId)!;
        const res = await withRetry(
          `judge ${jb.taskId} ${jb.left}v${jb.right}`,
          () => judgePair({
            taskPrompt: task.prompt, specA, specB,
            cwd: planningTarget.workspaceRoot, model: PLANNING_MODEL,
            maxTurns: JUDGE_MAX_TURNS, timeoutMs: JUDGE_TIMEOUT_MS,
            hints: {
              a: groundingHintOf(jb.taskId, presentedAArm, jb.rep),
              b: groundingHintOf(jb.taskId, presentedBArm, jb.rep),
            },
            expectedRepos: tasks.find((t) => t.id === jb.taskId)?.repos,
          }),
          // Retry an unusable verdict (mirrors the arms' transient-error retry);
          // thrown transient errors are already retried by withRetry's catch.
          (r) => (r.winner === 'invalid' ? r.reason : null),
        ).catch((e) => { console.error('[judge-error]', jb, e); return null; });
        // A judge that errored out or never produced a usable verdict is recorded
        // as 'invalid' (counted, excluded from win-rate) — never a silent tie.
        if (!res || res.winner === 'invalid') {
          const reason = res?.reason ?? 'judge error';
          verdicts.push({ taskId: jb.taskId, left: jb.left, right: jb.right, rep: jb.rep, order: jb.order, winner: 'invalid', reason });
          console.warn(`[judge] ${jb.taskId} ${jb.left}vs${jb.right} rep${jb.rep} ${jb.order} → invalid (${reason})`);
          continue;
        }
        // Map the judge's A/B back to the true arm id given the presentation order.
        const winner =
          res.winner === 'tie' ? 'tie'
          : jb.order === 'LR' ? (res.winner === 'A' ? jb.left : jb.right)
          : (res.winner === 'A' ? jb.right : jb.left);
        verdicts.push({ taskId: jb.taskId, left: jb.left, right: jb.right, rep: jb.rep, order: jb.order, winner, reason: res.reason });
        console.log(`[judge] ${jb.taskId} ${jb.left}vs${jb.right} rep${jb.rep} ${jb.order} → ${winner}`);
      }
    }),
  );
  writeFileSync(join(runDir, 'verdicts.jsonl'), verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n');

  // ---- Phase 3: aggregate + report ----
  const { standings, matrix, invalidCount } = aggregatePairwise(verdicts);
  // Fail loud: if too many specs errored or the judge produced too many unusable
  // verdicts, the win-rate is not trustworthy — withhold standings and exit non-zero
  // so a degraded run cannot masquerade as a clean comparison in CI.
  const DEGRADE_THRESHOLD = 0.2;
  const errorCount = records.filter((r) => r.error || r.specChars === 0).length;
  const errorRate = records.length ? errorCount / records.length : 0;
  const invalidRate = verdicts.length ? invalidCount / verdicts.length : 0;
  const degraded = errorRate > DEGRADE_THRESHOLD || invalidRate > DEGRADE_THRESHOLD;
  const degradation = {
    errorCount, invalidCount, totalSpecs: records.length, totalVerdicts: verdicts.length,
    threshold: DEGRADE_THRESHOLD, degraded,
  };
  const report = renderPlanningReport({
    runId, model: PLANNING_MODEL, records, standings, matrix,
    wallClockMs: Date.now() - startedAt, degradation,
  });
  const reportPath = join(runDir, 'REPORT.md');
  writeFileSync(reportPath, report);
  console.log(`\nReport: ${reportPath}`);
  if (degraded) {
    console.error(
      `\n⚠️  DEGRADED RUN — standings withheld, NOT trustworthy.\n` +
      `   arm spec errors: ${errorCount}/${records.length} (${(errorRate * 100).toFixed(0)}%)\n` +
      `   invalid judge verdicts: ${invalidCount}/${verdicts.length} (${(invalidRate * 100).toFixed(0)}%)\n` +
      `   threshold: ${(DEGRADE_THRESHOLD * 100).toFixed(0)}%. Fix the cause and re-run.`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
