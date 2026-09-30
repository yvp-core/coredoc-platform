import { z } from 'zod';
import { ALL_HTTP_METHODS, type HttpMethod } from '../types/output.js';
import { normalizeServiceName } from './descriptor-matcher.js';

function canonicalisePathTemplate(input: string): string {
  let out = input.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, ':$1');
  out = out.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, ':$1');
  return out;
}

// Derived from the canonical HttpMethod vocabulary so a new verb (or the `ALL` wildcard) cannot
// be added to the type without the mapper schema accepting it — they drifted apart once already.
const HttpMethodSchema = z.enum(ALL_HTTP_METHODS as unknown as readonly [HttpMethod, ...HttpMethod[]]);

const SdkHttpSchema = z
  .object({
    method: HttpMethodSchema,
    pathTemplate: z.string().min(1).transform(canonicalisePathTemplate),
    pathParams: z.array(z.string()).optional().default([]),
  })
  .strict();

const ServiceEntrySchema = z.object({
  name: z.string().min(1),
  repo: z.string().min(1),
  aliases: z.array(z.string()).optional().default([]),
  /**
   * v2: profile target name inside `repo` (multi-target monorepos). A service is
   * `(repo, target?)`; absent `target` means the whole repo is one service.
   */
  target: z.string().min(1).optional(),
  /**
   * v2: gateway/base-path prefix for THIS service. Overrides `RepoConfig.httpPrefix`
   * (per-repo), so a monorepo can express per-target prefixes (`ui` behind `/app`,
   * `api` behind `/api`) that a single per-repo prefix cannot.
   */
  httpPrefix: z.string().min(1).optional(),
});

const SdkMappingSchema = z.object({
  sdkPackage: z.string().min(1),
  sdkClass: z.string().min(1),
  sdkMethod: z.string().min(1),
  targetService: z.string().min(1),
  http: SdkHttpSchema.optional(),
});

// User-supplied regex compiles at every resolveWorkspace and runs against every
// external-call path in the workspace. To prevent ReDoS (catastrophic
// backtracking), we:
//  1. Cap the source length so a deeply pathological pattern can't fit;
//  2. Reject obvious nested-quantifier shapes (`(a+)+`, `(.*)*`, etc) which
//     are the most common ReDoS source on untrusted input;
//  3. Cap pathRewriteRules.length (below) so the per-resolve cost stays bounded.
// Anything more elaborate (re2, worker-thread timeouts) is a follow-up — these
// three guards make a malicious admin mapper merely slow, not server-killing.
const MAX_REGEX_LENGTH = 200;
const MAX_PATH_REWRITE_RULES = 50;
// Detect (X+)+ / (X*)* / (X+)* / (X*)+ where X is a charset/group — the
// canonical "evil regex" shapes. Conservative; rejects some legitimate patterns
// (rare in pathRewriteRules) in exchange for a single-pass static check.
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*]/;

const PathRewriteRuleSchema = z
  .object({
    match: z
      .string()
      .max(MAX_REGEX_LENGTH, `pathRewriteRules.match exceeds ${MAX_REGEX_LENGTH} chars`)
      .refine((s) => !NESTED_QUANTIFIER_RE.test(s), {
        message:
          'pathRewriteRules.match contains nested quantifiers (potential ReDoS); rewrite without (...+)+ / (...*)*',
      })
      .refine(
        (s) => {
          try {
            new RegExp(s);
            return true;
          } catch {
            return false;
          }
        },
        { message: 'pathRewriteRules.match must be a valid regular expression' },
      ),
    targetServiceFrom: z.string().min(1),
  })
  .strict();

export const MapperSchema = z
  .object({
    // v1 and v2 documents are both valid. v1 parses into the v2 internal shape
    // with `target`/`httpPrefix` simply absent on every service (see writing
    // policy: `pickMapperSchemaVersion` writes 2 only when a v2 field is used).
    $schemaVersion: z.union([z.literal(1), z.literal(2)]),
    project: z.string().min(1),
    services: z.array(ServiceEntrySchema),
    // sdkMappings is an OPTIONAL override. In-workspace SDKs are resolved by
    // the substrate moniker hop (no declared rows needed); explicit rows are kept
    // ONLY for published-only SDKs whose source is not in the workspace (spec §7,
    // D3). Defaults to [] so callers (mapper-engine `for (const m of
    // mapper.sdkMappings)`, status/diff counts) never see undefined.
    sdkMappings: z.array(SdkMappingSchema).optional().default([]),
    pathRewriteRules: z
      .array(PathRewriteRuleSchema)
      .max(MAX_PATH_REWRITE_RULES, `pathRewriteRules exceeds ${MAX_PATH_REWRITE_RULES} entries`),
    unresolvableServices: z.array(z.string().min(1)),
  })
  .strict();

export type Mapper = z.infer<typeof MapperSchema>;
export type ServiceEntry = z.infer<typeof ServiceEntrySchema>;
export type SdkMapping = z.infer<typeof SdkMappingSchema>;
export type PathRewriteRule = z.infer<typeof PathRewriteRuleSchema>;

export interface MapperValidationError {
  path: (string | number)[];
  message: string;
}

export function validateMapper(
  input: unknown,
): { ok: true; mapper: Mapper } | { ok: false; errors: MapperValidationError[] } {
  const result = MapperSchema.safeParse(input);
  if (result.success) return { ok: true, mapper: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({ path: i.path as (string | number)[], message: i.message })),
  };
}

/**
 * Pick the `$schemaVersion` to WRITE for a mapper. v2 only when some service uses
 * a v2-only field (`target` or `httpPrefix`); otherwise keep writing 1 so an
 * all-v1 mapper round-trips through the cloud unchanged (cloud contract may not
 * yet accept literal 2 — see `runMapperPush`). This is the single writing-policy
 * point every generic mapper writer routes through.
 */
export function pickMapperSchemaVersion(
  services: ReadonlyArray<{ name?: string; repo?: string; aliases?: string[]; target?: string; httpPrefix?: string }>,
): 1 | 2 {
  return services.some((s) => s.target !== undefined || s.httpPrefix !== undefined) ? 2 : 1;
}

/**
 * External evidence the semantic checks cross-reference against. Both fields are
 * optional — checks that need evidence not supplied are skipped (never guessed).
 */
export interface MapperSemanticContext {
  /**
   * repo name → the set of `FileNode.target` values present in that repo's parsed
   * output (loaded from `outputDir`). Enables the stale-target warning.
   */
  targetsByRepo?: Record<string, ReadonlySet<string>>;
  /** repo name → `RepoConfig.httpPrefix` from config. Enables the config cross-check. */
  repoHttpPrefixes?: Record<string, string | undefined>;
}

/** Errors fail validation; warnings are advisory (printed, do not fail). */
export interface MapperSemanticReport {
  errors: MapperValidationError[];
  warnings: MapperValidationError[];
}

/**
 * Semantic (cross-field / cross-artifact) checks that run AFTER the mapper parses
 * against the Zod schema. Pure — testable without CLI plumbing. Closes the audited
 * lifecycle gaps (spec §4.3):
 *   (a) every `sdkMappings[].targetService` resolves through
 *       `services[].name ∪ aliases ∪ unresolvableServices` — else error listing orphans.
 *       (pathRewriteRules produce path-derived names at RUNTIME; a captured name must
 *       itself land in this set, so rules never statically rescue an orphan.)
 *   (b) `(repo, target ?? '')` uniqueness across `services` — else error.
 *   (b2) `services[].name` uniqueness under `normalizeServiceName` — else error naming
 *       both `(repo, target)` identities. `buildServiceRepoMap` keys a Map by this same
 *       normalized name; an undetected collision is silent last-write-wins at resolve
 *       time (misrouted calls). Scope: names only, not aliases (out of scope).
 *   (c) stale-target warning: a service `target` that no parsed file in `repo` claims.
 *   (d) config cross-check warning: a repo carrying BOTH `RepoConfig.httpPrefix` and a
 *       per-service `httpPrefix` — print the effective precedence (service wins).
 */
export function checkMapperSemantics(mapper: Mapper, ctx: MapperSemanticContext = {}): MapperSemanticReport {
  const errors: MapperValidationError[] = [];
  const warnings: MapperValidationError[] = [];

  // (a) orphan targetService sweep. Normalized the same way the runtime resolver
  // (`buildServiceRepoMap` / `translateServiceToRepo`) does, so a targetService that
  // only differs by case/whitespace from a declared name doesn't false-positive here.
  const known = new Set<string>();
  for (const s of mapper.services) {
    known.add(normalizeServiceName(s.name));
    for (const a of s.aliases) known.add(normalizeServiceName(a));
  }
  for (const u of mapper.unresolvableServices) known.add(normalizeServiceName(u));
  mapper.sdkMappings.forEach((m, i) => {
    if (!known.has(normalizeServiceName(m.targetService))) {
      errors.push({
        path: ['sdkMappings', i, 'targetService'],
        message: `targetService "${m.targetService}" resolves through no services[].name / alias / unresolvableServices entry (orphan)`,
      });
    }
  });

  // (b) (repo, target ?? '') uniqueness. JSON-encoded key (not string-joined) so a
  // repo name containing whitespace can't collide with an unrelated (repo, target) pair.
  const seen = new Map<string, number>();
  mapper.services.forEach((s, i) => {
    const key = JSON.stringify([s.repo, s.target ?? '']);
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({
        path: ['services', i],
        message: `duplicate service identity (repo="${s.repo}", target="${s.target ?? ''}") — also declared at services[${first}]`,
      });
    } else {
      seen.set(key, i);
    }
  });

  // (b2) services[].name uniqueness under normalizeServiceName. Fires for all
  // sources — discover-side disambiguation, hand edits, or a merge — so a
  // colliding name is caught before it can silently misroute at resolve time.
  const seenNames = new Map<string, number>();
  mapper.services.forEach((s, i) => {
    const norm = normalizeServiceName(s.name);
    const first = seenNames.get(norm);
    if (first !== undefined) {
      const other = mapper.services[first]!;
      errors.push({
        path: ['services', i, 'name'],
        message:
          `duplicate service name "${s.name}" (normalized) — collides with services[${first}].name "${other.name}"; ` +
          `identities (repo="${other.repo}", target="${other.target ?? ''}") and (repo="${s.repo}", target="${s.target ?? ''}") ` +
          'would collide in buildServiceRepoMap (last-write-wins)',
      });
    } else {
      seenNames.set(norm, i);
    }
  });

  // (c) stale-target warning (only when parsed output evidence is supplied).
  if (ctx.targetsByRepo) {
    mapper.services.forEach((s, i) => {
      if (s.target === undefined) return;
      const present = ctx.targetsByRepo?.[s.repo];
      if (present && !present.has(s.target)) {
        warnings.push({
          path: ['services', i, 'target'],
          message: `target "${s.target}" is not present in any parsed file of repo "${s.repo}" (stale target name?)`,
        });
      }
    });
  }

  // (d) config cross-check warning (only when config prefixes are supplied).
  if (ctx.repoHttpPrefixes) {
    mapper.services.forEach((s, i) => {
      if (s.httpPrefix === undefined) return;
      const repoPrefix = ctx.repoHttpPrefixes?.[s.repo];
      if (repoPrefix !== undefined) {
        warnings.push({
          path: ['services', i, 'httpPrefix'],
          message: `service "${s.name}" httpPrefix "${s.httpPrefix}" overrides RepoConfig.httpPrefix "${repoPrefix}" for repo "${s.repo}" (effective: "${s.httpPrefix}")`,
        });
      }
    });
  }

  return { errors, warnings };
}
