// evals/cases-intent/setup.ts
/**
 * Seeds a cloud workspace for the intent eval and records where the runner
 * finds it.
 *
 *   delete the workspace a previous setup recorded (import needs an empty one)
 *   → create a workspace → enable intent → import the seed as a workspace
 *   document → mint an intent-agent MCP token → check the context read serves
 *   the seed → stage the fixture checkout → write the run config
 *
 * The import requires a signed-in USER session (`UserSessionGuard` refuses
 * service tokens), so setup authenticates with the access token `coredoc login`
 * stored for that server, or `COREDOC_EVAL_ACCESS_TOKEN`. The agents only ever
 * see the minted intent-agent token, which can read and propose but not accept.
 *
 * Code anchors are not staged: the workspace has no published graph, so the two
 * anchor-freshness facts in the corpus cannot be met and the runner reports
 * every run as diagnostic (`anchorsStaged: false`).
 *
 * Invocation (server from `pnpm server:dev`, URL from COREDOC_EVAL_SERVER_URL):
 *
 *   pnpm --dir evals run eval:intent:setup
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCoredocHome } from '@coredoc/core/utils';
import { readSeedIntent, seedToWorkspaceDocument, type WorkspaceDocument } from './seed-document.js';

const here = dirname(fileURLToPath(import.meta.url));

/** `pnpm server:dev` listens here unless PORT says otherwise. */
export const DEFAULT_EVAL_SERVER_URL = 'http://localhost:3000';
export const FIXTURE_SOURCE_DIR = join(here, 'fixture-repo');
/** Git-ignored (`cases-intent/.gitignore`). */
export const RUN_CONFIG_DIR = join(here, 'workspace');
export const RUN_CONFIG_PATH = join(RUN_CONFIG_DIR, 'cloud-run.json');
export const MCP_TOKEN_PATH = join(RUN_CONFIG_DIR, 'mcp-token');
/** Prefix of the temp checkout the arms run in; only directories with it are ever removed. */
export const CHECKOUT_PREFIX = 'coredoc-intent-eval-checkout-';
/** An accepted seed item the context read must return once the import landed. */
export const SEED_PROBE_ID = 'cap-widget-ordering';

const API = '/api/v1';

export interface IntentEvalRunConfig {
  version: 1;
  serverUrl: string;
  workspaceId: string;
  workspaceSlug: string;
  /** Streamable-HTTP MCP endpoint of the workspace. */
  mcpUrl: string;
  tokenId: string;
  /** Mode-0600 file holding the intent-agent token; the config never holds the secret. */
  tokenFile: string;
  /**
   * A copy of the fixture repo in a temp directory OUTSIDE this repository,
   * shared by both arms, so no relative path from an arm's cwd reaches
   * `seed-intent.json`.
   */
  checkoutRoot: string;
  seedRevision: string;
  importCounts: unknown;
  anchorsStaged: boolean;
  createdAt: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function resolveServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.COREDOC_EVAL_SERVER_URL?.trim() || DEFAULT_EVAL_SERVER_URL).replace(/\/+$/, '');
}

export function workspaceMcpUrl(serverUrl: string, workspaceId: string): string {
  return `${serverUrl}${API}/workspaces/${workspaceId}/mcp`;
}

/** The access token `coredoc login --server <serverUrl>` stored, if it is for this server and unexpired. */
export function readCliAccessToken(
  serverUrl: string,
  credentialsPath: string = join(resolveCoredocHome(), 'credentials.json'),
  now: number = Date.now(),
): string {
  const loginHint = `run \`pnpm cli login --server ${serverUrl}\` or set COREDOC_EVAL_ACCESS_TOKEN`;
  let stored: { accessToken?: unknown; serverUrl?: unknown; expiresAt?: unknown };
  try {
    stored = JSON.parse(readFileSync(credentialsPath, 'utf8')) as typeof stored;
  } catch {
    throw new Error(`No coredoc login found at ${credentialsPath} — ${loginHint}.`);
  }
  const storedServer = typeof stored.serverUrl === 'string' ? stored.serverUrl.replace(/\/+$/, '') : '';
  if (storedServer !== serverUrl) {
    throw new Error(`The stored coredoc login is for ${storedServer || 'an unknown server'}, not ${serverUrl} — ${loginHint}.`);
  }
  if (typeof stored.accessToken !== 'string' || typeof stored.expiresAt !== 'number' || stored.expiresAt <= now) {
    throw new Error(`The stored coredoc login for ${serverUrl} has expired — ${loginHint}.`);
  }
  return stored.accessToken;
}

export function resolveAccessToken(
  env: NodeJS.ProcessEnv,
  serverUrl: string,
  readCli: (serverUrl: string) => string = readCliAccessToken,
): string {
  const token = env.COREDOC_EVAL_ACCESS_TOKEN?.trim() || readCli(serverUrl);
  if (token.startsWith('cdt_')) {
    throw new Error(
      'COREDOC_EVAL_ACCESS_TOKEN is a service token (cdt_); the workspace import needs a user session token from `coredoc login`.',
    );
  }
  return token;
}

export class CloudClient {
  constructor(
    readonly serverUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Returns the parsed JSON body, `null` for an empty one; throws with status and body on any non-2xx. */
  async request(method: string, path: string, body?: unknown, okStatuses: readonly number[] = []): Promise<unknown> {
    const response = await this.fetchImpl(`${this.serverUrl}${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok && !okStatuses.includes(response.status)) {
      throw new Error(`${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    return text === '' ? null : (JSON.parse(text) as unknown);
  }
}

export interface SeededWorkspace {
  workspaceId: string;
  workspaceSlug: string;
  tokenId: string;
  token: string;
  importCounts: unknown;
}

/**
 * Every server call setup makes, in order. A fresh workspace each time is what
 * makes re-running safe: `import/workspace` only accepts a workspace with no
 * intent content, and there is no bulk delete of intent content.
 */
export async function seedCloudWorkspace(opts: {
  client: CloudClient;
  document: WorkspaceDocument;
  previousWorkspaceId?: string | undefined;
  now?: number;
}): Promise<SeededWorkspace> {
  const { client, document } = opts;
  if (opts.previousWorkspaceId) {
    // 404: someone already removed it, which is the state this step wants.
    await client.request('DELETE', `/workspaces/${opts.previousWorkspaceId}`, undefined, [404]);
  }
  const workspaceSlug = `intent-eval-${(opts.now ?? Date.now()).toString(36)}`;
  const workspace = (await client.request('POST', '/workspaces', {
    name: 'Intent eval',
    slug: workspaceSlug,
  })) as { id?: unknown };
  if (typeof workspace?.id !== 'string') throw new Error('POST /workspaces returned no workspace id');
  const workspaceId = workspace.id;

  await client.request('PATCH', `/workspaces/${workspaceId}`, { intentEnabled: true });
  const imported = (await client.request('POST', `/workspaces/${workspaceId}/intent/import/workspace`, {
    idempotencyKey: `intent-eval-seed-${document.source.revision.slice(0, 16)}`,
    document,
  })) as { counts?: unknown } | null;

  const minted = (await client.request('POST', `/workspaces/${workspaceId}/tokens`, {
    name: 'intent-eval-mcp',
    scope: 'intent-agent',
  })) as { id?: unknown; token?: unknown };
  if (typeof minted?.token !== 'string' || typeof minted.id !== 'string') {
    throw new Error('POST /tokens returned no token');
  }
  return { workspaceId, workspaceSlug, tokenId: minted.id, token: minted.token, importCounts: imported?.counts ?? null };
}

/**
 * The read the agents depend on, made with the agents' own token: the REST
 * twin of `get_intent_context`. Used after setup and before every run.
 */
export async function probeIntentContext(
  serverUrl: string,
  workspaceId: string,
  mcpToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const client = new CloudClient(serverUrl, mcpToken, fetchImpl);
  const answer = await client.request('GET', `/workspaces/${workspaceId}/intent/context?intentIds=${SEED_PROBE_ID}`);
  if (!JSON.stringify(answer).includes(`"${SEED_PROBE_ID}"`)) {
    throw new Error(
      `Workspace ${workspaceId} does not serve the seeded item ${SEED_PROBE_ID} — re-run \`pnpm --dir evals run eval:intent:setup\`.`,
    );
  }
}

/** Copy the fixture into a fresh temp directory, removing the one a previous setup made. */
export function stageCheckout(previousRoot?: string | undefined): string {
  if (previousRoot && basename(previousRoot).startsWith(CHECKOUT_PREFIX) && dirname(previousRoot) === tmpdir()) {
    rmSync(previousRoot, { recursive: true, force: true });
  }
  const root = mkdtempSync(join(tmpdir(), CHECKOUT_PREFIX));
  cpSync(FIXTURE_SOURCE_DIR, root, { recursive: true });
  return root;
}

export function readRunConfig(path: string = RUN_CONFIG_PATH): IntentEvalRunConfig | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as IntentEvalRunConfig;
}

export function writeRunConfig(config: IntentEvalRunConfig, token: string, dir: string = RUN_CONFIG_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(config.tokenFile, `${token}\n`, { mode: 0o600 });
  writeFileSync(join(dir, basename(RUN_CONFIG_PATH)), `${JSON.stringify(config, null, 2)}\n`);
}

/** The agents' token: COREDOC_EVAL_MCP_TOKEN, else the file setup wrote. */
export function readMcpToken(config: IntentEvalRunConfig, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.COREDOC_EVAL_MCP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(config.tokenFile)) {
    throw new Error(`MCP token file ${config.tokenFile} is missing — re-run \`pnpm --dir evals run eval:intent:setup\`.`);
  }
  return readFileSync(config.tokenFile, 'utf8').trim();
}

export async function runSetup(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): Promise<IntentEvalRunConfig> {
  const serverUrl = resolveServerUrl(env);
  const client = new CloudClient(serverUrl, resolveAccessToken(env, serverUrl), fetchImpl);
  const previous = readRunConfig();
  const document = seedToWorkspaceDocument(readSeedIntent());

  const seeded = await seedCloudWorkspace({
    client,
    document,
    // A workspace on another server is not this server's to delete.
    previousWorkspaceId: previous?.serverUrl === serverUrl ? previous.workspaceId : undefined,
  });
  await probeIntentContext(serverUrl, seeded.workspaceId, seeded.token, fetchImpl);

  const config: IntentEvalRunConfig = {
    version: 1,
    serverUrl,
    workspaceId: seeded.workspaceId,
    workspaceSlug: seeded.workspaceSlug,
    mcpUrl: workspaceMcpUrl(serverUrl, seeded.workspaceId),
    tokenId: seeded.tokenId,
    tokenFile: MCP_TOKEN_PATH,
    checkoutRoot: stageCheckout(previous?.checkoutRoot),
    seedRevision: document.source.revision,
    importCounts: seeded.importCounts,
    anchorsStaged: false,
    createdAt: new Date().toISOString(),
  };
  writeRunConfig(config, seeded.token);
  return config;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSetup()
    .then((config) => {
      console.log(
        `Seeded workspace ${config.workspaceSlug} (${config.workspaceId}) on ${config.serverUrl}\n` +
          `  import counts: ${JSON.stringify(config.importCounts)}\n` +
          `  MCP endpoint:  ${config.mcpUrl}\n` +
          `  checkout:      ${config.checkoutRoot}\n` +
          `  run config:    ${RUN_CONFIG_PATH}`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
