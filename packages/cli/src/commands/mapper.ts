/**
 * `coredoc mapper validate` — verifies a mapper.json against the v1 Zod schema
 * defined in @coredoc/core. Pure I/O wrapper around `validateMapper` so the
 * logic stays testable without spinning up Commander.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  validateMapper,
  checkMapperSemantics,
  pickMapperSchemaVersion,
  normalizeServiceName,
  readMapperMeta,
  writeMapperMeta,
  mapperPathsForProject,
  linkWorkspace,
  sliceParsedRepoByTarget,
  type MapperMeta,
  type MapperValidationError,
  type Mapper,
  type ParsedRepo,
  type ParsedRepoLike,
  type SdkMapping,
  type ServiceEntry,
  type PathRewriteRule,
  type HttpEntrypointDetails,
} from '@coredoc/core';
import {
  generateSdkMappings,
  providerForExport,
  type ExtractionProfile,
  type SdkSource,
} from '@coredoc/profile-parser';
import { JOB_STILL_RUNNING_CODE, parseStructuredServerError } from '../structured-error.js';

/**
 * Map loaded `ParsedRepo`s onto the linker's `ParsedRepoLike` input, slicing each
 * repo into one `ParsedRepoLike` per profile target exactly as the live push does
 * (`push/cross-repo.ts`): per-repo mapper service entries + the repo's gateway
 * prefix flow into `sliceParsedRepoByTarget`. A single-target repo yields exactly
 * one slice, byte-identical to the un-sliced repoLike (slicer passthrough), so
 * existing single-repo baselines are unchanged; a multi-target monorepo yields one
 * slice per target so the captured baseline counts intra-repo ui→backend edges the
 * push resolves — keeping the drift baseline and suggest under the exact same
 * semantics as a real push (including `functions`, which feeds the SDK moniker
 * symbol hop in `linkWorkspace`).
 */
function toParsedRepoLikes(
  repos: ParsedRepo[],
  repoPrefixes: Record<string, string>,
  services: readonly ServiceEntry[] = [],
): ParsedRepoLike[] {
  return repos.flatMap((r) => {
    const serviceEntries = services.filter((s) => s.repo === r.name);
    return sliceParsedRepoByTarget(r, serviceEntries, repoPrefixes[r.name]).map((slice) => slice.repoLike);
  });
}

export interface MapperValidateOptions {
  mapperPath: string;
  /**
   * When supplied together with `projectId`, the semantic sweep loads the
   * project's parsed output from here to run the stale-target warning (spec §4.3c).
   */
  outputDir?: string;
  projectId?: string;
  /**
   * repo name → `RepoConfig.httpPrefix` from config, enabling the httpPrefix
   * config cross-check warning (spec §4.3d). Omit to skip that check.
   */
  repoHttpPrefixes?: Record<string, string | undefined>;
}

export type MapperValidateResult =
  | { ok: true; warnings: MapperValidationError[] }
  | { ok: false; errors: MapperValidationError[]; warnings: MapperValidationError[] };

/** Build repo → set of FileNode.target values from parsed output for the stale-target check. */
function loadTargetsByRepo(outputDir: string, projectId: string): Record<string, Set<string>> {
  const byRepo: Record<string, Set<string>> = {};
  // Never parsed yet (directory absent) is benign — the stale-target check simply
  // does not run. Any OTHER failure (corrupt JSON, permissions) must be surfaced,
  // not silently swallowed, or `validate` reports "valid" while the §4.3c
  // stale-target sweep never actually ran.
  if (!fs.existsSync(path.join(outputDir, projectId))) return byRepo;
  let repos: ParsedRepo[];
  try {
    repos = loadProjectParsedRepos(outputDir, projectId);
  } catch (err) {
    console.warn(`  mapper: skipped stale-target check — could not load parsed output: ${(err as Error).message}`);
    return byRepo;
  }
  for (const r of repos) {
    const set = new Set<string>();
    for (const f of r.files ?? []) {
      if (f.target) set.add(f.target);
    }
    byRepo[r.name] = set;
  }
  return byRepo;
}

export function runMapperValidate(options: MapperValidateOptions): MapperValidateResult {
  if (!fs.existsSync(options.mapperPath)) {
    return {
      ok: false,
      errors: [{ path: [], message: `Mapper file not found: ${options.mapperPath}` }],
      warnings: [],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(options.mapperPath, 'utf-8'));
  } catch (e) {
    return {
      ok: false,
      errors: [{ path: [], message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }],
      warnings: [],
    };
  }

  const v = validateMapper(raw);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: [] };

  // Schema passed — run the cross-field / cross-artifact semantic sweep (§4.3).
  const targetsByRepo =
    options.outputDir && options.projectId ? loadTargetsByRepo(options.outputDir, options.projectId) : undefined;
  const { errors, warnings } = checkMapperSemantics(v.mapper, {
    targetsByRepo,
    repoHttpPrefixes: options.repoHttpPrefixes,
  });
  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, warnings };
}

export function printValidateResult(result: MapperValidateResult, mapperPath: string): void {
  const printWarnings = () => {
    for (const w of result.warnings) {
      const prefix = w.path.length > 0 ? `${w.path.join('.')}: ` : '';
      console.warn(`  ⚠ ${prefix}${w.message}`);
    }
  };
  if (result.ok) {
    console.log(`✓ ${mapperPath} is valid`);
    if (result.warnings.length > 0) {
      console.warn(`  ${result.warnings.length} warning(s):`);
      printWarnings();
    }
    return;
  }
  console.error(`✗ ${mapperPath} has ${result.errors.length} error(s):`);
  for (const e of result.errors) {
    const prefix = e.path.length > 0 ? `${e.path.join('.')}: ` : '';
    console.error(`  • ${prefix}${e.message}`);
  }
  if (result.warnings.length > 0) {
    console.warn(`  ${result.warnings.length} warning(s):`);
    printWarnings();
  }
}

// =============================================================================
// `coredoc mapper status` — surface counts and baseline metadata so users can
// tell at a glance whether the mapper is fresh, drifting, or hand-written.
// Read-only.
// =============================================================================

export interface MapperStatusOptions {
  mapperPath: string;
  mapperMetaPath: string;
}

export type MapperStatusResult =
  | { exists: false }
  | {
      exists: true;
      mapperPath: string;
      project: string;
      counts: {
        services: number;
        sdkMappings: number;
        aliases: number;
        pathRewriteRules: number;
        unresolvable: number;
      };
      meta: MapperMeta | null;
    };

export function runMapperStatus(options: MapperStatusOptions): MapperStatusResult {
  if (!fs.existsSync(options.mapperPath)) return { exists: false };
  const parsed = JSON.parse(fs.readFileSync(options.mapperPath, 'utf-8'));
  const v = validateMapper(parsed);
  if (!v.ok) {
    throw new Error(
      `mapper.json at ${options.mapperPath} is not valid (run \`coredoc mapper validate\` to see details)`,
    );
  }
  const mapper = v.mapper;
  const aliases = mapper.services.reduce((sum, s) => sum + s.aliases.length, 0);
  return {
    exists: true,
    mapperPath: options.mapperPath,
    project: mapper.project,
    counts: {
      services: mapper.services.length,
      sdkMappings: mapper.sdkMappings.length,
      aliases,
      pathRewriteRules: mapper.pathRewriteRules.length,
      unresolvable: mapper.unresolvableServices.length,
    },
    meta: readMapperMeta(options.mapperMetaPath),
  };
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
}

export function printStatus(result: MapperStatusResult): void {
  if (!result.exists) {
    console.log('No mapper found for this project.');
    console.log('Run `coredoc mapper discover --project <id>` to auto-build one from parsed data.');
    return;
  }
  console.log(`  Project:        ${result.project}`);
  console.log(`  Mapper:         ${result.mapperPath}`);
  if (result.meta) {
    console.log(
      `  Generated:      ${result.meta.generatedAt} (${daysSince(result.meta.generatedAt)} days ago) by ${result.meta.generatedBy.model}`,
    );
    console.log(`  Baseline rate:  ${(result.meta.baselineResolutionRate * 100).toFixed(1)}%`);
  } else {
    console.log(`  Generated:      (no mapper.meta.json — hand-written mapper)`);
  }
  console.log(`  Sdk mappings:   ${result.counts.sdkMappings}`);
  console.log(`  Services:       ${result.counts.services}`);
  console.log(`  Aliases:        ${result.counts.aliases}`);
  console.log(`  Path rules:     ${result.counts.pathRewriteRules}`);
  console.log(`  Unresolvable:   ${result.counts.unresolvable}`);
}

// =============================================================================
// `coredoc mapper diff` — compare the current mapper against a baseline (by
// default the `.mapper.json.bak` snapshot left after a regen) so reviewers can
// eyeball schema changes before pushing. Both sides are validated through the
// v1 schema to avoid silently diffing malformed data.
// =============================================================================

export interface MapperDiffOptions {
  currentPath: string;
  baselinePath: string;
}

export type MapperDiffResult =
  | { ok: false; error: string }
  | {
      ok: true;
      servicesAdded: string[];
      servicesRemoved: string[];
      sdkMappingsAdded: string[];
      sdkMappingsRemoved: string[];
      sdkMappingsChanged: Array<{ key: string; before: SdkMapping; after: SdkMapping }>;
    };

function sdkKey(m: SdkMapping): string {
  return `${m.sdkPackage}::${m.sdkClass}::${m.sdkMethod}`;
}

export function runMapperDiff(options: MapperDiffOptions): MapperDiffResult {
  if (!fs.existsSync(options.currentPath)) {
    return { ok: false, error: `Current mapper not found: ${options.currentPath}` };
  }
  if (!fs.existsSync(options.baselinePath)) {
    return { ok: false, error: `Baseline mapper not found: ${options.baselinePath}` };
  }

  let currentRaw: unknown;
  let baselineRaw: unknown;
  try {
    currentRaw = JSON.parse(fs.readFileSync(options.currentPath, 'utf-8'));
  } catch (e) {
    return {
      ok: false,
      error: `Current mapper invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  try {
    baselineRaw = JSON.parse(fs.readFileSync(options.baselinePath, 'utf-8'));
  } catch (e) {
    return {
      ok: false,
      error: `Baseline mapper invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const curV = validateMapper(currentRaw);
  const baseV = validateMapper(baselineRaw);
  if (!curV.ok) {
    return { ok: false, error: `Current mapper invalid: ${curV.errors[0]?.message ?? 'unknown'}` };
  }
  if (!baseV.ok) {
    return { ok: false, error: `Baseline mapper invalid: ${baseV.errors[0]?.message ?? 'unknown'}` };
  }
  const current = curV.mapper;
  const baseline = baseV.mapper;

  const curServices = new Set(current.services.map((s) => s.name));
  const baseServices = new Set(baseline.services.map((s) => s.name));
  const servicesAdded = [...curServices].filter((s) => !baseServices.has(s));
  const servicesRemoved = [...baseServices].filter((s) => !curServices.has(s));

  const curSdkMap = new Map(current.sdkMappings.map((m) => [sdkKey(m), m]));
  const baseSdkMap = new Map(baseline.sdkMappings.map((m) => [sdkKey(m), m]));
  const sdkMappingsAdded = [...curSdkMap.keys()].filter((k) => !baseSdkMap.has(k));
  const sdkMappingsRemoved = [...baseSdkMap.keys()].filter((k) => !curSdkMap.has(k));
  const sdkMappingsChanged: Array<{ key: string; before: SdkMapping; after: SdkMapping }> = [];
  for (const [k, after] of curSdkMap) {
    const before = baseSdkMap.get(k);
    if (!before) continue;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      sdkMappingsChanged.push({ key: k, before, after });
    }
  }

  return {
    ok: true,
    servicesAdded,
    servicesRemoved,
    sdkMappingsAdded,
    sdkMappingsRemoved,
    sdkMappingsChanged,
  };
}

export function printDiff(result: MapperDiffResult): void {
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    return;
  }
  const print = (label: string, items: string[]) => {
    if (items.length === 0) return;
    console.log(`${label} (${items.length}):`);
    for (const i of items) console.log(`  ${i}`);
  };
  print('Services added', result.servicesAdded);
  print('Services removed', result.servicesRemoved);
  print('SDK mappings added', result.sdkMappingsAdded);
  print('SDK mappings removed', result.sdkMappingsRemoved);
  if (result.sdkMappingsChanged.length > 0) {
    console.log(`SDK mappings changed (${result.sdkMappingsChanged.length}):`);
    for (const c of result.sdkMappingsChanged) {
      console.log(`  ${c.key}`);
      console.log(`    before: ${JSON.stringify(c.before.http ?? c.before.targetService)}`);
      console.log(`    after:  ${JSON.stringify(c.after.http ?? c.after.targetService)}`);
    }
  }
  if (
    result.servicesAdded.length === 0 &&
    result.servicesRemoved.length === 0 &&
    result.sdkMappingsAdded.length === 0 &&
    result.sdkMappingsRemoved.length === 0 &&
    result.sdkMappingsChanged.length === 0
  ) {
    console.log('No differences.');
  }
}

// =============================================================================
// `coredoc mapper discover` — fast deterministic mapper builder.
//
// Scans parsed externalCalls' `targetDescriptor.targetService` (the
// parser-extracted hint), tallies per-service call counts, and tries to match
// each service against an existing repo via exact / prefix / substring rules.
// Writes a v1 mapper.json with the matches as service entries; reports the
// rest as either auto-marked infra (Redis/Kafka/etc) or unmatched (needs
// human review or extra repos). No LLM, no SDK source reading.
// =============================================================================

export interface DiscoverOptions {
  project: string;
  config?: string;
  /**
   * Full-rewrite mode. Default (false) MERGES into the existing mapper.json:
   * hand-edited fields on existing entries are preserved, newly discovered
   * services are added, and services whose `(repo, target)` no longer exists are
   * reported as stale but NOT deleted. `--overwrite` restores the old clobber
   * behavior (rebuild `services`/`pathRewriteRules`/`unresolvableServices` from
   * scratch). The `.mapper.json.bak` snapshot is taken in both modes.
   */
  overwrite?: boolean;
}

interface ServiceCallCounts {
  service: string;
  callCount: number;
}

interface DiscoverMatch {
  service: string;
  callCount: number;
  matchedRepo?: string;
  matchType: 'exact' | 'prefix' | 'substring' | 'none';
}

export interface DiscoverResult {
  project: string;
  mapperPath: string;
  /** Path to the per-project README. Undefined when a user-edited README already exists and was preserved. */
  readmePath?: string;
  /** Path to the snapshot of the previous mapper.json. Undefined when no prior mapper existed. */
  backupPath?: string;
  /** Path to the freshly written mapper.meta.json that records the baseline resolution rate. */
  mapperMetaPath: string;
  /** Resolution rate of the freshly built mapper (0..1), captured as the baseline for drift detection. */
  baselineResolutionRate: number;
  matched: DiscoverMatch[];
  unmatched: ServiceCallCounts[];
  unresolvableAuto: string[];
  totalCalls: number;
  sdkMappingsCount: number;
  /**
   * Merge mode only: existing services whose `(repo, target)` is no longer
   * produced by discovery. Reported for human review; never auto-deleted.
   */
  staleServices: ServiceEntry[];
  /** True when this run merged into an existing mapper (false on first run / `--overwrite`). */
  merged: boolean;
  /**
   * Generated services renamed with a numeric suffix (`svc-a-b-2`) to keep
   * `services[].name` unique after merging with existing entries. Hand-authored
   * entries are never renamed.
   */
  renamedServices: Array<{ from: string; to: string; repo: string; target?: string }>;
  /**
   * Two EXISTING (hand-authored) services collide on `services[].name` after
   * normalization. NOT auto-renamed — reported for human review; `mapper validate`
   * will fail on this until resolved by hand.
   */
  nameCollisions: Array<{ name: string; a: ServiceEntry; b: ServiceEntry }>;
}

/**
 * Minimal shape needed from the loaded coredoc config. Kept loose so tests can
 * pass a fixture without recreating every RuntimeConfig field.
 *
 * `repos[].httpPrefix` is required so the baseline resolution rate is computed
 * under the same prefix semantics that push will use at runtime — without it,
 * drift detection compares apples to oranges for projects with gateway prefixes.
 */
interface DiscoverConfigShape {
  resolvedOutputDir: string;
  resolvedParserStorage: string;
  projects: Array<{
    id: string;
    repos?: Array<{ name: string; httpPrefix?: string }>;
  }>;
}

// Generic discovery heuristics. These are NOT client-specific:
//   - KNOWN_INFRA: stack components that never live in a user repo
//   - REPO_NAME_PREFIXES: common organisational conventions where a service
//     name appears as a suffix on a repo name (e.g. `demo-core`, `@org/core`).
//     The prefix list is open-ended — users with their own conventions can
//     edit the generated mapper.json by hand.
const KNOWN_INFRA = new Set([
  'redis',
  'kafka',
  'temporal',
  'datadog',
  'sentry',
  'newrelic',
  'rabbitmq',
  'memcached',
  'elasticsearch',
  'postgres',
  'mysql',
  'mongodb',
  's3',
  'sqs',
  'sns',
  'pubsub',
  'bigquery',
]);

/**
 * Normalise a name for fuzzy matching by lowercasing and stripping separators.
 * Used so a camelCase service identifier matches a kebab-case repo name and vice versa.
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, '');
}

/** Lowercase, collapse non-alphanumerics to single dashes, trim edge dashes. */
function slugifyServiceName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Canonical identity key for merge/staleness: a service is `(repo, target ?? '')`. */
function serviceIdentityKey(s: { repo: string; target?: string }): string {
  return JSON.stringify([s.repo, s.target ?? '']);
}

interface ServiceNameCollisionResult {
  services: ServiceEntry[];
  /** Generated entries renamed with a numeric suffix to keep `services[].name` unique. */
  renamed: Array<{ from: string; to: string; repo: string; target?: string }>;
  /** Two EXISTING (hand-authored) entries collide — reported, left untouched. */
  existingCollisions: Array<{ name: string; a: ServiceEntry; b: ServiceEntry }>;
}

/**
 * Ensure `services[].name` values are unique under `normalizeServiceName` semantics
 * (the same normalizer `buildServiceRepoMap` keys its Map by). Two entries with the
 * same normalized name silently last-write-wins downstream, misrouting calls — this
 * closes that gap at the source rather than relying only on `mapper validate`.
 *
 * Only GENERATED entries (freshly discovered/added this run, per `isGenerated`) are
 * disambiguated with a numeric suffix (`svc-a-b-2`); an EXISTING (hand-authored) entry
 * is NEVER renamed. A collision between two EXISTING entries is left as-is and
 * reported — `checkMapperSemantics` flags it as an ERROR on the next validate.
 *
 * Relies on `services` being ordered existing-before-generated (true of both the merge
 * and overwrite assembly in `runMapperDiscover`) so an existing entry always claims its
 * name before any generated entry is considered for the same slot.
 */
function resolveServiceNameCollisions(
  services: ServiceEntry[],
  isGenerated: (s: ServiceEntry) => boolean,
): ServiceNameCollisionResult {
  const claimedBy = new Map<string, ServiceEntry>(); // normalized name -> claiming entry
  const renamed: ServiceNameCollisionResult['renamed'] = [];
  const existingCollisions: ServiceNameCollisionResult['existingCollisions'] = [];
  const result: ServiceEntry[] = [];

  for (const s of services) {
    const norm = normalizeServiceName(s.name);
    const holder = claimedBy.get(norm);
    if (!holder) {
      claimedBy.set(norm, s);
      result.push(s);
      continue;
    }
    if (!isGenerated(s)) {
      // Existing entry collides with an already-claimed name. Because existing
      // entries are ordered before generated ones, the holder is also existing.
      existingCollisions.push({ name: s.name, a: holder, b: s });
      result.push(s);
      continue;
    }
    // Generated entry collides — disambiguate with a numeric suffix.
    let n = 2;
    let candidate = `${s.name}-${n}`;
    while (claimedBy.has(normalizeServiceName(candidate))) {
      n += 1;
      candidate = `${s.name}-${n}`;
    }
    claimedBy.set(normalizeServiceName(candidate), s);
    renamed.push({ from: s.name, to: candidate, repo: s.repo, target: s.target });
    result.push({ ...s, name: candidate });
  }

  return { services: result, renamed, existingCollisions };
}

/**
 * Derive likely organisational prefixes from the actual repo names in this
 * project. A prefix is any leading segment ending in `-` or `/` that appears on
 * 2+ repos — that pattern signals a convention worth using for fuzzy matching
 * (e.g. project with `demo-core` + `demo-shifts` produces `['demo-']`).
 *
 * Pure data-driven. No hardcoded company / SDK / repo names in shared code.
 */
function discoverRepoPrefixes(repoNames: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of repoNames) {
    const match = name.match(/^([^-/]+[-/])/);
    if (!match || !match[1]) continue;
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([prefix]) => prefix);
}

function isParsedRepoLike(value: unknown): value is ParsedRepo {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && Array.isArray(v.entrypoints) && Array.isArray(v.externalCalls);
}

function loadProjectParsedRepos(outputDir: string, projectId: string): ParsedRepo[] {
  const projectOutputDir = path.join(outputDir, projectId);
  if (!fs.existsSync(projectOutputDir)) {
    throw new Error(`No parsed output for project ${projectId} at ${projectOutputDir}`);
  }
  const files = fs.readdirSync(projectOutputDir).filter((f) => f.endsWith('.json'));
  const repos: ParsedRepo[] = [];
  for (const f of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectOutputDir, f), 'utf-8')) as unknown;
    if (isParsedRepoLike(parsed)) {
      repos.push(parsed);
    }
  }
  return repos;
}

function matchServiceToRepo(
  service: string,
  repoNames: string[],
  prefixes: string[],
): { repo: string; type: DiscoverMatch['matchType'] } | undefined {
  const norm = normalizeForMatch(service);
  // 1. Exact match (normalised — strips dashes/underscores so camelCase matches kebab-case)
  for (const r of repoNames) {
    if (normalizeForMatch(r) === norm) return { repo: r, type: 'exact' };
  }
  // 2. Prefix variants from the project's own repo-naming convention.
  for (const prefix of prefixes) {
    const candidate = normalizeForMatch(`${prefix}${service}`);
    for (const r of repoNames) {
      if (normalizeForMatch(r) === candidate) return { repo: r, type: 'prefix' };
    }
  }
  // 3. Substring: lowercased only — substring on dash-stripped form would be too aggressive
  const lower = service.toLowerCase();
  for (const r of repoNames) {
    if (r.toLowerCase().includes(lower)) return { repo: r, type: 'substring' };
  }
  return undefined;
}

export function runMapperDiscover(loadedConfig: DiscoverConfigShape, options: DiscoverOptions): DiscoverResult {
  const project = loadedConfig.projects.find((p) => p.id === options.project);
  if (!project) {
    throw new Error(`Project '${options.project}' missing from coredoc.config.json`);
  }
  const outputDir = loadedConfig.resolvedOutputDir;
  const parserStorage = loadedConfig.resolvedParserStorage;
  if (!outputDir || !parserStorage) {
    throw new Error('Loaded config is missing resolvedOutputDir / resolvedParserStorage');
  }

  const repos = loadProjectParsedRepos(outputDir, options.project);
  const repoNames = repos.map((r) => r.name);
  const prefixes = discoverRepoPrefixes(repoNames);

  // Tally per-service call counts from the parsed externalCalls. Source of
  // truth is targetDescriptor.targetService (set by recent parsers); fall back
  // to serviceName for legacy outputs.
  const counts = new Map<string, number>();
  let totalCalls = 0;
  for (const repo of repos) {
    for (const call of repo.externalCalls ?? []) {
      totalCalls += 1;
      // Trim before bucketing — some parsers emit `serviceName: "core\n"` from
      // multi-line source extraction. Without this trim such entries bucket
      // separately from the canonical `core` and never resolve.
      const rawSvc = call.targetDescriptor?.targetService ?? call.serviceName;
      const svc = typeof rawSvc === 'string' ? rawSvc.trim() : rawSvc;
      if (!svc) continue;
      counts.set(svc, (counts.get(svc) ?? 0) + 1);
    }
  }

  const matched: DiscoverMatch[] = [];
  const unmatched: ServiceCallCounts[] = [];
  const unresolvableAuto: string[] = [];
  for (const [service, callCount] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const lower = service.toLowerCase();
    // Strip common SDK-package prefixes when matching against KNOWN_INFRA and
    // repo names, e.g. '<package>.<service>' → '<service>'.
    const stripped = lower.includes('.') ? lower.split('.').pop()! : lower;

    if (KNOWN_INFRA.has(stripped) || KNOWN_INFRA.has(lower)) {
      unresolvableAuto.push(service);
      continue;
    }
    const match = matchServiceToRepo(stripped, repoNames, prefixes) ?? matchServiceToRepo(lower, repoNames, prefixes);
    if (match) {
      matched.push({ service, callCount, matchedRepo: match.repo, matchType: match.type });
    } else {
      unmatched.push({ service, callCount });
    }
  }

  // mapperPathsForProject validates options.project against a slug pattern, so
  // every fs write below is safely scoped under parserStorage/<projectId>/.
  const paths = mapperPathsForProject(parserStorage, options.project);
  const mapperPath = paths.mapperJson;
  fs.mkdirSync(path.dirname(mapperPath), { recursive: true });

  // ---------------------------------------------------------------------------
  // Discovered services. Two synthesis strategies, split by repo:
  //   * multi-target repos (files[] carry `FileNode.target`) → one entry per
  //     distinct target `{ name, repo, target }`. The repo is NOT one service.
  //   * plain repos → today's call-based matching `{ name, repo, aliases }`,
  //     where `name` strips any SDK-package prefix so it lines up with the
  //     `targetService` recent parsers emit, keeping the prefixed form as an alias.
  // ---------------------------------------------------------------------------
  const targetsByRepo = new Map<string, string[]>();
  for (const repo of repos) {
    const set = new Set<string>();
    for (const f of repo.files ?? []) {
      if (f.target) set.add(f.target);
    }
    if (set.size > 0) targetsByRepo.set(repo.name, [...set].sort());
  }

  // A bare target name is used when it is globally unique across the target
  // proposal set; on collision (same target name in two repos) fall back to the
  // deterministic `<repo>-<target>` slug so `services[].name` stays unique.
  const targetNameCounts = new Map<string, number>();
  for (const targets of targetsByRepo.values()) {
    for (const t of targets) targetNameCounts.set(t, (targetNameCounts.get(t) ?? 0) + 1);
  }
  const targetServices: ServiceEntry[] = [];
  for (const [repo, targets] of targetsByRepo) {
    for (const t of targets) {
      const name = (targetNameCounts.get(t) ?? 0) === 1 ? t : slugifyServiceName(`${repo}-${t}`);
      targetServices.push({ name, repo, aliases: [], target: t });
    }
  }

  // Call-based entries, skipping repos already represented per-target above.
  const callBasedServices: ServiceEntry[] = matched
    .filter((m) => !targetsByRepo.has(m.matchedRepo!))
    .map((m) => {
      const canonical = m.service.includes('.') ? m.service.split('.').pop()! : m.service;
      const aliases = canonical === m.service ? [] : [m.service];
      return { name: canonical, repo: m.matchedRepo!, aliases };
    });

  const discovered: ServiceEntry[] = [...callBasedServices, ...targetServices];
  const discoveredKeys = new Set(discovered.map(serviceIdentityKey));

  // Load the existing mapper for merge mode (default). Fail fast on a corrupt
  // existing file so a hand-curated mapper is never silently clobbered. In
  // `--overwrite` mode we skip this entirely (old clobber behavior).
  let existingMapper: Mapper | undefined;
  if (!options.overwrite && fs.existsSync(mapperPath)) {
    const existingRaw: unknown = JSON.parse(fs.readFileSync(mapperPath, 'utf-8'));
    const ev = validateMapper(existingRaw);
    if (!ev.ok) {
      const first = ev.errors[0];
      throw new Error(
        `Existing mapper.json at ${mapperPath} is invalid; fix it or re-run with --overwrite to replace it. ` +
          `First error: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'}`,
      );
    }
    existingMapper = ev.mapper;
  }

  // Snapshot the previous mapper.json (both modes) so a bad merge or clobber can
  // be recovered via `coredoc mapper diff --baseline <bak>` (or by hand).
  let backupPath: string | undefined;
  if (fs.existsSync(mapperPath)) {
    fs.copyFileSync(mapperPath, paths.backup);
    backupPath = paths.backup;
  }

  // Assemble the final mapper. The override file carries no sdkMappings table by
  // default — in-workspace SDKs resolve via the substrate moniker hop and
  // published-only overrides are added by hand; discover never synthesises them.
  // Merge mode preserves any existing sdkMappings the user/pull added.
  let finalServices: ServiceEntry[];
  let finalPathRewriteRules: PathRewriteRule[];
  let finalUnresolvable: string[];
  let finalSdkMappings: SdkMapping[] | undefined;
  const staleServices: ServiceEntry[] = [];
  const merged = existingMapper !== undefined;

  if (existingMapper) {
    // Merge: keep existing entries verbatim (hand-edited name/aliases/httpPrefix
    // are never overwritten), add newly discovered services, report stale ones.
    const existingKeys = new Set(existingMapper.services.map(serviceIdentityKey));
    const mergedServices: ServiceEntry[] = [];
    for (const s of existingMapper.services) {
      mergedServices.push(s);
      if (!discoveredKeys.has(serviceIdentityKey(s))) staleServices.push(s);
    }
    for (const s of discovered) {
      if (!existingKeys.has(serviceIdentityKey(s))) mergedServices.push(s);
    }
    finalServices = mergedServices;
    finalPathRewriteRules = existingMapper.pathRewriteRules;
    // unresolvableServices: preserve the user-curated set, ADD auto names not present.
    const seenUnresolvable = new Set(existingMapper.unresolvableServices);
    finalUnresolvable = [...existingMapper.unresolvableServices];
    for (const u of unresolvableAuto) {
      if (!seenUnresolvable.has(u)) finalUnresolvable.push(u);
    }
    finalSdkMappings = existingMapper.sdkMappings.length > 0 ? existingMapper.sdkMappings : undefined;
  } else {
    // First run or `--overwrite`: full rebuild from discovery.
    finalServices = discovered;
    finalPathRewriteRules = [];
    finalUnresolvable = unresolvableAuto;
    finalSdkMappings = undefined;
  }

  // Guarantee services[].name uniqueness under normalizeServiceName before writing.
  // The <repo>-<target> slug fallback above only dedupes within the target-name
  // proposal set — it is never checked against the FULL final name space (existing
  // + call-based + target entries), so two entries could still end with the same
  // `name`. `buildServiceRepoMap` (packages/core) keys a Map by normalized name and
  // would silently last-write-wins on that, misrouting calls. Existing entries are
  // ordered first in `finalServices` in both branches above, so a hand-authored name
  // always wins the slot; only generated entries get disambiguated here.
  const existingIdentityKeys = new Set((existingMapper?.services ?? []).map(serviceIdentityKey));
  const nameCollisionResult = resolveServiceNameCollisions(
    finalServices,
    (s) => !existingIdentityKeys.has(serviceIdentityKey(s)),
  );
  finalServices = nameCollisionResult.services;

  // Build the object with a stable key order. `sdkMappings` is only emitted when
  // non-empty so the no-sdk case stays byte-identical to the historical layout.
  const mapper: Record<string, unknown> = {
    // v2 only when a service uses a v2 field (`target`/`httpPrefix`); otherwise
    // keep writing 1 — cloud round-trip stays safe until the server accepts 2.
    $schemaVersion: pickMapperSchemaVersion(finalServices),
    project: options.project,
    services: finalServices,
  };
  if (finalSdkMappings && finalSdkMappings.length > 0) mapper.sdkMappings = finalSdkMappings;
  mapper.pathRewriteRules = finalPathRewriteRules;
  mapper.unresolvableServices = finalUnresolvable;
  fs.writeFileSync(mapperPath, JSON.stringify(mapper, null, 2) + '\n');

  // Capture the resolution rate of the just-written mapper as the drift
  // baseline. Without a baseline, push-time drift detection is a dead branch.
  // We validate through the schema first because pathTemplate canonicalisation
  // happens in the Zod transform — the engine expects canonicalised templates.
  // Apply the same repoPrefixes the push pipeline uses so the baseline is
  // measured under runtime-equivalent semantics; otherwise gateway-prefixed
  // projects would see false drift the first time they push.
  const baselineRepoPrefixes: Record<string, string> = {};
  for (const r of project.repos ?? []) {
    if (r.httpPrefix) baselineRepoPrefixes[r.name] = r.httpPrefix;
  }
  const validated = validateMapper(mapper);
  let baselineResolutionRate = 0;
  let baselineEdgeIds: string[] = [];
  if (validated.ok) {
    // Mirror the live push (`push/unified.ts`): one `linkWorkspace` pass over
    // the loaded repos with each repo's gateway prefix attached, so the captured
    // baseline is measured under runtime-equivalent semantics.
    const result = linkWorkspace(
      toParsedRepoLikes(repos, baselineRepoPrefixes, validated.mapper.services),
      validated.mapper,
    );
    baselineResolutionRate = result.metrics.rate;
    baselineEdgeIds = result.edges.map((e) => `${e.sourceId}::${e.targetId}`);
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    generatedBy: { model: 'discover', iterations: 1 },
    inputsHash: `discover:${repos.length}-repos:${totalCalls}-calls`,
    baselineResolutionRate,
    baselineEdgeIds,
    regenHistory: [],
  };
  writeMapperMeta(paths.mapperMeta, meta);

  // Write the per-project README on first run only; preserve user edits on re-runs.
  const readmePath = path.join(parserStorage, options.project, 'mapper.README.md');
  let writtenReadme: string | undefined;
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, buildMapperReadme(options.project));
    writtenReadme = readmePath;
  }

  return {
    project: options.project,
    mapperPath,
    readmePath: writtenReadme,
    backupPath,
    mapperMetaPath: paths.mapperMeta,
    baselineResolutionRate,
    matched,
    unmatched,
    unresolvableAuto,
    totalCalls,
    sdkMappingsCount: 0,
    staleServices,
    merged,
    renamedServices: nameCollisionResult.renamed,
    nameCollisions: nameCollisionResult.existingCollisions,
  };
}

// =============================================================================
// `mapper gen-sdk-mappings` — regenerate the sdkMappings fallback table from the
// in-workspace SDK source repos' parsed egress. Complementary to `discover`,
// which writes services / pathRewriteRules / unresolvableServices but never the
// sdkMappings table. Explicit subcommand (not auto-on-push): it re-parses the SDK
// repos and rewrites a reviewable table, so the user runs it deliberately.
// =============================================================================

export interface GenSdkMappingsOptions {
  project: string;
  mapperPath: string;
  dryRun?: boolean;
}

/** Minimal config shape: SDK sources are project repos tagged `sdkSourcePackages`. */
interface GenSdkMappingsConfigShape {
  projects: Array<{
    id: string;
    repos?: Array<{ name: string; path: string; key?: string; sdkSourcePackages?: string[] }>;
  }>;
}

export interface GenSdkMappingsResult {
  project: string;
  mapperPath: string;
  sources: Array<{ name: string; emitted: number; noService: number }>;
  count: number;
  written: boolean;
}

export async function runMapperGenSdkMappings(
  loadedConfig: GenSdkMappingsConfigShape,
  options: GenSdkMappingsOptions,
): Promise<GenSdkMappingsResult> {
  const project = loadedConfig.projects.find((p) => p.id === options.project);
  if (!project) {
    throw new Error(`Project '${options.project}' missing from coredoc.config.json`);
  }

  const sdkRepos = (project.repos ?? []).filter((r) => (r.sdkSourcePackages?.length ?? 0) > 0);
  if (sdkRepos.length === 0) {
    throw new Error(
      `No SDK source repos for project '${options.project}'. Mark in-workspace SDK repos with ` +
        '`sdkSourcePackages: ["@scope/pkg"]` in coredoc.config.json projects[].repos[].',
    );
  }

  // Profiles live alongside the mapper: <parsersRoot>/<projectId>/<repo>/profile.ts.
  const projectParsersDir = path.dirname(options.mapperPath);
  const sdkSources: SdkSource[] = [];
  for (const repo of sdkRepos) {
    // Fail fast: a degraded parse (no node_modules → no SCIP monikers → 0 rows) would
    // silently WIPE the existing table. Require deps so regeneration is meaningful.
    if (!fs.existsSync(path.join(repo.path, 'node_modules'))) {
      throw new Error(
        `SDK source repo '${repo.name}' has no node_modules at ${repo.path}. SCIP moniker ` +
          "tagging needs the repo's installed dependencies; install them and re-run.",
      );
    }
    const profilePath = path.join(projectParsersDir, repo.name, 'profile.ts');
    if (!fs.existsSync(profilePath)) {
      throw new Error(`SDK source repo '${repo.name}' has no authored profile at ${profilePath}`);
    }
    const mod = (await import(pathToFileURL(profilePath).href)) as Record<string, unknown>;
    // SDK source repos are TS/JS — resolve via the provider registry and require the
    // TypeScript provider (which serves both 'ts' and 'js'); a Ruby profile is rejected.
    const match = Object.values(mod)
      .map((v) => providerForExport(v))
      .find((m) => m !== undefined);
    if (!match || match.provider.language !== 'ts') {
      throw new Error(`No ExtractionProfile export found in ${profilePath}`);
    }
    const profile = match.profile as ExtractionProfile;
    // biome-ignore lint/style/noNonNullAssertion: sdkRepos are pre-filtered on a non-empty sdkSourcePackages
    sdkSources.push({ name: repo.name, root: repo.path, profile, packages: repo.sdkSourcePackages! });
  }

  // Base mapper (validated) — preserves services / pathRewriteRules / unresolvableServices.
  const baseRaw = validateMapper(JSON.parse(fs.readFileSync(options.mapperPath, 'utf-8')));
  if (!baseRaw.ok) {
    throw new Error(
      `Base mapper.json invalid: ${baseRaw.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`,
    );
  }

  const { sdkMappings, perRepo, mapper } = await generateSdkMappings({ sdkSources, baseMapper: baseRaw.mapper });

  if (!options.dryRun) {
    fs.writeFileSync(options.mapperPath, `${JSON.stringify(mapper, null, 2)}\n`);
  }

  return {
    project: options.project,
    mapperPath: options.mapperPath,
    sources: sdkSources.map((s) => ({ name: s.name, ...perRepo[s.name]! })),
    count: sdkMappings.length,
    written: !options.dryRun,
  };
}

export function printGenSdkMappings(result: GenSdkMappingsResult): void {
  console.log(`\nsdkMappings for project '${result.project}':`);
  for (const s of result.sources) {
    console.log(
      `  ${s.name}: ${s.emitted} emitted${s.noService ? ` (${s.noService} dropped — no targetService)` : ''}`,
    );
  }
  console.log(`  total: ${result.count} rows`);
  console.log(result.written ? `  wrote ${result.mapperPath}` : '  (dry-run — not written)');
}

function buildMapperReadme(projectId: string): string {
  return `# Mapper for project \`${projectId}\`

\`mapper.json\` tells the cross-service resolver how to map external SDK / HTTP calls in this
project's parsed repos to their target entrypoints.

## Schema

\`\`\`json
{
  "$schemaVersion": 1,
  "project": "${projectId}",

  "services": [
    // 'name' is the canonical service identifier the resolver matches against.
    // 'repo' must be the name of a parsed repo in this project.
    // 'aliases' are alternative serviceName values the parser emits for the same target.
    { "name": "<canonical-service>", "repo": "<parsed-repo-name>", "aliases": ["<other-name>"] }
  ],

  "sdkMappings": [
    // Optional fallback table — one row per SDK method, for SDK-mediated calls the
    // moniker symbol hop can't reach (locally-defined clients / consumers without the
    // SDK in node_modules). Regenerate with \`coredoc mapper gen-sdk-mappings -p ${projectId}\`,
    // which parses the in-workspace SDK source repos (those marked \`sdkSourcePackages\`
    // in coredoc.config.json) and writes the rows from their captured egress. Rarely
    // hand-edited.
    //
    // Lookup key: (sdkPackage, canonical-service-name, sdkMethod). So 'sdkClass' must
    // be the canonical service name (matches 'targetService' below), NOT the JS class
    // name — hand-authoring with the class name will silently miss the lookup.
    {
      "sdkPackage": "@org/sdk", "sdkClass": "<canonical-service>", "sdkMethod": "<method>",
      "targetService": "<canonical-service>",
      "http": { "method": "GET", "pathTemplate": "/v1/things/:id", "pathParams": ["id"] }
    }
  ],

  "pathRewriteRules": [
    // Optional. Regex with a named group; the captured value becomes the target service.
    // Useful when calls have a path but no service identifier.
    { "match": "^/api/(?<svc>[a-z-]+)/", "targetServiceFrom": "svc" }
  ],

  "unresolvableServices": [
    // Infra / third-party services with no code-level entrypoint to resolve to.
    // Excluded from the resolution-rate denominator so they don't pollute drift detection.
    "redis", "kafka", "datadog"
  ]
}
\`\`\`

## Filling in unmatched services from \`coredoc mapper discover\`

For each unmatched service the discover command reports, pick ONE option:

### (A) The service lives in a parsed repo, just under a different name

Add the unmatched name as an alias on an existing \`services[]\` entry, or create a new one:

\`\`\`json
{ "name": "<canonical-service>", "repo": "<parsed-repo-name>",
  "aliases": ["<unmatched-name>", "<another-variant>"] }
\`\`\`

Multiple aliases are allowed and all of them will resolve to the same canonical service.

### (B) The target repo isn't parsed yet

Add the repo to \`coredoc.config.json\` under \`projects[].repos[]\`, run \`coredoc parse\` for it,
then re-run \`coredoc mapper discover --project ${projectId}\`. The new entry will auto-match
by name (e.g. service \`core\` matches a repo named \`<prefix>-core\` via the prefix convention
discovered from your other repo names).

### (C) It's infrastructure (Redis, Kafka, third-party API, queue, etc.)

Add the service name to \`unresolvableServices[]\`. These are excluded from the resolution-rate
denominator so they don't pollute drift detection.

\`\`\`json
"unresolvableServices": ["redis", "kafka", "hubspot", "mailchimp", "google-cloud-pubsub"]
\`\`\`

## Commands

- \`coredoc mapper validate --project ${projectId}\` — schema check on the JSON
- \`coredoc mapper status --project ${projectId}\` — show counts and last-discover metadata
- \`coredoc mapper diff --project ${projectId}\` — diff current \`mapper.json\` against \`.mapper.json.bak\`
  (the snapshot written by the most recent \`mapper discover\`)
- \`coredoc mapper discover --project ${projectId}\` — re-run discovery. By default
  MERGES into the existing \`mapper.json\`: hand-edited fields (renamed \`name\`,
  \`aliases\`, \`httpPrefix\`) on existing entries are preserved, newly discovered
  services are added, and entries whose \`(repo, target)\` no longer exists are
  reported as stale (but NOT deleted — removal is a human action). Pass
  \`--overwrite\` to rebuild from scratch (clobber hand-edits). The previous file is
  snapshotted to \`.mapper.json.bak\` in both modes.

## What the resolver does at push time

When you run \`coredoc push <repo> --project ${projectId}\`:

1. For each externalCall in the parsed repo, take \`targetDescriptor.targetService\`
2. Canonicalise via \`services[].aliases\` → get the canonical service name
3. Look up the target repo via \`services[].repo\`
4. Find an entrypoint in the target repo matching the call's HTTP method + path
5. Emit a cross-service edge in the graph

Calls that fall through go into bucket counts visible via \`coredoc mapper status\`.

---

This README is autogenerated by \`coredoc mapper discover\` on first run only — re-runs
skip the README so any hand-edits to it are preserved. \`mapper.json\` re-runs MERGE by
default (hand-edits preserved; snapshotted to \`.mapper.json.bak\` first); pass
\`--overwrite\` to rebuild it from scratch. Safe to commit alongside \`mapper.json\`.
`;
}

export function printDiscoverResult(result: DiscoverResult): void {
  console.log('');
  console.log(`Mapper discover — ${result.project}`);
  console.log('================');
  console.log(`Total external calls scanned: ${result.totalCalls}`);
  console.log('');
  if (result.matched.length > 0) {
    console.log(`Auto-matched services (${result.matched.length}):`);
    for (const m of result.matched) {
      console.log(`  ${m.service.padEnd(40)} → ${m.matchedRepo}  [${m.matchType}, ${m.callCount} calls]`);
    }
    console.log('');
  }
  if (result.sdkMappingsCount > 0) {
    console.log(`SDK mappings populated from parsed sdkDefinitions: ${result.sdkMappingsCount}`);
    console.log('');
  }
  if (result.unresolvableAuto.length > 0) {
    console.log(`Auto-marked unresolvable infra (${result.unresolvableAuto.length}):`);
    for (const s of result.unresolvableAuto) console.log(`  ${s}`);
    console.log('');
  }
  if (result.unmatched.length > 0) {
    console.log(`Could NOT match (${result.unmatched.length}) — for each, pick ONE option:`);
    console.log('');
    console.log('  (A) Lives in a parsed repo under a different name → add as an alias in services[]:');
    console.log('        { "name": "<canonical>", "repo": "<parsed-repo>", "aliases": ["<unmatched-name>"] }');
    console.log('      Or extend an existing entry: add "<unmatched-name>" to its aliases array.');
    console.log('');
    console.log('  (B) Target repo is not parsed → add to coredoc.config.json projects[].repos[],');
    console.log('      then `coredoc parse` it and re-run `mapper discover`.');
    console.log('');
    console.log('  (C) Infra / third-party (Redis, Kafka, HubSpot, etc.) → add to unresolvableServices[].');
    console.log('');
    console.log('Unmatched (sorted by call count):');
    for (const u of result.unmatched) {
      console.log(`  ${u.service.padEnd(40)} (${u.callCount} calls)`);
    }
    console.log('');
  }
  if (result.staleServices.length > 0) {
    console.log(`# stale — existing services no longer produced by discovery (${result.staleServices.length}):`);
    console.log('  Kept in mapper.json (removal is a human action). Review and delete if truly gone:');
    for (const s of result.staleServices) {
      const t = s.target ? `#${s.target}` : '';
      console.log(`  ${s.name.padEnd(40)} (repo=${s.repo}${t})`);
    }
    console.log('');
  }
  if (result.renamedServices.length > 0) {
    console.log(
      `# renamed — generated services disambiguated to keep services[].name unique (${result.renamedServices.length}):`,
    );
    for (const r of result.renamedServices) {
      const t = r.target ? `#${r.target}` : '';
      console.log(`  ${r.from.padEnd(30)} → ${r.to.padEnd(30)} (repo=${r.repo}${t})`);
    }
    console.log('');
  }
  if (result.nameCollisions.length > 0) {
    console.log(
      `# WARNING — existing services collide on services[].name after normalization (${result.nameCollisions.length}):`,
    );
    console.log('  NOT auto-renamed (hand-authored) — rename one by hand; `mapper validate` will fail until resolved:');
    for (const c of result.nameCollisions) {
      const ta = c.a.target ? `#${c.a.target}` : '';
      const tb = c.b.target ? `#${c.b.target}` : '';
      console.log(`  "${c.a.name}" (repo=${c.a.repo}${ta})  vs  "${c.b.name}" (repo=${c.b.repo}${tb})`);
    }
    console.log('');
  }
  if (result.backupPath) {
    console.log(`Snapshot of previous mapper: ${result.backupPath}`);
    console.log('  (recover hand-edits via `coredoc mapper diff --project <id>` or by hand)');
  }
  console.log(
    result.merged
      ? 'Mode: merge (preserved hand-edits; added newly discovered services). Use --overwrite to rebuild from scratch.'
      : 'Mode: overwrite (rebuilt mapper.json from discovery).',
  );
  console.log(`Wrote: ${result.mapperPath}`);
  console.log(
    `Wrote: ${result.mapperMetaPath}  (baseline resolution rate ${(result.baselineResolutionRate * 100).toFixed(1)}%)`,
  );
  if (result.readmePath) {
    console.log(`Wrote: ${result.readmePath}  (schema reference + step-by-step instructions)`);
  }
  console.log('Next: review the mapper, then run `coredoc push <repo> --project <id>` to use it.');
}

// =============================================================================
// `coredoc mapper suggest` — propose sdkMappings for unresolved external calls
// =============================================================================
//
// PURPOSE
//   When an SDK consumer calls a method (`this.apiClient.X.someMethod(...)`)
//   that doesn't exist in any parsed SDK source — e.g. a vendor SDK published
//   only as a compiled .d.ts, a method added in a dev branch not yet checked
//   in, or a private wrapper — the resolver has no way to know which HTTP
//   route the method calls. Those calls bucket as `no-sdk-mapping`.
//
//   This command surfaces those calls grouped by (sdkPackage, sdkMethod),
//   pairs each with the candidate entrypoint paths in the target repo, and
//   produces a structured proposal file the user (or an LLM) can review and
//   merge into mapper.json's `sdkMappings`.
//
// THREE MODES
//   --mode=prompt     — emit an LLM-ready prompt + data (recommended;
//                       avoids project-specific heuristics)
//   --mode=heuristic  — token-overlap scoring (offline, deterministic, but
//                       conservative; many calls will need manual review)
//   --mode=both       — produce both files so the user can compare
//
// SAFETY
//   No suggestion is ever auto-applied. The output is always a JSON file
//   for review. The companion command `mapper apply-suggestions` reads it
//   and merges approved entries (subject to schema validation).
//
// GENERIC DESIGN
//   This algorithm makes ZERO assumptions about specific service names or
//   path conventions. The HTTP-verb hint (`get*` → GET, `delete*` → DELETE,
//   etc.) is the only domain knowledge, and it's universal across REST
//   client conventions. Token-overlap is structural.

const VERB_HINT: Record<string, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'> = {
  // GET-shaped verbs
  get: 'GET',
  list: 'GET',
  fetch: 'GET',
  find: 'GET',
  search: 'GET',
  read: 'GET',
  show: 'GET',
  describe: 'GET',
  // POST-shaped verbs
  create: 'POST',
  insert: 'POST',
  upsert: 'POST',
  save: 'POST',
  add: 'POST',
  publish: 'POST',
  send: 'POST',
  generate: 'POST',
  start: 'POST',
  execute: 'POST',
  // PUT-shaped verbs
  update: 'PUT',
  set: 'PUT',
  edit: 'PUT',
  replace: 'PUT',
  overwrite: 'PUT',
  // PATCH-shaped verbs
  patch: 'PATCH',
  // DELETE-shaped verbs
  delete: 'DELETE',
  remove: 'DELETE',
  destroy: 'DELETE',
  clear: 'DELETE',
};

/** Split camelCase + snake_case + kebab-case into lowercase atom list. */
function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Method name → { tokens, verbHint }. Verb words are dropped from tokens. */
function tokenizeMethod(method: string): { tokens: Set<string>; verbHint?: string } {
  let verbHint: string | undefined;
  const tokens = new Set<string>();
  for (const w of splitWords(method)) {
    if (!verbHint && VERB_HINT[w]) verbHint = VERB_HINT[w];
    if (VERB_HINT[w]) continue;
    tokens.add(w);
  }
  return { tokens, verbHint };
}

/** Path → set of significant tokens. Drops path params, version segments,
 *  empty segments. Does NOT drop any literal segment (no project-specific
 *  skip list — to stay generic across codebases). */
function tokenizePathSegments(p: string): Set<string> {
  const segs = p.split('/').filter((s) => s && !/^v\d+$/.test(s));
  const out = new Set<string>();
  for (const s of segs) {
    if (s.startsWith(':') || /^\{.*\}$/.test(s) || /^\$\{.*\}$/.test(s)) continue;
    for (const w of splitWords(s)) out.add(w);
  }
  return out;
}

export interface MapperSuggestOptions {
  project: string;
  config?: string;
  /** Output file path (relative to configDir or absolute). */
  out?: string;
  /** 'prompt' (LLM-ready), 'heuristic' (offline scoring), or 'both'. */
  mode?: 'prompt' | 'heuristic' | 'both';
  /** Minimum token overlap to include a candidate in heuristic mode. Default 2. */
  minOverlap?: number;
}

export interface SuggestionCandidate {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  pathTemplate: string;
  /** Heuristic score: token-overlap count + verb-match bonus. */
  score?: number;
  /** Plain-text explanation of why this candidate was proposed. */
  rationale?: string;
}

export interface UnresolvedGroup {
  /** Identity of the unresolved (pkg, class, method) tuple. */
  sdkPackage: string;
  sdkClass: string;
  sdkMethod: string;
  /** What the resolver canonicalised the target to. */
  canonicalService: string;
  targetRepo: string;
  /** How many call-sites this method has — higher = more impact. */
  callCount: number;
  /** Sample caller source so reviewers can inspect intent. */
  sampleCaller?: string;
  /** Sorted by score desc when heuristic mode is on. */
  candidates: SuggestionCandidate[];
}

export interface MapperSuggestResult {
  project: string;
  /** Where the proposals file was written. */
  outputPath: string;
  /** Optional companion file with the LLM prompt template. */
  promptPath?: string;
  groups: UnresolvedGroup[];
  stats: {
    totalUnresolved: number; // raw unresolved call count
    uniqueMethods: number; // unique (pkg, class, method) tuples
    withCandidates: number; // tuples with ≥1 candidate entrypoint
    withoutCandidates: number; // tuples with 0 candidates in target repo
  };
}

/**
 * Build proposals for `no-sdk-mapping` unresolved calls.
 *
 * The function is pure: no mapper or DB writes. Returns a structure the
 * caller serialises to JSON for review.
 */
export function runMapperSuggest(
  loadedConfig: DiscoverConfigShape,
  options: MapperSuggestOptions,
): MapperSuggestResult {
  const proj = loadedConfig.projects.find((p) => p.id === options.project);
  if (!proj) throw new Error(`Project "${options.project}" not found in config`);

  const paths = mapperPathsForProject(loadedConfig.resolvedParserStorage, options.project);
  const mapper = JSON.parse(fs.readFileSync(paths.mapperJson, 'utf8'));
  const validated = validateMapper(mapper);
  if (!validated.ok) {
    throw new Error(
      `mapper.json is invalid; fix it before running suggest. First error: ${validated.errors[0]?.message}`,
    );
  }

  // Load parsed repos from outputDir/projectId
  const projectDir = path.join(loadedConfig.resolvedOutputDir, options.project);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Output directory not found: ${projectDir}. Run 'coredoc parse' first.`);
  }
  const repos: ParsedRepo[] = [];
  for (const f of fs.readdirSync(projectDir)) {
    if (!f.endsWith('.json')) continue;
    const d = JSON.parse(fs.readFileSync(path.join(projectDir, f), 'utf8'));
    if (d.name && d.externalCalls) repos.push(d);
  }

  // Per-repo httpPrefix map (mirrors push semantics)
  const repoPrefixes: Record<string, string> = {};
  for (const r of proj.repos ?? []) {
    if (r.httpPrefix) repoPrefixes[r.name] = r.httpPrefix;
  }

  const result = linkWorkspace(toParsedRepoLikes(repos, repoPrefixes, validated.mapper.services), validated.mapper);

  // Per-service alias→canonical and canonical→repo index. Built once and reused
  // for both canonicalising an unresolved call's target service and looking up
  // its owning repo for candidate gathering. Generic shape — no client names.
  const ctx = (function () {
    const aliasToCanonical = new Map<string, string>();
    const canonicalToRepo = new Map<string, string>();
    for (const svc of validated.mapper.services) {
      aliasToCanonical.set(svc.name.toLowerCase(), svc.name);
      for (const alias of svc.aliases) aliasToCanonical.set(alias.toLowerCase(), svc.name);
      canonicalToRepo.set(svc.name, svc.repo);
    }
    return {
      canonicalToRepo,
      canonicalise(name: string | undefined): string | undefined {
        if (!name) return undefined;
        return aliasToCanonical.get(name.trim().toLowerCase());
      },
    };
  })();

  // Group SDK-mediated unresolved calls by (sdkPackage, canonicalService, sdkMethod)
  // to propose new SDK mappings. The linker emits `UnresolvedReason` keyed by the
  // external call id (`sourceId`); we join back to the call's own (sdkName, method,
  // targetService) and canonicalise the target service through the mapper alias map
  // (the linker does not surface a canonical service on its unresolved reasons).
  // Keying on the full triple (not just pkg+method) keeps calls to different
  // services that share a method name (e.g. `getById` on two clients in the same
  // SDK package) in separate groups so the first canonical doesn't shadow the rest.
  type Key = string;
  const groups = new Map<
    Key,
    {
      sdkPackage: string;
      sdkMethod: string;
      canonicalService: string;
      callCount: number;
      sampleCaller?: string;
    }
  >();

  const callIndex = new Map<string, { sdkName?: string; method?: string; callerId: string; targetService?: string }>();
  for (const r of repos)
    for (const c of r.externalCalls ?? []) {
      callIndex.set(c.id, {
        sdkName: c.sdkName,
        method: c.method,
        callerId: c.callerId,
        targetService: c.targetDescriptor?.targetService ?? c.serviceName,
      });
    }

  for (const u of result.unresolved) {
    const c = callIndex.get(u.sourceId);
    // Only SDK-mediated calls (carry sdkName + method) get an sdkMapping proposal.
    if (!c?.sdkName || !c.method) continue;
    // Canonicalise the call's own target service through the mapper alias map;
    // skip when the service is unknown rather than bucketing under an arbitrary one.
    const canonical = ctx.canonicalise(c.targetService);
    if (!canonical) continue;
    const key = `${c.sdkName}::${canonical}::${c.method}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        sdkPackage: c.sdkName,
        sdkMethod: c.method,
        canonicalService: canonical,
        callCount: 0,
        sampleCaller: c.callerId,
      };
      groups.set(key, g);
    }
    g.callCount += 1;
  }

  // Pre-index entrypoints per repo for fast candidate gathering.
  const epIndex = new Map<string, Array<{ method: string; pathTemplate: string }>>();
  for (const r of repos) {
    const eps: Array<{ method: string; pathTemplate: string }> = [];
    for (const ep of r.entrypoints ?? []) {
      if (ep.type !== 'http') continue;
      const http = ep.details as HttpEntrypointDetails;
      if (!http?.method) continue;
      const tpl = http.fullPath ?? http.path;
      if (!tpl) continue;
      eps.push({ method: http.method, pathTemplate: tpl });
    }
    if (eps.length > 0) epIndex.set(r.name, eps);
  }

  // Score each group's candidates.
  const outGroups: UnresolvedGroup[] = [];
  for (const g of groups.values()) {
    const canonical = g.canonicalService;
    const targetRepo = ctx.canonicalToRepo.get(canonical);
    if (!targetRepo) continue;

    const eps = epIndex.get(targetRepo) ?? [];
    const { tokens: methTokens, verbHint } = tokenizeMethod(g.sdkMethod);
    const includeHeuristic = options.mode === 'heuristic' || options.mode === 'both';
    const minOverlap = options.minOverlap ?? 2;

    let candidates: SuggestionCandidate[] = eps.map((ep) => ({
      method: ep.method as SuggestionCandidate['method'],
      pathTemplate: ep.pathTemplate,
    }));

    // Filter by verb hint (always — if we know it's a `get*` method, no point
    // including POST candidates). This is a universal REST convention.
    if (verbHint) candidates = candidates.filter((c) => c.method === verbHint);

    // Lightweight ranking (always-on): score by method-token overlap with path,
    // ties broken by path specificity. This isn't strict like heuristic mode
    // — we don't filter, just sort — so the LLM/human reviewer sees the most
    // likely candidates first in the prompt. Safe because no decision is made
    // here; the user/LLM still chooses.
    const scored = candidates
      .map((c) => {
        const pathTokens = tokenizePathSegments(c.pathTemplate);
        let overlap = 0;
        const matched: string[] = [];
        for (const t of methTokens)
          if (pathTokens.has(t)) {
            overlap++;
            matched.push(t);
          }
        return {
          ...c,
          score: overlap,
          rationale: `verb=${verbHint ?? '?'}; tokens matched [${matched.join(', ')}] of [${[...methTokens].join(', ')}]`,
        };
      })
      .sort((a, b) => b.score! - a.score! || a.pathTemplate.split(/[:{]/).length - b.pathTemplate.split(/[:{]/).length);

    if (includeHeuristic) {
      // Heuristic mode: enforce a hard minimum overlap so the JSON only
      // contains plausible matches (no flood).
      candidates = scored.filter((c) => (c.score ?? 0) >= minOverlap);
    } else {
      // Prompt mode: keep up to 20 ranked candidates. Methods with too many
      // candidates produce overwhelming LLM prompts; the ranking puts the
      // most likely ones first so an LLM at 20-cap usually has the answer.
      candidates = scored.slice(0, 20);
    }

    outGroups.push({
      sdkPackage: g.sdkPackage,
      sdkClass: canonical,
      sdkMethod: g.sdkMethod,
      canonicalService: canonical,
      targetRepo,
      callCount: g.callCount,
      sampleCaller: g.sampleCaller,
      candidates,
    });
  }

  // Order groups by impact: methods with most call sites first.
  outGroups.sort((a, b) => b.callCount - a.callCount);

  const outputPath = path.resolve(
    loadedConfig.resolvedParserStorage,
    options.project,
    options.out ?? 'mapper-suggestions.json',
  );
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        project: options.project,
        generated: { at: new Date().toISOString(), mode: options.mode ?? 'prompt' },
        groups: outGroups,
      },
      null,
      2,
    ),
  );

  // For prompt mode, also write a markdown file with an LLM prompt
  // template + the data shaped for inline pasting.
  let promptPath: string | undefined;
  if (options.mode === 'prompt' || options.mode === 'both') {
    promptPath = outputPath.replace(/\.json$/, '.prompt.md');
    fs.writeFileSync(promptPath, buildLlmPrompt(outGroups));
  }

  return {
    project: options.project,
    outputPath,
    promptPath,
    groups: outGroups,
    stats: {
      totalUnresolved: [...groups.values()].reduce((s, g) => s + g.callCount, 0),
      uniqueMethods: outGroups.length,
      withCandidates: outGroups.filter((g) => g.candidates.length > 0).length,
      withoutCandidates: outGroups.filter((g) => g.candidates.length === 0).length,
    },
  };
}

/** Build a self-contained LLM prompt — paste into Claude/GPT/etc. and the
 *  reply is a JSON the user feeds back into `mapper apply-suggestions`.
 *
 *  The LLM is instructed to emit the FULL `SdkMapping` shape (sdkPackage,
 *  sdkClass, sdkMethod, targetService, http.{method,pathTemplate}) so the
 *  reply file is drop-in input for `mapper apply-suggestions` with no manual
 *  reshaping. The per-item `sdkPackage`/`sdkClass`/`sdkMethod`/`targetService`
 *  fields are pre-filled in the prompt — the LLM's job is only to fill the
 *  matching `http` object from the candidates list, or skip the item. */
function buildLlmPrompt(groups: UnresolvedGroup[]): string {
  const items = groups
    .filter((g) => g.candidates.length > 0)
    .map((g) => ({
      // Constants the LLM should copy through verbatim into its reply.
      sdkPackage: g.sdkPackage,
      sdkClass: g.sdkClass,
      sdkMethod: g.sdkMethod,
      targetService: g.canonicalService,
      target_repo: g.targetRepo,
      call_count: g.callCount,
      // What the LLM must choose from. `null` = "no match" — the LLM is told
      // to skip the entry rather than emit a guess.
      candidate_routes: g.candidates.map((c) => ({ method: c.method, pathTemplate: c.pathTemplate })),
    }));

  return `# SDK-method → HTTP-route mapping

The cross-repo resolver has SDK consumer calls (\`this.apiClient.X.method(...)\`)
where the SDK source isn't available and the call carries no http path. Below is
each unresolved (sdkMethod, targetService) pair plus the candidate routes that
exist on the target service.

For each item, decide which candidate route the SDK method most likely calls.
Use the method name + your knowledge of REST conventions to choose.

REPLY FORMAT: a JSON array of full \`SdkMapping\` objects ready for
\`coredoc mapper apply-suggestions\`. For each item below where you can pick a
single best candidate, emit one object. SKIP items where no candidate is a
good fit — do NOT guess.

\`\`\`json
[
  {
    "sdkPackage": "@org/sdk",
    "sdkClass": "<canonical-service>",
    "sdkMethod": "createTask",
    "targetService": "<canonical-service>",
    "http": { "method": "POST", "pathTemplate": "/v2/projects/:projectId/tasks" }
  }
]
\`\`\`

Rules:
- Copy \`sdkPackage\`, \`sdkClass\` (= targetService), \`sdkMethod\`,
  \`targetService\` verbatim from each item below.
- Set \`http.method\` and \`http.pathTemplate\` from one entry in that item's
  \`candidate_routes\` list.
- OMIT items where no candidate fits. Empty array is allowed.
- Use the EXACT pathTemplate string from a \`candidate_routes\` entry.

## Items

${JSON.stringify(items, null, 2)}

## Apply

Save your JSON reply to \`mapper-suggestions.review.json\` next to this file,
then run \`coredoc mapper apply-suggestions --project <id> --input
mapper-suggestions.review.json\`.
`;
}

export function printSuggestResult(r: MapperSuggestResult): void {
  console.log(`  Project          : ${r.project}`);
  console.log(`  Output JSON      : ${r.outputPath}`);
  if (r.promptPath) console.log(`  LLM prompt       : ${r.promptPath}`);
  console.log('');
  console.log(`  Unresolved calls : ${r.stats.totalUnresolved}`);
  console.log(`  Unique methods   : ${r.stats.uniqueMethods}`);
  console.log(`    with ≥1 candidate route : ${r.stats.withCandidates}`);
  console.log(`    with 0 candidate routes : ${r.stats.withoutCandidates}`);
  console.log('');
  if (r.groups.length > 0) {
    console.log('Top unresolved methods (by call count):');
    for (const g of r.groups.slice(0, 10)) {
      const top = g.candidates[0];
      // Only print the top candidate if we have strong signal (single match or
      // top score is clearly above the runner-up). Otherwise just show the
      // count + target — the JSON/prompt file has the full picture.
      let hint = `(${g.candidates.length} candidate routes)`;
      if (top && (g.candidates.length === 1 || (top.score ?? 0) >= 2)) {
        const runnerUp = g.candidates[1];
        const isUnique = !runnerUp || (top.score ?? 0) > (runnerUp.score ?? 0);
        if (isUnique) hint = `${top.method} ${top.pathTemplate.slice(0, 70)}`;
      }
      console.log(
        `  ${String(g.callCount).padStart(4)} × ${g.sdkMethod.padEnd(35)} → ${g.targetRepo.padEnd(26)} ${hint}`,
      );
    }
  }
  console.log('');
  console.log('Next: review the output file (or feed the prompt to an LLM).');
  console.log('      Approved suggestions go in mapper.json under `sdkMappings`.');
}

// =============================================================================
// `coredoc mapper apply-suggestions` — merge approved sdkMappings into mapper.json
// =============================================================================
//
// Input is a JSON file of approved entries in the v1 SdkMapping shape:
//   [{ sdkPackage, sdkClass, sdkMethod, targetService, http: { method, pathTemplate } }, ...]
// Each entry is validated against the schema. Duplicates (same sdkPackage +
// sdkClass + sdkMethod as an existing mapping) are skipped — caller can use
// `--overwrite` to replace.

export interface MapperApplySuggestionsOptions {
  project: string;
  config?: string;
  /** Path to the approved suggestions JSON. */
  input: string;
  /** Replace existing matching entries instead of skipping them. */
  overwrite?: boolean;
  /** Dry-run: print what would be added/replaced without writing. */
  dryRun?: boolean;
}

export interface MapperApplySuggestionsResult {
  added: number;
  replaced: number;
  skipped: number;
  rejected: Array<{ entry: unknown; reason: string }>;
  mapperPath: string;
  backupPath?: string;
}

export function runMapperApplySuggestions(
  loadedConfig: DiscoverConfigShape,
  options: MapperApplySuggestionsOptions,
): MapperApplySuggestionsResult {
  const paths = mapperPathsForProject(loadedConfig.resolvedParserStorage, options.project);
  const mapper = JSON.parse(fs.readFileSync(paths.mapperJson, 'utf8'));
  const validated = validateMapper(mapper);
  if (!validated.ok) {
    throw new Error(`mapper.json is invalid; fix it first. First error: ${validated.errors[0]?.message}`);
  }
  const m = validated.mapper as { sdkMappings: SdkMapping[] };

  const inputPath = path.resolve(loadedConfig.resolvedParserStorage, options.project, options.input);
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  // Accept either the raw array OR a wrapper with `sdkMappings` key
  const entries: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw.sdkMappings) ? raw.sdkMappings : [];

  const existingKeys = new Set(m.sdkMappings.map((s) => `${s.sdkPackage}::${s.sdkClass}::${s.sdkMethod}`));
  let added = 0,
    replaced = 0,
    skipped = 0;
  const rejected: Array<{ entry: unknown; reason: string }> = [];

  for (const e of entries) {
    if (typeof e !== 'object' || e === null) {
      rejected.push({ entry: e, reason: 'not an object' });
      continue;
    }
    const obj = e as Record<string, unknown>;
    const sdkPackage = obj.sdkPackage as string | undefined;
    const sdkClass = obj.sdkClass as string | undefined;
    const sdkMethod = obj.sdkMethod as string | undefined;
    const targetService = obj.targetService as string | undefined;
    const http = obj.http as { method?: string; pathTemplate?: string } | undefined;
    if (!sdkPackage || !sdkClass || !sdkMethod || !targetService || !http?.method || !http?.pathTemplate) {
      rejected.push({
        entry: e,
        reason: 'missing required fields (sdkPackage/sdkClass/sdkMethod/targetService/http.method/http.pathTemplate)',
      });
      continue;
    }
    const candidate: SdkMapping = {
      sdkPackage,
      sdkClass,
      sdkMethod,
      targetService,
      http: {
        method: http.method as NonNullable<SdkMapping['http']>['method'],
        pathTemplate: http.pathTemplate,
        pathParams: [],
      },
    };
    const key = `${sdkPackage}::${sdkClass}::${sdkMethod}`;
    if (existingKeys.has(key)) {
      if (options.overwrite) {
        const idx = m.sdkMappings.findIndex((s) => `${s.sdkPackage}::${s.sdkClass}::${s.sdkMethod}` === key);
        if (idx >= 0) m.sdkMappings[idx] = candidate;
        replaced++;
      } else {
        skipped++;
      }
    } else {
      m.sdkMappings.push(candidate);
      existingKeys.add(key);
      added++;
    }
  }

  // Re-validate the modified mapper to ensure schema integrity.
  const reValidated = validateMapper(m);
  if (!reValidated.ok) {
    throw new Error(`Merged mapper failed schema validation: ${reValidated.errors[0]?.message}`);
  }

  let backupPath: string | undefined;
  if (!options.dryRun) {
    // Use the canonical backup path (`.mapper.json.bak`) shared with
    // `mapper discover` and `mapper diff --baseline`. Without this, the
    // diff command would not see the apply-suggestions snapshot.
    backupPath = paths.backup;
    fs.copyFileSync(paths.mapperJson, backupPath);
    fs.writeFileSync(paths.mapperJson, JSON.stringify(m, null, 2));
  }
  return { added, replaced, skipped, rejected, mapperPath: paths.mapperJson, backupPath };
}

export function printApplySuggestionsResult(r: MapperApplySuggestionsResult, dryRun: boolean): void {
  console.log(`  Mapper           : ${r.mapperPath}${dryRun ? '  (DRY RUN — not written)' : ''}`);
  if (r.backupPath) console.log(`  Backup           : ${r.backupPath}`);
  console.log('');
  console.log(`  Added            : ${r.added}`);
  console.log(`  Replaced         : ${r.replaced}`);
  console.log(`  Skipped (exists) : ${r.skipped}`);
  console.log(`  Rejected         : ${r.rejected.length}`);
  if (r.rejected.length > 0) {
    console.log('');
    console.log('Rejected entries:');
    for (const x of r.rejected.slice(0, 10)) console.log(`  - ${x.reason}`);
  }
}

// ============================================================================
// mapper push / pull (cloud sync)
// ============================================================================

export interface MapperPushOptions {
  workspaceId: string;
  /** Path to the local mapper.json. Use `mapperPathsForProject` to derive when invoking from commander. */
  file: string;
  /**
   * Upload only — skip the server-side inline resolve. Used by batch sync,
   * whose single finalizing resolve reads the live mapper row anyway.
   */
  defer?: boolean;
}

export interface MapperPushResolutionMetrics {
  resolved: number;
  total: number;
  rate: number;
  legacyEdges: number;
  mapperSha?: string | null;
}

/**
 * Server returns either the resolver metrics or `{ error }` when the upload
 * succeeded but the post-upload re-resolution failed. The PUT itself is still
 * 200 in that case — the mapper IS persisted — so CLI must branch on the
 * shape rather than assume metrics.
 */
export type MapperPushResolution = MapperPushResolutionMetrics | { error: string };

export interface MapperPushResult {
  sha256: string;
  r2Key: string;
  sizeBytes: number;
  duplicate: boolean;
  /**
   * `null` in two legitimate success cases: a deferred upload (batch sync
   * finalizes resolution itself), and an idempotent no-op on a file-snapshot
   * workspace — a duplicate mapper leaves the composition identical to the
   * active version, whose resolution was asserted when it was published.
   */
  resolution: MapperPushResolution | null;
}

/**
 * The mapper was stored, but publishing the graph outlived the server's
 * synchronous budget and the job kept running in the background. Not a failure:
 * the upload landed and the publication completes without the client.
 */
export interface MapperPushPending {
  status: 'publishing';
  jobId: string;
}

export type MapperPushOutcome = MapperPushResult | MapperPushPending;

function isPending(r: MapperPushOutcome): r is MapperPushPending {
  return 'status' in r && r.status === 'publishing';
}

/**
 * Upload the local mapper.json to the cloud workspace.
 *
 * Cloud uses workspaceId as the resolution boundary; the CLI's `--project`
 * argument is only used to locate the right local file path. Server has
 * no concept of project namespacing.
 *
 * Validates against MapperSchema before sending — fails fast without burning
 * a network round trip on malformed input.
 */
export async function runMapperPush(options: MapperPushOptions): Promise<MapperPushOutcome> {
  if (!fs.existsSync(options.file)) {
    throw new Error(`Mapper file not found: ${options.file}`);
  }
  const raw = fs.readFileSync(options.file, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Mapper file at ${options.file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const validation = validateMapper(parsed);
  if (!validation.ok) {
    const summary = validation.errors
      .slice(0, 5)
      .map((e) => ` - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Mapper at ${options.file} failed schema validation:\n${summary}`);
  }

  // Cloud contract guard: the server's mapper endpoint (a separate repo) has not
  // been confirmed to accept `$schemaVersion: 2`. Rather than push a v2 document
  // the server may reject with an opaque error, refuse up front with an actionable
  // message. A v2 mapper only arises when a service uses `target`/`httpPrefix`
  // (multi-target monorepos); all v1 mappers push unchanged. Lift this guard once
  // the server is confirmed to validate/accept version 2 (spec §4.3 Writing / §8).
  if (validation.mapper.$schemaVersion === 2) {
    throw new Error(
      `Mapper at ${options.file} is $schemaVersion 2 (uses per-service target/httpPrefix), which the cloud mapper endpoint is not yet confirmed to accept. ` +
        'Push is blocked to avoid an opaque server rejection. Keep this mapper local until the server supports v2, or remove per-service target/httpPrefix fields to write v1.',
    );
  }

  const { getToken, getServerUrl } = await import('../auth.js');
  const token = await getToken();
  if (!token) throw new Error('Not authenticated. Run: coredoc login');
  const serverUrl = await getServerUrl();
  const url = `${serverUrl}/api/v1/workspaces/${options.workspaceId}/mapper${options.defer ? '?defer=true' : ''}`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: raw,
  });
  if (!response.ok) {
    const body = await response.text();
    // On a file_snapshot workspace the PUT stores the mapper and then waits for
    // the publish job; when that wait exceeds the server's budget the response
    // is a structured 504 while the job keeps running. The upload succeeded, so
    // failing the command here would report a false error to CI.
    const structured = parseStructuredServerError(body);
    if (structured?.code === JOB_STILL_RUNNING_CODE && structured.jobId) {
      return { status: 'publishing', jobId: structured.jobId };
    }
    throw new Error(`Mapper push failed (${response.status}): ${body}`);
  }
  return (await response.json()) as MapperPushResult;
}

export function printMapperPushResult(r: MapperPushOutcome): void {
  if (isPending(r)) {
    console.log(`Mapper stored. Graph publication continues in background (jobId=${r.jobId}).`);
    console.log(`Check status with: coredoc sync-status ${r.jobId}`);
    return;
  }
  const status = r.duplicate ? 'unchanged' : 'uploaded';
  console.log(`Mapper ${status} (sha=${r.sha256.slice(0, 8)}, ${r.sizeBytes} bytes)`);
  if (r.resolution === null) {
    // Success without fresh metrics: either a deferred upload (the batch's
    // finalizing resolve carries them) or an idempotent no-op whose resolution
    // is already pinned to the active graph version.
    console.log('Resolution: unchanged (graph composition identical to the active version)');
    return;
  }
  if ('error' in r.resolution) {
    // Mapper was persisted but the server-side re-resolution failed. Print the
    // actionable message; the CLI exit code stays 0 because the upload itself
    // succeeded. Caller can retry resolution via a no-op push (the duplicate
    // path will trigger another resolveWorkspace).
    console.warn(`Resolution failed on server: ${r.resolution.error}`);
    console.warn("Mapper is stored. Re-run 'coredoc mapper push' to retry resolution.");
    return;
  }
  const { resolved, total, rate, legacyEdges } = r.resolution;
  const pct = total > 0 ? (rate * 100).toFixed(1) : '0.0';
  console.log(`Resolution: ${resolved}/${total} (${pct}%) — ${legacyEdges} via descriptor resolver`);
}

export interface MapperPullOptions {
  workspaceId: string;
  /** Output path. Default: derived from --project via the existing mapper paths helper at the caller. */
  out: string;
  /** Overwrite the local file even if it differs from server content. */
  force?: boolean;
}

export interface MapperPullResult {
  /** True if the local file was written (changed). False if already up to date. */
  written: boolean;
  path: string;
  sha256: string;
}

/**
 * Download the cloud workspace's mapper.json to a local path.
 *
 * Sha-divergence guard: if the local file exists and differs from the
 * remote content, refuse to overwrite unless `force: true`. The remote sha
 * comes from the response ETag (set by MapperController.getMapper) when
 * available, else we recompute locally to compare.
 */
export async function runMapperPull(options: MapperPullOptions): Promise<MapperPullResult> {
  const { getToken, getServerUrl } = await import('../auth.js');
  const token = await getToken();
  if (!token) throw new Error('Not authenticated. Run: coredoc login');
  const serverUrl = await getServerUrl();
  const url = `${serverUrl}/api/v1/workspaces/${options.workspaceId}/mapper`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) {
    throw new Error(`No mapper exists for workspace ${options.workspaceId} (run 'coredoc mapper push' first)`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mapper pull failed (${response.status}): ${body}`);
  }

  const content = await response.text();
  const { createHash } = await import('node:crypto');
  const computeSha = (s: string) => createHash('sha256').update(s).digest('hex');
  const remoteSha = response.headers.get('ETag') ?? computeSha(content);

  if (fs.existsSync(options.out)) {
    const local = fs.readFileSync(options.out, 'utf-8');
    const localSha = computeSha(local);
    if (localSha === remoteSha) {
      return { written: false, path: options.out, sha256: remoteSha };
    }
    if (!options.force) {
      throw new Error(
        `Local mapper at ${options.out} differs from server (local sha=${localSha.slice(0, 8)}, remote sha=${remoteSha.slice(0, 8)}). Pass --force to overwrite.`,
      );
    }
  }

  const dir = path.dirname(options.out);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(options.out, content);
  return { written: true, path: options.out, sha256: remoteSha };
}

export function printMapperPullResult(r: MapperPullResult): void {
  if (!r.written) {
    console.log(`Local mapper is already up to date (sha=${r.sha256.slice(0, 8)}, ${r.path})`);
    return;
  }
  console.log(`Pulled mapper to ${r.path} (sha=${r.sha256.slice(0, 8)})`);
}
