/**
 * Canonical coredoc.config.json loader.
 *
 * Single definition for every host (CLI commands, CLI SDK, `coredoc sync`, the
 * local MCP server). They previously each carried their own copy, which drifted:
 * `coredoc sync` silently skipped the one-shot workspace-layout migration that
 * all other hosts run. Diagnostics stay per-host through the callbacks, because
 * a CLI writes to stderr while the MCP server must not write to stdio at all.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { CoredocConfig, RuntimeConfig } from '../types/index.js';
import { migrateWorkspaceLayout, type MigrationResult } from './migrate-workspace-layout.js';
import { repoRefKey } from './repo-ref.js';

export interface LoadConfigOptions {
  /**
   * Skip the one-shot workspace-layout migration. Only for sandbox-confined
   * callers whose trusted host already ran the migration before entering the
   * sandbox: inside the sandbox the parser-storage root is unreadable, so even
   * the migration's idempotency check (reading `.layout-version`) fails with
   * EPERM.
   *
   * Also for callers that must never mutate parser storage because the config
   * they were handed may be partial or CI-generated (`coredoc sync`).
   */
  skipMigration?: boolean;
  /** Sink for a single migration warning. Silent when omitted. */
  onMigrationWarning?: (message: string) => void;
  /** Called with the migration result when the migration ran, for summary output. */
  onMigrated?: (result: MigrationResult) => void;
}

/**
 * Load and resolve a config file into a RuntimeConfig.
 *
 * @param configPath - Path to coredoc.config.json; relative paths resolve against cwd
 * @returns Resolved runtime config with absolute paths
 */
export function loadConfig(configPath: string, options: LoadConfigOptions = {}): RuntimeConfig {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);

  if (!fs.existsSync(absoluteConfigPath)) {
    throw new Error(`Config file not found: ${absoluteConfigPath}`);
  }

  if (!options.skipMigration) {
    // Run the one-shot workspace-layout migration. Idempotent.
    const migration = migrateWorkspaceLayout(absoluteConfigPath);
    options.onMigrated?.(migration);
    for (const error of migration.errors) {
      options.onMigrationWarning?.(error);
    }
  }

  const config: CoredocConfig = JSON.parse(fs.readFileSync(absoluteConfigPath, 'utf-8'));
  const configDir = path.dirname(absoluteConfigPath);

  // Resolve repo paths, keyed by `${projectId}/${repoName}` so consumers can
  // look them up via repoRefKey().
  const resolvedRepoPaths = new Map<string, string>();
  for (const project of config.projects) {
    for (const repo of project.repos) {
      resolvedRepoPaths.set(repoRefKey(project.id, repo.name), path.resolve(configDir, repo.path));
    }
  }

  return {
    ...config,
    configPath: absoluteConfigPath,
    configDir,
    resolvedRepoPaths,
    resolvedOutputDir: path.resolve(configDir, config.output.dir),
    resolvedParserStorage: path.resolve(configDir, config.parserStorage),
  };
}
