/**
 * The server's one configuration schema.
 *
 * Every environment variable the server reads is declared here, grouped by the
 * concern that owns it, with the default that used to live at the read site.
 * `loadAppConfig` is pure — env in, config out, no I/O, no caching — so it can
 * be called from a unit test with a literal record, and so the same function
 * can both validate at boot (`ConfigModule.forRoot({ validate })`) and produce
 * the value consumers inject.
 *
 * Two rules shape what is in here:
 *
 *  - **Requiredness is role-dependent.** A `PROCESS_ROLE=worker` process never
 *    loads the OAuth/web-auth graph, so demanding its keys would turn a
 *    correctly-configured worker into a boot failure. Each app root declares
 *    its own role (`ApiAppModule` → `api`, `WorkerAppModule` → `worker`), which
 *    is the same thing `main.ts` uses `PROCESS_ROLE` to decide.
 *  - **A var is required here only when the code already refuses to run without
 *    it.** `OAUTH_JWT_SECRET` is required for the API role because
 *    `McpAuthModule.forRoot()` rejects a short/absent secret at boot today;
 *    `DATABASE_URL` is *not*, because `PrismaService.onModuleInit` deliberately
 *    warns and continues without it. This schema makes existing failures
 *    earlier and clearer; it does not invent new ones.
 *
 * Exact-literal flags (`=== 'true'`, `!== 'false'`) stay raw strings: see
 * `libs/retention.ts` for why the vocabulary must not be widened.
 */

import { z } from 'zod';
import { WorkspaceMemberRole } from '../modules/members/dto/workspace-role.enum.js';
import { parseProcessRole, type ProcessRole } from '../process-role.js';

export type { ProcessRole };

/** DI token for the whole validated config. */
export const APP_CONFIG = 'APP_CONFIG';
/** DI token for the storage/graph group. */
export const STORAGE_CONFIG = 'STORAGE_CONFIG';
/** DI token for the auth/WorkOS group. */
export const AUTH_CONFIG = 'AUTH_CONFIG';
/** DI token for the workers + retention group. */
export const WORKERS_CONFIG = 'WORKERS_CONFIG';
/** DI token for the delivery-connector group. */
export const CONNECTORS_CONFIG = 'CONNECTORS_CONFIG';
/** DI token for the telemetry group. */
export const TELEMETRY_CONFIG = 'TELEMETRY_CONFIG';
/** DI token for the legacy Turso group. */
export const TURSO_CONFIG = 'TURSO_CONFIG';
/** DI token for the misc/bootstrap group. */
export const MISC_CONFIG = 'MISC_CONFIG';
/** DI token for the TEMPORARY intent-rollout group. */
export const INTENT_CONFIG = 'INTENT_CONFIG';

/** Thrown with one line per bad or missing variable, each naming the variable. */
export class AppConfigError extends Error {
  constructor(public readonly lines: string[]) {
    super(`Invalid server configuration:\n${lines.join('\n')}`);
    this.name = 'AppConfigError';
  }
}

const optionalString = z.string().optional();

const MEMBER_ROLES = Object.values(WorkspaceMemberRole) as string[];

/** `INTENT_ROLES` entries: comma-separated, trimmed, blanks dropped, duplicates kept once. */
function intentRoleEntries(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Raw shape. Tuning knobs that their owning module already parses and
 * range-checks (with its own error message) stay raw strings here and keep
 * being parsed at that site — this schema moves the *read*, not the policy.
 */
const RawEnvSchema = z.object({
  // storage / graph
  R2_ENDPOINT: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  R2_BUCKET: optionalString,
  R2_REGION: optionalString,
  R2_FORCE_PATH_STYLE: optionalString,
  GRAPH_FILE_CACHE_DIR: optionalString,
  GRAPH_FILE_CACHE_MAX_OPEN_HANDLES: optionalString,
  GRAPH_FILE_MAX_TOTAL_BUFFER_POOL_BYTES: optionalString,
  GRAPH_FILE_CACHE_MAX_BYTES: optionalString,
  GRAPH_FILE_DOWNLOAD_TIMEOUT_MS: optionalString,
  GRAPH_FILE_MAX_DB_SIZE_BYTES: optionalString,
  GRAPH_FILE_BUFFER_POOL_BYTES: optionalString,
  GRAPH_FILE_QUERY_TIMEOUT_MS: optionalString,
  GRAPH_SNAPSHOT_BUILD_ROOT: optionalString,
  GRAPH_SNAPSHOT_STORAGE_TIMEOUT_MS: optionalString,
  GRAPH_SNAPSHOT_COMPONENT_MAX_BYTES: optionalString,
  FILE_SNAPSHOT_SYNC_TIMEOUT_MS: optionalString,
  COREDOC_DB_BACKEND: optionalString,
  COREDOC_ALLOW_CYPHER: optionalString,

  // auth / WorkOS
  OAUTH_JWT_SECRET: optionalString,
  OAUTH_UPSTREAM: optionalString,
  OAUTH_ACCESS_TTL: optionalString,
  OAUTH_REFRESH_TTL: optionalString,
  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  WORKOS_API_KEY: optionalString,
  WORKOS_CLIENT_ID: optionalString,
  WORKOS_CLIENT_SECRET: optionalString,
  WORKOS_AUTHKIT_CLIENT_ID: optionalString,
  WORKOS_AUTHKIT_DOMAIN: optionalString,
  ALLOWED_EMAIL_DOMAINS: optionalString,
  SERVER_ENCRYPTION_KEY: optionalString,
  WEB_ORIGINS: optionalString,
  SERVER_URL: optionalString,
  MCP_SERVER_URL: optionalString,
  DESKTOP_RELEASES_URL: optionalString,

  // workers + retention
  PUSH_WORKER_ENABLED: optionalString,
  PUSH_WORKER_CONCURRENCY: optionalString,
  PUSH_WORKER_POLL_INTERVAL_MS: optionalString,
  MCP_METRICS_RETENTION_ENABLED: optionalString,
  MCP_METRICS_RETENTION_DAYS: optionalString,
  CAPTURE_FINE_RETENTION_ENABLED: optionalString,
  CAPTURE_FINE_RETENTION_DAYS: optionalString,
  INTENT_MUTATION_RETENTION_ENABLED: optionalString,
  INTENT_MUTATION_RETENTION_DAYS: optionalString,
  DELIVERY_SYNC_ENABLED: optionalString,
  DELIVERY_RAW_RETENTION_DAYS: optionalString,
  AGENT_RUN_RETENTION_ENABLED: optionalString,

  // delivery connectors
  GITHUB_TOKEN: optionalString,
  GITLAB_TOKEN: optionalString,

  // telemetry
  COREDOC_POSTHOG_KEY: optionalString,
  COREDOC_POSTHOG_HOST: optionalString,

  // Turso — legacy data plane, kept for not-yet-migrated workspaces only.
  TURSO_ORG: optionalString,
  TURSO_ORG_TOKEN: optionalString,

  // misc / bootstrap
  PROCESS_ROLE: optionalString,
  DATABASE_URL: optionalString,
  NODE_ENV: optionalString,
  ENVIRONMENT: optionalString,
  PORT: optionalString,
  WEB_DIST_PATH: optionalString,
  ENABLE_CLI_BUNDLE: optionalString,
  ENABLE_SOURCE_MODULE: optionalString,
  COREDOC_LICENSE_FILE: optionalString,

  // intent rollout — TEMPORARY, see IntentConfig
  INTENT_ROLES: optionalString.superRefine((value, ctx) => {
    const unknown = intentRoleEntries(value).filter((entry) => !MEMBER_ROLES.includes(entry));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          `unknown workspace role ${unknown.map((entry) => `'${entry}'`).join(', ')}; ` +
          `expected a comma-separated list of ${MEMBER_ROLES.join(', ')}`,
      });
    }
  }),
});

export interface R2Config {
  /** Unset selects the local-filesystem fallback (`.r2-local/`). */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Former default at `database/r2-storage.service.ts`. */
  bucket: string;
  /** Former default at `database/r2-storage.service.ts`. */
  region: string;
  /** Exact literal: only `'true'` enables path-style addressing. */
  forcePathStyle: boolean;
}

/** Raw, still-unparsed tuning knobs for the workspace graph-file cache. */
export interface GraphFileConfig {
  cacheDir?: string;
  maxOpenHandles?: string;
  maxTotalBufferPoolBytes?: string;
  maxCacheBytes?: string;
  downloadTimeoutMs?: string;
  maxDbSizeBytes?: string;
  bufferPoolBytes?: string;
  queryTimeoutMs?: string;
}

export interface GraphSnapshotConfig {
  buildRoot?: string;
  storageTimeoutMs?: string;
  componentMaxBytes?: string;
}

export interface StorageConfig {
  r2: R2Config;
  graphFile: GraphFileConfig;
  graphSnapshot: GraphSnapshotConfig;
  /** Raw; `modules/job-queue/push-queue.service.ts` bounds it. */
  fileSnapshotSyncTimeoutMs?: string;
  /** Former default `''`; only the literal lowercased `neo4j` selects Neo4j. */
  dbBackend: string;
  /** Exact literal: only `'true'` opens the operator opt-in. */
  allowCypher: boolean;
}

/**
 * WorkOS credentials stay raw: every site trims them itself and treats a
 * whitespace-only value as missing, and the two that require them
 * (`resolveUpstream`, `WorkOSInvitationsService`) name the missing ones in their
 * own message. This schema does not repeat those checks — see the header rule.
 */
export interface WorkOSConfig {
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  authkitClientId?: string;
  authkitDomain?: string;
}

export interface AuthConfig {
  /** Required for the API role — `McpAuthModule.forRoot()` refuses a short one. */
  jwtSecret: string;
  /**
   * Trimmed and lower-cased once, here, because three sites did it identically.
   * Empty means unset: `resolveUpstream` still reads that as `github`, which is
   * what keeps an on-prem `OAUTH_UPSTREAM=` bootable.
   */
  upstream: string;
  /** Former default at `auth/oauth/oauth.module.ts` / `auth/web/web-auth.service.ts`. */
  accessTtl: string;
  /** Former default at `auth/oauth/oauth.module.ts` / `auth/web/web-auth.service.ts`. */
  refreshTtl: string;
  /** Former default `''` at `auth/oauth/oauth-upstream.ts`. */
  githubClientId: string;
  /** Former default `''` at `auth/oauth/oauth-upstream.ts`. */
  githubClientSecret: string;
  workos: WorkOSConfig;
  /** Raw CSV; `parseCsv` at the site decides what an entry is. */
  allowedEmailDomains?: string;
  /** Optional: absent means tokens are stored without an encrypted copy. */
  serverEncryptionKey?: string;
  /** Former default `''` at `auth/oauth/server-url.ts`. */
  webOrigins: string;
  serverUrl?: string;
  mcpServerUrl?: string;
  desktopReleasesUrl?: string;
}

function toAuth(raw: z.infer<typeof RawEnvSchema>): AuthConfig {
  return {
    jwtSecret: raw.OAUTH_JWT_SECRET ?? '',
    upstream: (raw.OAUTH_UPSTREAM ?? '').trim().toLowerCase(),
    accessTtl: raw.OAUTH_ACCESS_TTL ?? '1d',
    refreshTtl: raw.OAUTH_REFRESH_TTL ?? '30d',
    githubClientId: raw.GITHUB_CLIENT_ID ?? '',
    githubClientSecret: raw.GITHUB_CLIENT_SECRET ?? '',
    workos: {
      apiKey: raw.WORKOS_API_KEY,
      clientId: raw.WORKOS_CLIENT_ID,
      clientSecret: raw.WORKOS_CLIENT_SECRET,
      authkitClientId: raw.WORKOS_AUTHKIT_CLIENT_ID,
      authkitDomain: raw.WORKOS_AUTHKIT_DOMAIN,
    },
    allowedEmailDomains: raw.ALLOWED_EMAIL_DOMAINS,
    serverEncryptionKey: raw.SERVER_ENCRYPTION_KEY,
    webOrigins: raw.WEB_ORIGINS ?? '',
    serverUrl: raw.SERVER_URL,
    mcpServerUrl: raw.MCP_SERVER_URL,
    desktopReleasesUrl: raw.DESKTOP_RELEASES_URL,
  };
}

/**
 * The retention sweeps' kill-switches and windows, RAW.
 *
 * `libs/retention.ts` owns the vocabulary and states why it is exact — a
 * deployment carrying `MCP_METRICS_RETENTION_ENABLED=0` must keep meaning
 * "enabled". Nothing here coerces, trims or case-folds; the raw string is
 * handed to `parseRetentionFlag` / `parseRetentionDays` unchanged.
 */
export interface RetentionConfig {
  mcpMetricsEnabled?: string;
  mcpMetricsDays?: string;
  captureFineEnabled?: string;
  captureFineDays?: string;
  intentMutationEnabled?: string;
  intentMutationDays?: string;
  deliverySyncEnabled?: string;
  deliveryRawDays?: string;
  /** Cloud agent runs' machine-derived data (events, turns, state archives); default on. */
  agentRunsEnabled?: string;
}

export interface WorkersConfig {
  /** Exact literal: only `'false'` stops the push worker. Raw on purpose. */
  pushWorkerEnabled?: string;
  /** Raw; `push-worker.service.ts` parses and logs its own fallback. */
  pushWorkerConcurrency?: string;
  /** Raw; `push-worker.service.ts` parses and logs its own fallback. */
  pushWorkerPollIntervalMs?: string;
  retention: RetentionConfig;
}

export interface ConnectorsConfig {
  githubToken?: string;
  gitlabToken?: string;
}

export interface TelemetryConfig {
  posthogKey?: string;
  posthogHost?: string;
}

/** Legacy Turso data plane. Not used by new workspaces; see CLAUDE.md. */
export interface TursoLegacyConfig {
  org?: string;
  orgToken?: string;
}

export interface MiscConfig {
  /** Raw; `parseProcessRole` still validates it at the bootstrap boundary. */
  processRole?: string;
  /**
   * Optional: `PrismaService.onModuleInit` warns and runs without a connection
   * when it is unset, so making it boot-required here would be a new failure.
   */
  databaseUrl?: string;
  /** Raw; compared to the literal 'development' / 'production'. */
  nodeEnv?: string;
  /** Raw; compared to the literal 'development' / 'production'. */
  environment?: string;
  /** Raw; `main.ts` and `web-auth.service.ts` keep their 3000 fallback. */
  port?: string;
  webDistPath?: string;
  /** Exact literal: only `'true'` mounts the module. */
  enableCliBundle: boolean;
  /** Exact literal: only `'true'` mounts the module. */
  enableSourceModule: boolean;
  /** Raw; `LicenseService` treats a whitespace-only value as unset. */
  licenseFile?: string;
}

/**
 * TEMPORARY role-limited intent rollout (`INTENT_ROLES`): product roles fill in
 * and verify intent before developers see it. Once intent is on for every role,
 * delete this group, the variable and `modules/intent/intent-rollout.ts`, which
 * holds the rule.
 *
 * `rolloutRoles` unset (the variable unset or blank) is today's behaviour: the
 * workspace's `intentEnabled` alone decides. Set, intent counts as enabled for
 * an actor only when the workspace has it on AND the actor's role in that
 * workspace is listed. An unknown role name fails boot.
 */
export interface IntentConfig {
  rolloutRoles?: readonly WorkspaceMemberRole[];
}

export interface AppConfig {
  role: ProcessRole;
  storage: StorageConfig;
  auth: AuthConfig;
  workers: WorkersConfig;
  connectors: ConnectorsConfig;
  telemetry: TelemetryConfig;
  turso: TursoLegacyConfig;
  misc: MiscConfig;
  intent: IntentConfig;
}

function toIntent(raw: z.infer<typeof RawEnvSchema>): IntentConfig {
  // Already validated by the schema: every entry is a member role.
  const roles = intentRoleEntries(raw.INTENT_ROLES) as WorkspaceMemberRole[];
  return roles.length > 0 ? { rolloutRoles: roles } : {};
}

function toMisc(raw: z.infer<typeof RawEnvSchema>): MiscConfig {
  return {
    processRole: raw.PROCESS_ROLE,
    databaseUrl: raw.DATABASE_URL,
    nodeEnv: raw.NODE_ENV,
    environment: raw.ENVIRONMENT,
    port: raw.PORT,
    webDistPath: raw.WEB_DIST_PATH,
    enableCliBundle: raw.ENABLE_CLI_BUNDLE === 'true',
    enableSourceModule: raw.ENABLE_SOURCE_MODULE === 'true',
    licenseFile: raw.COREDOC_LICENSE_FILE,
  };
}

function toWorkers(raw: z.infer<typeof RawEnvSchema>): WorkersConfig {
  return {
    pushWorkerEnabled: raw.PUSH_WORKER_ENABLED,
    pushWorkerConcurrency: raw.PUSH_WORKER_CONCURRENCY,
    pushWorkerPollIntervalMs: raw.PUSH_WORKER_POLL_INTERVAL_MS,
    retention: {
      mcpMetricsEnabled: raw.MCP_METRICS_RETENTION_ENABLED,
      mcpMetricsDays: raw.MCP_METRICS_RETENTION_DAYS,
      captureFineEnabled: raw.CAPTURE_FINE_RETENTION_ENABLED,
      captureFineDays: raw.CAPTURE_FINE_RETENTION_DAYS,
      intentMutationEnabled: raw.INTENT_MUTATION_RETENTION_ENABLED,
      intentMutationDays: raw.INTENT_MUTATION_RETENTION_DAYS,
      deliverySyncEnabled: raw.DELIVERY_SYNC_ENABLED,
      deliveryRawDays: raw.DELIVERY_RAW_RETENTION_DAYS,
      agentRunsEnabled: raw.AGENT_RUN_RETENTION_ENABLED,
    },
  };
}

function toStorage(raw: z.infer<typeof RawEnvSchema>): StorageConfig {
  return {
    r2: {
      endpoint: raw.R2_ENDPOINT,
      accessKeyId: raw.R2_ACCESS_KEY_ID,
      secretAccessKey: raw.R2_SECRET_ACCESS_KEY,
      bucket: raw.R2_BUCKET ?? 'coredoc-parsers',
      region: raw.R2_REGION ?? 'auto',
      forcePathStyle: raw.R2_FORCE_PATH_STYLE === 'true',
    },
    graphFile: {
      cacheDir: raw.GRAPH_FILE_CACHE_DIR,
      maxOpenHandles: raw.GRAPH_FILE_CACHE_MAX_OPEN_HANDLES,
      maxTotalBufferPoolBytes: raw.GRAPH_FILE_MAX_TOTAL_BUFFER_POOL_BYTES,
      maxCacheBytes: raw.GRAPH_FILE_CACHE_MAX_BYTES,
      downloadTimeoutMs: raw.GRAPH_FILE_DOWNLOAD_TIMEOUT_MS,
      maxDbSizeBytes: raw.GRAPH_FILE_MAX_DB_SIZE_BYTES,
      bufferPoolBytes: raw.GRAPH_FILE_BUFFER_POOL_BYTES,
      queryTimeoutMs: raw.GRAPH_FILE_QUERY_TIMEOUT_MS,
    },
    graphSnapshot: {
      buildRoot: raw.GRAPH_SNAPSHOT_BUILD_ROOT,
      storageTimeoutMs: raw.GRAPH_SNAPSHOT_STORAGE_TIMEOUT_MS,
      componentMaxBytes: raw.GRAPH_SNAPSHOT_COMPONENT_MAX_BYTES,
    },
    fileSnapshotSyncTimeoutMs: raw.FILE_SNAPSHOT_SYNC_TIMEOUT_MS,
    dbBackend: raw.COREDOC_DB_BACKEND ?? '',
    allowCypher: raw.COREDOC_ALLOW_CYPHER === 'true',
  };
}

/** Vars the API graph refuses to boot without. The worker graph needs none of them. */
function apiRequirements(raw: z.infer<typeof RawEnvSchema>): string[] {
  const secret = raw.OAUTH_JWT_SECRET ?? '';
  if (!secret) return ['OAUTH_JWT_SECRET: required for the api role (the OAuth server signs access tokens with it)'];
  if (secret.length < 32) return ['OAUTH_JWT_SECRET: must be at least 32 characters'];
  return [];
}

/**
 * Validate `env` for `role` and return the grouped config.
 *
 * `role` defaults to `PROCESS_ROLE` so a standalone call matches what `main.ts`
 * would boot; each app root passes its own role explicitly.
 */
export function loadAppConfig(
  env: NodeJS.ProcessEnv,
  role: ProcessRole = parseProcessRole(env.PROCESS_ROLE),
): AppConfig {
  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new AppConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`));
  }
  const raw = parsed.data;
  const missing = role === 'worker' ? [] : apiRequirements(raw);
  if (missing.length > 0) throw new AppConfigError(missing);

  return {
    role,
    storage: toStorage(raw),
    auth: toAuth(raw),
    workers: toWorkers(raw),
    connectors: { githubToken: raw.GITHUB_TOKEN, gitlabToken: raw.GITLAB_TOKEN },
    telemetry: { posthogKey: raw.COREDOC_POSTHOG_KEY, posthogHost: raw.COREDOC_POSTHOG_HOST },
    turso: { org: raw.TURSO_ORG, orgToken: raw.TURSO_ORG_TOKEN },
    misc: toMisc(raw),
    intent: toIntent(raw),
  };
}

/**
 * The ambient-environment fallback for construction-time defaults in services
 * that are also instantiated directly by unit tests (`new R2StorageService()`).
 * Under Nest the boot-validated config is injected instead. Keeping the
 * `process.env` read in this file is what lets `no-process-env.test.ts` hold.
 *
 * Loaded as the `worker` role on purpose: a storage consumer must never fail
 * because an unrelated group (auth) is unset in the process that constructs it.
 */
export function storageConfigFromEnv(): StorageConfig {
  return loadAppConfig(process.env, 'worker').storage;
}

/**
 * The auth group read from the ambient environment.
 *
 * Several auth readers are not providers at all: `resolveUpstream` and
 * `buildGitHubProvider` run while `OAuthModule`'s imports array is built, before
 * DI exists, and `serverUrl()` is deliberately read live per request (a test
 * changes `SERVER_URL` between two calls and expects the second to follow). They
 * take this as a default argument, which keeps both properties while leaving
 * this file as the only place `process.env` is touched.
 */
export function authConfigFromEnv(): AuthConfig {
  return loadAppConfig(process.env, 'worker').auth;
}

/** The workers + retention group read from the ambient environment. */
export function workersConfigFromEnv(): WorkersConfig {
  return loadAppConfig(process.env, 'worker').workers;
}

/** The delivery-connector group read from the ambient environment. */
export function connectorsConfigFromEnv(): ConnectorsConfig {
  return loadAppConfig(process.env, 'worker').connectors;
}

/** The telemetry group read from the ambient environment. */
export function telemetryConfigFromEnv(): TelemetryConfig {
  return loadAppConfig(process.env, 'worker').telemetry;
}

/** The legacy Turso group read from the ambient environment. */
export function tursoConfigFromEnv(): TursoLegacyConfig {
  return loadAppConfig(process.env, 'worker').turso;
}

/**
 * The boot gate `main.ts` runs before it imports an app root: an app root's own
 * modules execute top-level side effects while being imported (the OAuth store
 * opens a Prisma client), and a misconfigured deployment should hear about the
 * variable rather than about the side effect.
 */
export function assertAppConfigValid(role: ProcessRole): void {
  loadAppConfig(process.env, role);
}

/** The misc/bootstrap group read from the ambient environment. */
export function miscConfigFromEnv(): MiscConfig {
  return loadAppConfig(process.env, 'worker').misc;
}

/** The TEMPORARY intent-rollout group read from the ambient environment. */
export function intentConfigFromEnv(): IntentConfig {
  return loadAppConfig(process.env, 'worker').intent;
}
