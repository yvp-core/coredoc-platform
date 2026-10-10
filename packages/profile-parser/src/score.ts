/**
 * Coverage scorecard — the deterministic feedback the author-profile loop iterates
 * against, for ANY registered language.
 *
 *   tsx src/score.ts <path-to-profile-module> <repoPath>
 *
 * Resolves a profile by path (any language's profile module), dispatches through the
 * LanguageProvider registry, and composes:
 *   - per-category coverage (source signal vs emitted) — shared score-core math,
 *   - structural integrity (provider-supplied; TS only),
 *   - a per-category + overall verdict.
 * The verdict math + scorecard rendering live once in scoring/score-core.ts; each
 * provider supplies only its language-specific source signals. Exits non-zero unless
 * overall PASS so the loop can gate on it.
 */
import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertProfileTypechecks } from './profile-typecheck.js';
import { resolveProfileModule } from './providers/index.js';
import type { ResolvedProfileExport } from './providers/index.js';
import type { LanguageProvider } from './providers/types.js';
import { Verdict } from './score-verdict.js';
import { applyIntegrityReport, formatViolation } from './integrity/referential-integrity.js';
import { renderMissClusters, unclaimedClusters } from './scoring/cluster-report.js';
import {
  blockingExtractionErrors,
  callResolutionBlackouts,
  extractionErrorSummary,
  perPackageCallResolution,
  unclaimedFrontendRedFlags,
  unclaimedFrontendSurface,
} from './scoring/silent-failure.js';
import {
  type ProfileCompletion,
  type ScoreContext,
  coverageRedFlags,
  emittedCountsFromRepo,
  emittedLocationsFromRepo,
  isOverallPass,
  profileCompletion,
  renderScorecard,
  scoreCategories,
} from './scoring/score-core.js';
import { unclaimedScope, unclaimedScopeRedFlags } from './scoring/unclaimed-scope.js';
import type { BaseProfile } from './types/profile-base.js';

/** Resolve a profile module by path — single-language or multi-target. */
async function resolveProfileRef(ref: string): Promise<{ name: string; dir: string; resolved: ResolvedProfileExport }> {
  const abs = path.resolve(ref);
  if (!existsSync(abs)) {
    throw new Error(
      `Profile module not found at '${abs}'. Pass a path to a profile module (e.g. coredoc-parsers/<project>/<repo>/profile.ts).`,
    );
  }
  // The authoring loop gates on this command's exit code, so this is the earliest point
  // a schema-mismatched rule can be caught — before it scores as "category FAIL" and the
  // author starts tuning conventions that were never wired up.
  assertProfileTypechecks(abs);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const resolved = resolveProfileModule(mod);
  if (!resolved) throw new Error(`No registered-language profile export found in ${abs}`);
  return { name: path.basename(abs).replace(/\.[tj]s$/, ''), dir: path.dirname(abs), resolved };
}

/**
 * Score ONE profile (single-language, or one target of a composite) against a repo,
 * printing the coverage scorecard + gaps to stdout. Whole-repo ownership comes from
 * provider.sourceFiles, independently of whether a substrate emits FileNodes.
 */
async function scoreSingle(
  name: string,
  provider: LanguageProvider,
  profile: BaseProfile,
  repoRoot: string,
  reportDir: string,
  auditWholeRepoScope = false,
): Promise<{ pass: boolean; completion: ProfileCompletion }> {
  const sourceScope = provider.sourceFiles(profile, repoRoot);
  const parsed = await provider.parse(profile, { repoRoot, repoName: name });
  // Record referential integrity BEFORE the report is written, so the scored
  // JSON carries the same errors[]/stats.integrity a real parse would.
  const integrity = applyIntegrityReport(parsed);
  // Next to the profile module, NOT tmpdir(): the authoring agent runs this command inside a
  // sandbox whose only writable/readable scratch root is the profile's own directory, so a tmp
  // report is both unwritable by this process and unreadable by the agent that needs it.
  const outPath = path.join(reportDir, `score-${name}.json`);
  writeFileSync(outPath, JSON.stringify(parsed, null, 2));
  console.log(`Full parse report: ${outPath}`);

  const ctx: ScoreContext = { repoRoot, sourceFiles: sourceScope.included, outPath, profile, parsed };

  // --- coverage (shared math) ------------------------------------------------
  const emitted = emittedCountsFromRepo(parsed);
  const signals = provider.sourceSignals(ctx);
  const scores = scoreCategories(emitted, signals);

  // --- structural integrity (provider-supplied; TS only) ---------------------
  const structural = provider.structuralChecks?.(ctx) ?? { errors: [], redFlags: [] };

  // --- silent-failure signals (language-neutral) -----------------------------
  // Referential integrity, known extraction loss, unclaimed API handlers, and the per-package
  // call-resolution blackout are RED:
  // both mean the graph is partial in a way the coverage rows cannot see. The
  // unclaimed-frontend rows are WARN — a target may legitimately leave that
  // surface to a sibling target.
  const packageResolution = perPackageCallResolution(parsed);
  const blackouts = callResolutionBlackouts(packageResolution);
  const frontendWarnings = unclaimedFrontendSurface(parsed, profile, new Set(sourceScope.included));
  const frontendRedFlags = unclaimedFrontendRedFlags(frontendWarnings);
  const extractionRedFlags = blockingExtractionErrors(parsed);
  const scopeReport = auditWholeRepoScope
    ? unclaimedScope(repoRoot, new Set(sourceScope.included), [
        {
          excludedPaths: new Set(sourceScope.excluded.filter((file) => !sourceScope.profileExcluded.includes(file))),
          profileExcludedPaths: new Set(sourceScope.profileExcluded),
          explicitExclude: profile.substrate.exclude ?? [],
        },
      ])
    : undefined;
  const scopeRedFlags = scopeReport ? unclaimedScopeRedFlags(scopeReport) : [];
  const redFlags = [
    ...coverageRedFlags(emitted, signals),
    ...structural.redFlags,
    ...integrity.violations.map(formatViolation),
    ...blackouts,
    ...frontendRedFlags,
    ...extractionRedFlags,
    ...scopeRedFlags,
  ];

  // --- print -----------------------------------------------------------------
  console.log('=== Coverage scorecard ===');
  renderScorecard(scores);

  // --- unclaimed-site cluster report (refine aid) -----------------------------
  // For each category that FAILs or under-emits vs its signal, join the signal's
  // grep hits against the emitted nodes' locations and show the top miss-clusters.
  // Categories without a hit list (Ruby provider, dbOperations today) are skipped.
  const emittedLocations = emittedLocationsFromRepo(parsed);
  for (const s of scores) {
    const hits = signals.hits?.[s.category];
    if (!hits?.length) continue;
    if (s.verdict !== Verdict.FAIL && s.source <= s.emitted) continue;
    renderMissClusters(s.category, unclaimedClusters(hits, emittedLocations[s.category] ?? []));
  }

  // --- referential integrity --------------------------------------------------
  console.log('\n=== Referential integrity ===');
  if (integrity.violations.length === 0) {
    console.log(`0 dangling references (${integrity.syntheticHandlers} synthetic entrypoint handlers, by design)`);
  } else {
    console.table(
      Object.fromEntries(integrity.violations.map((v) => [v.ref, { count: v.count, samples: v.samples.join(' ') }])),
    );
  }

  // --- per-package call resolution (silent-SCIP-death detector) --------------
  // Only worth printing for a multi-package repo — a single-package repo's row
  // is just the overall rate already shown by the provenance table.
  if (packageResolution.length > 1) {
    console.log('\n=== Call resolution by package ===');
    console.table(
      Object.fromEntries(
        packageResolution.slice(0, 20).map((r) => [
          r.packagePath,
          {
            functions: r.functions,
            callSites: r.callSites,
            resolved: r.resolved,
            rate: r.rate == null ? 'n/a' : `${Math.round(r.rate * 100)}%`,
          },
        ]),
      ),
    );
    if (packageResolution.length > 20) console.log(`  … ${packageResolution.length - 20} more package(s)`);
    for (const b of blackouts) console.log(`  RED: ${b}`);
  }

  // --- unclaimed frontend surface ---------------------------------------------
  if (frontendWarnings.length > 0) {
    console.log('\n=== Unclaimed frontend surface ===');
    for (const warning of frontendWarnings) {
      const level = warning.blocking ? 'RED' : 'WARN';
      console.log(`  ${level} ${warning.surface}: ${warning.message}`);
    }
  }

  if (scopeReport) {
    console.log('\n=== Unclaimed scope ===');
    console.log(`${scopeReport.unclaimed}/${scopeReport.total} known-language files claimed by no target`);
    if (scopeReport.intentionallyExcluded > 0) {
      console.log(`${scopeReport.intentionallyExcluded} known-language file(s) intentionally excluded by target scope`);
    }
    for (const d of scopeReport.topDirs) console.log(`  ${d.dir}: ${d.count}`);
    for (const file of scopeReport.sampleFiles) console.log(`  unclaimed: ${file}`);
    for (const flag of scopeRedFlags) console.log(`  RED: ${flag}`);
  }

  // --- extraction errors (degrade reasons, surfaced not buried) ---------------
  const extractionErrors = extractionErrorSummary(parsed);
  if (extractionErrors.length > 0) {
    console.log('\n=== Extraction errors ===');
    console.table(Object.fromEntries(extractionErrors.slice(0, 15).map((e, i) => [`${i + 1}`, { ...e }])));
  }

  console.log('\n=== Structural ===');
  console.table({
    validateErrors: { count: structural.errors.length },
    consistencyRedFlags: { count: redFlags.length },
  });
  if (structural.errors.length) console.log('validate errors:', structural.errors.slice(0, 20));
  if (redFlags.length) console.log('red flags:', redFlags);

  // --- call-graph provenance (diagnostic; only when the parse produced calls) -
  // Bucket by the RAW provenance value so every tier shows distinctly (scip/di for the
  // TS path; rb-const/rb-unique/rb-self for the Ruby heuristic graph) — never collapse
  // an unknown provenance into 'scip'.
  const calls = parsed.calls ?? [];
  if (calls.length > 0) {
    const byProv = new Map<string, number>();
    let unresolved = 0;
    let resolvedTotal = 0;
    for (const c of calls) {
      if (!c.calleeId) {
        unresolved++;
        continue;
      }
      resolvedTotal++;
      const key = c.provenance ?? 'resolved';
      byProv.set(key, (byProv.get(key) ?? 0) + 1);
    }
    const pct = (n: number): string => (resolvedTotal ? `${Math.round((n / resolvedTotal) * 100)}%` : 'n/a');
    console.log('\n=== Call graph (provenance) ===');
    const table: Record<string, { count: number; pctOfResolved: string }> = {};
    for (const [k, n] of [...byProv.entries()].sort((a, b) => b[1] - a[1])) {
      table[k] = { count: n, pctOfResolved: pct(n) };
    }
    table.unresolved = { count: unresolved, pctOfResolved: 'n/a' };
    console.table(table);
  }

  // --- overall verdict -------------------------------------------------------
  const overallPass = isOverallPass(scores, structural.errors, redFlags);
  const completion = profileCompletion(scores, structural.errors, redFlags);

  const gaps: string[] = [];
  for (const f of scores.filter((s) => s.status === 'required' && s.verdict !== Verdict.PASS)) {
    gaps.push(
      `${f.category}: ${f.verdict} (${f.emitted}/${f.source} = ${Math.round((f.ratio ?? 0) * 100)}%) — raise coverage`,
    );
  }
  if (structural.errors.length)
    gaps.push(`structural: ${structural.errors.length} validate-output error(s) — must be 0`);
  for (const rf of redFlags) gaps.push(`consistency: ${rf}`);

  console.log(`\n=== Overall: ${overallPass ? Verdict.PASS : Verdict.FAIL} ===`);
  if (gaps.length) {
    console.log('Gaps to fix next:');
    for (const g of gaps) console.log(`  - ${g}`);
  } else {
    console.log('No gaps. Every required category PASS, 0 validate errors, no red flags.');
  }

  return { pass: overallPass, completion };
}

/**
 * Score a profile module against a repo, printing the coverage scorecard + gaps to stdout.
 * Single-language profiles print one scorecard; multi-target composites print one per target,
 * then an unclaimed-scope diff and an AND-of-targets overall verdict. Returns overall PASS so
 * callers (the `coredoc profile score` CLI command, tests) can gate on it without owning process.exit.
 */
export async function scoreProfile(ref: string, repoPath: string): Promise<boolean> {
  const { name, dir, resolved } = await resolveProfileRef(ref);
  const repoRoot = path.resolve(repoPath);

  if (resolved.kind === 'single') {
    console.log(`Scoring '${name}' against ${repoRoot}…\n`);
    const result = await scoreSingle(name, resolved.provider, resolved.profile, repoRoot, dir, true);
    console.log(`\n=== Profile completion: ${result.completion} ===`);
    return result.pass;
  }

  // Multi-target: one scorecard per target (sequential — readable output), then
  // the unclaimed-scope diff and an AND-of-targets overall verdict.
  const targetFileScopes = resolved.targets.map((target) => {
    const sourceScope = target.provider.sourceFiles(target.profile, repoRoot);
    return {
      targetName: target.name,
      sourceScope,
      auditScope: {
        excludedPaths: new Set(sourceScope.excluded.filter((file) => !sourceScope.profileExcluded.includes(file))),
        profileExcludedPaths: new Set(sourceScope.profileExcluded),
        explicitExclude: target.profile.substrate.exclude ?? [],
      },
    };
  });
  const ownersByFile = new Map<string, string[]>();
  for (const { targetName, sourceScope } of targetFileScopes) {
    for (const file of sourceScope.included) {
      const owners = ownersByFile.get(file) ?? [];
      owners.push(targetName);
      ownersByFile.set(file, owners);
    }
  }
  const overlappingClaims = [...ownersByFile]
    .filter(([, owners]) => owners.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));
  const overlapRedFlags =
    overlappingClaims.length === 0
      ? []
      : [
          `${overlappingClaims.length} source file(s) are claimed by multiple targets; make target include/exclude globs disjoint: ` +
            overlappingClaims
              .slice(0, 10)
              .map(([file, owners]) => `${file} (${owners.join(', ')})`)
              .join(', ') +
            (overlappingClaims.length > 10 ? `, … ${overlappingClaims.length - 10} more` : ''),
        ];
  const claimed = new Set(targetFileScopes.flatMap(({ sourceScope }) => sourceScope.included));
  let allPass = true;
  let completion: ProfileCompletion = 'PASS';
  for (const t of resolved.targets) {
    console.log(`\n===== Target: ${t.name} (${t.profile.substrate.language}) =====\n`);
    const result = await scoreSingle(`${name}-${t.name}`, t.provider, t.profile, repoRoot, dir);
    const { pass } = result;
    allPass = allPass && pass;
    if (result.completion === 'BLOCKED') completion = 'BLOCKED';
    else if (result.completion === 'ACCEPTABLE_GAP' && completion === 'PASS') completion = 'ACCEPTABLE_GAP';
  }

  const report = unclaimedScope(
    repoRoot,
    claimed,
    targetFileScopes.map(({ auditScope }) => auditScope),
  );
  const scopeRedFlags = [...overlapRedFlags, ...unclaimedScopeRedFlags(report)];
  allPass = allPass && scopeRedFlags.length === 0;
  if (scopeRedFlags.length > 0) completion = 'BLOCKED';
  console.log('\n=== Unclaimed scope ===');
  console.log(`${report.unclaimed}/${report.total} known-language files claimed by no target`);
  if (report.intentionallyExcluded > 0) {
    console.log(`${report.intentionallyExcluded} known-language file(s) intentionally excluded by target scope`);
  }
  for (const d of report.topDirs) console.log(`  ${d.dir}: ${d.count}`);
  for (const file of report.sampleFiles) console.log(`  unclaimed: ${file}`);
  for (const flag of scopeRedFlags) console.log(`  RED: ${flag}`);

  console.log(`\n=== Overall (all targets): ${allPass ? Verdict.PASS : Verdict.FAIL} ===`);
  console.log(`=== Profile completion: ${completion} ===`);
  return allPass;
}

async function main(): Promise<void> {
  const [ref, repoPath] = process.argv.slice(2);
  if (!ref || !repoPath) {
    console.error('Usage: tsx src/score.ts <path-to-profile-module> <repoPath>');
    process.exit(2);
  }
  const overallPass = await scoreProfile(ref, repoPath);
  process.exit(overallPass ? 0 : 1);
}

// Run only when invoked as a script (not when imported by tests). Matched by
// entrypoint PATH: comparing import.meta.url to argv[1] is true for EVERY module
// inside the single-file CLI bundle.
const _entrypoint = process.argv[1]?.replace(/\\/g, '/');
if (_entrypoint?.endsWith('/score.ts') || _entrypoint?.endsWith('/score.js')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
