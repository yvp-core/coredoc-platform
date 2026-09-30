/**
 * CLI: tsx src/run.ts <profileName> <repoPath> <outJson>
 *
 * Dispatches the profile module through the LanguageProvider registry
 * (resolveProfileModule) — single-language via provider.parse, multi-target via
 * parseMultiTarget — writes the ParsedRepo JSON, then shells out to
 * validate-output.mjs and pre-scan.mjs and prints a count table.
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseMultiTarget, resolveProfileModule } from './index.js';
import { applyIntegrityReport, formatViolation } from './integrity/referential-integrity.js';
import { assertProfileTypechecks } from './profile-typecheck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(__dirname, '../scripts');

async function main(): Promise<void> {
  const [profilePath, repoPath, outJson] = process.argv.slice(2);
  if (!profilePath || !repoPath || !outJson) {
    console.error('Usage: tsx src/run.ts <path-to-profile-module> <repoPath> <outJson>');
    process.exit(2);
  }
  assertProfileTypechecks(path.resolve(profilePath));
  const mod = (await import(pathToFileURL(path.resolve(profilePath)).href)) as Record<string, unknown>;
  const resolved = resolveProfileModule(mod);
  if (!resolved) {
    console.error(`No registered-language profile export found in ${profilePath}`);
    process.exit(2);
  }
  const profileName = path.basename(profilePath).replace(/\.[tj]s$/, '');
  const repoRoot = path.resolve(repoPath);
  console.log(`Parsing ${repoRoot} with profile '${profileName}'…`);
  const result =
    resolved.kind === 'multi'
      ? await parseMultiTarget(resolved.profile, { repoRoot, repoName: profileName })
      : await resolved.provider.parse(resolved.profile, { repoRoot, repoName: profileName });
  // Same integrity pass the CLI parse path runs, applied before the JSON is written so this
  // script's output carries the same errors[]/stats.integrity a real parse would.
  const integrity = applyIntegrityReport(result);
  const outPath = path.resolve(outJson);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Wrote ${outPath}`);

  const http = result.entrypoints.filter((e) => e.type === 'http').length;
  const queue = result.entrypoints.filter((e) => e.type === 'queue').length;
  console.log('\n=== Engine counts ===');
  console.table({
    http: { count: http },
    queue: { count: queue },
    entities: { count: result.entities.length },
    dbOperations: { count: result.dbOperations.length },
    functions: { count: result.functions.length },
    calls: { count: result.calls.length },
    externalCalls: { count: result.externalCalls.length },
    components: { count: (result.components ?? []).length },
    routes: { count: (result.routes ?? []).length },
    stateStores: { count: (result.stateStores ?? []).length },
    parseErrors: { count: (result.errors ?? []).length },
    danglingRefs: { count: integrity.danglingRefs },
  });
  for (const v of integrity.violations) console.log(`  INTEGRITY: ${formatViolation(v)}`);

  // Frontend childComponent dangling report: componentId set but
  // not matching any emitted component id.
  if ((result.components ?? []).length > 0) {
    const ids = new Set((result.components ?? []).map((c) => c.id));
    let total = 0;
    let nullId = 0;
    let dangling = 0;
    for (const c of result.components ?? []) {
      for (const u of c.childComponents ?? []) {
        total++;
        if (u.componentId == null) nullId++;
        else if (!ids.has(u.componentId)) dangling++;
      }
    }
    console.log('\n=== childComponent resolution ===');
    console.table({
      childUsages: { count: total },
      nullId: { count: nullId, pct: total ? `${Math.round((nullId / total) * 100)}%` : '0%' },
      trueDangling: { count: dangling, pct: total ? `${Math.round((dangling / total) * 100)}%` : '0%' },
    });
  }

  // validate-output.mjs
  console.log('\n=== validate-output ===');
  try {
    const out = execFileSync(process.execPath, [path.join(SCRIPTS, 'validate-output.mjs'), outPath], {
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    console.log(`valid=${parsed.valid} errors=${parsed.errors.length} warnings=${parsed.warnings.length}`);
    if (parsed.errors.length) console.log('ERRORS:', parsed.errors.slice(0, 20));
  } catch (e: any) {
    // validate-output exits 1 on errors but still prints JSON on stdout.
    const out = e.stdout?.toString() ?? '';
    try {
      const parsed = JSON.parse(out);
      console.log(`valid=${parsed.valid} errors=${parsed.errors.length}`);
      console.log('ERRORS:', parsed.errors.slice(0, 20));
    } catch {
      console.error('validate-output failed:', e.message);
    }
  }

  // pre-scan.mjs (coverage diff)
  console.log('\n=== pre-scan (coverage) ===');
  try {
    const out = execFileSync(process.execPath, [path.join(SCRIPTS, 'pre-scan.mjs'), repoRoot, outPath], {
      encoding: 'utf-8',
    });
    console.log(out.slice(0, 4000));
  } catch (e: any) {
    console.log((e.stdout?.toString() ?? e.message).slice(0, 4000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
