// =============================================================================
// RubyProfile — declarative per-repo config for the Ruby/Rails parser.
//
// A NEW type (not ExtractionProfile, whose primitives are TS-AST-shaped). The
// framework conventions (Grape DSL, Rails routing, ActiveRecord) live in generic
// code under substrate/ruby/; this profile only TUNES them per repo (globs, which
// sources are enabled, the ORM base classes / schema path, HTTP-client libs). No
// client-specific strings belong in shared code — only in a repo's own profile.ts.
// =============================================================================
import type { BaseProfile } from './profile-base.js';
import type { IndexPolicy } from '../facts/scip/index-host.js';

export interface RubyProfile extends BaseProfile {
  parserId: string;
  substrate: {
    language: 'ruby';
    include: string[];
    exclude?: string[];
    /**
     * Built-in vendor/tmp/log/spec/test/db/public/storage skips ship in code and the profile's
     * `exclude` EXTENDS them. Set `excludeDefaults: false` to opt out of the built-ins entirely,
     * exactly as the Go/Python/Rust/Zig substrates already allow.
     */
    excludeDefaults?: boolean;
    analysis?: IndexPolicy;
  };
  /** Entrypoint sources. Default (no profile): http both enabled, queue enabled. */
  entrypoints?: {
    grape?: { enabled?: boolean; apiPath?: string };
    railsRoutes?: { enabled?: boolean; routeFile?: string };
    /** Karafka queue (Kafka consumer) entrypoints. Default enabled; scans app/lib/config + karafka.rb. */
    queue?: { enabled?: boolean; scanPaths?: string[] };
  };
  /** Outbound HTTP egress (Rails as a cross-repo consumer). */
  egress?: {
    clientLibs?: string[];
    scanPaths?: string[];
    /**
     * Custom request-wrapper methods that carry verb + url as keyword args (e.g. a shared
     * API client's `send_request(http_method: :post, url: ROUTE)`). The method name is
     * CLIENT-SPECIFIC, so it is declared here per repo — never hardcoded in shared code.
     */
    requestWrappers?: Array<{ method: string; verbArg: string; urlArg: string }>;
  };
  /** ActiveRecord (or other ORM) DB entities. Omit to skip entity extraction. */
  entities?: {
    orm: string;
    /** Model base classes to treat as entities — CONFIGURABLE; never default to a generic `Base`. */
    baseClasses?: string[];
    schemaPath?: string;
    modelGlob?: string;
  };
  /** DB operations (ORM query call sites). Omit to skip. */
  dbOperations?: { opMap?: Record<string, string>; scanPaths?: string[]; rawQuerySql?: boolean };
}
