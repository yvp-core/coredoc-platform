import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ENV_REFERENCE, ManifestError, type ResolvedManifest, resolveManifest } from '@coredoc/core/agent-runner';

export const MANIFEST_VARIABLE = 'COREDOC_RUNNER_MANIFEST';
const DEFAULT_MANIFEST_PATH = '/etc/coredoc/agent-runner.json';

export interface LoadedManifest {
  manifest: ResolvedManifest;
  /** Null when the platform defaults apply (no manifest file). */
  digest: string | null;
  /** The runner variables the manifest's MCP server headers read, for masking. */
  secrets: string[];
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
  const manifest = resolveManifest(text, defaultPluginPath);
  return {
    manifest,
    secrets: resolveHeaderVariables(manifest, env),
    digest: text === undefined ? null : `sha256:${createHash('sha256').update(text).digest('hex')}`,
  };
}

/** Replaces each `env:<VARIABLE>` header value with the variable, in place; an unset one is a manifest error. */
function resolveHeaderVariables(manifest: ResolvedManifest, env: NodeJS.ProcessEnv): string[] {
  const secrets: string[] = [];
  for (const workflow of manifest.workflows) {
    for (const [server, { headers }] of Object.entries(workflow.mcpServers)) {
      for (const [header, value] of Object.entries(headers)) {
        const name = ENV_REFERENCE.exec(value)?.[1];
        if (!name) continue;
        const resolved = env[name]?.trim();
        if (!resolved || /[\r\n]/.test(resolved)) {
          throw new ManifestError(
            `The runner manifest is invalid: ${workflow.id}: mcpServers.${server}.headers.${header} reads ${name}, which is not set to a one-line value`,
          );
        }
        headers[header] = resolved;
        secrets.push(resolved);
      }
    }
  }
  return secrets;
}

export async function readPluginManifest(pluginPath: string): Promise<{ name: string; version?: string } | null> {
  try {
    const manifest = JSON.parse(await readFile(join(pluginPath, '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest?.name === 'string' ? manifest : null;
  } catch {
    return null;
  }
}

export function sdkPlugins(plugins: Array<{ path: string }>) {
  return plugins.map(({ path }) => ({ type: 'local' as const, path }));
}
