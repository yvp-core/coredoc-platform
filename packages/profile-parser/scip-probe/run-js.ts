/**
 * run-js.ts — decisive JS probe: can coredoc extraction run on tree-sitter + SCIP
 * for a PURE-JS, CALL-SHAPE-driven repo (a Koa+Sequelize service), the open risk the
 * TS (NestJS, decorator-driven) probe did not exercise?
 *
 *   Step 1: buildBaseline runScip=true — does scip-typescript index pure JS
 *           (via the synthesized/--infer-tsconfig path) or degrade? Report
 *           functions/classes/calls/externalCalls, src-scoped to match the golden.
 *   Step 2: call-shape conventions over RAW tree-sitter CST (NOT StructuralCall)
 *           reproduce the 16 entities / 82 http / 9 queue.
 *   Step 3: compare to the ts-morph golden (82/9/16).
 *
 * Usage: npx tsx packages/profile-parser/scip-probe/run-js.ts \
 *          <repoRoot> <repoName> <outJson> [goldenJson]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { assemble, buildBaseline } from '../src/facts/index.js';
import type { ParsedRepo } from '@coredoc/core/types';
import { extractCallShapeConventions } from './call-shape-conventions.js';

// Golden substrate scope (mirrors the target repo profile include/exclude).
const INCLUDE_PREFIXES = ['app/'];
const INCLUDE_EXACT = new Set([
  'index.js',
  'run.js',
  'run-jobs.js',
  'run-pub-sub-jobs.js',
  'run-pub-sub-jobs-operations.js',
  'run-pub-sub-jobs-shifts-generation.js',
  'run-pub-sub-jobs-shifts-generation-bg.js',
  'run-pub-sub-jobs-shifts-import-file.js',
  'config.js',
]);
const EXCLUDE_RE = /(^|\/)(node_modules|migrations|seeders|test)\//;
const inScope = (p: string): boolean => {
  if (EXCLUDE_RE.test(p) || /\.test\.js$/.test(p)) return false;
  return INCLUDE_EXACT.has(p) || INCLUDE_PREFIXES.some((pre) => p.startsWith(pre));
};

async function main() {
  const [repoRoot, repoName, outJson, goldenJson] = process.argv.slice(2);
  if (!repoRoot || !repoName || !outJson) {
    console.error('Usage: run-js.ts <repoRoot> <repoName> <outJson> [goldenJson]');
    process.exit(2);
  }

  const t0 = Date.now();
  console.error(`[js-probe] buildBaseline(${repoName}) runScip=true … (SCIP on JS via infer-tsconfig)`);
  const baseline = await buildBaseline({ repoRoot, repoName }, { runScip: true });
  const baselineMs = Date.now() - t0;
  console.error(`[js-probe] baseline done in ${(baselineMs / 1000).toFixed(1)}s`);

  const { graph, structuralFiles, idGen, plan, errors } = baseline;

  // ── SCIP-on-JS result ──────────────────────────────────────────────────────
  const scipWarn = errors.find((e) => /scip|tsconfig|indexer|degrade/i.test(e.message));
  const scipDegraded =
    !!scipWarn && scipWarn.severity === 'warning' && /degrad|cannot|skip|not installed/i.test(scipWarn.message);

  const nativeCalls = graph.calls.size;
  const resolvedCalls = [...graph.calls.values()].filter((c) => c.calleeId).length;
  const nativeExternal = graph.externalCalls.size;

  // src-scoped native counts (functions/classes whose file is in the golden scope).
  const scopedFileIds = new Set(structuralFiles.filter((f) => inScope(f.path)).map((f) => idGen.fileId(f.path)));
  const scopedFns = [...graph.functions.values()].filter((f) => scopedFileIds.has((f as any).fileId)).length;
  const scopedClasses = [...graph.classes.values()].filter((c) => scopedFileIds.has((c as any).fileId)).length;

  // ── Step 2: call-shape conventions over raw CST ─────────────────────────────
  const modelFiles = structuralFiles
    .map((f) => f.path)
    .filter((p) => p.startsWith('app/models/') && p.endsWith('.js') && inScope(p));
  console.error(`[js-probe] model files in scope: ${modelFiles.length}`);

  const validFnId = (id: string) => graph.functions.has(id);
  const conv = await extractCallShapeConventions(repoRoot, modelFiles, idGen, validFnId);
  for (const ep of conv.entrypoints) graph.addEntrypoint(ep);
  for (const en of conv.entities) graph.addEntity(en);

  const repo: ParsedRepo = assemble(graph, { repoRoot, repoName }, errors, Date.now() - t0, plan);
  writeFileSync(outJson, JSON.stringify(repo, null, 1));
  console.error(`[js-probe] wrote ${outJson}`);

  // ── Report ──────────────────────────────────────────────────────────────────
  console.error('\n========== STEP 1: SCIP-on-JS ==========');
  console.error(`SCIP degraded: ${scipDegraded}${scipWarn ? `  (warn: ${scipWarn.message})` : ''}`);
  console.error(`native (raw)   functions=${graph.functions.size} classes=${graph.classes.size}`);
  console.error(`native (src)   functions=${scopedFns} classes=${scopedClasses}`);
  console.error(`calls=${nativeCalls} (resolved calleeId=${resolvedCalls}) externalCalls=${nativeExternal}`);

  console.error('\n========== STEP 2: CALL-SHAPE conventions over RAW tree-sitter CST ==========');
  console.error(`http=${conv.httpCount}  queue=${conv.queueCount}  entities=${conv.entities.length}`);
  const totFields = conv.entities.reduce((s, e) => s + e.fields.length, 0);
  const totRels = conv.entities.reduce((s, e) => s + e.relations.length, 0);
  console.error(`entity fields=${totFields}  relations=${totRels}`);

  const golden = goldenJson ? JSON.parse(readFileSync(goldenJson, 'utf8')) : undefined;
  if (golden) {
    const gHttp = new Set(
      golden.entrypoints
        .filter((e: any) => e.type === 'http')
        .map((e: any) => `${e.details.method} ${e.details.fullPath}`),
    );
    const tHttp = new Set(
      repo.entrypoints
        .filter((e: any) => e.type === 'http')
        .map((e: any) => `${e.details.method} ${e.details.fullPath}`),
    );
    const gQueue = new Set(golden.entrypoints.filter((e: any) => e.type === 'queue').map((e: any) => e.details.topic));
    const tQueue = new Set(repo.entrypoints.filter((e: any) => e.type === 'queue').map((e: any) => e.details.topic));
    const gEnt = new Set(golden.entities.map((e: any) => e.name));
    const tEnt = new Set(repo.entities.map((e: any) => e.name));

    const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;

    console.error('\n========== STEP 3: COMPARISON vs ts-morph GOLDEN ==========');
    const row = (k: string, g: number, t: number, exact: number) =>
      console.error(
        `${k.padEnd(14)} | golden ${String(g).padStart(4)} | tt+SCIP ${String(t).padStart(4)} | exact-match ${exact}/${g}`,
      );
    row('http', gHttp.size, tHttp.size, overlap(gHttp, tHttp));
    row('queue', gQueue.size, tQueue.size, overlap(gQueue, tQueue));
    row('entities', gEnt.size, tEnt.size, overlap(gEnt, tEnt));

    console.error('\nhttp missing:', [...gHttp].filter((x) => !tHttp.has(x)).slice(0, 12));
    console.error('http extra:  ', [...tHttp].filter((x) => !gHttp.has(x)).slice(0, 12));
    console.error(
      'queue missing:',
      [...gQueue].filter((x) => !tQueue.has(x)),
    );
    console.error(
      'queue extra:  ',
      [...tQueue].filter((x) => !gQueue.has(x)),
    );
    console.error(
      'entity missing:',
      [...gEnt].filter((x) => !tEnt.has(x)),
    );
    console.error(
      'entity extra:  ',
      [...tEnt].filter((x) => !gEnt.has(x)),
    );

    console.error(`\nnative functions src=${scopedFns} vs golden ${golden.stats.totalFunctions}`);
    console.error(`native calls=${nativeCalls} (resolved ${resolvedCalls}) vs golden ${golden.stats.totalCalls}`);
    console.error(`native externalCalls=${nativeExternal} vs golden ${golden.stats.totalExternalCalls}`);

    // entity fidelity spot-check
    const shared = repo.entities.find((e) => gEnt.has(e.name) && e.fields.length);
    if (shared) {
      const g = golden.entities.find((e: any) => e.name === shared.name);
      console.error(`\nEntity fidelity spot-check: ${shared.name}`);
      console.error(`  golden fields=${g.fields.length} rels=${g.relations.length} table=${g.tableName}`);
      console.error(
        `  tt     fields=${shared.fields.length} rels=${shared.relations.length} table=${shared.tableName}`,
      );
    }
  }

  console.error('\n[js-probe] baseline warnings/errors:');
  for (const e of errors) console.error(`  [${e.severity}] ${e.file}: ${e.message}`);
}

main().catch((e) => {
  console.error('[js-probe] FAILED:', e);
  process.exit(1);
});
