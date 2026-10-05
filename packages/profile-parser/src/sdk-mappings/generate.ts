/**
 * Auto-generate the declarative `sdkMappings` table for the cross-repo linker's
 * moniker-independent fallback (HYBRID cross-repo recovery).
 *
 * WHY: the symbol hop cannot resolve SDK-mediated calls when the client is defined
 * locally in the consumer (a `local:` moniker, no package join key) or when the
 * consumer's `node_modules` lack the SDK package. The linker's declarative
 * sdkMapping fallback recovers those by looking up (sdk class/package, method) →
 * route. The routes are SOURCED from the IN-WORKSPACE SDK source repos we already
 * parse — each exported client method's OWN captured egress IS the route table.
 *
 * `targetService` is derived from the route path via the base mapper's
 * `pathRewriteRules` (config-driven — NO client-specific names live in this module);
 * rows whose service cannot be derived are dropped (`targetService` is required).
 *
 * The pure {@link buildSdkMappings} does the derivation from already-parsed repos
 * (unit-tested); {@link generateSdkMappings} parses the sources first, then delegates.
 */

import { type Mapper, type SdkMapping, validateMapper } from '@coredoc/core';
import { runProfile } from '../substrate/run.js';
import type { ExtractionProfile } from '../types.js';

/** Captured http egress descriptor shape the builder reads off a parsed method. */
interface EgressHttp {
  method: string;
  pathTemplate: string;
}

/** Minimal parsed-repo shape {@link buildSdkMappings} reads (a subset of ParsedRepo). */
export interface SdkSourceRepo {
  functions: ReadonlyArray<{
    id: string;
    name: string;
    kind: 'function' | 'method';
    classId?: string;
    moniker?: { packageName: string; descriptor: string };
  }>;
  externalCalls: ReadonlyArray<{
    callerId: string;
    targetDescriptor?: { http?: EgressHttp };
  }>;
  classes: ReadonlyArray<{ id: string; name: string }>;
}

/** An already-parsed SDK source repo, restricted to its published package(s). */
export interface SdkSourceParsed {
  name: string;
  repo: SdkSourceRepo;
  /** Published SDK package names — only methods whose moniker package matches are emitted. */
  packages: string[];
}

/** An SDK source repo to parse: the authored profile + its root + published packages. */
export interface SdkSource {
  name: string;
  root: string;
  profile: ExtractionProfile;
  packages: string[];
}

export interface GenerateResult {
  sdkMappings: SdkMapping[];
  perRepo: Record<string, { emitted: number; noService: number }>;
  mapper: Mapper;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

/**
 * Normalize a captured uri/path template into a clean route path. Mirrors the
 * engine's `normalizeUrlTemplate`: `${expr}` → `{ident}`, drop query, ensure a
 * single leading slash, collapse slashes. Returns undefined for non-path text.
 */
export function normalizeUri(raw: string): string | undefined {
  let s = raw.trim();
  s = s.replace(/\$\{([^}]*)\}/g, (_f, expr: string) => {
    const id = /([A-Za-z0-9_]+)\s*$/.exec(String(expr).trim());
    return `{${id ? id[1] : 'p'}}`;
  });
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  // A `{url}` / `{baseUrl}` leading placeholder is the entrypoint base, not a path segment.
  s = s.replace(/^\{[A-Za-z0-9_]*url[A-Za-z0-9_]*\}/i, '');
  if (/[([]/.test(s)) return undefined; // contains a function call → not a static path
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/+/g, '/').replace(/\/$/, '');
  return s.length > 1 ? s : undefined;
}

/**
 * Extract { method, uri } from a method's captured egress http descriptor. Three
 * shapes occur across SDK sources:
 *  1. Clean route — `pathTemplate` already `/path`, `method` a verb.
 *  2. Wrapper shape — real `/path` in `pathTemplate` but `method` is the callee name
 *     upper-cased (e.g. `REQUEST`); treat any non-standard verb + real path as GET.
 *  3. Object-literal text (rare fallback) — parse `uri:`/`method:` out of the text.
 */
export function extractRoute(http: EgressHttp): { method: string; uri: string } | undefined {
  // SDKs that join a base URL with a relative path (`get(baseUrl, 'v2/management/…')`)
  // capture the route without its leading slash; normalizeUri adds it back.
  const isPath = /^\/|^[\w{}-]+\//.test(http.pathTemplate) && !/\s/.test(http.pathTemplate);
  if (HTTP_METHODS.has(http.method) && isPath) {
    const uri = normalizeUri(http.pathTemplate);
    return uri ? { method: http.method, uri } : undefined;
  }
  if (!HTTP_METHODS.has(http.method) && isPath) {
    const uri = normalizeUri(http.pathTemplate);
    return uri ? { method: 'GET', uri } : undefined;
  }
  const uriM = /\buri\s*:\s*[`'"]([^`'"\n]*)/.exec(http.pathTemplate);
  if (!uriM) return undefined;
  const methodM = /\bmethod\s*:\s*[`'"]([A-Za-z]+)[`'"]/.exec(http.pathTemplate);
  const method = methodM ? methodM[1].toUpperCase() : 'GET';
  if (!HTTP_METHODS.has(method)) return undefined;
  const uri = normalizeUri(uriM[1]);
  return uri ? { method, uri } : undefined;
}

/** Compile the base mapper's pathRewriteRules → derive a targetService from a path. */
function buildServiceDeriver(
  pathRewriteRules: ReadonlyArray<{ match: string; targetServiceFrom: string }>,
): (pathTemplate: string) => string | undefined {
  const compiled = pathRewriteRules.map((r) => ({ re: new RegExp(r.match), group: r.targetServiceFrom }));
  return (pathTemplate) => {
    for (const { re, group } of compiled) {
      const captured = pathTemplate.match(re)?.groups?.[group];
      if (captured) return captured;
    }
    return undefined;
  };
}

/**
 * PURE: derive the `sdkMappings` table from already-parsed SDK source repos and
 * merge it into `baseMapper` (preserving services / pathRewriteRules / unresolvable).
 * Throws when the merged mapper fails schema validation. Deterministic: rows are
 * deduped by `package::class::method` and sorted, so regeneration is a clean diff.
 */
export function buildSdkMappings(sources: readonly SdkSourceParsed[], baseMapper: Mapper): GenerateResult {
  const deriveService = buildServiceDeriver(baseMapper.pathRewriteRules ?? []);

  /** A pre-validation row; `validateMapper` narrows `method` to the HttpMethod enum. */
  type SdkMappingDraft = {
    sdkPackage: string;
    sdkClass: string;
    sdkMethod: string;
    targetService: string;
    http: { method: string; pathTemplate: string };
  };
  /** key `${pkg}::${class}::${method}` → row, deduped. */
  const rows = new Map<string, SdkMappingDraft>();
  const perRepo: Record<string, { emitted: number; noService: number }> = {};

  for (const src of sources) {
    // Join each method node to its FIRST http egress (callerId === method.id).
    const egressByCaller = new Map<string, EgressHttp>();
    for (const e of src.repo.externalCalls) {
      const http = e.targetDescriptor?.http;
      if (http && !egressByCaller.has(e.callerId)) egressByCaller.set(e.callerId, http);
    }
    const classNameById = new Map(src.repo.classes.map((c) => [c.id, c.name]));

    let emitted = 0;
    let noService = 0;
    for (const fn of src.repo.functions) {
      if (fn.kind !== 'method' || !fn.moniker) continue;
      const pkg = fn.moniker.packageName;
      if (!src.packages.includes(pkg)) continue; // only the published SDK surface
      const http = egressByCaller.get(fn.id);
      if (!http) continue;
      const route = extractRoute(http);
      if (!route) continue;
      const targetService = deriveService(route.uri);
      if (!targetService) {
        noService += 1;
        continue; // targetService is required — drop undeducible rows
      }
      const sdkClass = fn.classId ? (classNameById.get(fn.classId) ?? 'Client') : 'Client';
      const key = `${pkg}::${sdkClass}::${fn.name}`;
      if (rows.has(key)) continue;
      rows.set(key, {
        sdkPackage: pkg,
        sdkClass,
        sdkMethod: fn.name,
        targetService,
        http: { method: route.method, pathTemplate: route.uri },
      });
      emitted += 1;
    }
    perRepo[src.name] = { emitted, noService };
  }

  const sorted = [...rows.values()].sort((a, b) =>
    `${a.sdkPackage}${a.sdkClass}${a.sdkMethod}`.localeCompare(`${b.sdkPackage}${b.sdkClass}${b.sdkMethod}`),
  );

  const merged = { ...baseMapper, sdkMappings: sorted };
  const result = validateMapper(merged);
  if (!result.ok) {
    const detail = result.errors
      .slice(0, 10)
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw new Error(`generated sdkMappings failed validateMapper: ${detail}`);
  }
  return { sdkMappings: result.mapper.sdkMappings, perRepo, mapper: result.mapper };
}

/**
 * Parse each SDK source repo (via its authored profile), then build the table.
 * Side effect: runs the profile-parser substrate over each source repo on disk.
 */
export async function generateSdkMappings(opts: {
  sdkSources: readonly SdkSource[];
  baseMapper: Mapper;
}): Promise<GenerateResult> {
  const parsed: SdkSourceParsed[] = [];
  for (const src of opts.sdkSources) {
    const { repo } = await runProfile(src.profile, src.root, src.name, src.name);
    parsed.push({ name: src.name, repo: repo as unknown as SdkSourceRepo, packages: src.packages });
  }
  return buildSdkMappings(parsed, opts.baseMapper);
}
