/**
 * Config Manager - Handles loading, saving, and validating coredoc config
 */

import { IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  IpcChannels,
  ConfigLoadResult,
  ConfigSaveResult,
  ConfigValidateResult,
  CoredocConfigSerialized,
  RepoConfigSerialized,
  RemoveRepositoryResult,
} from '../shared/ipc-types.js';
import { getConfigPath as runtimeGetConfigPath, requireProjectRoot } from './runtime-paths.js';
import { parserDir, parsedRepoFile, summariesFile, embeddingsFile, docsDir, projectDbDir } from '@coredoc/core/utils';

let currentConfigPath: string | null = null;
let currentConfig: CoredocConfigSerialized | null = null;

/**
 * IDs backed by retained database files. Project deletion deliberately keeps
 * those files because another MCP process may still own their WAL handles; a
 * later project must therefore receive a new id instead of inheriting the old
 * graph by accident.
 */
export function listReservedProjectIds(configPath: string): string[] {
  const dbDir = projectDbDir(path.dirname(path.resolve(configPath)));
  if (!fs.existsSync(dbDir)) return [];
  if (fs.lstatSync(dbDir).isSymbolicLink()) {
    throw new Error(`Refusing to inspect project database directory "${dbDir}" because it is a symbolic link.`);
  }
  return fs
    .readdirSync(dbDir)
    .filter((name) => name.endsWith('.db') && name.length > '.db'.length)
    .map((name) => name.slice(0, -'.db'.length));
}

/**
 * Get default config path (uses runtime-paths).
 */
function getDefaultConfigPath(): string {
  return runtimeGetConfigPath() ?? path.join(requireProjectRoot(), 'coredoc.config.json');
}

/**
 * Load config from file
 */
export function loadConfig(configPath?: string): ConfigLoadResult {
  const targetPath = configPath || currentConfigPath || getDefaultConfigPath();

  try {
    if (!fs.existsSync(targetPath)) {
      return {
        success: false,
        error: `Config file not found: ${targetPath}`,
      };
    }

    const absoluteConfigPath = path.resolve(targetPath);
    const content = fs.readFileSync(absoluteConfigPath, 'utf-8');
    const config: CoredocConfigSerialized = JSON.parse(content);

    const seenProjectIds = new Set<string>();
    for (const project of config.projects) {
      if (seenProjectIds.has(project.id)) {
        throw new Error(
          `Project id "${project.id}" is duplicated in the config; each project must own a unique database.`,
        );
      }
      seenProjectIds.add(project.id);
    }

    const reservedProjectIds = listReservedProjectIds(absoluteConfigPath);

    currentConfigPath = absoluteConfigPath;
    currentConfig = config;
    return {
      success: true,
      config: currentConfig,
      reservedProjectIds,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error loading config',
    };
  }
}

/**
 * Save config to file
 */
export function saveConfig(config: CoredocConfigSerialized): ConfigSaveResult {
  const targetPath = currentConfigPath || getDefaultConfigPath();

  try {
    const content = JSON.stringify(config, null, 2);
    fs.writeFileSync(targetPath, content, 'utf-8');

    currentConfig = config;

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error saving config',
    };
  }
}

/**
 * Validate config
 */
export function validateConfig(): ConfigValidateResult {
  if (!currentConfig || !currentConfigPath) {
    return {
      valid: false,
      errors: [{ path: '', message: 'No config loaded' }],
      warnings: [],
    };
  }

  const errors: Array<{ path: string; message: string }> = [];
  const warnings: Array<{ path: string; message: string }> = [];
  const configDir = path.dirname(currentConfigPath);

  // Validate repos across projects and standalone
  const allRepos = getAllConfigRepos(currentConfig);
  allRepos.forEach((repo, index) => {
    if (!repo.name) {
      errors.push({ path: `repos[${index}].name`, message: 'name is required' });
    }
    if (!repo.path) {
      errors.push({ path: `repos[${index}].path`, message: 'path is required' });
    } else {
      const resolvedPath = path.resolve(configDir, repo.path);
      if (!fs.existsSync(resolvedPath)) {
        errors.push({
          path: `repos[${index}].path`,
          message: `Directory not found: ${resolvedPath}`,
        });
      }
    }
    if (!repo.type) {
      errors.push({ path: `repos[${index}].type`, message: 'type is required' });
    }
  });

  // Validate output
  if (!currentConfig.output) {
    errors.push({ path: 'output', message: 'output configuration is required' });
  } else {
    if (!currentConfig.output.dir) {
      errors.push({ path: 'output.dir', message: 'output directory is required' });
    }
  }

  // Validate parser storage
  if (!currentConfig.parserStorage) {
    warnings.push({
      path: 'parserStorage',
      message: 'parserStorage not specified, will use default',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Get current config
 */
export function getCurrentConfig(): CoredocConfigSerialized | null {
  return currentConfig;
}

/**
 * Get current config path
 */
export function getCurrentConfigPath(): string | null {
  return currentConfigPath;
}

/**
 * Get all repos across all projects.
 */
export function getAllConfigRepos(config: CoredocConfigSerialized): RepoConfigSerialized[] {
  return config.projects.flatMap((p) => p.repos);
}

// Internal desktop IPC always carries the stable project id (migration guarantees it),
// so we look up by id only. MCP scope-resolver still accepts name-or-id because AI
// agents pass human-readable names through tool arguments.
function findProjectByIdentifier(projectId: string) {
  return currentConfig?.projects.find((project) => project.id === projectId);
}

/**
 * Resolve a repo name to its absolute path using the loaded config
 */
export function resolveRepoPath(repoName: string, projectId?: string): string | null {
  if (!currentConfig || !currentConfigPath) {
    return null;
  }

  const repo = projectId
    ? findProjectByIdentifier(projectId)?.repos.find((r) => r.name === repoName)
    : getAllConfigRepos(currentConfig).find((r) => r.name === repoName);
  if (!repo) {
    return null;
  }

  const configDir = path.dirname(currentConfigPath);
  return path.resolve(configDir, repo.path);
}

/**
 * Get config directory (for resolving relative paths)
 */
export function getConfigDir(): string | null {
  return currentConfigPath ? path.dirname(currentConfigPath) : null;
}

/**
 * Get all repos belonging to a project
 * @param projectId - The stable project id
 * @returns Array of repos in the project
 */
export function getProjectRepos(projectId: string): RepoConfigSerialized[] {
  if (!currentConfig) {
    return [];
  }
  const project = findProjectByIdentifier(projectId);
  return project?.repos ?? [];
}

/**
 * Resolve project to a working directory (first repo's path in the project)
 * @param projectId - The stable project id
 * @returns Absolute path of first repo in the project, or null if not found
 */
export function resolveProjectPath(projectId: string): string | null {
  if (!currentConfig || !currentConfigPath) {
    return null;
  }

  const projectRepos = getProjectRepos(projectId);
  if (projectRepos.length === 0) {
    return null;
  }

  const configDir = path.dirname(currentConfigPath);
  return path.resolve(configDir, projectRepos[0].path);
}

/**
 * Remove a repository from a specific project and clean up its parser
 * folder, parsed JSON, summaries, embeddings, and docs subfolder.
 */
export function removeRepository(projectId: string, repoName: string): RemoveRepositoryResult {
  if (!currentConfig || !currentConfigPath) {
    return { success: false, error: 'No config loaded' };
  }

  try {
    const configDir = path.dirname(currentConfigPath);

    const project = findProjectByIdentifier(projectId);
    if (!project) {
      return { success: false, error: `Project "${projectId}" not found in config` };
    }
    const repoIndex = project.repos.findIndex((r) => r.name === repoName);
    if (repoIndex === -1) {
      return { success: false, error: `Repository "${repoName}" not found in project "${projectId}"` };
    }
    project.repos.splice(repoIndex, 1);

    // Save updated config
    const content = JSON.stringify(currentConfig, null, 2);
    fs.writeFileSync(currentConfigPath, content, 'utf-8');

    // Clean up both the canonical parser folder and its rebuildable compiled cache.
    // Leaving dist behind lets CLI parse succeed from an orphaned profile.mjs while
    // desktop state correctly reports that no canonical profile.ts exists.
    const parserStorageRoot = path.resolve(configDir, currentConfig.parserStorage);
    const parserPath = parserDir(parserStorageRoot, projectId, repoName);
    if (fs.existsSync(parserPath)) {
      fs.rmSync(parserPath, { recursive: true, force: true });
    }
    const compiledParserRoot = path.join(path.dirname(parserStorageRoot), 'dist', 'coredoc-parsers');
    const compiledParserPath = parserDir(compiledParserRoot, projectId, repoName);
    if (fs.existsSync(compiledParserPath)) {
      fs.rmSync(compiledParserPath, { recursive: true, force: true });
    }

    // Clean up output artifacts
    const outputBase = path.resolve(configDir, currentConfig.output.dir);
    const filesToDelete = [
      parsedRepoFile(outputBase, projectId, repoName),
      summariesFile(outputBase, projectId, repoName),
      embeddingsFile(outputBase, projectId, repoName),
    ];
    for (const filePath of filesToDelete) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    const docs = docsDir(outputBase, projectId, repoName);
    if (fs.existsSync(docs)) {
      fs.rmSync(docs, { recursive: true, force: true });
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error removing repository',
    };
  }
}

/**
 * Register IPC handlers for config operations
 */
export function registerConfigHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IpcChannels.CONFIG_LOAD, (_event, configPath?: string) => {
    return loadConfig(configPath);
  });

  ipcMain.handle(IpcChannels.CONFIG_SAVE, (_event, config: CoredocConfigSerialized) => {
    return saveConfig(config);
  });

  ipcMain.handle(IpcChannels.CONFIG_VALIDATE, () => {
    return validateConfig();
  });

  ipcMain.handle(IpcChannels.CONFIG_REMOVE_REPO, (_event, projectId: string, repoName: string) => {
    return removeRepository(projectId, repoName);
  });
}
