/**
 * Ruby/Rails repo parser — assembles a linker-ready `ParsedRepoLike` plus the
 * intra-repo `entities`/`dbOperations` facts, from the generic Ruby extractors. All
 * extraction is generic Rails/Ruby; per-repo TUNING comes from an optional RubyProfile
 * (globs, enabled sources, ORM base classes / schema path). The cross-repo linker reads
 * only the `ParsedRepoLike` subset — entities/db-ops never affect cross-repo edges.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AnalysisRecord,
  type CallEdge,
  type CallResolutionStats,
  type ClassNode,
  type DbOpResolutionStats,
  type DbOperation,
  type Entrypoint,
  type EntityNode,
  type ExternalCallEdge,
  type FileNode,
  type FunctionNode,
  type Package,
  type ParseError,
  type ParsedRepo,
  type ParsedRepoLike,
  type RepoType,
  StableIdGenerator,
} from '@coredoc/core';
import type { RubyProfile } from '../../types.js';
import { loadOptionalScip, assertScipSources } from '../../facts/scip/source-manifest.js';
import type { IndexerResult } from '../../facts/scip/run-indexer.js';
import { runScipRuby } from './scip-run.js';
import { optionalAnalysis } from '../../facts/scip/index-host.js';
import { makeFileScopeDiscoverer } from '../cst-kit/file-scope.js';
import {
  SHIPPABLE_PROVENANCE,
  countResolvedRubySites,
  emptyRubyCallSiteMeasurement,
  indexRubyDefs,
  resolveRubyCalls,
} from './ruby-callgraph.js';
import { buildRubyMappingHooks, scipRubyToCallEdges, unionRubyCalls } from './ruby-scip.js';
import { resolveGrapeEntrypoints } from './grape-mounts.js';
import { extractRubyDbOps } from './ruby-dbops.js';
import { type RubyAssociationReader, extractRubyEntities } from './ruby-entities.js';
import { extractRubyEgress } from './ruby-egress.js';
import { rubyQueueFromRoot } from './ruby-queue.js';
import { withParsedRuby } from './ruby-cst.js';
import { toRubyFileNodes, toRubyPackages } from './ruby-structure.js';
import { extractRailsRoutes } from './rails-routes.js';
import { parseRailsSchema } from './ruby-schema.js';
import { toParsedRepo } from '../to-parsed-repo.js';

/** Ruby source extensions parsed by the tree-sitter substrate. */
export const RUBY_SOURCE_EXTENSIONS = ['.rb', '.rake'] as const;

/** Empty profile includes mean all Ruby sources, matching the other language substrates. */
export const DEFAULT_RUBY_INCLUDES = ['**/*.rb', '**/*.rake'];

/** Preserve the Ruby substrate's historical vendor/runtime/test/schema skips. */
export const DEFAULT_RUBY_EXCLUDES = [
  '**/vendor/**',
  '**/tmp/**',
  '**/log/**',
  '**/spec/**',
  '**/test/**',
  '**/db/**',
  '**/public/**',
  '**/storage/**',
];

/** The one source-scope contract shared by the Ruby parser and coverage scorer. */
export const discoverRubyFileScope = makeFileScopeDiscoverer({
  extensions: RUBY_SOURCE_EXTENSIONS,
  defaultInclude: DEFAULT_RUBY_INCLUDES,
  defaultExclude: DEFAULT_RUBY_EXCLUDES,
});

export function discoverRubyFiles(
  root: string,
  include: string[],
  exclude: string[] = [],
  excludeDefaults?: boolean,
): string[] {
  return discoverRubyFileScope(root, include, exclude, excludeDefaults).included;
}

/** A full URL → its path (strip scheme + host); a bare path passes through. */
function urlToPath(url: string): string {
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(url.trim());
  if (m) return m[1] ?? '/';
  return url.trim().startsWith('/') ? url.trim() : `/${url.trim()}`;
}

function httpEntrypoint(
  idGen: StableIdGenerator,
  method: string,
  fullPath: string,
  file: string,
  line: number,
): Entrypoint {
  const id = idGen.httpEntrypointId(method, fullPath, file);
  return {
    id,
    versionedId: idGen.versionedId(id, `${method} ${fullPath}`),
    type: 'http',
    handlerId: idGen.functionId(file, `${method} ${fullPath}`),
    location: { filePath: file, startLine: line, endLine: line },
    details: { type: 'http', method: method as never, path: fullPath, fullPath },
  } as Entrypoint;
}

function queueEntrypoint(
  idGen: StableIdGenerator,
  topic: string,
  consumerGroup: string | undefined,
  file: string,
  line: number,
): Entrypoint {
  const id = idGen.queueEntrypointId('kafka', topic, file);
  return {
    id,
    versionedId: idGen.versionedId(id, `kafka:${topic}`),
    type: 'queue',
    handlerId: idGen.functionId(file, `queue:${topic}`),
    location: { filePath: file, startLine: line, endLine: line },
    details: { type: 'queue', system: 'kafka', topic, consumerGroup },
  } as Entrypoint;
}

function httpEgressEdge(
  idGen: StableIdGenerator,
  method: string,
  path: string,
  file: string,
  line: number,
): ExternalCallEdge {
  const callerId = idGen.functionId(file, `egress@${line}`);
  const id = idGen.externalCallId(callerId, '', method, `${file}:${line}:${path}`);
  return {
    id,
    versionedId: idGen.versionedId(id, `${method} ${path}`),
    callerId,
    // NOT the transport literal 'http' — that collides with `unresolvableServices`
    // (which lists 'http') and would exclude every egress call from the linker. The
    // target service is unknown at extraction; the linker recovers it from the route
    // prefix (resolveRepoByRoutePrefix) instead of a service hint.
    serviceName: '',
    method,
    targetDescriptor: { protocol: 'http', http: { method: method as never, pathTemplate: path } },
    location: { filePath: file, startLine: line, endLine: line },
  } as ExternalCallEdge;
}

export interface ParseRubyRepoOptions {
  /** Gateway prefix from RepoConfig.httpPrefix, propagated to the linker for prefix-aware matching. */
  httpPrefix?: string;
  /** Path-independent hash seed for StableIdGenerator (repoHash = hash(repoKey ?? name)); must match the TS path. */
  repoKey?: string;
  /** External directory for verified compiler indexes; the source tree stays read-only. */
  cacheDir?: string;
  /** SCIP index output dir; defaults to `cacheDir`. Must be unique per concurrent target. */
  scipOutDir?: string;
  /**
   * Test/override seam for the Tier-A scip-ruby indexer. Defaults to the prereq-gated
   * `runScipRuby`. In enhanced mode this bypasses the installed-tool prerequisite check, letting a fixture index drive the full Tier-A union path without a toolchain.
   */
  runScip?: (repoRoot: string) => Promise<IndexerResult> | IndexerResult;
}

/** In-module parse stats surfaced on the final ParseStats (built here, not via `assemble()`). */
export interface RubyParseStats {
  analysis?: AnalysisRecord;
  totalFiles: number;
  parsedFiles: number;
  skippedFiles: number;
  parseTimeMs: number;
  /** In-repo call resolution over the enumerated tier-B sites (BR-2, LIM-7). */
  callResolution?: CallResolutionStats;
  /** DB-operation site resolution (BR-4). Absent when the profile configures no db-op lane. */
  dbOpResolution?: DbOpResolutionStats;
}

/** The Ruby parser's full output — the linker reads only the ParsedRepoLike subset. */
export interface RubyParsedRepo extends ParsedRepoLike {
  entities: EntityNode[];
  dbOperations: DbOperation[];
  /** Structure nodes the rest of the graph joins on: the root package + one node per parsed file. */
  packages: Package[];
  files: FileNode[];
  /** One node per `class`/`module` definition — the target of every method's `classId`. */
  classes: ClassNode[];
  /** One entry per file that could not be read — surfaced, not merely counted. */
  errors: ParseError[];
  /** Carrier for the in-module stats (toFullParsedRepo folds these into ParseStats). */
  parseStats: RubyParseStats;
  /**
   * Internal call edges. Tier-A scip-ruby (provenance 'scip', compiler-grade) when the
   * indexer is available, unioned with Tier-B (rb-const + rb-self) for sites scip didn't
   * cover; otherwise Tier-B alone. See ruby-scip.ts + SHIPPABLE_PROVENANCE.
   */
  calls: CallEdge[];
}

/**
 * Parse a Ruby/Rails repo on disk into a `RubyParsedRepo`. Without a profile the
 * defaults reproduce the generic behaviour (Grape + Rails routes + egress, no
 * entities). With a profile, entity/db-op extraction is enabled per its config.
 */
export async function parseRubyRepo(
  root: string,
  name: string,
  opts: ParseRubyRepoOptions = {},
  profile?: RubyProfile,
): Promise<RubyParsedRepo> {
  // One id generator for the whole repo — seeded exactly like the TS path
  // (repoHash = hash(repoKey ?? name)) so Ruby IDs are canonical + cross-repo-consistent.
  const idGen = new StableIdGenerator(root, opts.repoKey ?? name);
  const start = Date.now();

  const include = profile?.substrate.include ?? DEFAULT_RUBY_INCLUDES;
  const exclude = profile?.substrate.exclude ?? [];
  const files = discoverRubyFiles(root, include, exclude, profile?.substrate.excludeDefaults);
  const all: Array<{ relPath: string; source: string }> = [];
  const skippedFiles: string[] = [];
  for (const relPath of files) {
    try {
      all.push({ relPath, source: readFileSync(join(root, relPath), 'utf-8') });
    } catch {
      // Git can retain an unstaged-deleted path; like the other substrates, skip files
      // that disappeared between deterministic discovery and the read.
      skippedFiles.push(relPath);
    }
  }

  // Structure: the root package → one FileNode per source actually read. Emitted for EVERY
  // parsed path (not only the ones a lane produced a symbol for), because every FunctionNode's
  // `fileId` and every EntityNode's `fileId` is minted from the same `idGen.fileId(relPath)`.
  const packages = toRubyPackages(name, idGen);
  const fileNodes = toRubyFileNodes(all, idGen);

  const grapeEnabled = profile?.entrypoints?.grape?.enabled ?? true;
  const railsRoutesEnabled = profile?.entrypoints?.railsRoutes?.enabled ?? true;
  const apiPath = profile?.entrypoints?.grape?.apiPath ?? 'app/api/';
  const routeFile = profile?.entrypoints?.railsRoutes?.routeFile ?? 'config/routes.rb';
  const egressScanPaths = profile?.egress?.scanPaths ?? ['app/', 'lib/'];

  const routesRbAbs = join(root, routeFile);
  const routesRbSource =
    all.find((file) => file.relPath === routeFile)?.source ??
    (existsSync(routesRbAbs) ? readFileSync(routesRbAbs, 'utf-8') : '');

  const entrypoints: Entrypoint[] = [];
  const seen = new Set<string>();
  const addEp = (method: string, path: string, file: string, line: number) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    entrypoints.push(httpEntrypoint(idGen, method, path, file, line));
  };

  if (grapeEnabled) {
    const grapeInputs = all
      .filter((f) => f.relPath.startsWith(apiPath) || f.relPath.endsWith(routeFile))
      .map((f) => ({ relPath: f.relPath, source: f.source }));
    if (routesRbSource && !grapeInputs.some((f) => f.relPath === routeFile)) {
      grapeInputs.push({ relPath: routeFile, source: routesRbSource });
    }
    for (const g of await resolveGrapeEntrypoints(grapeInputs)) addEp(g.method, g.path, g.file, g.line);
  }
  if (railsRoutesEnabled) {
    for (const r of await extractRailsRoutes(routesRbSource)) addEp(r.method, r.path, routeFile, 1);
  }

  // Karafka queue (Kafka consumer) entrypoints — a topic the repo consumes.
  const queueEnabled = profile?.entrypoints?.queue?.enabled ?? true;
  if (queueEnabled) {
    const queueScanPaths = profile?.entrypoints?.queue?.scanPaths ?? ['app/', 'lib/', 'config/'];
    const queueFiles = all.filter(
      (f) => queueScanPaths.some((p) => f.relPath.startsWith(p)) || f.relPath.endsWith('karafka.rb'),
    );
    for (const f of queueFiles) {
      // NOT `root`: that name is the repo ROOT PATH in this function (read again below at
      // `join(root, …)`), and shadowing it with a tree-sitter node made a later edit inside this
      // loop reaching for the repo root fail at runtime rather than at compile time.
      await withParsedRuby(f.source, (queueRoot) => {
        for (const q of rubyQueueFromRoot(queueRoot)) {
          const key = `queue ${q.topic}`;
          if (seen.has(key)) continue;
          seen.add(key);
          entrypoints.push(queueEntrypoint(idGen, q.topic, q.consumerGroup, f.relPath, q.line));
        }
      });
    }
  }

  // Egress: scan app/lib files for outbound HTTP client calls.
  const externalCalls: ExternalCallEdge[] = [];
  const egressOpts = { requestWrappers: profile?.egress?.requestWrappers };
  for (const f of all) {
    if (!egressScanPaths.some((p) => f.relPath.startsWith(p))) continue;
    for (const e of await extractRubyEgress(f.source, egressOpts)) {
      externalCalls.push(httpEgressEdge(idGen, e.method, urlToPath(e.url), f.relPath, e.line));
    }
  }

  // Intra-repo DB facts (entities + db-ops) — only when the profile asks.
  let entities: EntityNode[] = [];
  let dbOperations: DbOperation[] = [];
  let functions: FunctionNode[] = [];
  /** Association readers for the def index — empty without an entity config (models come from `modelGlob`). */
  let associationsByClass: Map<string, RubyAssociationReader[]> | undefined;
  let dbOpResolution: DbOpResolutionStats | undefined;
  if (profile?.entities) {
    const schemaAbs = join(root, profile.entities.schemaPath ?? 'db/schema.rb');
    const schema = existsSync(schemaAbs) ? parseRailsSchema(readFileSync(schemaAbs, 'utf-8')) : new Map();
    const modelPrefix = profile.entities.modelGlob?.split('**')[0] ?? 'app/models/';
    const modelFiles = all.filter((f) => f.relPath.startsWith(modelPrefix));
    const res = await extractRubyEntities(modelFiles, schema, {
      idGen,
      baseClasses: profile.entities.baseClasses ?? ['ApplicationRecord', 'ActiveRecord::Base'],
      orm: profile.entities.orm,
    });
    entities = res.entities;
    associationsByClass = res.associationsByClass;

    if (profile.dbOperations) {
      const opScan = profile.dbOperations.scanPaths ?? ['app/', 'lib/'];
      const dbFiles = all.filter((f) => opScan.some((p) => f.relPath.startsWith(p)));
      const entityNames = new Set(entities.map((e) => e.name));
      const dres = await extractRubyDbOps(dbFiles, entityNames, res.entityIdByName, {
        idGen,
        opMap: profile.dbOperations.opMap,
      });
      dbOperations = dres.dbOperations;
      functions = dres.functions;
      dbOpResolution = dres.stats;
    }
  }

  // Call graph: emit a FunctionNode for EVERY def (not just db-op performers), merged by
  // canonical id (db-op performers are a subset, but add any not already present so no
  // performer node is lost). index.byId nodes win — they carry real endLine/params.
  // Association readers ride in with the defs: `has_many :employees` makes `employees` a callable
  // target on the model although no `def` exists (see `indexRubyDefs`).
  const index = await indexRubyDefs(all, idGen, associationsByClass);
  const fnById = new Map<string, FunctionNode>();
  for (const f of index.byId.values()) fnById.set(f.id, f);
  for (const f of functions) if (!fnById.has(f.id)) fnById.set(f.id, f);
  functions = [...fnById.values()];

  // CALLS — Tier-B baseline: the measured >=0.90-precision tree-sitter tiers (rb-const +
  // rb-self). rb-unique (~0.55 on real code) and unresolved sites are dropped — they would
  // fabricate edges that mislead find-callers. Self-edges (callerId === calleeId) are dropped
  // too, matching the Tier-A and TS SCIP paths (a recursive method is not its own caller).
  const measurement = emptyRubyCallSiteMeasurement();
  const tierB = (await resolveRubyCalls(all, index, idGen, measurement)).filter(
    (e) =>
      e.calleeId !== undefined &&
      e.callerId !== e.calleeId &&
      e.provenance !== undefined &&
      SHIPPABLE_PROVENANCE.has(e.provenance),
  );

  // The optional standalone Sorbet indexer supplements syntax-resolved calls.
  const enhanced = await optionalAnalysis(
    'ruby',
    all.length ? profile?.substrate.analysis : { mode: 'basic' },
    async () => (opts.runScip ? opts.runScip(root) : runScipRuby(root, { outDir: opts.scipOutDir ?? opts.cacheDir })),
    (path) => {
      const scip = loadOptionalScip(path);
      assertScipSources(
        scip,
        all.map((file) => ({ path: file.relPath, source: file.source })),
      );
      return unionRubyCalls(scipRubyToCallEdges(scip, buildRubyMappingHooks(scip, index), idGen), tierB);
    },
  );
  const analysis = enhanced.analysis;
  const calls = enhanced.result ?? tierB;

  console.log(`[coredoc] ruby ${name}: ${analysis.mode} analysis${analysis.fallback ? ' (fallback)' : ''}.`);

  return {
    id: idGen.getRepoHash(),
    name,
    entrypoints,
    externalCalls,
    functions,
    calls,
    type: 'backend',
    httpPrefix: opts.httpPrefix,
    entities,
    dbOperations,
    packages,
    files: fileNodes,
    classes: index.classes,
    // Every unreadable file is reported as a ParseError, not just counted: `stats.skippedFiles`
    // is invisible to the scorecard's silent-failure detector and to the CLI's `parseErrors`
    // gauge, both of which read `repo.errors`.
    errors: skippedFiles.map((file) => ({
      file,
      message: 'ruby: file could not be read',
      severity: 'error' as const,
    })),
    parseStats: {
      analysis,
      totalFiles: files.length,
      parsedFiles: all.length,
      skippedFiles: skippedFiles.length,
      parseTimeMs: Date.now() - start,
      // In-repo call resolution over the tier-B enumeration (LIM-7): a site is resolved when
      // tier B itself shipped an edge for it (counted in the walk) OR — for the sites tier B left
      // unshipped — the shipped union carries an edge at its key.
      callResolution: {
        callSites: measurement.callSites,
        outOfScopeCalls: measurement.outOfScopeCalls,
        resolvedCalls: countResolvedRubySites(measurement, calls),
      },
      dbOpResolution,
    },
  };
}

/**
 * Adapt a `RubyParsedRepo` to a full `ParsedRepo` for the CLI parse → push → DB flow
 * (the DB transformer + MCP/docs consume `ParsedRepo`). `stats` is built here in-module from
 * the parser's own `parseStats` (NOT via `assemble()`); `httpPrefix` is dropped (not a
 * `ParsedRepo` field; applied at link).
 *
 * Packages/files/classes come THROUGH from the parser. The collections that stay empty are the
 * ones Ruby has no construct for (`interfaces`, `typeAliases`, `enums`) plus `imports` and
 * `variables`, which no Ruby lane extracts today: an empty array is the honest report of that.
 */
export function toFullParsedRepo(
  ruby: RubyParsedRepo,
  repoPath: string,
  parserId: string,
  parsedAt: string,
  parserVersion = '1.4.0-ruby',
): ParsedRepo {
  const functions = ruby.functions ?? [];
  const calls = ruby.calls ?? [];
  const s = ruby.parseStats;
  return toParsedRepo(
    {
      id: ruby.id,
      name: ruby.name,
      path: repoPath,
      type: ruby.type as RepoType | undefined,
      parsedAt,
      parserId,
      packages: ruby.packages,
      files: ruby.files,
      functions,
      classes: ruby.classes,
      entrypoints: ruby.entrypoints,
      entities: ruby.entities,
      dbOperations: ruby.dbOperations,
      calls,
      externalCalls: ruby.externalCalls,
      // Carried through so the coverage scorecard's silent-failure detector and the CLI's
      // `parseErrors` gauge (both read `repo.errors`) can see a parse that produced nothing.
      errors: ruby.errors,
      stats: {
        totalFiles: s.totalFiles,
        parsedFiles: s.parsedFiles,
        skippedFiles: s.skippedFiles,
        totalImports: 0,
        parseTimeMs: s.parseTimeMs,
        callResolution: s.callResolution,
        dbOpResolution: s.dbOpResolution,
        analysis: s.analysis,
      },
    },
    { parserVersion },
  );
}
