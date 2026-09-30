// evals/harness/rejudge.ts
// Standalone re-judge over ALREADY-SAVED specs (no spec generation, no MCP).
// CLI: tsx harness/rejudge.ts --from <resultsDir> [--arms=A,C] [--concurrency=4] [--dry]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PLANNING_TASKS } from '../cases-planning/tasks.js';
import { planningTarget } from '../cases-planning/target.js';
import { judgePair, buildPairwisePrompt, type SpecGroundingHint } from './judge-pairwise.js';
import { groundingToHint } from './grounding.js';
import { aggregatePairwise } from './pairwise-aggregate.js';
import { renderPlanningReport } from './report-planning.js';
import { type ArmId, type PairwiseVerdict, type PlanningRunRecord } from './planning-types.js';

const JUDGE_MODEL = 'claude-opus-5-5';
const JUDGE_TIMEOUT_MS = 8 * 60 * 1000;
const JUDGE_MAX_TURNS = 30;

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      arms: { type: 'string' },
      concurrency: { type: 'string' },
      dry: { type: 'boolean' },
    },
  });

  if (!values.from) {
    console.error('Usage: tsx harness/rejudge.ts --from <resultsDir> [--arms=A,C] [--concurrency=4] [--dry]');
    process.exit(1);
  }

  const resultsDir = values.from;
  if (!existsSync(resultsDir)) {
    console.error(`Results dir not found: ${resultsDir}`);
    process.exit(1);
  }

  const selectedArmIds: ArmId[] = values.arms
    ? (values.arms.split(',').map((s) => s.trim()) as ArmId[])
    : ['A', 'B', 'C', 'D'];
  const concurrency = values.concurrency ? Math.max(1, parseInt(values.concurrency, 10)) : 4;
  const dry = values.dry ?? false;

  // 1. Load records.jsonl and index by taskId|arm|rep
  const recordsPath = join(resultsDir, 'records.jsonl');
  if (!existsSync(recordsPath)) {
    console.error(`records.jsonl not found at ${recordsPath}`);
    process.exit(1);
  }
  const allRecords: PlanningRunRecord[] = readFileSync(recordsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PlanningRunRecord);

  // Filter to selected arms
  const records = allRecords.filter((r) => selectedArmIds.includes(r.arm));

  const recordIndex = new Map<string, PlanningRunRecord>();
  for (const rec of allRecords) {
    recordIndex.set(`${rec.taskId}|${rec.arm}|${rec.rep}`, rec);
  }

  // Helper: get grounding hint for a (taskId, arm, rep)
  const groundingHintOf = (taskId: string, arm: ArmId, rep: number): SpecGroundingHint | undefined => {
    const rec = recordIndex.get(`${taskId}|${arm}|${rep}`);
    return rec ? groundingToHint(rec.grounding) : undefined;
  };

  // 2. Read spec file content
  const specsDir = join(resultsDir, 'specs');
  const specOf = (taskId: string, arm: ArmId, rep: number): string | null => {
    const specPath = join(specsDir, `${taskId}__${arm}__rep-${rep}.md`);
    if (!existsSync(specPath)) return null;
    return readFileSync(specPath, 'utf8');
  };

  // 3. Build arm-pairs (unordered) from selected arms
  type ArmPair = { left: ArmId; right: ArmId };
  const armPairs: ArmPair[] = [];
  for (let i = 0; i < selectedArmIds.length; i++) {
    for (let j = i + 1; j < selectedArmIds.length; j++) {
      armPairs.push({ left: selectedArmIds[i]!, right: selectedArmIds[j]! });
    }
  }

  // Collect all unique reps present for each task
  type JudgeJob = {
    taskId: string;
    taskPrompt: string;
    left: ArmId;
    right: ArmId;
    rep: number;
    order: 'LR' | 'RL';
  };
  const judgeJobs: JudgeJob[] = [];
  for (const task of PLANNING_TASKS) {
    // Find all reps that have specs for both arms in each pair
    for (const pair of armPairs) {
      // Get all reps that exist for the LEFT arm
      const leftRecs = allRecords.filter((r) => r.taskId === task.id && r.arm === pair.left);
      for (const lRec of leftRecs) {
        const rep = lRec.rep;
        const leftSpec = specOf(task.id, pair.left, rep);
        const rightSpec = specOf(task.id, pair.right, rep);
        if (!leftSpec || !rightSpec) continue;
        judgeJobs.push({ taskId: task.id, taskPrompt: task.prompt, left: pair.left, right: pair.right, rep, order: 'LR' });
        judgeJobs.push({ taskId: task.id, taskPrompt: task.prompt, left: pair.left, right: pair.right, rep, order: 'RL' });
      }
    }
  }

  const isoTs = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(resultsDir, `rejudge-${isoTs}`);

  if (dry) {
    console.log(`\n--- DRY RUN: would judge ${judgeJobs.length} pairs ---`);
    for (const jb of judgeJobs) {
      console.log(`  ${jb.taskId}  ${jb.left}v${jb.right}  rep${jb.rep}  ${jb.order}`);
    }
    // Print one sample prompt
    if (judgeJobs.length > 0) {
      const sample = judgeJobs[0]!;
      const specA = specOf(sample.taskId, sample.order === 'LR' ? sample.left : sample.right, sample.rep)!;
      const specB = specOf(sample.taskId, sample.order === 'LR' ? sample.right : sample.left, sample.rep)!;
      const presentedAArm = sample.order === 'LR' ? sample.left : sample.right;
      const presentedBArm = sample.order === 'LR' ? sample.right : sample.left;
      const hints = {
        a: groundingHintOf(sample.taskId, presentedAArm, sample.rep),
        b: groundingHintOf(sample.taskId, presentedBArm, sample.rep),
      };
      const sampleTask = PLANNING_TASKS.find((t) => t.id === sample.taskId);
      const samplePrompt = buildPairwisePrompt(sample.taskPrompt, specA, specB, hints, sampleTask?.repos);
      console.log(`\n--- SAMPLE PROMPT (${sample.taskId} ${sample.left}v${sample.right} rep${sample.rep} ${sample.order}) ---\n`);
      console.log(samplePrompt.slice(0, 3000));
      if (samplePrompt.length > 3000) console.log(`\n... [truncated, total ${samplePrompt.length} chars]`);
    }
    return;
  }

  // 4. Run judging with bounded concurrency
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'transcripts'), { recursive: true });

  const verdicts: PairwiseVerdict[] = [];
  let jnext = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, judgeJobs.length || 1) }, async () => {
      while (true) {
        const i = jnext++;
        if (i >= judgeJobs.length) return;
        const jb = judgeJobs[i]!;

        const leftSpec = specOf(jb.taskId, jb.left, jb.rep);
        const rightSpec = specOf(jb.taskId, jb.right, jb.rep);
        if (!leftSpec || !rightSpec) {
          console.warn(`[skip] missing spec for ${jb.taskId} ${jb.left}v${jb.right} rep${jb.rep}`);
          continue;
        }

        const specA = jb.order === 'LR' ? leftSpec : rightSpec;
        const specB = jb.order === 'LR' ? rightSpec : leftSpec;
        const presentedAArm = jb.order === 'LR' ? jb.left : jb.right;
        const presentedBArm = jb.order === 'LR' ? jb.right : jb.left;

        const hints = {
          a: groundingHintOf(jb.taskId, presentedAArm, jb.rep),
          b: groundingHintOf(jb.taskId, presentedBArm, jb.rep),
        };

        const transcriptPath = join(
          outDir,
          'transcripts',
          `${jb.taskId}__${jb.left}v${jb.right}__rep${jb.rep}__${jb.order}.json`,
        );

        try {
          const taskForJob = PLANNING_TASKS.find((t) => t.id === jb.taskId);
          const res = await judgePair({
            taskPrompt: jb.taskPrompt,
            specA,
            specB,
            cwd: planningTarget.workspaceRoot,
            model: JUDGE_MODEL,
            maxTurns: JUDGE_MAX_TURNS,
            timeoutMs: JUDGE_TIMEOUT_MS,
            hints,
            expectedRepos: taskForJob?.repos,
            transcriptPath,
          });

          // Map winner back to true arm
          const winner: ArmId | 'tie' =
            res.winner === 'tie' ? 'tie'
            : jb.order === 'LR' ? (res.winner === 'A' ? jb.left : jb.right)
            : (res.winner === 'A' ? jb.right : jb.left);

          verdicts.push({
            taskId: jb.taskId,
            left: jb.left,
            right: jb.right,
            rep: jb.rep,
            order: jb.order,
            winner,
            reason: res.reason,
          });

          console.log(
            `[judge] ${jb.taskId} ${jb.left}v${jb.right} rep${jb.rep} ${jb.order} → ${winner}  (${res.reason.slice(0, 80)})`,
          );
        } catch (e) {
          console.error(`[judge-error] ${jb.taskId} ${jb.left}v${jb.right} rep${jb.rep} ${jb.order}`, e);
        }
      }
    }),
  );

  // 5. Write verdicts.jsonl
  writeFileSync(
    join(outDir, 'verdicts.jsonl'),
    verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n',
  );

  // Per-task win breakdown
  console.log('\n--- Per-task breakdown ---');
  for (const task of PLANNING_TASKS) {
    const tv = verdicts.filter((v) => v.taskId === task.id);
    if (!tv.length) continue;
    const tally: Record<string, number> = {};
    for (const v of tv) tally[v.winner] = (tally[v.winner] ?? 0) + 1;
    const parts = Object.entries(tally)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${k}:${n}`)
      .join(' ');
    console.log(`  ${task.id}: ${parts}`);
  }

  // 6. Aggregate + report
  const { standings, matrix } = aggregatePairwise(verdicts);
  const wallClockMs = 0; // rejudge doesn't track wall-clock
  const report = renderPlanningReport({
    runId: isoTs,
    model: JUDGE_MODEL,
    records,
    standings,
    matrix,
    wallClockMs,
  });
  const reportPath = join(outDir, 'REPORT.md');
  writeFileSync(reportPath, report);
  console.log(`\nReport: ${reportPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
