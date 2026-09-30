/**
 * Parse-anomaly detection rules — pure, no I/O, no telemetry emit.
 *
 * Inspects a completed parse's stats/error-count and reports which anomaly
 * `rule_id`s (an `ErrorCode` subset, see events.ts) apply. The caller (P0.7)
 * maps each returned rule id into a `parse_anomaly` event; this module only
 * decides which rules fired.
 */

import { ErrorCode } from './events.js';
import type { ParseStats } from '../types/index.js';

export interface DetectParseAnomaliesInput {
  stats: ParseStats;
  errorCount: number;
}

/**
 * Detects parse anomalies from stats + error count. Thresholds are the
 * spec's fixed rules, not config (YAGNI) — inlined with a comment each.
 */
export function detectParseAnomalies(input: DetectParseAnomaliesInput): ErrorCode[] {
  const { stats, errorCount } = input;
  const rules: ErrorCode[] = [];

  // Rule 1: functions were found but no calls were extracted between them —
  // usually a call-resolution pass silently failed.
  if (stats.totalCalls === 0 && stats.totalFunctions > 0) {
    rules.push(ErrorCode.ZeroCallsNonzeroFunctions);
  }

  // Rule 2: more than 20% of parsed files errored.
  if (errorCount / Math.max(1, stats.parsedFiles) > 0.2) {
    rules.push(ErrorCode.ErrorRateGt20Pct);
  }

  // Rule 3 (hint): errors present and nothing at all parsed (no functions,
  // no calls) — the signature of the engine failing to locate the
  // tree-sitter WASM binaries, so nothing was extracted.
  if (errorCount > 0 && stats.totalCalls === 0 && stats.totalFunctions === 0) {
    rules.push(ErrorCode.WasmMissing);
  }

  return rules;
}
