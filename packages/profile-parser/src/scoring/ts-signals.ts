// =============================================================================
// TS/JS source signals + structural checks for the coverage scorer.
//
// The language-specific denominators (pre-scan greps over .ts/.js, declared-entity
// counting, queue-decorator counting) and TS structural integrity (validate-output
// errors + dangling/no-handler red flags) that the TypeScript LanguageProvider
// supplies to the shared score-core. Kept separate from score.ts so the provider can
// import it without a cycle (score.ts, the CLI, imports the providers).
// =============================================================================
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateRepoFiles } from '../facts/discovery/discover.js';
import { globMatches } from '../substrate/glob.js';
import type { SignalHit } from './cluster-report.js';
import { operatedEntityCount, type ScoreContext, type SourceSignals, type StructuralResult } from './score-core.js';
import type { ConventionEntityRule, EntityRule, ExtractionProfile } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runScript(script: string, args: string[]): string {
  // Desktop bundles this module into a main-process chunk. Its existing schema
  // override names the real profile-parser package, which also ships the scripts.
  const packageDir = process.env.COREDOC_PROFILE_SCHEMA_DIR?.trim() || path.resolve(__dirname, '../..');
  try {
    return execFileSync(process.execPath, [path.join(packageDir, 'scripts', script), ...args], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e: unknown) {
    const stdout = (e as { stdout?: Buffer | string }).stdout;
    if (stdout) return stdout.toString();
    throw e;
  }
}

/**
 * Static source roots from include globs (e.g. `apps/web/src/**` →
 * `apps/web/src`). Keeping the full non-glob prefix prevents one monorepo
 * target's source-signal scans from walking sibling packages.
 */
function includeRoots(include: string[], repoRoot: string): string[] {
  const roots = new Set<string>();
  for (const g of include) {
    const segments = g.replace(/\\/g, '/').split('/');
    const staticSegments: string[] = [];
    for (const segment of segments) {
      if (/[*?{[]/.test(segment)) break;
      if (segment) staticSegments.push(segment);
    }
    if (staticSegments.length === 0) {
      roots.add(repoRoot);
      continue;
    }
    const candidate = path.join(repoRoot, ...staticSegments);
    if (!existsSync(candidate)) continue;
    roots.add(statSync(candidate).isDirectory() ? candidate : path.dirname(candidate));
  }
  return roots.size ? [...roots] : [repoRoot];
}

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/;
const TEST_SOURCE = /(?:^|\/)(?:__tests?|__mocks?)(?:\/|$)|\.(?:spec|test)\.[^/]+$/;
const GREP_BATCH_SIZE = 256;

interface ExactSourceScope {
  include: readonly string[];
  exclude: readonly string[];
  /** Exact repo-relative files selected by provider.sourceFiles for a real score run. */
  sourceFiles?: readonly string[];
}

function sourceFiles(repoRoot: string, roots: string[], scope?: ExactSourceScope): string[] {
  const exactFiles = scope?.sourceFiles;
  const files = (exactFiles ?? enumerateRepoFiles(repoRoot))
    .filter((rel) =>
      exactFiles
        ? true
        : SOURCE_EXTENSION.test(rel) &&
          !TEST_SOURCE.test(rel) &&
          (!scope || globMatches(rel, [...scope.include], [...scope.exclude])),
    )
    .map((rel) => path.join(repoRoot, rel))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        // `git ls-files` can report an unstaged-deleted or sparse tracked path.
        return false;
      }
    });
  if (exactFiles) return files;
  return files.filter((file) =>
    roots.some((root) => {
      const rel = path.relative(root, file);
      return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
    }),
  );
}

/**
 * Grep raw `file:line:text` lines over an explicit extractor-aligned file list. Only portable
 * macOS/BSD grep flags are used because packaged Desktop intentionally runs with `/usr/bin` PATH.
 * NB: patterns are BRE: `(` is literal and alternation is `\|`.
 */
function grepSourceLines(roots: string[], bre: string, repoRoot: string, scope?: ExactSourceScope): string[] {
  const files = sourceFiles(repoRoot, roots, scope);
  const lines: string[] = [];
  for (let start = 0; start < files.length; start += GREP_BATCH_SIZE) {
    const batch = files.slice(start, start + GREP_BATCH_SIZE);
    try {
      const out = execFileSync('grep', ['-Hn', '-e', bre, ...batch], {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      lines.push(...out.split('\n').filter(Boolean));
    } catch (error: unknown) {
      const result = error as { status?: number; stderr?: Buffer | string };
      if (result.status === 1) continue;
      const detail = result.stderr?.toString().trim();
      throw new Error(`Source scan failed${detail ? `: ${detail}` : ''}`, { cause: error });
    }
  }
  return lines;
}

/** Count lines matching a grep BRE within the source scope. */
function countSourcePattern(roots: string[], bre: string, repoRoot: string, scope?: ExactSourceScope): number {
  return grepSourceLines(roots, bre, repoRoot, scope).length;
}

/**
 * Grep hits as `{file, line, text}` for the cluster report — `file` repo-relative,
 * `text` trimmed and capped at 200 chars (the report's samples slice further).
 * NB: the hit-parsing regex must stay in sync with `toHits` in scripts/pre-scan.mjs.
 */
function grepSourceHits(roots: string[], bre: string, repoRoot: string, scope?: ExactSourceScope): SignalHit[] {
  return grepSourceLines(roots, bre, repoRoot, scope).flatMap((l) => {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    return m ? [{ file: path.relative(repoRoot, m[1]), line: Number(m[2]), text: m[3].trim().slice(0, 200) }] : [];
  });
}

/** BRE matching `@<Decorator>(` occurrences for the given decorator names. */
const decoratorsBre = (decorators: string[]): string => decorators.map((d) => `@${d}(`).join('\\|');

/** Count `@<Decorator>(` occurrences for the given decorator names. */
function countSourceDecorators(
  roots: string[],
  decorators: string[],
  repoRoot: string,
  scope?: ExactSourceScope,
): number {
  return countSourcePattern(roots, decoratorsBre(decorators), repoRoot, scope);
}

/**
 * Grep BRE that counts call sites of a `call-shape` callee. A leading `*.` wildcard
 * receiver (`*.define`) becomes a method-call match (`\.define(`); a qualified callee
 * (`sequelize.define`) matches verbatim; a bare name (`initHandler`) matches as a call.
 */
function calleeGrepPattern(callee: string): string {
  if (callee.startsWith('*.')) return `\\.${callee.slice(2).replace(/\./g, '\\.')}(`;
  return `${callee.replace(/\./g, '\\.')}(`;
}

/**
 * Precise entity source-signal count from the profile's DECLARED entity rules:
 *   - prisma            → `model X {` blocks in the schema file
 *   - class-decorator   → `@<name>(` decorators in source (TypeORM/MikroORM `@Entity`)
 *   - call-shape        → factory `define()` call sites in source (Sequelize)
 * Trusts a declared source even when its count is 0. Falls back to `fallback` (the broad
 * pre-scan grep) ONLY when the profile declares no recognizable entity source.
 */
export function entitySourceCount(
  entities: EntityRule[] | undefined,
  include: string[],
  repoRoot: string,
  fallback: number,
  exclude: string[] = [],
  includedSourceFiles?: readonly string[],
): number {
  const rules = entities ?? [];
  if (rules.length === 0) return fallback;
  const roots = includeRoots(include, repoRoot);
  const scope = { include, exclude, sourceFiles: includedSourceFiles };
  let total = 0;
  let recognized = false;
  for (const rule of rules) {
    if (rule.orm === 'prisma' && 'schemaPath' in rule) {
      recognized = true;
      const abs = path.join(repoRoot, rule.schemaPath);
      if (existsSync(abs)) total += readFileSync(abs, 'utf8').match(/^\s*model\s+\w+\s*\{/gm)?.length ?? 0;
      continue;
    }
    const detect = (rule as ConventionEntityRule).detect;
    if (detect?.via === 'class-decorator') {
      recognized = true;
      total += countSourceDecorators(roots, [detect.name], repoRoot, scope);
    } else if (detect?.via === 'call-shape') {
      recognized = true;
      total += countSourcePattern(roots, calleeGrepPattern(detect.callee), repoRoot, scope);
    }
  }
  return recognized ? total : fallback;
}

/**
 * Known HTTP-client npm deps → the BRE that counts their call sites. A dep's grep runs
 * only when the dep is declared in the repo manifest, so the loose patterns (`fetch(`,
 * `got(`) stay scoped to repos that actually use the client.
 */
const HTTP_CLIENT_CALL_PATTERNS: Record<string, string> = {
  axios: 'axios\\.\\|axios(',
  got: 'got(\\|got\\.',
  'node-fetch': 'fetch(',
  undici: 'request(\\|fetch(',
  superagent: 'superagent(\\|superagent\\.',
  ky: 'ky(\\|ky\\.',
  '@nestjs/axios': 'httpService\\.\\|\\.axiosRef\\.',
};

/** Constructed API-client sites: `new UsersApi(…)` / `new BillingClient(…)`. */
const CONSTRUCTED_CLIENT_PATTERN = 'new [A-Z][A-Za-z0-9]*\\(Api\\|Client\\)(';

/**
 * `*Client` constructors that are infra/storage clients, not HTTP egress a
 * profile can emit — a `new PrismaClient(…)` site would otherwise inflate the
 * externalCalls denominator with sites no egress matcher can ever claim.
 * Extend as new false-positive constructors are found.
 */
const NON_HTTP_CLIENT_CONSTRUCTORS = [
  'PrismaClient',
  'MongoClient',
  'RedisClient',
  'S3Client',
  'DynamoDBClient',
  'DynamoDBDocumentClient',
  'SNSClient',
  'SQSClient',
  'SESClient',
  'SecretsManagerClient',
  'KafkaClient',
  'WebSocketClient',
  'LambdaClient',
];

/** JS regex twin of CONSTRUCTED_CLIENT_PATTERN — extracts the constructor name from a hit line. */
const CONSTRUCTED_CLIENT_NAME_RE = /new ([A-Z][A-Za-z0-9]*(?:Api|Client))\(/;

/** Parse one package.json's declared deps — fail-fast, naming the file that didn't parse. */
function readManifestDeps(manifestPath: string): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
  } catch (e) {
    throw new Error(`Cannot parse ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Every package.json under `dir` (node_modules and dot-dirs skipped), depth-bounded —
 * workspace repos declare per-package HTTP deps the root manifest never sees.
 */
function findManifests(dir: string, depth = 4): string[] {
  const manifests: string[] = [];
  const manifest = path.join(dir, 'package.json');
  if (existsSync(manifest)) manifests.push(manifest);
  if (depth === 0) return manifests;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    manifests.push(...findManifests(path.join(dir, entry.name), depth - 1));
  }
  return manifests;
}

/**
 * externalCalls source-signal hit list (externalCallsSourceCount = its length): call
 * sites of HTTP-client deps declared in the repo's manifests (the root
 * `${repoRoot}/package.json` plus every package.json under the profile's include
 * roots — monorepo packages declare their own deps), plus constructed `new *Api(…)` /
 * `new *Client(…)` client sites (infra/storage constructors excluded — see
 * NON_HTTP_CLIENT_CONSTRUCTORS). Returns undefined when no HTTP-client dep is present
 * AND no constructed client is found — the category then stays self-relative, so
 * pure-frontend / clientless repos don't false-FAIL.
 */
export function externalCallsSourceHits(
  include: string[],
  repoRoot: string,
  exclude: string[] = [],
  includedSourceFiles?: readonly string[],
): SignalHit[] | undefined {
  const roots = includeRoots(include, repoRoot);
  const scope = { include, exclude, sourceFiles: includedSourceFiles };

  // Aggregate `dependencies` across the root manifest AND every package
  // manifest under the include roots (deduped — a root of `.` walks repoRoot).
  const manifestPaths = new Set<string>();
  const rootManifest = path.join(repoRoot, 'package.json');
  if (existsSync(rootManifest)) manifestPaths.add(rootManifest);
  for (const root of roots) for (const m of findManifests(root)) manifestPaths.add(m);

  let deps: Record<string, string> = {};
  for (const manifestPath of manifestPaths) {
    deps = { ...deps, ...(readManifestDeps(manifestPath).dependencies ?? {}) };
  }
  const presentDeps = Object.keys(HTTP_CLIENT_CALL_PATTERNS).filter((d) => d in deps);

  const constructed = grepSourceHits(roots, CONSTRUCTED_CLIENT_PATTERN, repoRoot, scope).filter((hit) => {
    const name = hit.text.match(CONSTRUCTED_CLIENT_NAME_RE)?.[1];
    return !name || !NON_HTTP_CLIENT_CONSTRUCTORS.includes(name);
  });
  if (presentDeps.length === 0 && constructed.length === 0) return undefined;

  const hits = [...constructed];
  for (const dep of presentDeps) hits.push(...grepSourceHits(roots, HTTP_CLIENT_CALL_PATTERNS[dep], repoRoot, scope));
  // Overlapping patterns (node-fetch `fetch(` vs undici `request(|fetch(`, or a
  // constructed client on a client-call line) can match the same line — dedupe
  // by file:line so one call site counts once in the denominator.
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.file}:${hit.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** externalCalls source-signal count (see externalCallsSourceHits). */
export function externalCallsSourceCount(
  include: string[],
  repoRoot: string,
  exclude: string[] = [],
): number | undefined {
  return externalCallsSourceHits(include, repoRoot, exclude)?.length;
}

/**
 * Deps whose presence is EVIDENCE the entity set is generated from the DB
 * schema — the only case where `schemaMirror: true` earns the operated-entity
 * dbOperations denominator. Without one of these in the scored repo's root
 * manifest (`dependencies` ∪ `devDependencies`) the flag is ignored, because
 * the operated-entity basis is trivially gameable (≥1 op ⇒ ratio 1) and must
 * not be claimable by assertion alone.
 */
export const ENTITY_GENERATOR_DEPS = ['@mikro-orm/entity-generator', 'typeorm-model-generator', 'sequelize-auto'];

/** Note rendered on the dbOperations scorecard row when schemaMirror lacks evidence. */
export const SCHEMA_MIRROR_IGNORED_NOTE = 'schemaMirror ignored (no entity-generator dependency found)';

/** Whether the repo's root manifest declares any entity-generator dep (schemaMirror evidence). */
function hasEntityGeneratorDep(repoRoot: string): boolean {
  const manifestPath = path.join(repoRoot, 'package.json');
  if (!existsSync(manifestPath)) return false;
  const manifest = readManifestDeps(manifestPath);
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  return ENTITY_GENERATOR_DEPS.some((dep) => dep in deps);
}

const KAFKA_QUEUE_DEPS = ['kafkajs'];
const NATS_QUEUE_DEPS = ['nats', '@nats-io/transport-node', '@nats-io/jetstream'];
const REDIS_QUEUE_DEPS = ['redis', '@redis/client', 'ioredis'];

function declaredQueueDependencies(repoRoot: string, roots: string[]): Set<string> {
  const manifestPaths = new Set<string>();
  const rootManifest = path.join(repoRoot, 'package.json');
  if (existsSync(rootManifest)) manifestPaths.add(rootManifest);
  for (const root of roots) for (const manifestPath of findManifests(root)) manifestPaths.add(manifestPath);

  const dependencies = new Set<string>();
  for (const manifestPath of manifestPaths) {
    const manifest = readManifestDeps(manifestPath);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) dependencies.add(name);
  }
  return dependencies;
}

const hasAnyDependency = (dependencies: Set<string>, names: string[]): boolean =>
  names.some((name) => dependencies.has(name));

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function importsDependency(source: string, dependencies: string[]): boolean {
  return dependencies.some((dependency) => {
    const moduleName = `${escapeRegExp(dependency)}(?:/[^'"]*)?`;
    return new RegExp(`(?:from\\s*|require\\s*\\(\\s*)['"]${moduleName}['"]`).test(source);
  });
}

function addAssignedReceivers(receivers: Set<string>, source: string, rhs: RegExp): void {
  for (const match of source.matchAll(rhs)) receivers.add(match[1]);
}

/**
 * Detect subscription calls only when both the package manifest and the receiver's
 * construction identify a real messaging client. This restores KafkaJS/NATS/Redis
 * denominators without treating ubiquitous store/Supabase/RxJS `.subscribe()` calls
 * as queue entrypoints.
 */
function dependencyGatedQueueHits(roots: string[], repoRoot: string, scope: ExactSourceScope): SignalHit[] {
  const dependencies = declaredQueueDependencies(repoRoot, roots);
  const hasKafka = hasAnyDependency(dependencies, KAFKA_QUEUE_DEPS);
  const hasNats = hasAnyDependency(dependencies, NATS_QUEUE_DEPS);
  const hasRedis = hasAnyDependency(dependencies, REDIS_QUEUE_DEPS);
  if (!hasKafka && !hasNats && !hasRedis) return [];

  const hits: SignalHit[] = [];
  for (const file of sourceFiles(repoRoot, roots, scope)) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const receivers = new Set<string>();

    if (hasKafka) {
      addAssignedReceivers(
        receivers,
        source,
        /(?:\b(?:const|let|var)\s+)?((?:this\.)?[A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*(?:await\s+)?[^;\n]*?\.\s*consumer\s*\(/g,
      );
    }

    if (hasNats && importsDependency(source, NATS_QUEUE_DEPS)) {
      addAssignedReceivers(
        receivers,
        source,
        /(?:\b(?:const|let|var)\s+)?((?:this\.)?[A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*(?:await\s+)?(?:nats\s*\.\s*)?connect\s*\(/g,
      );
      for (let previousSize = -1; previousSize !== receivers.size; ) {
        previousSize = receivers.size;
        for (const match of source.matchAll(
          /(?:\b(?:const|let|var)\s+)?((?:this\.)?[A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*(?:await\s+)?((?:this\.)?[A-Za-z_$][\w$]*)\s*\.\s*jetstream\s*\(/g,
        )) {
          if (receivers.has(match[2])) receivers.add(match[1]);
        }
        for (const match of source.matchAll(
          /(?:\b(?:const|let|var)\s+)?((?:this\.)?[A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*(?:await\s+)?jetstream\s*\(\s*((?:this\.)?[A-Za-z_$][\w$]*)/g,
        )) {
          if (receivers.has(match[2])) receivers.add(match[1]);
        }
      }
    }

    if (hasRedis && importsDependency(source, REDIS_QUEUE_DEPS)) {
      addAssignedReceivers(
        receivers,
        source,
        /(?:\b(?:const|let|var)\s+)?((?:this\.)?[A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*(?:await\s+)?(?:redis\s*\.\s*)?createClient\s*\(/g,
      );
      addAssignedReceivers(
        receivers,
        source,
        /(?:\b(?:const|let|var)\s+)?((?:this\.)?[A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*new\s+(?:IO)?Redis\s*\(/g,
      );
      for (let previousSize = -1; previousSize !== receivers.size; ) {
        previousSize = receivers.size;
        for (const match of source.matchAll(
          /(?:\b(?:const|let|var)\s+)?((?:this\.)?[A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*((?:this\.)?[A-Za-z_$][\w$]*)\s*\.\s*duplicate\s*\(/g,
        )) {
          if (receivers.has(match[2])) receivers.add(match[1]);
        }
      }
    }

    source.split(/\r?\n/).forEach((text, index) => {
      for (const match of text.matchAll(/\b((?:this\.)?[A-Za-z_$][\w$]*)\s*\.\s*subscribe\s*\(/g)) {
        if (!receivers.has(match[1])) continue;
        hits.push({ file: path.relative(repoRoot, file), line: index + 1, text: text.trim().slice(0, 200) });
        break;
      }
    });
  }
  return hits;
}

/**
 * Queue fallback grep — evidence-rich framework shapes only. A bare `.subscribe(` is
 * intentionally absent: RxJS, state stores, and Supabase Realtime use that ubiquitous
 * shape without declaring queue entrypoints.
 * NB: keep in sync with QUEUE_PATTERN in scripts/pre-scan.mjs.
 */
const QUEUE_FALLBACK_PATTERN =
  '@EventPattern(\\|@MessagePattern(\\|@SqsMessageHandler(\\|new Consumer(\\|\\bon_message\\b';

const ENTITY_FALLBACK_PATTERN = '@Entity(\\|@Table(\\|@model(\\|Base\\.metadata\\|db\\.Model';

/**
 * Queue source-signal hit list (queueSourceCount = its length). When the profile
 * declares queue rules, count those rules' own detector shapes. Otherwise a frontend
 * has no queue surface → 0 (not_applicable); other repo types use the evidence-rich
 * fallback scoped to the profile's include roots.
 */
export function queueSourceHits(
  profile: ExtractionProfile,
  repoRoot: string,
  includedSourceFiles?: readonly string[],
): SignalHit[] {
  const roots = includeRoots(profile.substrate.include, repoRoot);
  const scope = {
    include: profile.substrate.include,
    exclude: profile.substrate.exclude ?? [],
    sourceFiles: includedSourceFiles,
  };
  const queueRules = (profile.entrypoints ?? []).filter((entrypoint) => entrypoint.kind === 'queue');
  if (queueRules.length > 0) {
    const patterns = queueRules.flatMap((rule) => {
      const detector = rule.detect;
      if (detector.via === 'call-shape') return [calleeGrepPattern(detector.callee)];
      if (detector.via === 'class-decorator') return [decoratorsBre([detector.name])];
      return [decoratorsBre(Array.isArray(detector.names) ? detector.names : Object.keys(detector.names))];
    });
    const seen = new Set<string>();
    return patterns
      .flatMap((pattern) => grepSourceHits(roots, pattern, repoRoot, scope))
      .filter((hit) => {
        const key = `${hit.file}:${hit.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  const hits = dependencyGatedQueueHits(roots, repoRoot, scope);
  if (profile.repoType !== 'frontend') hits.push(...grepSourceHits(roots, QUEUE_FALLBACK_PATTERN, repoRoot, scope));
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.file}:${hit.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Queue source-signal count (see queueSourceHits). */
export function queueSourceCount(profile: ExtractionProfile, repoRoot: string): number {
  return queueSourceHits(profile, repoRoot).length;
}

/**
 * Source-signal denominators for the cli/grpc/graphql entrypoint kinds, derived from
 * the profile's OWN declared rules (like the queue path): grpc/graphql count their
 * decorator occurrences, cli counts its command call-shape sites. Each stays
 * `undefined` when the profile declares no such rule, so the category is
 * self-relative (not_applicable) for repos without that surface.
 */
export function entrypointKindSignals(
  profile: ExtractionProfile,
  repoRoot: string,
  includedSourceFiles?: readonly string[],
): { cli?: number; grpc?: number; graphql?: number } {
  const eps = profile.entrypoints ?? [];
  const roots = includeRoots(profile.substrate.include, repoRoot);
  const scope = {
    include: profile.substrate.include,
    exclude: profile.substrate.exclude ?? [],
    sourceFiles: includedSourceFiles,
  };

  const grpcDecorators = eps.flatMap((e) =>
    e.kind === 'grpc' && 'detect' in e && e.detect.via === 'method-decorator' ? Object.keys(e.detect.names) : [],
  );
  const gqlDecorators = eps.flatMap((e) => (e.kind === 'graphql' ? Object.keys(e.operation) : []));
  const cliCallees = eps.flatMap((e) =>
    e.kind === 'cli' && 'detect' in e && e.detect.via === 'call-shape' ? [e.detect.callee] : [],
  );

  return {
    grpc: grpcDecorators.length ? countSourceDecorators(roots, grpcDecorators, repoRoot, scope) : undefined,
    graphql: gqlDecorators.length ? countSourceDecorators(roots, gqlDecorators, repoRoot, scope) : undefined,
    cli: cliCallees.length
      ? cliCallees.reduce((n, callee) => n + countSourcePattern(roots, calleeGrepPattern(callee), repoRoot, scope), 0)
      : undefined,
  };
}

/**
 * TS source-signal denominators: pre-scan grep counts, with the queue category counting
 * the profile's own decorator names when declared (precise, else a scoped shape grep;
 * frontends without a queue rule score not_applicable), entities counting the
 * declared entity source (Prisma schema / `@Entity` / `*.define`), externalCalls
 * counting HTTP-client call sites gated on the manifest deps, and dbOperations
 * switching to the operated-entity denominator on `schemaMirror` profiles —
 * honored only with entity-generator evidence (see ENTITY_GENERATOR_DEPS);
 * flagged-without-evidence keeps the all-entities basis and notes the ignore.
 * The grep-backed categories (http/queue/externalCalls) also expose their per-hit
 * lists for the unclaimed-site cluster report.
 */
export function tsSourceSignals(ctx: ScoreContext): SourceSignals {
  const profile = ctx.profile as ExtractionProfile;
  const roots = includeRoots(profile.substrate.include, ctx.repoRoot);
  const includedSourceFiles = ctx.sourceFiles;
  const includedSourceFileSet = new Set(includedSourceFiles.map((file) => file.split(path.sep).join('/')));
  const preScanRoots = roots.includes(ctx.repoRoot)
    ? []
    : roots.map((root) => path.relative(ctx.repoRoot, root).split(path.sep).join('/'));
  const preScan = JSON.parse(runScript('pre-scan.mjs', [ctx.repoRoot, ctx.outPath, ...preScanRoots]));
  const inProfileScope = (file: string): boolean => {
    const normalized = file.split(path.sep).join('/');
    return includedSourceFileSet.has(normalized);
  };
  // The standalone pre-scan intentionally recognizes several languages. A TS
  // target must score only its own exact include/exclude scope; otherwise sibling
  // Go/Python targets or TS packages inflate its denominator.
  const httpHits = ((preScan.hits?.httpPatterns ?? []) as SignalHit[])
    .map((hit) => ({ ...hit, file: hit.file.split(path.sep).join('/') }))
    .filter((hit) => inProfileScope(hit.file));
  const fallbackEntityFiles = new Set(
    grepSourceHits(roots, ENTITY_FALLBACK_PATTERN, ctx.repoRoot, {
      include: profile.substrate.include,
      exclude: profile.substrate.exclude ?? [],
      sourceFiles: includedSourceFiles,
    })
      .filter((hit) => inProfileScope(hit.file))
      .map((hit) => hit.file),
  ).size;

  const queueHits = queueSourceHits(profile, ctx.repoRoot, includedSourceFiles);
  const entities = entitySourceCount(
    profile.entities,
    profile.substrate.include,
    ctx.repoRoot,
    fallbackEntityFiles,
    profile.substrate.exclude ?? [],
    includedSourceFiles,
  );
  const externalCallHits = externalCallsSourceHits(
    profile.substrate.include,
    ctx.repoRoot,
    profile.substrate.exclude ?? [],
    includedSourceFiles,
  );

  // schemaMirror is an evidence-gated claim, not an assertion: only a repo
  // whose manifest carries an entity-generator dep gets the operated-entity
  // basis; otherwise the default all-entities denominator stays and the
  // scorecard row says why.
  let dbOperations: number | undefined;
  let dbOperationsNote: string | undefined;
  if (profile.schemaMirror === true) {
    if (hasEntityGeneratorDep(ctx.repoRoot)) dbOperations = operatedEntityCount(ctx.parsed);
    else dbOperationsNote = SCHEMA_MIRROR_IGNORED_NOTE;
  }

  return {
    http: httpHits.length,
    queue: queueHits.length,
    entities,
    externalCalls: externalCallHits?.length,
    dbOperations,
    ...entrypointKindSignals(profile, ctx.repoRoot, includedSourceFiles),
    ...(dbOperationsNote ? { dbOperationsNote } : {}),
    hits: {
      http: httpHits,
      queue: queueHits,
      ...(externalCallHits ? { externalCalls: externalCallHits } : {}),
    },
  };
}

/**
 * TS structural integrity: validate-output.mjs errors (MUST be 0) + the entrypoint
 * handler consistency checks. (The entities-but-no-dbOps red flag is language-neutral
 * and lives in score-core's coverageRedFlags.)
 */
export function tsStructuralChecks(ctx: ScoreContext): StructuralResult {
  const validate = JSON.parse(runScript('validate-output.mjs', [ctx.outPath]));
  const errors: string[] = validate.errors ?? [];

  const entrypoints = ctx.parsed.entrypoints ?? [];
  const functionIds = new Set((ctx.parsed.functions ?? []).map((f) => f.id));
  const redFlags: string[] = [];
  const epNoHandler = entrypoints.filter((e) => !e.handlerId).length;
  if (epNoHandler > 0) redFlags.push(`${epNoHandler} entrypoint(s) without a handlerId`);
  const epDangling = entrypoints.filter((e) => e.handlerId && !functionIds.has(e.handlerId)).length;
  if (epDangling > 0) redFlags.push(`${epDangling} entrypoint(s) with a dangling handlerId`);

  return { errors, redFlags };
}
