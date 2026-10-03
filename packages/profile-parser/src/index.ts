export * from './types.js';
// LanguageProvider extension model. Importing the package registers the
// built-in providers (the registry's single wiring point).
export * from './providers/index.js';
export { SubstrateProfileEngine } from './substrate/engine.js';
export { TreeSitterScipSubstrate } from './substrate/tree-sitter-scip.js';
export { runProfile, runSubstrate, runSubstrateWithEngine } from './substrate/run.js';
export { parseMultiTarget } from './multi/orchestrate.js';
export { mergeParsedRepos, type TargetResult } from './multi/merge.js';
export { scoreProfile } from './score.js';
export {
  applyIntegrityReport,
  checkReferentialIntegrity,
  formatViolation,
  isSyntheticHandlerId,
  INTEGRITY_ERROR_FILE,
  IntegrityRef,
  type IntegrityReport,
  type IntegrityViolation,
} from './integrity/referential-integrity.js';
export {
  blockingExtractionErrors,
  callResolutionBlackouts,
  declaredFrontendRules,
  extractionErrorSummary,
  perPackageCallResolution,
  unclaimedFrontendRedFlags,
  unclaimedFrontendSurface,
  type PackageCallResolution,
  type UnclaimedFrontendSignal,
} from './scoring/silent-failure.js';
export {
  assertProfileTypechecks,
  formatProfileCapabilityViolations,
  formatProfileDiagnostics,
  profileCapabilityViolations,
  typecheckProfile,
  ProfileCapabilityError,
  ProfileTypeError,
  type ProfileCapabilityViolation,
  type ProfileDiagnostic,
} from './profile-typecheck.js';
export { lintMessagingSystems, type MessagingSystemWarning } from './messaging-system-lint.js';
export {
  buildSdkMappings,
  generateSdkMappings,
  extractRoute,
  normalizeUri,
  type SdkSource,
  type SdkSourceParsed,
  type SdkSourceRepo,
  type GenerateResult,
} from './sdk-mappings/generate.js';
export type { RubyProfile } from './types.js';
