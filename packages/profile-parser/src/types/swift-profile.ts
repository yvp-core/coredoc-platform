// =============================================================================
// SwiftProfile — declarative per-repo config for the Swift/iOS parser.
//
// A NEW type (not ExtractionProfile, whose primitives are TS-AST-shaped, and not
// RubyProfile). The framework conventions (Moya endpoint tables, Realm models,
// service-container DI) live in generic code under substrate/swift/; this profile
// only TUNES them per repo (globs, ORM base classes, the API-protocol names, the DI
// container accessor). No client-specific strings belong in shared code — only in a
// repo's own profile.ts. The `'swift'` literal is the registry dispatch discriminant.
// =============================================================================
import type { BaseProfile } from './profile-base.js';

export interface SwiftProfile extends BaseProfile {
  parserId: string;
  substrate: { language: 'swift'; include: string[]; exclude?: string[] };
  /**
   * Outbound API egress (the iOS app as a cross-repo consumer of backend services).
   * Endpoints are modeled from enums that conform to a Moya-style `TargetType` protocol.
   */
  egress?: {
    /**
     * Protocol conformances that mark an enum as an API endpoint table. CONFIGURABLE —
     * never hardcode a client's protocol name in shared code. Default: ['TargetType'].
     */
    targetTypeProtocols?: string[];
  };
  /** DB entities (Realm `Object` subclasses, or another ORM base). Omit to skip entity extraction. */
  entities?: {
    /** ORM label surfaced on EntityNode.ormType (e.g. 'realm'). */
    orm: string;
    /**
     * Base classes/protocols that mark a type as a persisted entity — CONFIGURABLE
     * (e.g. ['Object'] for Realm, ['Record'] for GRDB). Never default to a generic base.
     */
    baseClasses?: string[];
  };
  /**
   * DB operations (ORM query call sites). Omit to skip. `opMap` overrides the default Realm
   * verb → operation-kind mapping (e.g. { objects: 'read', safeWrite: 'transaction' }).
   * `entityTypealias` names a per-service model-binding typealias (e.g. 'DBObject' for a
   * `DataService { associatedtype DBObject }` convention) used to attribute an op's entity when
   * no explicit `X.self` argument is present — CONFIGURABLE, never a hardcoded client name.
   */
  dbOperations?: { opMap?: Record<string, string>; entityTypealias?: string };
  /**
   * Dependency-injection resolution for the Tier-B call graph. `containerAccessor` is the
   * receiver chain that fronts service accessors (e.g. 'DI.shared'); the substrate indexes that
   * container's typed properties to resolve `DI.shared.<accessor>.<method>()` calls. Omit to
   * disable DI-accessor resolution (only direct-construction calls resolve).
   */
  di?: { containerAccessor?: string };
}
