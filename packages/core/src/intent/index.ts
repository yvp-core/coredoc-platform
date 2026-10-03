/**
 * Shared product-intent contracts. Product intent is owned by a cloud workspace;
 * these are the kinds, payload validators, condition evaluation, id derivation
 * and anchor-resolution helpers the server, web, desktop, CLI and evals share.
 *
 * This barrel is re-exported wholesale from `@coredoc/core`, so everything named
 * here is a CROSS-PACKAGE contract that changing later requires impact analysis
 * for. It therefore lists only what another package actually imports. The
 * sibling modules import each other BY FILE PATH, so a symbol only they use
 * stays module-internal rather than widening the public surface for free.
 */
export {
  DecisionStatus,
  INTENT_ID_MAX_LENGTH,
  INTENT_ID_PREFIX_BY_KIND,
  IntentAuthority,
  IntentKind,
  IntentSourceKind,
  type BusinessRulePayload,
  type CapabilityPayload,
  type CodeAnchor,
  type ContextCondition,
  type DimensionValueSelection,
  type DecisionPayload,
  type FlowBranch,
  type FlowPayload,
  type FlowStep,
  type IntentContext,
  type IntentDimension,
  type IntentDimensionValue,
  type IntentItemContextConditions,
  type IntentSourceRef,
  type LimitationPayload,
  type RuleVariant,
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
  validateIntentPayload,
  type IntentValidationError,
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

export { canonicalIntentJson } from './canonical-json.js';

export {
  INTENT_ANCHOR_WARNING,
  INTENT_CONTEXT_LIMITS,
  IntentMatchReason,
  defaultIntentLimit,
} from './context-contract.js';

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
