/**
 * Config Helper Utilities
 *
 * Pure functions for working with the v2 CoredocConfig structure
 * where projects contain repos.
 */

import type { CoredocConfig, RepoConfig } from '../types/config.js';

/**
 * Get all repos across all projects.
 */
export function getAllRepos(config: CoredocConfig): RepoConfig[] {
  return config.projects.flatMap((p) => p.repos);
}
