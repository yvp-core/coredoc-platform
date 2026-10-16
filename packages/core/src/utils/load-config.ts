/**
 * Canonical coredoc.config.json loader, shared by every host (CLI commands,
 * CLI SDK, `coredoc sync`, the local MCP server).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { CoredocConfig, RuntimeConfig } from '../types/index.js';
import { repoRefKey } from './repo-ref.js';

/**
 * Load and resolve a config file into a RuntimeConfig.
 *
 * @param configPath - Path to coredoc.config.json; relative paths resolve against cwd
 * @returns Resolved runtime config with absolute paths
 */
export function loadConfig(configPath: string): RuntimeConfig {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);

  if (!fs.existsSync(absoluteConfigPath)) {
    throw new Error(`Config file not found: ${absoluteConfigPath}`);
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
