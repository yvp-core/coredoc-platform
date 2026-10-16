/**
 * The runner never decrypts a repository's own (e.g. SOPS-encrypted) registry config; each turn's
 * home gets one built from `COREDOC_PACKAGE_REGISTRIES`, keyed by package scope or `default`:
 *
 *   { "@acme":   { "url": "https://npm.pkg.github.com", "credential": "github" },
 *     "@vendor": { "url": "https://npm.vendor.example/", "credential": "env:VENDOR_NPM_TOKEN" },
 *     "default": { "url": "https://npm-mirror.internal.example/" } }
 *
 * `github` is the bot's token (GitHub Packages accepts only a classic token with package read);
 * `env:NAME` reads a runner variable; no credential means anonymous access.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PackageRegistry {
  scope: string | null;
  /** Normalised with a trailing slash. */
  url: string;
  token: string | null;
}

export const PACKAGE_REGISTRIES_VARIABLE = 'COREDOC_PACKAGE_REGISTRIES';
const SCOPE = /^@[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalid(message: string): Error {
  return new Error(`${PACKAGE_REGISTRIES_VARIABLE}: ${message}`);
}

export function packageRegistries(env: NodeJS.ProcessEnv, botToken: string | null): PackageRegistry[] {
  const raw = env[PACKAGE_REGISTRIES_VARIABLE]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid('not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('expected an object keyed by package scope or "default"');
  }
  return Object.entries(parsed).map(([key, entry]) => {
    if (key !== 'default' && !SCOPE.test(key))
      throw invalid(`"${key}" is neither a package scope (@name) nor "default"`);
    const { url, credential } = (entry ?? {}) as { url?: unknown; credential?: unknown };
    const registryUrl = parseUrl(key, url);
    const token = resolveCredential(key, credential, env, botToken);
    if (token !== null && registryUrl.protocol !== 'https:') {
      throw invalid(`${key}: a credential is only sent to an https registry`);
    }
    return { scope: key === 'default' ? null : key, url: withSlash(registryUrl.href), token };
  });
}

function parseUrl(key: string, url: unknown): URL {
  let parsed: URL | null = null;
  try {
    if (typeof url === 'string') parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
    throw invalid(`${key}: "url" must be an http(s) URL without credentials`);
  }
  return parsed;
}

function resolveCredential(
  key: string,
  credential: unknown,
  env: NodeJS.ProcessEnv,
  botToken: string | null,
): string | null {
  if (credential === undefined || credential === null) return null;
  if (credential === 'github') {
    if (!botToken) throw invalid(`${key}: credential "github" needs COREDOC_GITHUB_TOKEN`);
    return botToken;
  }
  const name = typeof credential === 'string' && credential.startsWith('env:') ? credential.slice(4) : null;
  if (!name || !ENV_NAME.test(name)) {
    throw invalid(`${key}: credential must be "github" or "env:<VARIABLE>"`);
  }
  const value = env[name]?.trim();
  if (!value) throw invalid(`${key}: credential variable ${name} is not set`);
  // One line, so the value cannot add settings to the generated configuration.
  if (/[\r\n]/.test(value)) throw invalid(`${key}: credential variable ${name} spans several lines`);
  return value;
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** npm, pnpm and yarn 1 all read it. It holds credentials, so it is owner-only and outside every work tree. */
export async function writeUserRegistryConfig(home: string, registries: PackageRegistry[]): Promise<void> {
  if (registries.length === 0) return;
  const lines: string[] = [];
  for (const registry of registries) {
    lines.push(registry.scope ? `${registry.scope}:registry=${registry.url}` : `registry=${registry.url}`);
    // npm keys credentials by the registry URL without its scheme.
    if (registry.token) lines.push(`${registry.url.replace(/^https?:/, '')}:_authToken=${registry.token}`);
  }
  await writeFile(join(home, '.npmrc'), `${lines.join('\n')}\n`, { mode: 0o600 });
}
