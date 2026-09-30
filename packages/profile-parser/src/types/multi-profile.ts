// =============================================================================
// MultiTargetProfile — the composite profile for multi-language monorepos.
//
// A target = one language-scoped slice (substrate.language + include globs) with
// its own rule vocabulary. The unit of composition is the LANGUAGE SCOPE, not the
// workspace package: N same-language packages share one target and one SCIP index
// (cross-package call resolution depends on indexing the whole workspace together).
// Workspace-package topology stays engine-internal (facts/workspace.ts).
// =============================================================================
import type { RepoType } from '@coredoc/core/types';
import type { GoProfile } from './go-profile.js';
import type { KotlinProfile } from './kotlin-profile.js';
import type { CSharpProfile } from './csharp-profile.js';
import type { ExtractionProfile } from './profile.js';
import type { PythonProfile } from './python-profile.js';
import type { RubyProfile } from './ruby-profile.js';
import type { RustProfile } from './rust-profile.js';
import type { SwiftProfile } from './swift-profile.js';
import type { ZigProfile } from './zig-profile.js';

/**
 * One language-scoped slice of the repo: a full single-language profile minus
 * `parserId` (inherited from the composite; stamped on before provider dispatch)
 * plus a unique `name` that attributes scorecard sections, merge errors, and
 * per-target incremental cache subdirectories.
 * New languages extend the union here (one wiring point, like providers/index.ts).
 */
export type TargetProfile = (
  | Omit<ExtractionProfile, 'parserId'>
  | Omit<RubyProfile, 'parserId'>
  | Omit<SwiftProfile, 'parserId'>
  | Omit<PythonProfile, 'parserId'>
  | Omit<RustProfile, 'parserId'>
  | Omit<GoProfile, 'parserId'>
  | Omit<ZigProfile, 'parserId'>
  | Omit<KotlinProfile, 'parserId'>
  | Omit<CSharpProfile, 'parserId'>
) & {
  name: string;
};

export interface MultiTargetProfile {
  parserId: string;
  /** Usually 'monorepo'. Surfaces as the merged ParsedRepo.type. */
  repoType?: RepoType;
  targets: TargetProfile[];
}
