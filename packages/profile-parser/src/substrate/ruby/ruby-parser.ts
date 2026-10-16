/**
 * Ruby/Rails substrate — extracts the structural (`packages`/`files`/`classes`) and intra-repo
 * (`entrypoints`/`entities`/`dbOperations`/`calls`/`externalCalls`) facts from the generic Ruby
 * extractors. All extraction is generic Rails/Ruby; per-repo TUNING comes from the RubyProfile
 * (globs, enabled sources, ORM base classes / schema path).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DbOpResolutionStats,
  DbOperation,
  Entrypoint,
  EntityNode,
  ExternalCallEdge,
  FunctionNode,
  HttpMethod,
  StableIdGenerator,
} from '@coredoc/core';
import type { RubyProfile } from '../../types.js';
import { loadOptionalScip, assertScipSources } from '../../facts/scip/source-manifest.js';
import { runScipRuby } from './scip-run.js';
import { optionalAnalysis } from '../../facts/scip/index-host.js';
import { makeFileScopeDiscoverer } from '../cst-kit/file-scope.js';
import { type SourceFile, httpEntrypoint } from '../file-nodes.js';
import type { Substrate } from '../parse-substrate.js';
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

/** A full URL → its path (strip scheme + host); a bare path passes through. */
function urlToPath(url: string): string {
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(url.trim());
  if (m) return m[1] ?? '/';
  return url.trim().startsWith('/') ? url.trim() : `/${url.trim()}`;
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

/**
 * The Ruby/Rails substrate. Without profile knobs the defaults reproduce the generic behaviour
 * (Grape + Rails routes + egress, no entities); entity/db-op extraction is enabled per the
 * profile's config.
 *
 * No `grammar`: Ruby holds no shared trees. Every lane re-parses through `withParsedRuby` and
 * frees the tree before the next parse (peak liveness 1, pinned by ruby-tree-release.test.ts).
 * Its SCIP consumer (source assertion + Tier-A/Tier-B union) differs from the generic merge, so
 * it calls `optionalAnalysis` itself rather than `ctx.enhanceCalls`.
 */
export const rubySubstrate: Substrate<RubyProfile, SourceFile> = {
  language: 'ruby',
  parserVersion: '1.4.1-ruby',
  scope: (profile, root) =>
    discoverRubyFileScope(
      root,
      profile.substrate.include ?? [],
      profile.substrate.exclude ?? [],
      profile.substrate.excludeDefaults,
    ),

  async extract({ root, name, profile, opts, idGen, files: all }) {
    // Structure: the root package → one FileNode per source actually read. Emitted for EVERY
    // parsed path (not only the ones a lane produced a symbol for), because every FunctionNode's
    // `fileId` and every EntityNode's `fileId` is minted from the same `idGen.fileId(relPath)`.
    const packages = toRubyPackages(name, idGen);
    const fileNodes = toRubyFileNodes(all, idGen);

    const grapeEnabled = profile.entrypoints?.grape?.enabled ?? true;
    const railsRoutesEnabled = profile.entrypoints?.railsRoutes?.enabled ?? true;
    const apiPath = profile.entrypoints?.grape?.apiPath ?? 'app/api/';
    const routeFile = profile.entrypoints?.railsRoutes?.routeFile ?? 'config/routes.rb';
    const egressScanPaths = profile.egress?.scanPaths ?? ['app/', 'lib/'];

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
      entrypoints.push(httpEntrypoint(idGen, method as HttpMethod, path, file, line, line));
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
    const queueEnabled = profile.entrypoints?.queue?.enabled ?? true;
    if (queueEnabled) {
      const queueScanPaths = profile.entrypoints?.queue?.scanPaths ?? ['app/', 'lib/', 'config/'];
      const queueFiles = all.filter(
        (f) => queueScanPaths.some((p) => f.relPath.startsWith(p)) || f.relPath.endsWith('karafka.rb'),
      );
      for (const f of queueFiles) {
        // NOT `root`: that name is the repo ROOT PATH here (read again below at `join(root, …)`),
        // and shadowing it with a tree-sitter node made a later edit inside this loop reaching for
        // the repo root fail at runtime rather than at compile time.
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
    const egressOpts = { requestWrappers: profile.egress?.requestWrappers };
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
    if (profile.entities) {
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
      all.length ? profile.substrate.analysis : { mode: 'basic' },
      () => runScipRuby(root, { outDir: opts.scipOutDir }),
      (path) => {
        const scip = loadOptionalScip(path);
        // scip-ruby indexes `.rb` only (see scip-run inputs); `.rake` stays on syntax resolution.
        assertScipSources(
          scip,
          all
            .filter((file) => file.relPath.endsWith('.rb'))
            .map((file) => ({ path: file.relPath, source: file.source })),
        );
        return unionRubyCalls(scipRubyToCallEdges(scip, buildRubyMappingHooks(scip, index), idGen), tierB);
      },
    );
    const analysis = enhanced.analysis;
    const calls = enhanced.result ?? tierB;

    console.log(`[coredoc] ruby ${name}: ${analysis.mode} analysis${analysis.fallback ? ' (fallback)' : ''}.`);

    return {
      type: 'backend',
      entrypoints,
      externalCalls,
      functions,
      calls,
      entities,
      dbOperations,
      packages,
      files: fileNodes,
      classes: index.classes,
      stats: {
        analysis,
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
  },
};
