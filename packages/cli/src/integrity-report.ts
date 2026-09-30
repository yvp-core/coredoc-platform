/**
 * Parse-time referential-integrity reporting, shared by the `parse` command
 * (index.ts) and the programmatic SDK path (sdk/parse.ts) — both write the same
 * ParsedRepo, so both must say the same thing about it.
 */
import type { ParsedRepo } from '@coredoc/core/types';
import { CALL_RESOLUTION_TEXT, DB_OP_RESOLUTION_TEXT, ResolutionRecordState, classifyResolution } from '@coredoc/core';

/** Red for a terminal that wants colour; plain text everywhere else (NO_COLOR, pipes, CI logs). */
function red(text: string): string {
  const plain = !process.stdout.isTTY || process.env.NO_COLOR !== undefined;
  return plain ? text : `\u001b[31m${text}\u001b[39m`;
}

/**
 * Print the referential-integrity verdict of a finished parse. A dangling
 * reference means part of the graph is unjoinable — the exact failure mode that
 * used to ship as a green parse (see ParseStats.integrity), so it gets a red
 * line on stdout, not a JSON field nobody opens. Silent when the graph is clean.
 */
export function reportIntegrity(parsedRepo: ParsedRepo): void {
  const integrity = parsedRepo.stats.integrity;
  if (!integrity) return;
  const entries = Object.entries(integrity.byCollection);
  if (entries.length === 0) return;
  const detail = entries.map(([collection, count]) => `${collection}=${count}`).join(', ');
  console.log(red(`    \u2717 integrity: ${integrity.danglingRefs} dangling reference(s) — ${detail}`));
  console.log(red(`      the graph is partial; see errors[] in the output file`));
}

/**
 * Print how much of the call graph actually resolved, for substrates that measure it.
 *
 * The rate is reported against calls that could point INTO this repository, not against every
 * call expression. Most calls in an application go to its platform SDK, the standard library
 * or a dependency; no node in the graph could ever be their target, so counting them as
 * unresolved buries the number that matters under one that only reflects how much framework
 * an app uses. The raw total is still printed beside it, so nothing is hidden — a reader can
 * see both how much was in scope and how much of it bound.
 *
 * No target threshold is attached, deliberately: a threshold invites tuning the extractor
 * toward the number instead of toward correct edges, which for a precision-first substrate is
 * the failure mode, not the goal. Silent for substrates that record nothing.
 *
 * Prints the DB-operation counterpart beside it, on the same terms.
 */
export function reportCallResolution(parsedRepo: ParsedRepo): void {
  reportCallSites(parsedRepo);
  reportDbOpSites(parsedRepo);
}

function reportCallSites(parsedRepo: ParsedRepo): void {
  const stats = parsedRepo.stats.callResolution;
  if (!stats || stats.callSites === 0) return;
  const counts = { sites: stats.callSites, bound: stats.resolvedCalls, outOfScope: stats.outOfScopeCalls };
  const state = classifyResolution(counts);
  if (state === ResolutionRecordState.Inconsistent) {
    console.log(
      `    call resolution: ${CALL_RESOLUTION_TEXT.inconsistent} (${stats.resolvedCalls} bound, ${stats.outOfScopeCalls} out of scope over ${stats.callSites} counted sites)`,
    );
    return;
  }
  if (state === ResolutionRecordState.AllOutOfScope) {
    console.log(`    call resolution: ${CALL_RESOLUTION_TEXT.allOutOfScope(stats.callSites)}`);
    return;
  }
  // Ambiguity is a Kotlin-only diagnostic; the neutral record deliberately carries no such field, and
  // the line's denominator may span other targets — so the count is labelled rather than read as measured
  // over the same population. A repo with no Kotlin target carries no record, and the line prints without
  // the suffix rather than claiming zero ambiguity for a language that never ran.
  const ambiguousCalls = parsedRepo.stats.kotlin?.ambiguousCalls ?? 0;
  const ambiguous = ambiguousCalls > 0 ? ` (Kotlin: ${ambiguousCalls} ambiguous)` : '';
  const inScope = stats.callSites - stats.outOfScopeCalls;
  const pct = Math.round((stats.resolvedCalls / inScope) * 100);
  console.log(
    `    call resolution: ${stats.resolvedCalls}/${inScope} counted in-repo call sites bound (${pct}%)${ambiguous}` +
      `; ${stats.outOfScopeCalls} of ${stats.callSites} counted sites name nothing declared in this repository`,
  );
}

/**
 * The same report for DB operations: how many of the db-operation sites the parser COUNTED bound
 * to an entity, against the sites that could bind at all. Out-of-scope sites (their receiver or
 * table token names no entity or table declared here) are disclosed beside it rather than counted
 * as failures, exactly as for calls. Silent for substrates that record nothing.
 */
function reportDbOpSites(parsedRepo: ParsedRepo): void {
  const stats = parsedRepo.stats.dbOpResolution;
  if (!stats || stats.dbOpSites === 0) return;
  const counts = { sites: stats.dbOpSites, bound: stats.boundDbOps, outOfScope: stats.outOfScopeDbOps };
  const state = classifyResolution(counts);
  if (state === ResolutionRecordState.Inconsistent) {
    console.log(
      `    db-op resolution: ${DB_OP_RESOLUTION_TEXT.inconsistent} (${stats.boundDbOps} bound, ${stats.outOfScopeDbOps} out of scope over ${stats.dbOpSites} counted sites)`,
    );
    return;
  }
  if (state === ResolutionRecordState.AllOutOfScope) {
    console.log(`    db-op resolution: ${DB_OP_RESOLUTION_TEXT.allOutOfScope(stats.dbOpSites)}`);
    return;
  }
  const inScope = stats.dbOpSites - stats.outOfScopeDbOps;
  const pct = Math.round((stats.boundDbOps / inScope) * 100);
  console.log(
    `    db-op resolution: ${stats.boundDbOps}/${inScope} counted db-operation sites bound (${pct}%)` +
      `; ${stats.outOfScopeDbOps} of ${stats.dbOpSites} counted sites name no entity or table declared in this repository`,
  );
}
