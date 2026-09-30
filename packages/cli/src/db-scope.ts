/** Bind one CLI process to one project's local graph databases. */

import type { RuntimeConfig } from '@coredoc/core/types';
import { projectDbPath, projectDbUrl } from '@coredoc/core/utils';

let boundProjectId: string | undefined;

/**
 * Point the process-wide DB singleton at `projectId`'s engine-specific file.
 *
 * CLI and desktop worker processes execute one project at a time. The binding
 * is always derived from the loaded config; an ambient URL is overwritten so
 * it cannot collapse two projects back into one shared graph.
 */
export async function bindProjectDatabase(config: RuntimeConfig, projectId: string): Promise<void> {
  const matches = config.projects.filter((project) => project.id === projectId);
  if (matches.length === 0) {
    throw new Error(
      `Project "${projectId}" not found. Available projects: ${config.projects.map((project) => project.id).join(', ') || 'none'}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`Project id "${projectId}" is duplicated in the config; project database ownership is ambiguous.`);
  }

  const url = projectDbUrl(config.configDir, projectId);
  const ladybugPath = projectDbPath(config.configDir, projectId).replace(/\.db$/, '.lbdb');
  if (
    boundProjectId === projectId &&
    process.env.COREDOC_SQLITE_URL === url &&
    process.env.COREDOC_LADYBUG_PATH === ladybugPath
  ) {
    return;
  }

  const ambientBindingChanged =
    (!!process.env.COREDOC_SQLITE_URL && process.env.COREDOC_SQLITE_URL !== url) ||
    (!!process.env.COREDOC_LADYBUG_PATH && process.env.COREDOC_LADYBUG_PATH !== ladybugPath);
  if (boundProjectId !== undefined || ambientBindingChanged) {
    const { closeAllDrivers } = await import('@coredoc/db');
    await closeAllDrivers();
  }

  process.env.COREDOC_SQLITE_URL = url;
  process.env.COREDOC_LADYBUG_PATH = ladybugPath;
  boundProjectId = projectId;
}

export function unresolvedProjectError(repoArg: string): Error {
  return new Error(
    `Cannot determine which project "${repoArg}" belongs to. ` +
      'Pass --project <id>, or move the file under coredoc-output/<project>/.',
  );
}
