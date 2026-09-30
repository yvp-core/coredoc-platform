// Rewrites derived REPORT.md and mcp-gaps.jsonl for an existing run using the
// current report logic. Source artifacts (results, manifest, prompts,
// transcripts, responses, usage, verifier, and judge files) remain read-only.
//
// Usage: pnpm exec tsx scripts/rewrite-report.ts <run-dir>

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyzeRunDir } from '../harness/analyze-mcp.js';
import type { RunManifest } from '../harness/provenance.js';
import { type ReportMeta, writeReport } from '../harness/report.js';
import {
  AgentProvider,
  GraphBackend,
  type RunRecord,
} from '../harness/types.js';
import { compareCodeUnits } from '../harness/deterministic-order.js';

const LEGACY_UNKNOWN = 'unknown (legacy: no run-manifest.json)';

function objectAt(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where} must be a non-empty string.`);
  }
  return value;
}

export function readRunManifest(runDir: string): RunManifest | null {
  const manifestPath = join(runDir, 'run-manifest.json');
  if (!existsSync(manifestPath)) return null;

  const raw = objectAt(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
  if (raw.schemaVersion !== 1) throw new Error(`${manifestPath}: schemaVersion 1 is required.`);
  const harness = objectAt(raw.harness, `${manifestPath}.harness`);
  const graph = objectAt(raw.graph, `${manifestPath}.graph`);
  const models = objectAt(raw.models, `${manifestPath}.models`);
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error(`${manifestPath}.targets must contain at least one target.`);
  }
  if (!Array.isArray(graph.repositories) || graph.repositories.length === 0) {
    throw new Error(`${manifestPath}.graph.repositories must contain at least one repository.`);
  }

  stringAt(raw.cohortId, `${manifestPath}.cohortId`);
  stringAt(harness.head, `${manifestPath}.harness.head`);
  stringAt(models.agentModel, `${manifestPath}.models.agentModel`);
  stringAt(models.judgeModel, `${manifestPath}.models.judgeModel`);
  stringAt(models.judgeProvider, `${manifestPath}.models.judgeProvider`);
  const provider = stringAt(models.provider, `${manifestPath}.models.provider`);
  if (!Object.values(AgentProvider).includes(provider as AgentProvider)) {
    throw new Error(`${manifestPath}.models.provider is not a supported provider.`);
  }
  const backend = stringAt(graph.backend, `${manifestPath}.graph.backend`);
  if (!Object.values(GraphBackend).includes(backend as GraphBackend)) {
    throw new Error(`${manifestPath}.graph.backend is not a supported backend.`);
  }
  for (const [index, target] of raw.targets.entries()) {
    const value = objectAt(target, `${manifestPath}.targets[${index}]`);
    stringAt(value.repoKey, `${manifestPath}.targets[${index}].repoKey`);
    stringAt(
      value.actualVerifierGitSha,
      `${manifestPath}.targets[${index}].actualVerifierGitSha`,
    );
  }
  for (const [index, repository] of graph.repositories.entries()) {
    const value = objectAt(repository, `${manifestPath}.graph.repositories[${index}]`);
    stringAt(value.repoKey, `${manifestPath}.graph.repositories[${index}].repoKey`);
    stringAt(value.parsedGitSha, `${manifestPath}.graph.repositories[${index}].parsedGitSha`);
  }
  return raw as unknown as RunManifest;
}

function parseLegacyModels(existingReport: string): [string, string] {
  const models = existingReport.match(/\*\*Models:\*\*\s+([^\n]+)/)?.[1];
  if (!models) return ['unknown (legacy)', 'unknown (legacy)'];
  const [agentModel, judgeModel] = models
    .split(',')
    .map((value) => value.trim().replace(/\s*\([^)]+\)/, ''));
  return [agentModel || 'unknown (legacy)', judgeModel || 'unknown (legacy)'];
}

function wallClockMs(existingReport: string): number {
  const match = existingReport.match(/\*\*wall-clock:\*\*\s+([\d.]+)m/i);
  return match ? Number(match[1]) * 60_000 : 0;
}

function legacyCommit(existingReport: string): string {
  return (
    existingReport.match(/\*\*Harness HEAD:\*\*\s+`([^`]+)`/)?.[1] ??
    existingReport.match(/\*\*Commit:\*\*\s+`([^`]+)`/)?.[1] ??
    'unknown (legacy)'
  );
}

function sortedRevisionSummary(
  revisions: ReadonlyArray<{ repoKey: string; sha: string }>,
): string {
  return [...revisions]
    .sort((left, right) => compareCodeUnits(left.repoKey, right.repoKey))
    .map((revision) => `${revision.repoKey}=${revision.sha}`)
    .join(', ');
}

export function resolveReportMetadata(opts: {
  runDir: string;
  existingReport: string;
  records: readonly RunRecord[];
}): ReportMeta {
  const manifest = readRunManifest(opts.runDir);
  if (!manifest) {
    const [agentModel, judgeModel] = parseLegacyModels(opts.existingReport);
    return {
      runId: basename(opts.runDir),
      agentModel,
      judgeModel,
      wallClockMs: wallClockMs(opts.existingReport),
      commit: legacyCommit(opts.existingReport),
      ...(opts.records[0]?.provider ? { provider: opts.records[0].provider } : {}),
      ...(opts.records[0]?.backend ? { backend: opts.records[0].backend } : {}),
      ...(opts.records[0]?.accessMode ? { accessMode: opts.records[0].accessMode } : {}),
      actualTargetSha: LEGACY_UNKNOWN,
      graphParsedSha: LEGACY_UNKNOWN,
      cohortId: LEGACY_UNKNOWN,
    };
  }

  return {
    runId: basename(opts.runDir),
    agentModel:
      manifest.models.provider === AgentProvider.Codex
        ? `codex:${manifest.models.agentModel}`
        : manifest.models.agentModel,
    judgeModel: `${manifest.models.judgeProvider}:${manifest.models.judgeModel}`,
    wallClockMs: wallClockMs(opts.existingReport),
    commit: manifest.harness.head,
    provider: manifest.models.provider,
    backend: manifest.graph.backend,
    ...(manifest.graph.sourceInGraph === undefined
      ? {}
      : { sourceInGraph: manifest.graph.sourceInGraph }),
    ...(opts.records[0]?.accessMode ? { accessMode: opts.records[0].accessMode } : {}),
    actualTargetSha: sortedRevisionSummary(
      manifest.targets.map((target) => ({
        repoKey: target.repoKey,
        sha: target.actualVerifierGitSha,
      })),
    ),
    graphParsedSha: sortedRevisionSummary(
      manifest.graph.repositories.map((repository) => ({
        repoKey: repository.repoKey,
        sha: repository.parsedGitSha,
      })),
    ),
    cohortId: manifest.cohortId,
  };
}

function main(): void {
  const target = process.argv[2];
  if (!target) throw new Error('usage: tsx scripts/rewrite-report.ts <run-dir>');

  const runDir = resolve(target);
  const jsonlPath = join(runDir, 'results.jsonl');
  if (!existsSync(jsonlPath)) throw new Error(`results.jsonl not found at ${jsonlPath}`);

  const records = readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunRecord);
  console.log(`loaded ${records.length} records from ${jsonlPath}`);

  const reportPath = join(runDir, 'REPORT.md');
  const existingReport = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  const runManifest = readRunManifest(runDir);
  writeReport({
    records,
    meta: resolveReportMetadata({ runDir, existingReport, records }),
    reportPath,
    runManifest,
  });

  // Both outputs below are derived and reproducible. results.jsonl,
  // run-manifest.json, and every per-run source artifact remain untouched.
  const gap = analyzeRunDir(runDir);
  const current = readFileSync(reportPath, 'utf8');
  const gapIndex = current.indexOf('## MCP gap signals');
  const stripped =
    gapIndex >= 0 ? current.slice(0, gapIndex).replace(/\s+$/, '\n') : current;
  writeFileSync(reportPath, `${stripped}${gap.reportSection.join('\n')}\n`);
  console.log(`rewrote ${reportPath}`);
  console.log(`MCP gaps refreshed: ${gap.records.length} flagged`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 2;
  }
}
