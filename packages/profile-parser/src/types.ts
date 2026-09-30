/**
 * ExtractionProfile schema — the declarative, per-repo convention config the AI
 * authors and the generic engine interprets. Transcribed from
 * docs/superpowers/specs/2026-06-17-extraction-profile-schema.md.
 *
 * Nothing here is repo-specific: it is a vocabulary of detector *shapes* and
 * argument-extraction *references*. The repo specifics (decorator names, callee
 * names, op maps, …) live in the concrete profile objects under ./profiles.
 *
 * This file is a re-export barrel: the types live under ./types/, grouped by rule
 * family. Importers keep using `../types.js` and `export * from './types.js'`.
 */

export * from './types/db-ops.js';
export * from './types/detectors.js';
export * from './types/entities.js';
export * from './types/entrypoints.js';
export * from './types/external-calls.js';
export * from './types/frontend.js';
export * from './types/profile-base.js';
export * from './types/profile.js';
export * from './types/multi-profile.js';
export * from './types/ruby-profile.js';
export * from './types/swift-profile.js';
export * from './types/python-profile.js';
export * from './types/rust-profile.js';
export * from './types/go-profile.js';
export * from './types/zig-profile.js';
export * from './types/kotlin-profile.js';
export * from './types/csharp-profile.js';
