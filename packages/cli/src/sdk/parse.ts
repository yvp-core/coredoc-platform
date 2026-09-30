/**
 * SDK Parse — programmatic API for parsing repositories.
 *
 * Throws on failure instead of calling process.exit().
 */

import * as path from 'path';
import * as fs from 'fs';
import type { RuntimeConfig, RepoConfig } from '@coredoc/core/types';
import { getTelemetryConfig, parserDir, parsedRepoFile, repoRefKey } from '@coredoc/core/utils';
import { EventName, repoId, track } from '@coredoc/core/telemetry';
import { trackOperation } from '../operations-tracker.js';
import { bindProjectDatabase } from '../db-scope.js';
import { reportCallResolution, reportIntegrity } from '../integrity-report.js';
import { parseRepoArtifact } from '../parse-repo.js';

export interface ParseOptions {
  config: RuntimeConfig;
  repo?: string;
  /**
   * With `repo`, disambiguates which project's repo to parse (required when the
   * same repo name exists in multiple projects). Without `repo`, scopes the run
   * to that project's repos.
   */
  projectId?: string;
  output?: string;
  pretty?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  /**
   * Auto-generate `repo.key` from the repo name when absent and persist it back
   * into the config file. The Commander `parse` command passes true (it owns the
   * user's config file); other callers opt in.
   */
  writeBackRepoKey?: boolean;
}

export interface ParseResult {
  repo: string;
  success: boolean;
  outputFile?: string;
  error?: string;
}

/**
 * Parse one or more repositories.
 *
 * @returns Array of per-repo results
 * @throws Error only for config-level failures (e.g. repo not found)
 */
export async function parse(options: ParseOptions): Promise<ParseResult[]> {
  const { config } = options;
  const verbose = options.verbose ?? false;

  // Build { projectId, repo } tuples for all repos
  const allRepoRefs: Array<{ projectId: string; repo: RepoConfig }> = [];
  for (const project of config.projects) {
    for (const repo of project.repos) {
      allRepoRefs.push({ projectId: project.id, repo });
    }
  }

  // Determine which repos to parse
  let refsToProcess = allRepoRefs;
  if (options.repo) {
    const matches = allRepoRefs.filter((ref) => ref.repo.name === options.repo);
    if (matches.length === 0) {
      throw new Error(
        `Repo '${options.repo}' not found in config. Available: ${allRepoRefs.map((ref) => ref.repo.name).join(', ')}`,
      );
    }
    let targetRef: { projectId: string; repo: RepoConfig };
    if (options.projectId) {
      const scoped = matches.find((ref) => ref.projectId === options.projectId);
      if (!scoped) {
        throw new Error(
          `Repo '${options.repo}' not found in project '${options.projectId}'. Found in: ${matches.map((m) => m.projectId).join(', ')}`,
        );
      }
      targetRef = scoped;
    } else if (matches.length > 1) {
      throw new Error(
        `Repo '${options.repo}' is ambiguous — exists in projects: ${matches.map((m) => m.projectId).join(', ')}. Specify projectId.`,
      );
    } else {
      targetRef = matches[0]!;
    }
    refsToProcess = [targetRef];
  } else if (options.projectId) {
    // Existence is checked against the projects, not the filtered repos: a known
    // project with zero repos is a no-op, not an error.
    if (!config.projects.some((project) => project.id === options.projectId)) {
      throw new Error(`Project '${options.projectId}' not found`);
    }
    refsToProcess = allRepoRefs.filter((ref) => ref.projectId === options.projectId);
  }

  // Determine output directory
  const outputDir = options.output
    ? path.isAbsolute(options.output)
      ? options.output
      : path.resolve(process.cwd(), options.output)
    : config.resolvedOutputDir;

  if (verbose) {
    console.log('\nCoredoc Parser');
    console.log('==============\n');
    console.log(`Config: ${config.configPath}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Repos to parse: ${refsToProcess.map((ref) => ref.repo.name).join(', ')}`);
    console.log('');
  }

  if (options.dryRun) {
    console.log('\n[DRY RUN] Would parse the following repos:\n');
    for (const { projectId, repo } of refsToProcess) {
      const repoPath = config.resolvedRepoPaths.get(repoRefKey(projectId, repo.name))!;
      const parserPath = parserDir(config.resolvedParserStorage, projectId, repo.name);
      const artifact = ['profile.ts', 'parser.ts'].map((f) => path.join(parserPath, f)).find((p) => fs.existsSync(p));
      console.log(`  ${repo.name}`);
      console.log(`    Path: ${repoPath}`);
      console.log(`    Parser: ${artifact ?? 'NOT FOUND'}`);
      console.log('');
    }
    return [];
  }

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Parse each repo
  const results: ParseResult[] = [];

  for (const { projectId, repo } of refsToProcess) {
    const repoPath = config.resolvedRepoPaths.get(repoRefKey(projectId, repo.name))!;

    // The SDK is callable without the Commander wrapper. Bind before the
    // first operations-table read for this repo, and rebind when a single SDK
    // invocation walks projects sequentially.
    await bindProjectDatabase(config, projectId);

    // Auto-generate repo key from name if absent and write back to config.
    if (options.writeBackRepoKey && !repo.key) {
      repo.key = repo.name;
      try {
        const rawConfig = JSON.parse(fs.readFileSync(config.configPath, 'utf-8'));
        const target = rawConfig.projects
          ?.find((p: { id?: string; repos?: Array<{ name?: string }> }) => p.id === projectId)
          ?.repos?.find((r: { name?: string }) => r.name === repo.name);
        if (target) {
          target.key = repo.name;
          fs.writeFileSync(config.configPath, JSON.stringify(rawConfig, null, 2) + '\n');
        }
      } catch {
        /* non-fatal: config write-back failed */
      }
    }

    console.log(`\nParsing ${repo.name}...`);

    if (!fs.existsSync(repoPath)) {
      console.error(`  \u2717 Repository path not found: ${repoPath}`);
      results.push({ repo: repo.name, success: false, error: 'Repository path not found' });
      continue;
    }

    try {
      // repo_added (P1.T2): there is no `coredoc add` command — a repo is
      // materialized on its FIRST parse, so this event fires once, on that
      // first parse. Detect it by querying the ops repo for a PRIOR completed
      // parse BEFORE this one records. `getOperationSummary` only counts
      // 'completed' ops, so the current in-flight 'started' op never appears
      // here. On any DB error we skip the emit rather than over-count every
      // parse as a first-parse.
      let isFirstParse = false;
      try {
        const { getOperationsRepository } = await import('@coredoc/db');
        const opsRepo = await getOperationsRepository();
        const summary = await opsRepo.getOperationSummary(projectId, repo.name);
        isFirstParse = !summary.lastParsed;
      } catch {
        // DB unavailable — cannot confirm first parse; skip repo_added.
      }

      const parsedRepo = await trackOperation(
        projectId,
        repo.name,
        'parse',
        async () => {
          const parsedRepo = await parseRepoArtifact({
            parserStorage: config.resolvedParserStorage,
            projectId,
            repoName: repo.name,
            repoRoot: repoPath,
            repoKey: repo.key,
            repoType: repo.type,
            exclude: [...(config.exclude || []), ...(repo.exclude || [])],
          });

          // Write output file (nested under {projectId}/ in the workspace-scoped layout)
          const outputFilePath = parsedRepoFile(outputDir, projectId, repo.name);
          fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
          const pretty = options.pretty ?? true;
          const jsonContent = pretty ? JSON.stringify(parsedRepo, null, 2) : JSON.stringify(parsedRepo);
          fs.writeFileSync(outputFilePath, jsonContent);

          console.log(`  \u2713 Parsed successfully`);
          console.log(`    Output: ${outputFilePath}`);
          reportIntegrity(parsedRepo);
          reportCallResolution(parsedRepo);
          results.push({ repo: repo.name, success: true, outputFile: outputFilePath });

          return parsedRepo;
        },
        // SQLite metadata reads the engine-recorded stats, not re-derived
        // `.length` (which drifts). The parse scorecard/anomaly telemetry is
        // emitted from trackOperation's parse branch, off `parsedRepo.stats`.
        (parsedRepo) => ({
          files: parsedRepo.stats.parsedFiles,
          functions: parsedRepo.stats.totalFunctions,
          classes: parsedRepo.stats.totalClasses,
          entrypoints: parsedRepo.stats.totalEntrypoints,
          entities: parsedRepo.stats.totalEntities,
          gitCommitHash: parsedRepo.git?.commitHash,
          gitCommitShortHash: parsedRepo.git?.commitShortHash,
          gitBranch: parsedRepo.git?.branch,
          gitIsDirty: parsedRepo.git?.isDirty,
        }),
      );

      // Fire repo_added exactly once, after the successful first parse. Props
      // are only knowable post-parse: package_count off the parsed packages and
      // language_hint off the distinct file languages (there is no `language`
      // field on RepoConfig). Scalar props only — languages are comma-joined.
      if (isFirstParse) {
        const languageHint = [...new Set((parsedRepo.files ?? []).map((f) => f.language))].join(',');
        // repo_added is the funnel ENTRY milestone — it must carry repo_id or the
        // (install_id, repo_id) funnel has no anchor. The client's base repo_id is
        // never populated, so derive it here from the parsed repo path (same source
        // parse_completed uses, so both milestones agree on the id).
        const { installId } = await getTelemetryConfig();
        track(EventName.RepoAdded, {
          package_count: parsedRepo.packages?.length ?? 0,
          language_hint: languageHint,
          repo_id: repoId(installId, parsedRepo.path),
        });
      }
    } catch (error) {
      console.error(`  \u2717 Error: ${error instanceof Error ? error.message : error}`);
      results.push({ repo: repo.name, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Summary
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  if (successful > 0) {
    console.log(`\nSuccessfully parsed ${successful} repo${successful === 1 ? '' : 's'}`);
  }
  if (failed > 0) {
    console.log(`Failed to parse ${failed} repo${failed === 1 ? '' : 's'}`);
    // SDK throws instead of process.exit()
    throw new Error(`Failed to parse ${failed} repo${failed === 1 ? '' : 's'}`);
  }

  return results;
}
