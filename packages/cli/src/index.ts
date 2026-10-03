#!/usr/bin/env node
/**
 * Coredoc CLI
 *
 * Command-line interface for running coredoc parsers.
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { RuntimeConfig } from '@coredoc/core/types';
import { listAvailableParsers } from './parser-loader.js';
import { parse as sdkParse } from './sdk/parse.js';
import { readOpsTimestamps } from './sdk/ops.js';
import { CLI_VERSION } from './version.js';
import {
  getAllRepos,
  loadConfig as loadCoredocConfig,
  repoRefKey,
  resolveRepoRef,
  parserDir as buildParserDir,
  resolveCoredocHome,
} from '@coredoc/core/utils';
import { runSummarize } from './summarize/index.js';
import { resolveSummarizeHarness } from './summarize/harness.js';
import type { EmbedOptions, EmbeddingProvider, InputStrategy } from './embed/index.js';
import { resolveMetadataInclusion, runUnifiedPush } from './push/index.js';
import { login, logout, whoami } from './auth.js';
import { config } from 'dotenv';
import { getTelemetryConfig, setTelemetryEnabled } from '@coredoc/core/utils';
import { initTelemetry, type Surface } from '@coredoc/core/telemetry';
import { BUNDLED_POSTHOG_KEY, BUNDLED_POSTHOG_HOST } from './build-env.js';
import {
  shutdownTelemetry,
  classifyError,
  trackCommandCompleted,
  trackCommandFailed,
  trackProfileAuthored,
  isTelemetryCommandPath,
  buildTelemetryShowText,
} from './telemetry.js';
import { maybeShowFirstRunTelemetryNotice } from './first-run-notice.js';
import { bindProjectDatabase, unresolvedProjectError } from './db-scope.js';
import type { DatabaseBackend } from '@coredoc/db';
import { isAbortedControlWrite } from './review/claude-code-runtime.js';
import { registerReviewCommand } from './review/command.js';

// Load env vars: .env in cwd first, then <coredoc home>/.env as fallback.
// COREDOC_HOME itself must come from the real environment — it cannot be set
// from these .env files since it decides which of them is read.
config(); // cwd/.env
config({ path: path.join(resolveCoredocHome(), '.env'), override: false });

// Standalone bundle: the engine is esbuilt into one file, so the profile
// typecheck gate finds no @coredoc/profile-parser package root on disk to
// compile profiles against. Only the host knows the sidecar layout, so point
// the gate at it — same wiring as apps/desktop/src/main/index.ts. Left unset
// when the schema isn't there, so the gate raises its own explicit error
// instead of failing later against a directory that holds no declarations.
if (!process.env.COREDOC_PROFILE_SCHEMA_DIR && process.env.COREDOC_RUNTIME_MODULES) {
  const schemaDir = path.join(process.env.COREDOC_RUNTIME_MODULES, '@coredoc', 'profile-parser');
  if (fs.existsSync(path.join(schemaDir, 'dist', 'index.d.ts'))) {
    process.env.COREDOC_PROFILE_SCHEMA_DIR = schemaDir;
  }
}

// The SCIP tier shells out to bare binaries by name (`scip-typescript`), which
// the sidecar ships with the shims the bundler recreates. Appended, not
// prepended: an indexer the host already provides — the Docker image installs
// one globally — stays authoritative over the bundled copy.
if (process.env.COREDOC_RUNTIME_MODULES) {
  const binDir = path.join(process.env.COREDOC_RUNTIME_MODULES, '.bin');
  const parts = (process.env.PATH ?? '').split(path.delimiter);
  if (fs.existsSync(binDir) && !parts.includes(binDir)) {
    process.env.PATH = [...parts, binDir].join(path.delimiter);
  }
}

// Configure the shared telemetry client up front with the CLI's bundled anon
// key (baked into build-env.ts at release-build time; empty in dev/test ⇒
// no-op, unchanged behavior). Without this the standalone CLI has NO PostHog
// key and every parse_completed emit is a silent no-op. Init is lazy +
// idempotent, so a later auto-init on first `track` is harmless; a runtime
// COREDOC_POSTHOG_* env still wins inside the channel. COREDOC_SURFACE is set
// by the desktop main when it spawns the CLI/worker (surface: 'desktop').
//
// Version base props are env-driven so child processes/threads inherit them.
// `??=` keeps a desktop parent's stamp (it sets both at launch); standalone the
// CLI stamps its own build version. The engine ships in lockstep with the CLI
// (one release tag stamps every workspace manifest), so it carries the same value.
process.env.COREDOC_CLI_VERSION ??= CLI_VERSION;
process.env.COREDOC_ENGINE_VERSION ??= CLI_VERSION;
initTelemetry({
  surface: (process.env.COREDOC_SURFACE as Surface | undefined) ?? 'cli',
  channels: { posthogKey: BUNDLED_POSTHOG_KEY, posthogHost: BUNDLED_POSTHOG_HOST },
});

const program = new Command();

const cliStartTime = Date.now();

/** Max repos summarized in parallel when `summarize` runs over a whole project. */
const SUMMARIZE_PROJECT_CONCURRENCY = 4;

program
  .name('coredoc')
  .description('AI-powered codebase parser that generates structured JSON representations')
  .version(CLI_VERSION);

registerReviewCommand(program);

program
  .command('tools')
  .description('Install optional analysis tools outside source repositories')
  .command('install <language>')
  .description('Install a pinned optional indexer: csharp, ruby, python')
  .action(async (language: string) => {
    if (!['csharp', 'ruby', 'python'].includes(language))
      program.error(
        'Supported tools: csharp, ruby, python. TypeScript is bundled. For Rust use rustup component add rust-analyzer rust-src. For Go use go install github.com/scip-code/scip-go/cmd/scip-go@v0.2.7.',
      );
    const install =
      language === 'ruby'
        ? (await import('@coredoc/profile-parser/ruby-install')).installRubyTool
        : language === 'python'
          ? (await import('@coredoc/profile-parser/python-install')).installPythonTool
          : (await import('@coredoc/profile-parser/csharp-install')).installCSharpTool;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const installed = await install(undefined, { signal: controller.signal, onLog: console.log });
      console.log(`${language} indexer ready: ${installed}`);
    } catch (error) {
      console.error(`${language} tool installation failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  });

// =============================================================================
// Parse Command
// =============================================================================

program
  .command('parse')
  .description('Parse repositories defined in config file')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-r, --repo <name>', 'Parse only specific repo (by name)')
  .option('-p, --project <id>', 'Project (workspace) id; use when repo name is ambiguous across projects')
  .option('-o, --output <dir>', 'Override output directory')
  .option('--pretty', 'Pretty print JSON output', true)
  .option('--no-pretty', 'Minify JSON output')
  .option('-v, --verbose', 'Verbose output')
  .option('--dry-run', 'Show what would be parsed without actually parsing')
  .action(async (options) => {
    try {
      await runParse(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// List Command
// =============================================================================

program
  .command('list')
  .description('List available parsers')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .action(async (options) => {
    try {
      const config = loadConfig(options.config);
      const parsers = await listAvailableParsers(config.resolvedParserStorage);

      console.log('\nAvailable Parsers:');
      console.log('==================\n');

      if (parsers.length === 0) {
        console.log('No parsers found in', config.resolvedParserStorage);
        return;
      }

      for (const parser of parsers) {
        console.log(`  ${parser.name}`);
        console.log(`    Project: ${parser.projectId}`);
        console.log(
          `    Type: ${parser.kind === 'profile' ? 'profile.ts (extraction profile)' : 'parser.ts (legacy)'}`,
        );
        // metadata.json is optional (legacy parsers only); skip these fields
        // entirely rather than printing a wall of "unknown".
        if (parser.metadata) {
          console.log(`    Target repos: ${parser.metadata.targetRepos?.join(', ') || 'unknown'}`);
          console.log(`    Language: ${parser.metadata.language || 'unknown'}`);
          console.log(`    Frameworks: ${parser.metadata.frameworks?.join(', ') || 'none'}`);
          console.log(`    Validated: ${parser.metadata.validation?.passed ? 'Yes' : 'No'}`);
        }
        console.log('');
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// Validate Command
// =============================================================================

program
  .command('validate')
  .description('Validate config file')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .action((options) => {
    try {
      const config = loadConfig(options.config);
      const allRepos = getAllRepos(config);
      console.log('\nConfig validation passed!\n');
      console.log(`  Projects: ${config.projects.length}`);
      console.log(`  Total repos: ${allRepos.length}`);
      console.log(`  Output dir: ${config.resolvedOutputDir}`);
      console.log(`  Parser storage: ${config.resolvedParserStorage}`);
      console.log('');

      for (const project of config.projects) {
        for (const repo of project.repos) {
          const repoPath = config.resolvedRepoPaths.get(repoRefKey(project.id, repo.name));
          const exists = repoPath && fs.existsSync(repoPath);
          console.log(`  [${exists ? '✓' : '✗'}] ${project.id}/${repo.name}: ${repoPath}`);
        }
      }
      console.log('');
    } catch (error) {
      console.error('Validation failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// Resolve Command
// =============================================================================

program
  .command('resolve')
  .description('Resolve cross-repo edges from parsed output files')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <ids>', 'Only resolve repos in these project ids (comma-separated)')
  .option('-o, --output <path>', 'Output file for resolved graph', 'resolved-graph.json')
  .option('--pretty', 'Pretty print JSON output', true)
  .option('--no-pretty', 'Minify JSON output')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      await runResolve(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

interface ResolveOptions {
  config: string;
  project?: string;
  output: string;
  pretty?: boolean;
  verbose?: boolean;
}

async function runResolve(options: ResolveOptions): Promise<void> {
  const config = loadConfig(options.config);

  const projectIds = options.project
    ? options.project
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  const { runResolveCore } = await import('./sdk/resolve.js');
  runResolveCore({
    config,
    projectIds,
    output: options.output,
    pretty: options.pretty ?? true,
    verbose: options.verbose ?? false,
  });
}

// =============================================================================
// Cross-Service Report Command
// =============================================================================

program
  .command('cross-service-report')
  .description('Diagnostic report on cross-service resolution health for a project')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <id>', 'Restrict to a single project')
  .option('--json', 'Output JSON instead of human-readable text', false)
  .option('-o, --output <path>', 'Write report to file instead of stdout')
  .action(async (options) => {
    try {
      const { runCrossServiceReport, formatReport } = await import('./sdk/cross-service-report.js');
      const report = await runCrossServiceReport(options);
      const text = options.json ? JSON.stringify(report, null, 2) : formatReport(report);
      if (options.output) {
        fs.writeFileSync(options.output, text);
        console.log(`Wrote report to ${options.output}`);
      } else {
        console.log(text);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// =============================================================================
// Summarize Command
// =============================================================================

program
  .command('summarize')
  .description('Generate AI summaries for functions in a parsed repository')
  .argument(
    '[repo]',
    'Repository name or path to parsed JSON file; omit with --project to summarize every repo in the project',
  )
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <id>', 'Project (workspace) id; use when repo name is ambiguous across projects')
  .option('-b, --batch-size <number>', 'Batch size for parallel processing', '10')
  .option('-d, --delay <ms>', 'Delay between batches in milliseconds', '100')
  .option('-f, --force', 'Force re-summarization (ignore cache)', false)
  .option(
    '-m, --model <name>',
    'Model to use (defaults to claude-haiku-4-5-20251001 for the Claude Code harness, gpt-6-luna for the Codex harness; required with --provider)',
  )
  .option(
    '--provider <name>',
    'LLM provider: anthropic, openai, openrouter, ollama. Omit to use the local harness selected by COREDOC_HARNESS_PROVIDER (Claude Code by default, no API key).',
  )
  .option('-k, --api-key <key>', 'API key for the LLM provider (or set COREDOC_LLM_API_KEY). Not needed for ollama.')
  .option('--base-url <url>', 'Override provider base URL, e.g. a remote Ollama host (or set OLLAMA_BASE_URL)')
  .option('-v, --verbose', 'Verbose output', false)
  .option('--dry-run', 'Show what would be processed without making API calls', false)
  .option('--repo-summary', 'Generate repository-level summary after function summaries (default: true)', true)
  .option('--no-repo-summary', 'Skip repository-level summary generation')
  .action(async (repo: string | undefined, options: Record<string, string | boolean | undefined>) => {
    try {
      const config = loadConfig(options.config as string);
      const projectOpt = options.project as string | undefined;

      // Honor the harness the desktop Settings screen wrote into the loaded .env files.
      // An explicit --provider routes through the API-key pipeline instead and wins.
      const harnessSelection = options.provider ? undefined : resolveSummarizeHarness(process.env);
      if (harnessSelection) {
        console.log(`Summarize harness: ${harnessSelection.harness} (auth: ${harnessSelection.authMode})`);
      }

      const baseOptions = {
        config: options.config as string,
        batchSize: parseInt(options.batchSize as string, 10),
        delay: parseInt(options.delay as string, 10),
        force: options.force as boolean,
        model: options.model as string | undefined,
        provider: options.provider as string | undefined,
        apiKey: options.apiKey as string | undefined,
        baseURL: options.baseUrl as string | undefined,
        verbose: options.verbose as boolean,
        dryRun: options.dryRun as boolean,
        repoSummary: options.repoSummary as boolean,
        ...(harnessSelection && {
          harness: harnessSelection.harness,
          codexCliPath: harnessSelection.codexCliPath,
          sdkEnv: harnessSelection.sdkEnv,
        }),
      };

      // No repo argument: summarize every repo in the given project.
      if (!repo) {
        if (!projectOpt) {
          throw new Error('Provide a <repo> argument, or use --project to summarize every repo in a project.');
        }
        const project = config.projects.find((p) => p.id === projectOpt);
        if (!project) {
          throw new Error(`Project not found: ${projectOpt}`);
        }
        if (project.repos.length === 0) {
          throw new Error(`Project '${projectOpt}' has no repos to summarize.`);
        }
        await bindProjectDatabase(config, project.id);

        const concurrency = Math.min(SUMMARIZE_PROJECT_CONCURRENCY, project.repos.length);
        console.log(
          `\nSummarizing ${project.repos.length} repo(s) in project '${projectOpt}' (up to ${concurrency} in parallel)...`,
        );

        // Run repos through a bounded worker pool. A failing repo is recorded
        // and reported at the end instead of aborting the whole batch.
        const queue = [...project.repos];
        const failures: { repo: string; error: string }[] = [];
        const worker = async () => {
          for (;;) {
            const r = queue.shift();
            if (!r) return;
            console.log(`\n=== ${r.name} ===`);
            try {
              await runSummarize({ ...baseOptions, projectId: project.id, repo: r.name }, config);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              failures.push({ repo: r.name, error: message });
              console.error(`Failed to summarize ${r.name}: ${message}`);
            }
          }
        };
        await Promise.all(Array.from({ length: concurrency }, () => worker()));

        if (failures.length > 0) {
          console.error(`\n${failures.length}/${project.repos.length} repo(s) failed to summarize:`);
          for (const f of failures) {
            console.error(`  - ${f.repo}: ${f.error}`);
          }
          process.exit(1);
        }
        console.log(`\nSummarized ${project.repos.length} repo(s) in project '${projectOpt}'.`);
        return;
      }

      const sumProjectId = resolveRepoProjectId(config, repo, projectOpt);
      if (!sumProjectId) throw unresolvedProjectError(repo);
      await bindProjectDatabase(config, sumProjectId);
      await runSummarize({ ...baseOptions, projectId: sumProjectId, repo }, config);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// Embed Command
// =============================================================================

program
  .command('embed')
  .description('Generate embeddings for functions and endpoints in a parsed repository')
  .argument('<repo>', 'Repository name or path to parsed JSON file')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('--project <id>', 'Project (workspace) id; use when repo name is ambiguous across projects')
  .option('-p, --provider <name>', 'Embedding provider: ollama, openrouter', 'ollama')
  .option('-m, --model <name>', 'Model name (defaults to provider-specific default)')
  .option('-k, --api-key <key>', 'API key (OpenRouter)')
  .option('--base-url <url>', 'Override base URL')
  .option('-d, --dimensions <number>', 'Embedding dimensions')
  .option('-b, --batch-size <number>', 'Batch size for processing', '50')
  .option('--delay <ms>', 'Delay between batches in milliseconds', '100')
  .option('-i, --input-strategy <strategy>', 'Input strategy: summary, source, both', 'summary')
  .option('-f, --force', 'Force re-embedding (ignore cache)', false)
  .option('-v, --verbose', 'Verbose output', false)
  .option('--dry-run', 'Show what would be processed without embedding', false)
  .option('--summaries-path <path>', 'Path to summaries file')
  .option('--no-functions', 'Skip functions')
  .option('--no-endpoints', 'Skip endpoints')
  .action(async (repo: string, options: Record<string, string | boolean | undefined>) => {
    try {
      const config = loadConfig(options.config as string);
      const embedProjectId = resolveRepoProjectId(config, repo, options.project as string | undefined);

      const embedOptions: EmbedOptions = {
        config: options.config as string,
        projectId: embedProjectId,
        repo,
        provider: options.provider as EmbeddingProvider,
        model: options.model as string | undefined,
        apiKey: options.apiKey as string | undefined,
        baseUrl: options.baseUrl as string | undefined,
        dimensions: options.dimensions ? parseInt(options.dimensions as string, 10) : 768,
        batchSize: parseInt(options.batchSize as string, 10),
        delay: parseInt(options.delay as string, 10),
        inputStrategy: options.inputStrategy as InputStrategy,
        force: options.force as boolean,
        verbose: options.verbose as boolean,
        dryRun: options.dryRun as boolean,
        summariesPath: options.summariesPath as string | undefined,
        noFunctions: options.functions === false,
        noEndpoints: options.endpoints === false,
      };

      const { runEmbed } = await import('./embed/index.js');
      await runEmbed(embedOptions, config);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// Push Command
// =============================================================================

program
  .command('push')
  .description('Push parsed repository data to graph database (Neo4j or SQLite)')
  .argument(
    '[repo]',
    'Repository name (local), or parsed JSON path with --remote; omit with --project to push every local repo',
  )
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <id>', 'Project (workspace) id; use when repo name is ambiguous across projects')
  .option('-b, --backend <backend>', 'Database backend: ladybug | neo4j | sqlite (or set COREDOC_DB_BACKEND env var)')
  .option('--include-summaries', 'Include AI-generated summaries if available')
  .option('--no-summaries', 'Exclude AI-generated summaries')
  .option('--include-embeddings', 'Include embeddings if available')
  .option('--no-embeddings', 'Exclude embeddings')
  .option('--create-vector-indexes', 'Create vector indexes for similarity search (Neo4j only)')
  .option('-v, --verbose', 'Verbose output')
  .option('--dry-run', 'Show what would be pushed without actually pushing')
  .option('--remote', 'Push to remote workspace server instead of local database')
  .option(
    '--cloud',
    'Publish the whole project to the cloud workspace already linked in the config (no ids to type). Requires --project unless the config has one project; skips repos whose graph is already current',
  )
  .option('--workspace-id <workspaceId>', 'Workspace ID for remote push')
  .option('--rebuild', 'Remote: explicitly authorize replacing the repo graph (local push already replaces it)')
  .option(
    '--no-cross-repo',
    'Skip cross-repo resolution for this push; run `coredoc link <project>` once after pushing all repos (much faster for multi-repo projects)',
  )
  .action(async (repo, options) => {
    try {
      const config = loadConfig(options.config);
      const projectOpt = options.project as string | undefined;
      const metadataInclusion = resolveMetadataInclusion(options);

      // Project-level cloud publish. Handled before every other branch because
      // it answers a different question than the rest of `push`: not "which
      // backend and which repo" but "publish this project where the config
      // already says it belongs". It delegates to the sync orchestration rather
      // than reimplementing the upload/delta/resolve sequence.
      if (options.cloud) {
        const { assertCloudPushFlags, assertProjectHasParsedOutput, resolveLinkedCloudProject } = await import(
          './push/cloud-project.js'
        );
        if (repo) {
          throw new Error(
            '`--cloud` publishes a whole project; drop the <repo> argument, or push one parsed file with ' +
              '`--remote --workspace-id <id>`.',
          );
        }
        assertCloudPushFlags(options);
        const { project, workspaceId } = resolveLinkedCloudProject(config, projectOpt);
        assertProjectHasParsedOutput(config, project);

        const { runSync } = await import('./sync/index.js');
        console.log(`\nPublishing project '${project.id}' to cloud workspace ${workspaceId}...`);
        const result = await runSync({
          configPath: options.config,
          // Passed as the stored link, never as a flag: `resolveWorkspace`'s
          // flag branch would persist a rebind, and this verb does not retarget.
          projectId: project.id,
          force: false,
          includeSummaries: metadataInclusion.includeSummaries,
          includeEmbeddings: metadataInclusion.includeEmbeddings,
          includeMapper: true,
          dryRun: options.dryRun === true,
          verbose: options.verbose === true,
          // The low-level `--remote` form waits for its push job; a project
          // publish that returned before the graph existed would be a step
          // backwards from the path it replaces.
          wait: options.dryRun !== true,
        });
        if (result.exitCode !== 0) process.exit(result.exitCode);
        return;
      }

      // No repo argument: push every repo in the project. Each repo is pushed
      // with per-repo cross-repo resolution skipped, then the whole project is
      // resolved once at the end (mirrors `coredoc summarize`/`sync` batching,
      // but with the `--no-cross-repo` + `link` optimization so we don't relink
      // O(N²) times). Local DB only — the remote path resolves server-side.
      if (!repo) {
        if (!projectOpt) {
          throw new Error('Provide a <repo> argument, or use --project to push every repo in a project.');
        }
        if (options.remote) {
          throw new Error(
            'Project-wide push is local-only; push remote repos individually with --remote, or omit --remote to push to the local graph DB.',
          );
        }
        const project = config.projects.find((p) => p.id === projectOpt);
        if (!project) {
          throw new Error(`Project not found: ${projectOpt}`);
        }
        if (project.repos.length === 0) {
          throw new Error(`Project '${projectOpt}' has no repos to push.`);
        }
        await bindProjectDatabase(config, project.id);

        const backend = (options.backend || process.env.COREDOC_DB_BACKEND || 'sqlite') as DatabaseBackend;
        const runFinalLink = options.crossRepo !== false && !options.dryRun;
        console.log(
          `\nPushing ${project.repos.length} repo(s) in project '${projectOpt}' to ${backend}` +
            `${runFinalLink ? ' (cross-repo resolved once at the end)' : ''}...`,
        );

        // Ladybug publishes one immutable project file. Calling the per-repo
        // entrypoint repeatedly would rebuild that same complete file N times,
        // so dispatch exactly once using any parsed repo as the SDK entrypoint.
        if (backend === 'ladybug') {
          const { findParsedRepo } = await import('./push/helpers.js');
          const parsedRepo = project.repos.find((candidate) =>
            findParsedRepo(project.id, candidate.name, config, { allowDirectPath: false }),
          );
          if (!parsedRepo) {
            throw new Error(
              `No parsed repo artifacts for project "${project.id}". Run 'coredoc parse --project ${project.id}' first.`,
            );
          }
          console.log('\n=== complete project graph ===');
          await runUnifiedPush(
            project.id,
            parsedRepo.name,
            {
              config: options.config,
              backend,
              ...metadataInclusion,
              crossRepo: options.crossRepo,
              verbose: options.verbose,
              dryRun: options.dryRun,
              rebuild: options.rebuild,
            },
            config,
          );
          console.log(`\nPushed parsed repositories in project '${projectOpt}'.`);
          return;
        }

        const { getDriver, getRepository, closeDriver } = await import('@coredoc/db');
        const failures: { repo: string; error: string }[] = [];
        let pushedAny = false;
        try {
          // Sequential by design: every repo shares one cached connection
          // (skipClose keeps it open across the batch), and concurrent writes on
          // a single driver would contend (SQLite single-writer / Neo4j tx).
          for (const r of project.repos) {
            console.log(`\n=== ${r.name} ===`);
            try {
              await runUnifiedPush(
                project.id,
                r.name,
                {
                  config: options.config,
                  backend,
                  ...metadataInclusion,
                  createVectorIndexes: options.createVectorIndexes,
                  crossRepo: false,
                  verbose: options.verbose,
                  dryRun: options.dryRun,
                  rebuild: options.rebuild,
                  skipClose: true,
                },
                config,
              );
              pushedAny = true;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              failures.push({ repo: r.name, error: message });
              console.error(`Failed to push ${r.name}: ${message}`);
            }
          }

          if (runFinalLink && pushedAny) {
            const { resolveProjectCrossRepo } = await import('./push/cross-repo.js');
            console.log(`\nResolving cross-repo calls (${backend}) for project '${projectOpt}'...`);
            await getDriver(backend);
            const repository = await getRepository(backend);
            const m = await resolveProjectCrossRepo(project.id, config, repository);
            if (!m) {
              console.log('  No parsed repos found for project — nothing to resolve.');
            } else {
              console.log(
                `  Linked ${m.resolved}/${m.resolvable} resolvable calls ` +
                  `(${(m.rate * 100).toFixed(1)}%; ${m.unresolvableExcluded} excluded as unresolvable)`,
              );
            }
          } else if (options.crossRepo === false) {
            console.log('\nSkipping cross-repo resolution (--no-cross-repo); run `coredoc link <project>` when ready.');
          }
        } finally {
          // The per-repo pushes left the shared driver open (skipClose); close it once.
          await closeDriver();
        }

        if (failures.length > 0) {
          console.error(`\n${failures.length}/${project.repos.length} repo(s) failed to push:`);
          for (const f of failures) {
            console.error(`  - ${f.repo}: ${f.error}`);
          }
          process.exit(1);
        }
        console.log(`\nPushed ${project.repos.length} repo(s) in project '${projectOpt}'.`);
        return;
      }

      const pushProjectId = resolveRepoProjectId(config, repo, projectOpt);
      // A local push writes into a project-scoped database, so an unresolved
      // project has nowhere correct to go. Remote pushes are keyed by
      // workspaceId server-side and never touch a local file, so they are
      // exempt. (`resolveRepoRef` already throws on an ambiguous bare name;
      // this covers the other gap — a .json path outside coredoc-output/.)
      if (!options.remote && !pushProjectId) {
        throw unresolvedProjectError(repo);
      }

      // Remote push to workspace server (incremental: upload → push by version)
      if (options.remote) {
        const { uploadResult, uploadSummaries, uploadEmbeddings, pushByVersion, waitForPushJob, queuedPushJobId } =
          await import('./push/remote.js');
        const { findParsedRepo, findSummariesFile, loadSummaries, findEmbeddingsFile, loadEmbeddings } = await import(
          './push/helpers.js'
        );
        const workspaceId = options.workspaceId || process.env.COREDOC_WORKSPACE_ID;
        if (!workspaceId) {
          console.error('Error: --workspace-id is required for remote push (or set COREDOC_WORKSPACE_ID)');
          process.exit(1);
        }

        // Advisory version handshake before the uploads: an on-prem server
        // lagging this CLI otherwise shows up as an opaque 404 mid-push.
        const { checkServerCompat } = await import('./sync/workspace-api.js');
        const { getServerUrl } = await import('./auth.js');
        await checkServerCompat(await getServerUrl());

        // Load the parsed repo data using config-aware path resolution
        const parsedPath = findParsedRepo(pushProjectId, repo, config);
        if (!parsedPath) {
          console.error(`Error: Parsed repo not found for: ${repo}. Run 'coredoc parse' first.`);
          process.exit(1);
        }
        const { readFileSync } = await import('node:fs');
        const parsedRepo = JSON.parse(readFileSync(parsedPath, 'utf-8'));

        // Load summaries and embeddings (same as local push)
        let summaryOutput = null;
        if (metadataInclusion.includeSummaries) {
          const summariesPath = findSummariesFile(pushProjectId, parsedRepo.name, config, parsedPath);
          if (summariesPath) {
            summaryOutput = loadSummaries(summariesPath);
            if (summaryOutput) console.log(`Including summaries from ${summariesPath}`);
          }
        }

        let embeddingsOutput = null;
        if (metadataInclusion.includeEmbeddings) {
          const embeddingsPath = findEmbeddingsFile(pushProjectId, parsedRepo.name, config, parsedPath);
          if (embeddingsPath) {
            embeddingsOutput = loadEmbeddings(embeddingsPath);
            if (embeddingsOutput) console.log(`Including embeddings from ${embeddingsPath}`);
          }
        }

        // Step 1: upload parsed result to R2
        const upload = await uploadResult({ workspaceId, repoName: parsedRepo.name, parsedRepo });

        // Step 2: upload summaries if present
        let summaryVersion: string | undefined;
        if (summaryOutput) {
          const sumUp = await uploadSummaries({ workspaceId, repoName: parsedRepo.name, summaryOutput });
          summaryVersion = sumUp.version;
        }

        // Step 3: upload embeddings if present
        let embeddingsVersion: string | undefined;
        if (embeddingsOutput) {
          const embUp = await uploadEmbeddings({ workspaceId, repoName: parsedRepo.name, embeddingsOutput });
          embeddingsVersion = embUp.version;
        }

        // Step 4: finalize push by version reference
        // Queue + poll. An inline (?sync) push keeps the HTTP request open for
        // the entire server-side graph write, which proxies terminate long
        // before it completes — reporting a failure for a push that landed.
        const pushResponse = await pushByVersion({
          workspaceId,
          repoName: parsedRepo.name,
          parsedVersion: upload.version,
          summaryVersion,
          embeddingsVersion,
          excludeSummaries: !metadataInclusion.includeSummaries,
          excludeEmbeddings: !metadataInclusion.includeEmbeddings,
          commitSha: parsedRepo.git?.commitHash,
          // Remote replacement stays explicit: ordinary server pushes are
          // guarded diffs, while local pushes already replace their selected
          // repo inside an isolated project database.
          rebuild: options.rebuild,
        });
        const pushJobId = queuedPushJobId(pushResponse);
        if (pushJobId) {
          console.log(`Push queued (jobId=${pushJobId}); waiting for it to finish...`);
          const job = await waitForPushJob(workspaceId, pushJobId);
          console.log(`Push job ${job.id}: ${job.status}`);
        }
        return;
      }

      // Unified push handles both backends via the @coredoc/db abstraction
      // (backend-factory selects SQLite or Neo4j; the repository's pushNodes/
      // pushEdges consume the canonical GraphNode/GraphEdge from the single db
      // transformer).
      const backend = (options.backend || process.env.COREDOC_DB_BACKEND || 'sqlite') as 'sqlite' | 'neo4j';
      if (!pushProjectId) throw unresolvedProjectError(repo);

      await runUnifiedPush(
        pushProjectId,
        repo,
        {
          config: options.config,
          backend,
          ...metadataInclusion,
          createVectorIndexes: options.createVectorIndexes,
          crossRepo: options.crossRepo,
          verbose: options.verbose,
          dryRun: options.dryRun,
          rebuild: options.rebuild,
        },
        config,
      );
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// Link Command (standalone cross-repo resolution into the graph DB)
// =============================================================================

program
  .command('link')
  .description(
    'Resolve cross-repo calls and persist RESOLVES_TO edges in the graph database (run once after pushing all repos with --no-cross-repo)',
  )
  .argument('<project>', 'Project (workspace) id')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-b, --backend <backend>', 'Database backend: ladybug | neo4j | sqlite (or set COREDOC_DB_BACKEND env var)')
  .action(async (project, options) => {
    try {
      const config = loadConfig(options.config);
      const projectConfig = config.projects.find((candidate) => candidate.id === project);
      if (!projectConfig) {
        throw new Error(
          `Project "${project}" not found. Available projects: ${config.projects.map((candidate) => candidate.id).join(', ') || 'none'}`,
        );
      }
      await bindProjectDatabase(config, projectConfig.id);
      const backend = (options.backend || process.env.COREDOC_DB_BACKEND || 'sqlite') as 'sqlite' | 'neo4j';

      const { getDriver, getRepository, closeDriver } = await import('@coredoc/db');
      const { resolveProjectCrossRepo } = await import('./push/cross-repo.js');

      console.log(`\nResolving cross-repo calls (${backend}) for project '${project}'...`);
      await getDriver(backend);
      const repository = await getRepository(backend);
      try {
        const m = await resolveProjectCrossRepo(project, config, repository);
        if (!m) {
          console.log('  No parsed repos found for project — nothing to resolve.');
        } else {
          console.log(`  Repos: ${m.repos}`);
          console.log(
            `  Linked ${m.resolved}/${m.resolvable} resolvable calls ` +
              `(${(m.rate * 100).toFixed(1)}%; ${m.unresolvableExcluded} excluded as unresolvable)`,
          );
        }
      } finally {
        await closeDriver();
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// MCP Server Command
// =============================================================================

program
  .command('mcp')
  .description('Start the MCP (Model Context Protocol) server for AI agent integration')
  .option('-c, --config <path>', 'Path to coredoc config file', 'coredoc.config.json')
  .requiredOption('-p, --project <id>', 'Project id this MCP process may access')
  .action(async (options) => {
    try {
      const runtime = loadConfig(options.config);
      const project = runtime.projects.find((candidate) => candidate.id === options.project);
      if (!project) {
        throw new Error(
          `Project "${options.project}" not found. Available projects: ${runtime.projects.map((candidate) => candidate.id).join(', ') || 'none'}`,
        );
      }
      process.env.MCP_CONFIG_PATH = runtime.configPath;
      process.env.COREDOC_SCOPE = `project:${project.id}`;

      // Import and start MCP server
      const { startServer } = await import('@coredoc/mcp');
      await startServer();
    } catch (error) {
      console.error('Error starting MCP server:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// Sync Command
// =============================================================================

program
  .command('sync')
  .description('Sync a local project to a cloud workspace')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <id>', 'Project id to sync; required when config has > 1 project')
  .option('--workspace-id <id>', 'Cloud workspace id; overrides stored project.cloud.workspaceId')
  .option('--rebind', 'Allow --workspace-id to overwrite a different stored workspaceId', false)
  .option('--name <name>', 'Workspace name when creating (default: project.name)')
  .option('--slug <slug>', 'Workspace slug when creating (default: project.id)')
  .option('--no-summaries', 'Skip uploading summaries')
  .option('--no-embeddings', 'Skip including embeddings')
  .option('--no-mapper', 'Skip pushing mapper.json')
  .option('--force', 'Skip per-repo delta check; push every repo', false)
  .option('--dry-run', 'Plan and print actions without uploading', false)
  .option('-v, --verbose', 'Verbose output', true)
  .option('-q, --quiet', 'Suppress per-step logs; only print the final summary', false)
  .option('--wait', 'Poll until all queued jobs reach terminal state', false)
  .option('--wait-timeout <seconds>', 'Max wait duration in seconds (default: no timeout)')
  .action(async (options) => {
    try {
      const { runSync } = await import('./sync/index.js');
      const result = await runSync({
        configPath: options.config,
        projectId: options.project,
        workspaceId: options.workspaceId,
        rebind: options.rebind,
        nameOverride: options.name,
        slugOverride: options.slug,
        force: options.force,
        includeSummaries: options.summaries !== false,
        includeEmbeddings: options.embeddings !== false,
        includeMapper: options.mapper !== false,
        dryRun: options.dryRun,
        verbose: options.verbose,
        quiet: options.quiet,
        wait: options.wait,
        waitTimeoutMs: options.waitTimeout ? parseInt(options.waitTimeout, 10) * 1000 : undefined,
      });
      if (result.exitCode !== 0) process.exit(result.exitCode);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// Sync Status Command
// =============================================================================

program
  .command('sync-status <jobId>')
  .description('Show status for a single sync job')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <id>', 'Project id to scope the workspace lookup')
  .option('--workspace-id <id>', 'Cloud workspace id (overrides project lookup)')
  .action(async (jobId: string, options) => {
    try {
      const { getJob } = await import('./sync/workspace-api.js');
      let workspaceId: string | undefined = options.workspaceId;
      if (!workspaceId) {
        const config = loadConfig(options.config);
        const project = options.project
          ? config.projects.find((p) => p.id === options.project)
          : config.projects.length === 1
            ? config.projects[0]
            : undefined;
        if (!project) {
          throw new Error('Pass --workspace-id or --project (or have a single project in config)');
        }
        workspaceId = project.cloud?.workspaceId;
        if (!workspaceId) {
          throw new Error(`Project '${project.id}' has no cloud workspaceId stored`);
        }
      }
      const job = await getJob(workspaceId, jobId);
      if (!job) {
        console.error(`Job ${jobId} not found in workspace ${workspaceId}`);
        process.exit(2);
      }
      console.log(JSON.stringify(job, null, 2));
      if (job.status === 'failed') process.exit(1);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// =============================================================================
// Ops Command
// =============================================================================

program
  .command('ops')
  .description('Output operation timestamps for a repository as JSON')
  .argument('<repo>', 'Repository name')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  // `--project-id` used to default to '' and silently match no rows; it now
  // also selects which project's database to open, so it must resolve.
  .option('-p, --project <id>', 'Project id scope for the operation lookup')
  .option('--project-id <id>', 'Deprecated alias for --project')
  .action(async (repo: string, options: { config: string; project?: string; projectId?: string }) => {
    try {
      const config = loadConfig(options.config);
      const explicitProject = options.project ?? (options.projectId || undefined);
      const projectId = resolveRepoProjectId(config, repo, explicitProject);
      if (!projectId) throw unresolvedProjectError(repo);
      try {
        // Same reader as the desktop status path — it also returns `parsedRevision`.
        // Throws on an unavailable/corrupt project database so the command exits 1;
        // `{}` is printed only when there is genuinely no operation summary.
        const timestamps = await readOpsTimestamps(projectId, repo, config.configDir);
        process.stdout.write(JSON.stringify(timestamps ?? {}));
      } finally {
        // readOpsTimestamps leaves its drivers open for the process lifetime; this
        // one-shot command owns the shutdown.
        const { closeAllDrivers, closeProjectDatabases } = await import('@coredoc/db');
        await closeProjectDatabases();
        await closeAllDrivers();
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// =============================================================================
// Helper Functions
// =============================================================================

function loadConfig(configPath: string): RuntimeConfig {
  return loadCoredocConfig(configPath, {
    onMigrated: (migration) => {
      if (
        !migration.skipped &&
        (migration.parserDirsMoved > 0 || migration.outputArtifactsMoved > 0 || migration.idsAssigned > 0)
      ) {
        // Diagnostic, not command output: it must go to stderr so machine-readable
        // stdout modes (e.g. `--json` output) never receive it as a data line.
        console.error(
          `[coredoc] Migrated layout: ${migration.parserDirsMoved} parser dirs, ` +
            `${migration.outputArtifactsMoved} output artifacts, ` +
            `${migration.idsAssigned} project ids backfilled, ` +
            `${migration.orphansDeleted} orphans deleted`,
        );
      }
    },
    onMigrationWarning: (message) => console.warn(`[coredoc] Migration warning: ${message}`),
  });
}

async function resolveMapperPaths(
  config: { resolvedParserStorage: string },
  options: { project?: string; file?: string },
): Promise<{ mapperPath: string; mapperMetaPath: string; backupPath: string }> {
  const { mapperPathsForProject } = await import('@coredoc/core');
  if (options.file) {
    // Explicit --file overrides the conventional layout; derive the sibling
    // meta/backup paths from the explicit file location instead of from a
    // project id, so users can validate ad-hoc mappers without a project.
    const dir = path.dirname(options.file);
    return {
      mapperPath: options.file,
      mapperMetaPath: path.join(dir, 'mapper.meta.json'),
      backupPath: path.join(dir, '.mapper.json.bak'),
    };
  }
  if (!options.project) {
    throw new Error('Either --project or --file is required');
  }
  const paths = mapperPathsForProject(config.resolvedParserStorage, options.project);
  return { mapperPath: paths.mapperJson, mapperMetaPath: paths.mapperMeta, backupPath: paths.backup };
}

function resolveParsedRepoInput(repoArg: string): string | undefined {
  if (!repoArg.endsWith('.json')) {
    return undefined;
  }

  const absolutePath = path.resolve(process.cwd(), repoArg);
  try {
    return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile() ? absolutePath : undefined;
  } catch {
    return undefined;
  }
}

function inferProjectIdFromParsedPath(config: RuntimeConfig, parsedRepoPath: string): string | undefined {
  const absolutePath = path.resolve(process.cwd(), parsedRepoPath);
  const relativePath = path.relative(config.resolvedOutputDir, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }

  const segments = relativePath.split(path.sep);
  if (segments.length < 2 || !segments[segments.length - 1]?.endsWith('.json')) {
    return undefined;
  }

  return segments[0];
}

function resolveRepoProjectId(config: RuntimeConfig, repoArg: string, explicitProjectId?: string): string | undefined {
  const parsedRepoPath = resolveParsedRepoInput(repoArg);
  if (parsedRepoPath) {
    return explicitProjectId ?? inferProjectIdFromParsedPath(config, parsedRepoPath);
  }

  return resolveRepoRef(config, repoArg, explicitProjectId).projectId;
}

interface ParseOptions {
  config: string;
  repo?: string;
  project?: string;
  output?: string;
  pretty?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
}

async function runParse(options: ParseOptions): Promise<void> {
  const config = loadConfig(options.config);
  try {
    await sdkParse({
      config,
      repo: options.repo,
      projectId: options.project,
      output: options.output,
      pretty: options.pretty,
      verbose: options.verbose,
      dryRun: options.dryRun,
      // The CLI owns the user's config file, so it keeps the repo-key write-back.
      writeBackRepoKey: true,
    });
  } catch (error) {
    // The SDK throws; the command surface keeps exiting non-zero.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// =============================================================================
// Parser Push/Pull Commands
// =============================================================================

const profileCmd = program.command('profile').description('Author and validate extraction profiles');

profileCmd
  .command('score <profile> <repoPath>')
  .description('Score a profile module against a repo (coverage scorecard); exits non-zero unless overall PASS')
  .action(async (profile: string, repoPath: string) => {
    try {
      const { scoreProfile } = await import('@coredoc/profile-parser');
      const pass = await scoreProfile(profile, repoPath);
      trackProfileAuthored(pass);
      process.exitCode = pass ? 0 : 1;
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

const parserCmd = program.command('parser').description('Manage remote parser artifacts');

parserCmd
  .command('push')
  .description('Upload local parser to cloud workspace')
  .requiredOption('-r, --repo <name>', 'Repository name')
  .requiredOption('--workspace-id <id>', 'Workspace ID (or set COREDOC_WORKSPACE_ID)')
  .option('-p, --project <id>', 'Project (workspace) id; required if repo name is ambiguous across projects')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .action(async (options) => {
    try {
      const { pushParserToServer } = await import('./parser-remote.js');
      const workspaceId = options.workspaceId || process.env.COREDOC_WORKSPACE_ID;
      if (!workspaceId) {
        console.error('Error: --workspace-id is required (or set COREDOC_WORKSPACE_ID)');
        process.exit(1);
      }

      const config = loadConfig(options.config);
      const ref = resolveRepoRef(config, options.repo, options.project);
      const parserSourceDir = buildParserDir(config.resolvedParserStorage, ref.projectId, ref.repoName);

      await pushParserToServer({ workspaceId, repoName: options.repo, parserDir: parserSourceDir });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

parserCmd
  .command('pull')
  .description('Download parser from cloud workspace')
  .requiredOption('-r, --repo <name>', 'Repository name')
  .requiredOption('--workspace-id <id>', 'Workspace ID (or set COREDOC_WORKSPACE_ID)')
  .option('-p, --project <id>', 'Project (workspace) id to extract into; required if repo name is ambiguous')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option(
    '-o, --output <dir>',
    'Output directory for parser files (overrides --project; the parser will be extracted to <dir>/<repo>)',
  )
  .action(async (options) => {
    try {
      const { pullParserFromServer } = await import('./parser-remote.js');
      const workspaceId = options.workspaceId || process.env.COREDOC_WORKSPACE_ID;
      if (!workspaceId) {
        console.error('Error: --workspace-id is required (or set COREDOC_WORKSPACE_ID)');
        process.exit(1);
      }

      // pullParserFromServer extracts into {targetDir}/{repoName}, so we pass
      // the PROJECT directory ({parserStorage}/{projectId}) — NOT the per-repo
      // directory. The extractor will then create {parserStorage}/{projectId}/{repoName}/.
      let targetDir: string;
      if (options.output) {
        targetDir = options.output;
      } else {
        const config = loadConfig(options.config);
        const ref = resolveRepoRef(config, options.repo, options.project);
        targetDir = path.join(config.resolvedParserStorage, ref.projectId);
        // Ensure the project subfolder exists so extractTarGz can write into it.
        fs.mkdirSync(targetDir, { recursive: true });
      }

      await pullParserFromServer({ workspaceId, repoName: options.repo, targetDir });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

parserCmd
  .command('list')
  .description('List parsers in cloud workspace')
  .requiredOption('--workspace-id <id>', 'Workspace ID (or set COREDOC_WORKSPACE_ID)')
  .action(async (options) => {
    try {
      const { listRemoteParsers } = await import('./parser-remote.js');
      const workspaceId = options.workspaceId || process.env.COREDOC_WORKSPACE_ID;
      if (!workspaceId) {
        console.error('Error: --workspace-id is required (or set COREDOC_WORKSPACE_ID)');
        process.exit(1);
      }

      const parsers = await listRemoteParsers(workspaceId);
      if (parsers.length === 0) {
        console.log('No parsers found in workspace.');
        return;
      }

      console.log('\nRemote Parsers:');
      console.log('===============\n');
      for (const p of parsers) {
        console.log(`  ${p.repoName}`);
        console.log(`    Size: ${(p.sizeBytes / 1024).toFixed(1)} KB`);
        console.log(`    Uploaded: ${p.uploadedAt}`);
        console.log('');
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// Mapper Commands
// =============================================================================
//
// Cross-service `mapper.json` artifacts capture the manual hints that the
// resolver needs to stitch SDK calls across repositories. Validating them
// locally before a push catches schema drift early.

const mapperCmd = program.command('mapper').description('Manage cross-service mapper artifacts');

mapperCmd
  .command('validate')
  .description('Validate a mapper.json file against the v1 schema')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <id>', 'Project id (resolves mapper path automatically)')
  .option('-f, --file <path>', 'Explicit mapper.json path (overrides --project)')
  .action(async (options) => {
    try {
      const { runMapperValidate, printValidateResult } = await import('./commands/mapper.js');
      const config = loadConfig(options.config);
      const { mapperPath } = await resolveMapperPaths(config, options);
      // When a project is named, feed the semantic sweep its parsed output
      // (stale-target check) and per-repo config prefixes (httpPrefix cross-check).
      let outputDir: string | undefined;
      let repoHttpPrefixes: Record<string, string | undefined> | undefined;
      if (options.project) {
        const project = config.projects.find((p) => p.id === options.project);
        if (project) {
          outputDir = config.resolvedOutputDir;
          repoHttpPrefixes = {};
          for (const r of project.repos) repoHttpPrefixes[r.name] = r.httpPrefix;
        }
      }
      const result = runMapperValidate({ mapperPath, outputDir, projectId: options.project, repoHttpPrefixes });
      printValidateResult(result, mapperPath);
      if (!result.ok) process.exit(1);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

mapperCmd
  .command('status')
  .description('Show mapper status, baseline rate, and counts')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <id>', 'Project id')
  .option('-f, --file <path>', 'Explicit mapper.json path (overrides --project)')
  .action(async (options) => {
    try {
      const { runMapperStatus, printStatus } = await import('./commands/mapper.js');
      const config = loadConfig(options.config);
      const { mapperPath, mapperMetaPath } = await resolveMapperPaths(config, options);
      const result = runMapperStatus({ mapperPath, mapperMetaPath });
      printStatus(result);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

mapperCmd
  .command('diff')
  .description(
    'Diff the current mapper.json against the snapshot left by `mapper discover` (.mapper.json.bak) or a specified baseline',
  )
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <id>', 'Project id')
  .option('-f, --file <path>', 'Explicit mapper.json path')
  .option('--baseline <path>', 'Path to baseline mapper (defaults to .mapper.json.bak written by `mapper discover`)')
  .action(async (options) => {
    try {
      const { runMapperDiff, printDiff } = await import('./commands/mapper.js');
      const config = loadConfig(options.config);
      const { mapperPath, backupPath } = await resolveMapperPaths(config, options);
      const baselinePath = options.baseline ?? backupPath;
      const result = runMapperDiff({ currentPath: mapperPath, baselinePath });
      printDiff(result);
      if (!result.ok) process.exit(1);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

mapperCmd
  .command('discover')
  .description('Auto-build mapper.json from parsed externalCalls (no AI, fast)')
  .requiredOption('-p, --project <id>', 'Project id')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option(
    '--overwrite',
    'Rebuild mapper.json from scratch (clobber hand-edits). Default merges: preserves hand-edited entries, adds new, reports stale.',
  )
  .action(async (options) => {
    try {
      const { runMapperDiscover, printDiscoverResult } = await import('./commands/mapper.js');
      const config = loadConfig(options.config);
      const result = runMapperDiscover(config, options);
      printDiscoverResult(result);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

mapperCmd
  .command('gen-sdk-mappings')
  .description("Regenerate the sdkMappings fallback table from the project's in-workspace SDK source repos")
  .requiredOption('-p, --project <id>', 'Project id')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('--dry-run', 'Compute and validate the table but do not write mapper.json')
  .action(async (options) => {
    try {
      const { runMapperGenSdkMappings, printGenSdkMappings } = await import('./commands/mapper.js');
      const config = loadConfig(options.config);
      const { mapperPath } = await resolveMapperPaths(config, options);
      const result = await runMapperGenSdkMappings(config, {
        project: options.project,
        mapperPath,
        dryRun: options.dryRun,
      });
      printGenSdkMappings(result);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

mapperCmd
  .command('suggest')
  .description(
    'Propose sdkMappings for unresolved external calls. Output is JSON for review + an LLM-ready prompt. NEVER auto-applies — use `mapper apply-suggestions` to merge.',
  )
  .requiredOption('-p, --project <id>', 'Project id')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-o, --out <file>', 'Output filename (relative to project dir)', 'mapper-suggestions.json')
  .option(
    '--mode <mode>',
    'prompt = emit LLM-ready prompt (recommended), heuristic = offline token scoring, both',
    'prompt',
  )
  .option('--min-overlap <n>', 'Minimum method↔path token overlap (heuristic mode)', '2')
  .action(async (options) => {
    try {
      const { runMapperSuggest, printSuggestResult } = await import('./commands/mapper.js');
      const config = loadConfig(options.config);
      const result = runMapperSuggest(config, {
        project: options.project,
        config: options.config,
        out: options.out,
        mode: options.mode,
        minOverlap: Number(options.minOverlap),
      });
      printSuggestResult(result);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

mapperCmd
  .command('apply-suggestions')
  .description(
    'Merge approved sdkMappings from a reviewed suggestions JSON into mapper.json (with schema validation + backup).',
  )
  .requiredOption('-p, --project <id>', 'Project id')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-i, --input <file>', 'Reviewed suggestions JSON (relative to project dir)', 'mapper-suggestions.review.json')
  .option('--overwrite', 'Replace existing matching sdkMappings (default: skip)', false)
  .option('--dry-run', 'Show changes without writing', false)
  .option('--workspace-id <id>', 'Workspace ID for auto-push (or set COREDOC_WORKSPACE_ID)')
  .option('--push', 'Push mapper to cloud after applying (skip prompt)')
  .option('--no-push', 'Skip the auto-push prompt entirely')
  .action(async (options) => {
    try {
      const { runMapperApplySuggestions, printApplySuggestionsResult, runMapperPush, printMapperPushResult } =
        await import('./commands/mapper.js');
      const config = loadConfig(options.config);
      const result = runMapperApplySuggestions(config, {
        project: options.project,
        config: options.config,
        input: options.input,
        overwrite: options.overwrite,
        dryRun: options.dryRun,
      });
      printApplySuggestionsResult(result, !!options.dryRun);

      // Auto-push hook: only when the file was actually written + flags allow.
      if (options.dryRun) return;
      const workspaceId = options.workspaceId || process.env.COREDOC_WORKSPACE_ID;
      // commander gives us push: true | false | undefined.
      // false  → --no-push, skip silently
      // true   → --push,    skip prompt
      // undef  → prompt the user (TTY only)
      if (options.push === false) return;
      if (!workspaceId) return; // no cloud configured; nothing to push to
      let shouldPush = options.push === true;
      if (!shouldPush && process.stdin.isTTY) {
        const readline = await import('node:readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`? Push mapper to cloud workspace '${workspaceId}'? (Y/n) `);
        rl.close();
        shouldPush = !/^n/i.test(answer.trim());
      }
      if (!shouldPush) return;

      const pushResult = await runMapperPush({ workspaceId, file: result.mapperPath });
      printMapperPushResult(pushResult);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

mapperCmd
  .command('push')
  .description('Upload the local mapper.json to a cloud workspace and trigger re-resolution')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <id>', 'Project id (resolves mapper path automatically)')
  .option('-f, --file <path>', 'Explicit mapper.json path (overrides --project)')
  .option('--workspace-id <id>', 'Workspace ID (or set COREDOC_WORKSPACE_ID)')
  .action(async (options) => {
    try {
      const workspaceId = options.workspaceId || process.env.COREDOC_WORKSPACE_ID;
      if (!workspaceId) {
        console.error('Error: --workspace-id is required (or set COREDOC_WORKSPACE_ID)');
        process.exit(1);
      }
      const { runMapperPush, printMapperPushResult } = await import('./commands/mapper.js');
      const config = loadConfig(options.config);
      const { mapperPath } = await resolveMapperPaths(config, options);
      const result = await runMapperPush({ workspaceId, file: mapperPath });
      printMapperPushResult(result);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

mapperCmd
  .command('pull')
  .description('Download the cloud workspace mapper.json to local disk')
  .option('-c, --config <path>', 'Path to config file', 'coredoc.config.json')
  .option('-p, --project <id>', 'Project id (resolves output path automatically)')
  .option('-o, --out <path>', 'Output path (overrides --project)')
  .option('--workspace-id <id>', 'Workspace ID (or set COREDOC_WORKSPACE_ID)')
  .option('--force', 'Overwrite local file even if it differs from server')
  .action(async (options) => {
    try {
      const workspaceId = options.workspaceId || process.env.COREDOC_WORKSPACE_ID;
      if (!workspaceId) {
        console.error('Error: --workspace-id is required (or set COREDOC_WORKSPACE_ID)');
        process.exit(1);
      }
      const { runMapperPull, printMapperPullResult } = await import('./commands/mapper.js');
      const config = loadConfig(options.config);
      // --out wins over --project; otherwise reuse the same mapper-path helper.
      const out = options.out ?? (await resolveMapperPaths(config, options)).mapperPath;
      const result = await runMapperPull({ workspaceId, out, force: !!options.force });
      printMapperPullResult(result);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// =============================================================================
// Intent Commands
// =============================================================================
//
// Product intent is owned by a cloud workspace. Read, propose and review are
// MCP and UI surfaces (spec §11); the CLI carries the export projection and the
// CI release actor.

const intentCmd = program.command('intent').description('Cloud workspace product-intent export and release');

intentCmd
  .command('export')
  .description('Write the workspace intent export to an explicit path')
  .requiredOption('-w, --workspace-id <id>', 'Cloud workspace to export')
  .requiredOption(
    '-o, --out <path>',
    'File to write. Required and never inferred: in a multi-repo workspace there is no "the" repo to write into',
  )
  .option(
    '--format <format>',
    '"backup": the hashed projection with history (CloudIntentExportV1); ' +
      '"workspace": the document `intent/import/workspace` takes',
    'backup',
  )
  .action(async (options) => {
    try {
      const { parseIntentExportFormat, runIntentExport, printIntentExportResult } = await import(
        './commands/intent-cloud.js'
      );
      const format = parseIntentExportFormat(options.format);
      printIntentExportResult(await runIntentExport({ workspaceId: options.workspaceId, out: options.out, format }));
    } catch (err) {
      await printIntentCommandError(err);
      process.exit(1);
    }
  });

// The CI actor of the release amendment §3.2. Run AFTER the production deploy
// job — never as part of parse+push, which says nothing about production.
// `--deploy-id`/`--deployed-at` are required with no default: they are
// properties of the DEPLOYMENT run, so a retry carries the same pair, replays
// the same idempotency key, and cannot leapfrog a later release.
intentCmd
  .command('release')
  .description('Record a delivered release from CI, with the PR intent trailers (needs an `intent:release` token)')
  .requiredOption('-w, --workspace-id <id>', 'Cloud workspace that owns product intent')
  .requiredOption('-r, --repo <repoKey>', 'Repository key in the workspace')
  .requiredOption('--ref <sha>', 'The full commit SHA deployed to production')
  .requiredOption('--deploy-id <id>', "The deploy run's identity (GitHub: `github.run_id`). No default.")
  .requiredOption(
    '--deployed-at <iso>',
    "The deploy run's start time as ISO 8601 (GitHub: `run_started_at`). No default.",
  )
  .option('--handoff-id <uuid>', 'Explicit server handoff; otherwise record every merged PR the deployed ref includes')
  .action(async (options) => {
    try {
      const { runIntentRelease, printIntentReleaseResult } = await import('./commands/intent-cloud.js');
      printIntentReleaseResult(
        await runIntentRelease({
          workspaceId: options.workspaceId,
          repo: options.repo,
          ref: options.ref,
          deployId: options.deployId,
          deployedAt: options.deployedAt,
          handoffId: options.handoffId,
        }),
      );
    } catch (err) {
      await printIntentCommandError(err);
      process.exit(1);
    }
  });

/**
 * A server refusal reaches the terminal with its exact code, message, and field
 * paths (spec §12); anything else prints as an ordinary error. Nothing is
 * summarized away — that swallowing is the named defect of the archived CLI.
 */
async function printIntentCommandError(err: unknown): Promise<void> {
  const { IntentApiError } = await import('./sync/workspace-api.js');
  if (err instanceof IntentApiError) {
    const { formatIntentApiError } = await import('./commands/intent-cloud.js');
    console.error(formatIntentApiError(err));
    return;
  }
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
}

// =============================================================================
// CI Commands
// =============================================================================

const ciCmd = program.command('ci').description('CI/CD automation commands');

ciCmd
  .command('run')
  .description('Fetch parser, parse repo, and push results to workspace (designed for CI/CD)')
  .option('--profile <path>', 'Checked-in profile.ts (or set COREDOC_PROFILE_PATH); skips cloud parser download')
  .requiredOption('-r, --repo <name>', 'Repository name')
  .option('--workspace-id <id>', 'Workspace ID (or set COREDOC_WORKSPACE_ID)')
  .option('--server-url <url>', 'Server URL override (or set COREDOC_SERVER_URL)')
  .option('-o, --output <dir>', 'Temp directory for CI artifacts', '.coredoc-ci')
  .option('--dry-run', 'Parse but do not push')
  .option('--push-timeout <minutes>', 'How long to watch the queued push job before giving up watching it', '15')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const pushTimeoutMinutes = Number(options.pushTimeout);
      if (!Number.isFinite(pushTimeoutMinutes) || pushTimeoutMinutes <= 0) {
        console.error(`Error: --push-timeout must be a positive number of minutes, got ${options.pushTimeout}`);
        process.exit(1);
      }
      const { runCi } = await import('./ci/run.js');
      const result = await runCi({
        repo: options.repo,
        workspaceId: options.workspaceId,
        serverUrl: options.serverUrl,
        output: options.output,
        dryRun: options.dryRun,
        verbose: options.verbose,
        pushTimeoutMs: pushTimeoutMinutes * 60 * 1000,
        profile: options.profile,
      });

      if (result.status === 'error') {
        process.exit(1);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// Auth Commands
// =============================================================================

program
  .command('login')
  .description('Login to coredoc server')
  .option(
    '-s, --server <url>',
    'Server URL (or set COREDOC_SERVER_URL)',
    process.env.COREDOC_SERVER_URL ?? 'http://localhost:3000',
  )
  .action(async (options) => {
    await login(options.server);
  });

program
  .command('logout')
  .description('Logout from coredoc server')
  .action(async () => {
    await logout();
  });

program
  .command('whoami')
  .description('Show current auth status')
  .action(async () => {
    await whoami();
  });

// =============================================================================
// Telemetry Commands
// =============================================================================

const telemetryCmd = program.command('telemetry').description('Manage anonymous telemetry');

telemetryCmd
  .command('on')
  .description('Enable anonymous telemetry')
  .action(async () => {
    await setTelemetryEnabled(true);
    const cfg = await getTelemetryConfig();
    console.log('Telemetry enabled.');
    console.log(`Install ID: ${cfg.installId}`);
    console.log('Run `coredoc telemetry status` to see what is collected.');
  });

telemetryCmd
  .command('off')
  .description('Disable anonymous telemetry')
  .action(async () => {
    await setTelemetryEnabled(false);
    console.log('Telemetry disabled. No data will be sent.');
  });

telemetryCmd
  .command('status')
  .description('Show current telemetry state')
  .action(async () => {
    const cfg = await getTelemetryConfig();
    console.log(`Telemetry: ${cfg.enabled ? 'enabled' : 'disabled'}`);
    console.log(`Install ID: ${cfg.installId}`);
    console.log(`First seen: ${cfg.firstSeenAt}`);
    if (cfg.lastOptInChangeAt) {
      console.log(`Last changed: ${cfg.lastOptInChangeAt}`);
    }
  });

telemetryCmd
  .command('show')
  .description('Show what telemetry data would be sent')
  .action(async () => {
    const cfg = await getTelemetryConfig();
    // Enumerated from the EventName enum + real BaseProps in
    // `@coredoc/core/telemetry` (see telemetry.ts) — the first-run notice sends
    // users here for "exactly what would be sent", so the disclosure must track
    // the code and can't drift back into listing only command_* / a fake $lib.
    console.log(buildTelemetryShowText(cfg.installId));
  });

// =============================================================================
// Post-action hook: track command usage
// =============================================================================

// Commander invokes the postAction hook with (thisCommand, actionCommand).
// `thisCommand` is whatever the hook was registered on (here: the root
// program, so its name is always "coredoc"), while `actionCommand` is the
// leaf subcommand that actually ran. For nested commands like `parser list`
// or `telemetry on`, the leaf's .name() is just `list` / `on`, which
// collapses distinct commands together in analytics. Walk up the parent
// chain (stopping before the root program) to build the full path.
function resolveCommandPath(leaf: Command): string {
  const parts: string[] = [];
  let cmd: Command | null = leaf;
  // Stop when we hit the root `program` (no parent).
  while (cmd && cmd.parent) {
    parts.unshift(cmd.name());
    cmd = cmd.parent;
  }
  return parts.join(' ');
}

// The full name-path (e.g. "parser list") of the command currently running,
// captured before the action so `reportCliError` can attribute an unhandled
// crash to it WITHOUT reading process.argv (which carries paths / repo names).
// Stays 'unknown' for a crash outside any command's action.
let currentCommandPath = 'unknown';

program.hook('preAction', (_thisCommand, actionCommand) => {
  currentCommandPath = resolveCommandPath(actionCommand);
});

program.hook('postAction', (_thisCommand, actionCommand) => {
  const commandName = resolveCommandPath(actionCommand);
  // Skip telemetry-related commands themselves so toggling telemetry
  // doesn't emit its own events (e.g. `telemetry`, `telemetry on`).
  if (!commandName || isTelemetryCommandPath(commandName)) return;

  // `command_completed` (P1) replaces the retired raw-string `command_run` —
  // running both would double-count command volume. Fire-and-forget: the emit
  // is queued in the shared client and drained by the beforeExit flush.
  trackCommandCompleted(commandName, Date.now() - cliStartTime);
});

// Track unhandled command errors with a `command_failed` funnel event carrying
// an `error_code` bucket. No free-text error report is sent: a crash message can
// carry un-redactable repo / workspace / branch names (see telemetry.ts), so the
// `error_code` bucket is the only failure signal shipped. The handler is async so
// we can flush before exiting — Node's default behavior on an unhandled error is
// to crash, but installing a listener disables that, so we must re-raise by
// calling process.exit(1) ourselves.
//
// This is the one place that actively queues telemetry before exiting, so it's
// also the one place that needs to await shutdownTelemetry() — beforeExit is
// skipped on explicit exit(). The in-action `process.exit(1)` sites live inside
// action `try/catch` blocks and fire before postAction runs, so they queue no
// command_* event here; an operation failure among them is emitted
// (`<op>_failed`) + flushed by `trackOperation`'s catch (P0.7) instead.
async function reportCliError(reason: unknown): Promise<void> {
  const command = currentCommandPath;
  const durationMs = Date.now() - cliStartTime;
  const errorCode = classifyError(reason);
  try {
    // `command_failed` (P1) is the funnel event — scalar props only, `error_code`
    // as the grouping key. No free-text message rides along (repo-name leak).
    // Skip the emit for a crashing `telemetry` subcommand, mirroring the
    // postAction success-hook skip — toggling/inspecting telemetry must never
    // emit its own funnel event. Still flush + exit(1) regardless.
    if (!isTelemetryCommandPath(command)) {
      trackCommandFailed(command, durationMs, errorCode, reason instanceof Error ? reason.name : undefined);
    }
    await shutdownTelemetry();
  } catch {
    /* swallowed — telemetry must never change error semantics */
  }
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  if (isAbortedControlWrite(reason)) return;
  void reportCliError(reason);
});
process.on('uncaughtException', (error) => {
  void reportCliError(error);
});

// Happy-path flush: when the event loop drains naturally (no one called
// process.exit), flush any queued events. beforeExit fires exactly once
// and supports async handlers, so this is the cleanest place for it.
process.on('beforeExit', async () => {
  await shutdownTelemetry();
});

// Show the first-run telemetry notice (once, non-enabling, non-fatal) before
// dispatching the command, then hand off to Commander. The notice is skipped
// for the `telemetry` subcommands and is a no-op after the first run.
async function main(): Promise<void> {
  await maybeShowFirstRunTelemetryNotice(process.argv);
  program.parse(process.argv);
}

void main();
