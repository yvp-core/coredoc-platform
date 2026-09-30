/**
 * MCP Bridge - Generates and verifies project-bound MCP client configuration.
 */

import { IpcMain, BrowserWindow, app } from 'electron';
import * as path from 'path';
import { IpcChannels, McpInfoResult } from '../shared/ipc-types.js';
import { getCurrentConfig, getCurrentConfigPath } from './config-manager.js';
import {
  requireProjectRoot,
  getExternalNodeExec,
  getConfigPath as runtimeGetConfigPath,
  getMcpServerPath as runtimeGetMcpServerPath,
} from './runtime-paths.js';

/**
 * Get the monorepo root directory (delegates to runtime-paths).
 */
function getRootDir(): string {
  return requireProjectRoot();
}

/**
 * Find the MCP server executable (delegates to runtime-paths).
 */
function findMcpServer(): string {
  const mcpPath = runtimeGetMcpServerPath();
  if (mcpPath) return mcpPath;

  if (app.isPackaged) {
    throw new Error(
      'Bundled MCP server not found in packaged app (expected node_modules/@coredoc/mcp/dist/index.js). ' +
        'Rebuild and reinstall the desktop app package.',
    );
  }

  return path.join(getRootDir(), 'packages', 'mcp', 'dist', 'index.js');
}

/**
 * Get MCP server info (paths for config display)
 */
export function getMcpInfo(projectId: string): McpInfoResult {
  try {
    if (!projectId) throw new Error('A project id is required to configure the local MCP server.');
    const serverPath = path.resolve(findMcpServer());
    const configPath = getCurrentConfigPath() || runtimeGetConfigPath() || undefined;
    if (!configPath) throw new Error('No coredoc config is loaded.');
    const config = getCurrentConfig();
    const projectMatches = config?.projects.filter((project) => project.id === projectId) ?? [];
    if (projectMatches.length === 0) {
      throw new Error(`Project "${projectId}" not found in the loaded config.`);
    }
    if (projectMatches.length > 1) {
      throw new Error(`Project id "${projectId}" is duplicated in the loaded config.`);
    }
    const { execPath, env: launchEnv } = getExternalNodeExec();
    const env: Record<string, string> = {
      // External MCP clients spawn the server out-of-process, so it must be told
      // the SAME backend this app resolved at startup (defaulted to ladybug, or
      // whatever the workspace .env / user set) — a hardcoded value would point
      // the client at a different graph file than the explorer reads.
      COREDOC_DB_BACKEND: process.env.COREDOC_DB_BACKEND?.trim() || 'ladybug',
      MCP_CONFIG_PATH: configPath,
      COREDOC_SCOPE: `project:${projectId}`,
    };

    if (launchEnv.ELECTRON_RUN_AS_NODE) {
      env.ELECTRON_RUN_AS_NODE = launchEnv.ELECTRON_RUN_AS_NODE;
    }

    // External MCP clients spawn the server outside this process, so an active
    // COREDOC_HOME override (dev builds → ~/.coredoc-dev) must travel in the
    // written config or the server would stitch telemetry sessions against the
    // packaged app's ~/.coredoc.
    if (process.env.COREDOC_HOME) {
      env.COREDOC_HOME = process.env.COREDOC_HOME;
    }

    return {
      success: true,
      command: execPath,
      args: [serverPath],
      env,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get MCP info',
    };
  }
}

/**
 * Register IPC handlers for MCP operations
 */
export function registerMcpHandlers(ipcMain: IpcMain, _mainWindow: BrowserWindow): void {
  ipcMain.handle(IpcChannels.MCP_GET_INFO, (_event, projectId: string) => {
    return getMcpInfo(projectId);
  });
}
