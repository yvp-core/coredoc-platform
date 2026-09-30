/**
 * Parsing one repository with its stored parser artifact.
 *
 * The single implementation behind `coredoc parse`, the SDK `parse()` and
 * `ci run`. Deliberately free of any local graph-database import: `ci run`
 * reaches this module, and a CI process must never open a local graph
 * (enforced by the CI-boundary test in db-scope.test.ts).
 */

import * as path from 'path';
import * as fs from 'fs';
import type { RepoConfig, ParsedRepo } from '@coredoc/core/types';
import { parserDir } from '@coredoc/core/utils';
import { loadParser } from './parser-loader.js';
import { assertNoBlockingExtractionErrors } from './extraction-error-gate.js';

export interface ParseRepoArtifactOptions {
  /** Root of parser artifact storage ({parserStorage}/{projectId}/{repoName}/profile.ts). */
  parserStorage: string;
  projectId: string;
  repoName: string;
  /** Path of the repository checkout to parse. */
  repoRoot: string;
  repoKey?: string;
  repoType?: RepoConfig['type'];
  exclude?: string[];
  /**
   * Throw when TS/JS semantic analysis produced no resolved edge at all for a
   * degraded target ("semantic blackout"). `ci run` passes true — a blackout
   * graph must not reach a shared workspace. Local parse leaves it false: an
   * inspectable degraded output beats no output.
   */
  refuseSemanticBlackout?: boolean;
  /** Sink for the degraded-analysis notice. Defaults to `console.warn`; `ci run` passes its prefixed logger. */
  warn?: (message: string) => void;
}

/**
 * Owns nothing else: operations tracking, output files and telemetry stay with
 * the caller.
 */
export async function parseRepoArtifact(options: ParseRepoArtifactOptions): Promise<ParsedRepo> {
  const parser = await loadParser(options.parserStorage, options.projectId, options.repoName, {
    repoRoot: options.repoRoot,
    repoName: options.repoName,
    repoKey: options.repoKey ?? options.repoName,
    repoType: options.repoType,
    exclude: options.exclude,
  });

  if (!parser) {
    throw new Error(
      `Failed to load parser for "${options.repoName}" from ${parserDir(options.parserStorage, options.projectId, options.repoName)}`,
    );
  }

  const parsedRepo = await parser.parse();
  assertNoBlockingExtractionErrors(parsedRepo);
  assertNoSemanticBlackout(parsedRepo, options.refuseSemanticBlackout ?? false, options.warn ?? console.warn);

  // Compute parser-artifact hash for review/approval tracking. Prefer the declarative
  // profile.ts (legacy parser.ts fallback) — must match loadParser's resolution and the
  // desktop review gate, or the gate compares against the wrong artifact.
  const artifactDir = parserDir(options.parserStorage, options.projectId, options.repoName);
  const artifactPath = ['profile.ts', 'parser.ts']
    .map((file) => path.join(artifactDir, file))
    .find((candidate) => fs.existsSync(candidate));
  if (artifactPath) {
    const crypto = await import('crypto');
    const parserContent = fs.readFileSync(artifactPath);
    parsedRepo.parserHashAtParse = crypto.createHash('sha256').update(parserContent).digest('hex');
  }

  // Capture git version info — optional, a checkout without git still parses.
  try {
    const { captureGitInfo } = await import('@coredoc/core/utils');
    const gitInfo = await captureGitInfo(options.repoRoot);
    if (gitInfo) {
      parsedRepo.git = gitInfo;
    }
  } catch {
    // Non-fatal: git info is optional.
  }

  return parsedRepo;
}

/** Refuse a semantic blackout, not a useful graph that was produced in basic mode. */
function assertNoSemanticBlackout(parsedRepo: ParsedRepo, refuse: boolean, warn: (message: string) => void): void {
  const degradedTargets = (parsedRepo.stats?.analysis ?? []).filter(
    (record) => (record.language === 'ts' || record.language === 'js') && record.fallback,
  );
  if (degradedTargets.length === 0) return;
  warn('TypeScript/JavaScript used basic analysis; compiler resolution was unavailable.');
  if (!refuse) return;

  // mergeParsedRepos preserves ownership on files. Attribute an edge to its caller,
  // so a healthy backend cannot conceal a frontend's complete resolution failure.
  const fileTargets = new Map(parsedRepo.files.map((file) => [file.id, file.target]));
  const pathTargets = new Map(parsedRepo.files.map((file) => [file.path, file.target]));
  const callerTargets = new Map(parsedRepo.functions.map((fn) => [fn.id, fileTargets.get(fn.fileId)]));
  const resolvedEdges = [...(parsedRepo.calls ?? []).filter((call) => call.calleeId), ...parsedRepo.externalCalls];
  const blackoutTargets = degradedTargets.filter(
    (record) =>
      !resolvedEdges.some(
        (edge) =>
          !record.target ||
          (callerTargets.get(edge.callerId) ?? pathTargets.get(edge.location?.filePath)) === record.target,
      ),
  );
  if (blackoutTargets.length > 0) {
    throw new Error(
      `TypeScript/JavaScript semantic analysis was unavailable for ${blackoutTargets.map((record) => record.target ?? record.language).join(', ')}; ` +
        'refusing to publish a degraded graph with no resolved call or external-call edges. Install the repository dependencies and ensure scip-typescript can run, then retry. Use --dry-run to inspect basic output without publishing.',
    );
  }
}
