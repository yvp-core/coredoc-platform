/**
 * run.ts — decisive probe: can coredoc extraction run on tree-sitter + SCIP
 * instead of ts-morph?
 *
 *   Step 1: buildBaseline (tree-sitter structure + scip-typescript calls).
 *   Step 2: extractConventions over the tree-sitter decorator STRINGS to
 *           reproduce HTTP entrypoints + MikroORM entities (no ts-morph).
 *   Step 3: assemble a ParsedRepo (conventions + SCIP calls), validate, and
 *           tabulate vs the ts-morph golden.
 *
 * Usage: npx tsx packages/profile-parser/scip-probe/run.ts \
 *          <repoRoot> <repoName> <outJson> [goldenJson]
 */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { assemble, buildBaseline } from '../src/facts/index.js';
import type { ParsedRepo } from '@coredoc/core/types';
import { extractConventions } from './decorator-conventions.js';

async function main() {
  const [repoRoot, repoName, outJson, goldenJson] = process.argv.slice(2);
  if (!repoRoot || !repoName || !outJson) {
    console.error('Usage: run.ts <repoRoot> <repoName> <outJson> [goldenJson]');
    process.exit(2);
  }

  const t0 = Date.now();
  console.error(`[probe] buildBaseline(${repoName}) runScip=true … (SCIP indexing can take minutes)`);
  const baseline = await buildBaseline({ repoRoot, repoName }, { runScip: true });
  const baselineMs = Date.now() - t0;
  console.error(`[probe] baseline done in ${(baselineMs / 1000).toFixed(1)}s`);

  const { graph, structuralFiles, idGen, plan, errors } = baseline;

  const scipDegraded = errors.some((e) => /scip|degrade|tsconfig|indexer/i.test(e.message) && e.severity === 'warning');

  // Native baseline counts (Step 1) — structure + SCIP calls, no entrypoints/entities yet.
  const nativeCalls = graph.calls.size;
  const nativeResolvedCalls = [...graph.calls.values()].filter((c) => c.calleeId).length;
  const nativeExternal = graph.externalCalls.size;

  // Step 2: conventions over tree-sitter decorator strings.
  const { entrypoints, entities } = extractConventions(structuralFiles, idGen);
  for (const ep of entrypoints) graph.addEntrypoint(ep);
  for (const en of entities) graph.addEntity(en);

  // Step 3: assemble full ParsedRepo (calls/externalCalls already in graph from SCIP).
  const repo: ParsedRepo = assemble(graph, { repoRoot, repoName }, errors, Date.now() - t0, plan);
  writeFileSync(outJson, JSON.stringify(repo, null, 1));
  console.error(`[probe] wrote ${outJson}`);

  // ── Tabulate ───────────────────────────────────────────────────────────────
  const golden = goldenJson ? JSON.parse(readFileSync(goldenJson, 'utf8')) : undefined;
  const row = (k: string, ts: number, tt: number) => {
    const delta = tt - ts;
    const pct = ts > 0 ? ((tt / ts) * 100).toFixed(0) + '%' : 'n/a';
    return `${k.padEnd(16)} | ${String(ts).padStart(7)} | ${String(tt).padStart(10)} | ${String(delta).padStart(6)} | ${pct.padStart(5)}`;
  };

  const httpCount = entrypoints.filter((e) => e.type === 'http').length;
  const queueCount = entrypoints.filter((e) => e.type === 'queue').length;

  console.error('\n========== STEP 1: NATIVE BASELINE (tree-sitter + SCIP) ==========');
  console.error(`SCIP degraded: ${scipDegraded}`);
  console.error(`functions=${graph.functions.size} classes=${graph.classes.size}`);
  console.error(`calls=${nativeCalls} (resolved calleeId=${nativeResolvedCalls}) externalCalls=${nativeExternal}`);
  console.error(`entrypoints=0 entities=0  (expected: Layer-1 baseline emits none)`);

  console.error('\n========== STEP 2: CONVENTIONS over tree-sitter decorators ==========');
  console.error(`http entrypoints = ${httpCount}   queue entrypoints = ${queueCount}`);
  console.error(`entities = ${entities.length}`);
  const withRel = entities.filter((e) => e.relations.length).length;
  const totalFields = entities.reduce((s, e) => s + e.fields.length, 0);
  const totalRels = entities.reduce((s, e) => s + e.relations.length, 0);
  console.error(`entities with relations = ${withRel}; total fields = ${totalFields}; total relations = ${totalRels}`);

  if (golden) {
    const gs = golden.stats;
    console.error('\n========== STEP 3: COMPARISON vs ts-morph GOLDEN ==========');
    console.error('category         |  golden | tree-sit+S | delta  |  %');
    console.error('-----------------+---------+------------+--------+------');
    console.error(row('functions', gs.totalFunctions, repo.functions.length));
    console.error(row('classes', gs.totalClasses, repo.classes.length));
    console.error(row('entrypoints', gs.totalEntrypoints, repo.entrypoints.length));
    console.error(row('  http', 132, httpCount));
    console.error(row('  queue', 3, queueCount));
    console.error(row('entities', gs.totalEntities, repo.entities.length));
    console.error(row('dbOperations', gs.totalEntities ? golden.dbOperations.length : 0, repo.dbOperations.length));
    console.error(row('calls', gs.totalCalls, repo.calls.length));
    console.error(row('externalCalls', gs.totalExternalCalls, repo.externalCalls.length));

    // Entrypoint fullPath precision: how many golden http fullPaths did we reproduce exactly?
    const goldHttp = new Set(
      golden.entrypoints
        .filter((e: any) => e.type === 'http')
        .map((e: any) => `${e.details.method} ${e.details.fullPath}`),
    );
    const ttHttp = new Set(
      repo.entrypoints.filter((e) => e.type === 'http').map((e: any) => `${e.details.method} ${e.details.fullPath}`),
    );
    const matched = [...ttHttp].filter((x) => goldHttp.has(x)).length;
    const missing = [...goldHttp].filter((x) => !ttHttp.has(x));
    const extra = [...ttHttp].filter((x) => !goldHttp.has(x));
    console.error(`\nHTTP fullPath exact-match: ${matched}/${goldHttp.size} golden routes reproduced`);
    console.error(`  missing (golden not in tt): ${missing.length}`, missing.slice(0, 10));
    console.error(`  extra (tt not in golden):   ${extra.length}`, extra.slice(0, 10));

    // Entity-name overlap.
    const goldEnt = new Set(golden.entities.map((e: any) => e.name));
    const ttEnt = new Set(repo.entities.map((e) => e.name));
    const entMatched = [...ttEnt].filter((x) => goldEnt.has(x)).length;
    console.error(`\nEntity-name overlap: ${entMatched}/${goldEnt.size} golden entities reproduced`);
    console.error(`  missing:`, [...goldEnt].filter((x) => !ttEnt.has(x)).slice(0, 10));
    console.error(`  extra:`, [...ttEnt].filter((x) => !goldEnt.has(x)).slice(0, 10));

    // Field/relation fidelity spot-check on a shared entity.
    const shared = repo.entities.find((e) => goldEnt.has(e.name) && e.relations.length);
    if (shared) {
      const g = golden.entities.find((e: any) => e.name === shared.name);
      console.error(`\nEntity fidelity spot-check: ${shared.name}`);
      console.error(`  golden fields=${g.fields.length} rels=${g.relations.length} table=${g.tableName}`);
      console.error(
        `  tt     fields=${shared.fields.length} rels=${shared.relations.length} table=${shared.tableName}`,
      );
    }
  }

  console.error('\n[probe] baseline warnings/errors:');
  for (const e of errors) console.error(`  [${e.severity}] ${e.file}: ${e.message}`);
}

main().catch((e) => {
  console.error('[probe] FAILED:', e);
  process.exit(1);
});
