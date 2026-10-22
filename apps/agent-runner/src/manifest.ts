import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORE_PLUGIN_NAME, type ResolvedManifest, resolveManifest } from '@coredoc/core/agent-runner';

export const MANIFEST_VARIABLE = 'COREDOC_RUNNER_MANIFEST';
const DEFAULT_MANIFEST_PATH = '/etc/coredoc/agent-runner.json';

export interface LoadedManifest {
  manifest: ResolvedManifest;
  /** Null when the platform defaults apply (no manifest file). */
  digest: string | null;
}

/** Throws a ManifestError for a file that is present but invalid; a missing file means the defaults. */
export async function loadManifest(env: NodeJS.ProcessEnv, defaultPluginPath: string): Promise<LoadedManifest> {
  const path = env[MANIFEST_VARIABLE]?.trim() || DEFAULT_MANIFEST_PATH;
  let text: string | undefined;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    manifest: resolveManifest(text, defaultPluginPath),
    digest: text === undefined ? null : `sha256:${createHash('sha256').update(text).digest('hex')}`,
  };
}

export async function readPluginManifest(pluginPath: string): Promise<{ name: string; version?: string } | null> {
  try {
    const manifest = JSON.parse(await readFile(join(pluginPath, '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest?.name === 'string' ? manifest : null;
  } catch {
    return null;
  }
}

export function sdkPlugins(manifest: ResolvedManifest) {
  return manifest.plugins.map(({ path }) => ({ type: 'local' as const, path }));
}

/** The start-up check guarantees exactly one before any turn is claimed. */
export async function corePluginPath(manifest: ResolvedManifest): Promise<string> {
  for (const { path } of manifest.plugins) {
    if ((await readPluginManifest(path))?.name === CORE_PLUGIN_NAME) return path;
  }
  throw new Error(`No ${CORE_PLUGIN_NAME} plugin in the runner manifest.`);
}
