/**
 * Public surface of intent derivation (spec §6).
 *
 * The context-read API (§7) and the MCP tools (§11) consume this and nothing
 * deeper: area computation, applicability, bounds and degradation are one
 * decision each, made here.
 */

export {
  IntentDerivationLimit,
  IntentGraphUnavailableCode,
  IntentMatchReason,
  type DerivableFeature,
  type DerivableIntentItem,
  type FeatureArea,
  type FeatureAreaRepoSlice,
  type FeatureSeedRef,
  type IntentDerivationDegradation,
  type IntentDerivationEvidence,
  type IntentDerivationResult,
  type IntentNodeDerivationResult,
  type ItemAnchorEvidence,
  type ItemAnchorRef,
  type ItemApplicability,
  type ItemAttachmentRef,
  type RepoGraphProvenance,
} from './derivation-contract.js';

export {
  DEFAULT_DERIVATION_BOUNDS,
  DerivationBudget,
  resolveDerivationBounds,
  type DerivationBounds,
} from './derivation-bounds.js';

export {
  AREA_CALL_EDGE_TYPES,
  AREA_CONTAINMENT_EDGE_TYPES,
  AREA_HANDLER_EDGE_TYPES,
  computeFeatureArea,
  resolveBatchTraversal,
  type BatchTraversalCapability,
} from './feature-area.js';

export {
  resolveFeatureApplicability,
  resolveNodeApplicability,
  type NodeApplicabilityResult,
} from './applicability.js';

export { graphRemediation, graphUnavailableCode, isProgrammingError } from './graph-degradation.js';
export { assembleRepoProvenance, graphRepoHashByIntentKey } from './graph-provenance.js';

export {
  IntentDerivationService,
  type DeriveFeatureContextRequest,
  type DeriveNodeContextRequest,
} from './intent-derivation.service.js';

export { IntentDerivationModule } from './intent-derivation.module.js';
