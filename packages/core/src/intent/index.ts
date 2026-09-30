/**
 * Product-intent overlay (`<repoRoot>/.coredoc/intent.json`).
 *
 * Durable, human-reviewed product knowledge stored beside the code graph — not
 * part of the rebuildable `ParsedRepo`/`OutputFormat` contract.
 *
 * This barrel is re-exported wholesale from `@coredoc/core`, so everything named
 * here is a CROSS-PACKAGE contract that changing later requires impact analysis
 * for. It therefore lists only what another package actually imports (today: the
 * CLI, the MCP intent tool, and the intent eval harness). The sibling modules
 * import each other BY FILE PATH, so a symbol only they use stays module-internal
 * rather than widening the public surface for free.
 */
export {
  DecisionStatus,
  INTENT_ID_MAX_LENGTH,
  INTENT_ID_PREFIX_BY_KIND,
  INTENT_SCHEMA_VERSION,
  IntentAuthority,
  IntentKind,
  IntentRelationType,
  IntentSourceKind,
  type BusinessRuleItem,
  type BusinessRulePayload,
  type CapabilityItem,
  type CapabilityPayload,
  type CodeAnchor,
  type ContextCondition,
  type DimensionValueSelection,
  type DecisionItem,
  type DecisionPayload,
  type FlowBranch,
  type FlowItem,
  type FlowPayload,
  type FlowStep,
  type IntentContext,
  type IntentDimension,
  type IntentDimensionValue,
  type IntentDomain,
  type IntentFileV2,
  type IntentItem,
  type IntentItemContextConditions,
  type IntentItemProposal,
  type IntentRelation,
  type IntentSourceRef,
  type LimitationItem,
  type LimitationPayload,
  type RuleVariant,
  type UseCaseItem,
  type UseCasePayload,
  type VersionedAnchorNodeType,
  VERSIONED_ANCHOR_NODE_TYPES,
} from './types.js';

export {
  ContextConditionSchema,
  ContextConditionsSchema,
  INTENT_LIMITS,
  TreeConditionsSchema,
  IntentContextSchema,
  IntentDimensionSchema,
  IntentValidationCode,
  LEGACY_SCHEMA_REMEDIATION,
  formatIntentValidationErrors,
  validateIntentFile,
  validateIntentPayload,
  type IntentValidationError,
  type IntentValidationOptions,
  type IntentValidationResult,
} from './schema.js';

export {
  ConditionLevel,
  ConditionReasonCode,
  ContextMatchState,
  RegistryIssueCode,
  VariantIssueCode,
  VariantResolutionState,
  checkVariantOverlap,
  composeEffectiveConditions,
  evaluateContextConditions,
  evaluateEffectiveConditions,
  resolveVariants,
  validateAgainstRegistry,
  validateContext,
  type ConditionItemLookup,
  type ConditionItemRef,
  type ConditionReason,
  type ContextConditionsEvaluation,
  type EffectiveConditionsEvaluation,
  type LeveledConditions,
  type RegistryIssue,
  type VariantIssue,
  type VariantResolution,
} from './context-conditions.js';

export {
  HintKind,
  detectMissingConditionHints,
  detectVariantHints,
  type AmbiguousVariantsHint,
  type AuthoringHint,
  type DeadVariantHint,
  type MissingConditionHint,
} from './authoring-hints.js';

export {
  IntentLocalWriteBlockedError,
  assertLocalIntentWritable,
  repoHashesForProject,
  resolveCloudAuthority,
  resolveIntentTarget,
  type IntentCloudAuthority,
  type IntentTarget,
  type IntentTargetConfig,
  type LocalIntentWriteConfig,
  type RepoHashProjectConfig,
} from './target.js';

export {
  IntentOverlayStatus,
  MAX_INTENT_FILE_BYTES,
  MAX_INTENT_IMPORT_BODY_BYTES,
  canonicalIntentJson,
  describeJsonErrorPosition,
  readIntentFile,
  serializeIntentFile,
  writeIntentFile,
  type ReadIntentFileOptions,
  type ReadIntentFileResult,
} from './storage.js';

export {
  INTENT_ANCHOR_WARNING,
  INTENT_CONTEXT_LIMITS,
  INTENT_INDEX_LIMITS,
  IntentMatchReason,
  IntentQueryError,
  IntentQueryErrorCode,
  defaultIntentLimit,
  listIntentIndex,
  selectIntentContext,
  type IntentIndexEntry,
  type IntentIndexRequest,
  type IntentIndexResult,
  type IntentQueryMatch,
  type IntentQueryRequest,
  type IntentQueryResult,
} from './query.js';

export {
  IntentOverlayInvalidError,
  IntentProposalsInvalidError,
  captureIntoIntentFile,
  parseIntentProposalsDocument,
  type CaptureIntoIntentFileOptions,
  type CaptureIntoIntentFileResult,
} from './capture-file.js';

export { IntentCaptureError, type CaptureItemResult } from './capture.js';

export {
  BROWNFIELD_TEXT_LIMITS,
  BrownfieldCandidateFraming,
  BrownfieldPacketInvalidError,
  BrownfieldSourceClass,
  MAX_BROWNFIELD_PACKET_CANDIDATES,
  MAX_BROWNFIELD_PACKET_CONFLICTS,
  MAX_BROWNFIELD_PACKET_SOURCES,
  MAX_BROWNFIELD_SOURCE_REFS,
  brownfieldProposeItems,
  parseBrownfieldPacket,
  type BrownfieldCandidate,
  type BrownfieldPacket,
  type BrownfieldPacketConflict,
  type BrownfieldPacketSource,
  type BrownfieldProposal,
} from './brownfield.js';

export { parseAnchorEnvelope } from './anchor-mapping.js';
export { resolveAnchorEnvelope, type EnvelopeResolution } from './anchor-resolver.js';
export type {
  AnchorBinding,
  AnchorEnvelope,
  AnchorRecord,
  ResolvedTarget,
  ResolvedMapping,
  ParsedRepoGraphSnapshot,
} from './anchor-mapping-types.js';
