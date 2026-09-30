import { createHash } from 'node:crypto';
import type { FeaturePlanPrimaryVerifier } from '../cases/feature-implementation-plan.js';
import type { SelectedCell } from './target-loader.js';
import { compareCodeUnits } from './deterministic-order.js';
import type {
  CaseId,
  PrimaryAdmission,
  PrimaryVerifierId,
} from './types.js';

export interface PrimarySourcePredicate {
  file: string;
  targetAbsent: string[];
  sourcePresent: string[];
}

export interface PrimaryRegistration {
  verifierId: PrimaryVerifierId;
  repoKey: string;
  caseId: Extract<CaseId, 'feature-implementation-plan'>;
  snapshotCommit: string;
  artifactBaseCommit: string;
  sourceCommit: string;
  artifact: PrimaryAdmission['artifact'];
  observer: string;
  decision: string;
  cellContractHash: string;
  sourcePredicates: PrimarySourcePredicate[];
  verifier: FeaturePlanPrimaryVerifier;
}

// No primary cell is registered in this snapshot, so every primary selection is
// rejected as an unknown verifier. A registration pins one exact historical cell.
const registrations: Record<PrimaryVerifierId, PrimaryRegistration> = {};

export function isRegisteredPrimaryVerifier(verifierId: string): boolean {
  return Object.hasOwn(registrations, verifierId);
}

export function getPrimaryRegistration(verifierId: PrimaryVerifierId): PrimaryRegistration {
  if (!isRegisteredPrimaryVerifier(verifierId)) {
    throw new Error(`Unknown registered primary verifier: ${String(verifierId)}.`);
  }
  return registrations[verifierId]!;
}

function sameArtifact(
  actual: PrimaryAdmission['artifact'],
  expected: PrimaryAdmission['artifact'],
): boolean {
  return actual.kind === expected.kind && actual.ref === expected.ref;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function primaryCellContractHash(selected: SelectedCell): string {
  return createHash('sha256')
    .update(stableJson({ params: selected.cell.params, truth: selected.cell.truth }))
    .digest('hex');
}

export function assertRegisteredPrimary(opts: {
  repoKey: string;
  targetSha: string;
  selected: SelectedCell;
}): PrimaryRegistration {
  const { selected } = opts;
  const admission = selected.cell.admission;
  if (selected.cell.lifecycle !== 'primary' || !admission) {
    throw new Error(`${selected.caseId}: registered primary admission is required.`);
  }
  const registration = getPrimaryRegistration(admission.verifierId);
  const provenance = selected.cell.provenance;
  const valid =
    opts.repoKey === registration.repoKey &&
    selected.caseId === registration.caseId &&
    opts.targetSha.toLowerCase() === registration.snapshotCommit &&
    provenance.kind === 'historical-diff' &&
    provenance.snapshotCommit === registration.snapshotCommit &&
    provenance.sourceCommit === registration.sourceCommit &&
    provenance.artifactBaseCommit === registration.artifactBaseCommit &&
    sameArtifact(admission.artifact, registration.artifact) &&
    admission.observer === registration.observer &&
    admission.decision === registration.decision &&
    primaryCellContractHash(selected) === registration.cellContractHash;
  if (!valid) {
    throw new Error(
      `${selected.caseId}: registered primary ${admission.verifierId} does not match its exact repository, artifact, or revision binding.`,
    );
  }
  return registration;
}
