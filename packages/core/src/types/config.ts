/**
 * Coredoc Parser Configuration Types
 */

import { RepoType } from './output.js';

// =============================================================================
// Main Configuration
// =============================================================================

export interface CoredocConfig {
  /** Schema version for config validation */
  $schema?: string;

  /** Configuration version */
  version: '2.0';

  /** Projects containing grouped repositories */
  projects: ProjectConfig[];

  /** Global shared packages (fallback for projects without their own) */
  sharedPackages?: SharedPackageConfig[];

  /** Output configuration */
  output: OutputConfig;

  /** Directory to store generated parsers */
  parserStorage: string;

  /** Global exclude patterns */
  exclude?: string[];
}

// =============================================================================
// Project Configuration
// =============================================================================

export interface ProjectConfig {
  /**
   * Stable identifier for this project, used as a folder name on disk
   * (parser storage, output dir). Generated once at project creation by
   * slugifying `name`. Survives `name` renames.
   *
   * Required for v2.0 configs. Migration backfills this field for older
   * configs that predate workspace-scoped layouts.
   */
  id: string;

  /** Project display name (free-form, may contain spaces and casing) */
  name: string;

  /** Whether the setup wizard has been completed */
  wizardCompleted?: boolean;

  /** Whether the "graph ready" modal has been dismissed for this project */
  graphReadyModalShown?: boolean;

  /** Repositories belonging to this project */
  repos: RepoConfig[];

  /** Project-scoped shared packages for cross-service resolution */
  sharedPackages?: SharedPackageConfig[];

  /**
   * Cross-service mapper tuning. When `coredoc-parsers/<projectId>/mapper.json`
   * exists, the push pipeline runs the mapper engine instead of the legacy
   * heuristic resolver and compares the resulting resolution rate against the
   * baseline recorded in `mapper.meta.json`. If the rate drops by more than
   * `driftThreshold` (default 0.05), a drift warning is emitted.
   */
  mapper?: {
    /** Maximum allowed drop in resolution rate before warning (default 0.05) */
    driftThreshold?: number;
  };

  /**
   * Cloud workspace linkage written by `coredoc sync`.
   * Absent when the project has never been synced to cloud.
   */
  cloud?: CloudSyncState;
}

/**
 * Cloud workspace state for a local project. Written by `coredoc sync` and
 * read by the desktop's workspace-manager to find the local project that
 * owns a given cloud workspace.
 */
export interface CloudSyncState {
  /** True once the project has been linked to a cloud workspace. */
  enabled: boolean;
  /** Cloud workspace id this project syncs to. */
  workspaceId?: string;
  /** ISO timestamp of the last fully-successful sync (no failed repos). */
  lastSyncedAt?: string;
  /**
   * Reserved for future per-repo delta tracking. Not written in v1 —
   * delta detection currently uses server-side `/state` instead.
   */
  syncedRepos?: Record<string, { hash: string; syncedAt: string }>;
}

// =============================================================================
// Repository Configuration
// =============================================================================

export interface RepoConfig {
  /** Unique identifier for this repo */
  name: string;

  /**
   * Canonical identity key for this repo.
   * Used for stable ID hashing instead of filesystem path.
   * When absent, defaults to repo name.
   */
  key?: string;

  /** Path to repository root (relative to config file or absolute) */
  path: string;

  /** Repository type (optional — omit for repos that span multiple types) */
  type?: RepoType;

  /**
   * Name of another repo with similar architecture.
   * Parser will be reused and extended if needed.
   */
  similarTo?: string;

  /** Repo-specific exclude patterns */
  exclude?: string[];

  /** Override global output directory for this repo */
  outputDir?: string;

  /** Custom metadata */
  metadata?: Record<string, unknown>;

  /** Framework hints (helps agent generate better parser) */
  frameworkHints?: FrameworkHints;

  /** Per-package overrides for monorepo workspace detection */
  workspaceOverrides?: WorkspaceOverrideConfig[];

  /**
   * URL prefix at which this repo's HTTP entrypoints are exposed externally.
   * Used by the cross-repo resolver to bridge calls from clients that issue
   * unprefixed paths (e.g. a UI that writes `/foo` but actually hits
   * `/v3/public/api-gateway/foo` at runtime because the prefix lives in a
   * config constant the parser couldn't statically resolve).
   *
   * When set, the resolver indexes each HTTP entrypoint under BOTH its raw
   * fullPath AND a stripped-prefix variant, so unprefixed UI calls can find
   * the gateway entry. Should match the literal prefix that prepends the
   * controller routes (e.g. `/v3/public/api-gateway`, `/api`, `/v1`).
   *
   * Leave undefined for repos whose entrypoints are consumed via fully
   * qualified URLs or via SDK calls (no URL drift between caller and target).
   *
   * @example "/v3/public/api-gateway"
   */
  httpPrefix?: string;

  /**
   * Marks this repo as an in-workspace SDK SOURCE: the published package(s) whose
   * client methods seed the cross-repo `sdkMappings` fallback table. Each exported
   * client method (tagged with one of these package monikers) whose captured egress
   * is an HTTP route becomes one `sdkMapping` row when `coredoc mapper gen-sdk-mappings`
   * regenerates the table from this repo's parsed egress.
   *
   * Leave undefined for ordinary consumer/gateway repos. The package names are
   * client-specific DATA (not inlined into shared code); the generator is generic.
   *
   * @example ["@sample/management-api-client"]
   */
  sdkSourcePackages?: string[];
}

export interface WorkspaceOverrideConfig {
  /** Glob or exact path, relative to repo root */
  path: string;
  /** Override auto-detected type */
  type?: RepoType;
  /** Override detected language */
  language?: string;
  /** Framework hints for this package */
  frameworkHints?: FrameworkHints;
  /** Patterns to exclude */
  exclude?: string[];
}

export interface FrameworkHints {
  /** Primary language */
  language?: string;
  /** Frameworks/libraries used */
  frameworks?: string[];
  /** ORM if any */
  orm?: string;
  /** API style */
  apiStyle?: 'rest' | 'graphql' | 'grpc' | 'mixed';
  /** State management (frontend) */
  stateManagement?: string;
  /** Testing framework */
  testFramework?: string;
}

// =============================================================================
// Shared Package Configuration
// =============================================================================

export interface SharedPackageConfig {
  /** Package name */
  name: string;

  /** Path to package */
  path: string;

  /** Package type */
  type?: 'schemas' | 'types' | 'utils' | 'sdk' | 'other';

  /** Description for agent context */
  description?: string;

  /**
   * For SDK packages: maps client class names to target repo names.
   * Used by the cross-repo resolver to map SDK calls to their target services.
   * @example { "Core": "core", "Shifts": "shifts", "Schedules": "schedules" }
   */
  clientMappings?: Record<string, string>;
}

// =============================================================================
// Output Configuration
// =============================================================================

export interface OutputConfig {
  /** Output directory */
  dir: string;

  /** Output format (currently only json) */
  format: 'json';

  /** Pretty print JSON */
  prettyPrint?: boolean;
}

// =============================================================================
// Parser Metadata (stored alongside generated parsers)
// =============================================================================

export interface ParserMetadata {
  /** Parser ID */
  id: string;

  /** Parser version (incremented on updates) */
  version: number;

  /** Created timestamp */
  createdAt: string;

  /** Last updated timestamp */
  updatedAt: string;

  /** Repos this parser is used for */
  targetRepos: string[];

  /** Detected language */
  language: string;

  /** Detected frameworks */
  frameworks: string[];

  /** Parser capabilities */
  capabilities: ParserCapabilities;

  /** Test results from validation */
  validation: ParserValidation;

  /** Agent conversation ID (for debugging) */
  agentConversationId?: string;
}

export interface ParserCapabilities {
  /** Can parse functions */
  functions: boolean;
  /** Can parse classes */
  classes: boolean;
  /** Can parse interfaces/types */
  types: boolean;
  /** Entrypoint types supported */
  entrypoints: string[];
  /** Can parse DB entities */
  entities: boolean;
  /** Can parse DB operations */
  dbOperations: boolean;
  /** Can parse external calls */
  externalCalls: boolean;
  /** Can parse components (frontend) */
  components: boolean;
  /** Can parse routes (frontend) */
  routes: boolean;
  /** Can parse state stores (frontend) */
  stateStores: boolean;
}

export interface ParserValidation {
  /** Overall pass/fail */
  passed: boolean;

  /** Coverage percentage achieved */
  coveragePercent: number;

  /** Test results */
  tests: ParserTestResult[];

  /** Validation timestamp */
  validatedAt: string;
}

export interface ParserTestResult {
  /** Test name */
  name: string;

  /** Test passed */
  passed: boolean;

  /** Expected vs actual (if failed) */
  expected?: unknown;
  actual?: unknown;

  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Runtime Configuration (computed at runtime)
// =============================================================================

export interface RuntimeConfig extends CoredocConfig {
  /** Absolute path to config file */
  configPath: string;

  /** Absolute path to config directory */
  configDir: string;

  /**
   * Resolved repo paths (absolute), keyed by `${projectId}/${repoName}`.
   * Use `repoRefKey()` from `@coredoc/core/utils/repo-ref` to construct
   * the key — never inline the template literal.
   */
  resolvedRepoPaths: Map<string, string>;

  /** Resolved output directory (absolute) */
  resolvedOutputDir: string;

  /** Resolved parser storage (absolute) */
  resolvedParserStorage: string;
}
