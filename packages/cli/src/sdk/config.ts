/**
 * SDK Config Loader
 *
 * Thin wrapper over the canonical loader in @coredoc/core/utils: it only pins
 * the SDK's diagnostic prefix. Accepts absolute paths — no process.cwd()
 * dependency.
 */

import type { RuntimeConfig } from '@coredoc/core/types';
import { loadConfig as loadCoredocConfig, type LoadConfigOptions } from '@coredoc/core/utils';

export type { LoadConfigOptions };

/**
 * Load and resolve a coredoc config file into a RuntimeConfig.
 *
 * @param configPath - Absolute path to coredoc.config.json
 * @returns Resolved runtime config with absolute paths
 */
export function loadConfig(configPath: string, options: LoadConfigOptions = {}): RuntimeConfig {
  return loadCoredocConfig(configPath, {
    ...options,
    onMigrationWarning: (message) => console.warn(`[coredoc/sdk] Migration warning: ${message}`),
  });
}
