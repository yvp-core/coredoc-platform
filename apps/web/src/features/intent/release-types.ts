import type { IntentAuthority } from './types.js';
export type IntentEffectivity = 'effective' | 'planned' | 'withdrawn' | 'not_effective' | 'unknown';
export type IntentPlanState = 'none' | 'active' | 'withdrawn' | 'consumed';
export type IntentReleaseAction = 'release' | 'baseline' | 'rollback' | 'plan' | 'withdraw' | 'reinstate';
export interface IntentCurrentRelease {
  seq: number;
  deliveredRef: string;
  recordedAt: string;
}
export interface IntentReleasePreview {
  deliveryImpact: {
    ancestors: string[];
    replaces: { itemId: string; title: string }[];
    blockingSuccessors: { itemId: string; title: string }[];
  };
  itemId: string;
  authority: IntentAuthority;
  version: number;
  contentHash: string;
  content: { kind: string; title: string; statement: string; rationale: string | null; payload: unknown };
  effectivity: IntentEffectivity;
  planState: IntentPlanState;
  sources: { kind: string; ref: string; localId: string }[];
  headSeq: number;
  currentRelease: IntentCurrentRelease | null;
}
export interface IntentReleaseEntry {
  titles?: Record<string, string>;
  seq: number;
  kind: IntentReleaseAction;
  deliveredRef: string | null;
  reason: string;
  recordedAt: string;
  recordedBy: string;
  rolledBack: boolean;
  /** Provenance, lifted onto the entry by `IntentReleaseService.list`; absent only on pre-actor events. */
  actorKind?: ReleaseActorKind;
  pr?: ReleasePr;
  /** The deployment's own clock (`deployedAt`/`mergedAt`), never the server's. */
  orderingToken?: string;
  data: {
    included?: string[];
    retired?: string[];
    ancestors?: string[];
    itemId?: string;
    releaseSeq?: number;
    repoKey?: string;
    deployId?: string;
  };
}
export interface IntentReleaseHistory {
  entries: IntentReleaseEntry[];
  nextBeforeSeq: number | null;
  headSeq: number;
  currentReleaseSeq: number | null;
  currentRelease: IntentCurrentRelease | null;
}
export interface IntentReleaseWrite {
  idempotencyKey: string;
  expectedHeadSeq: number;
  /**
   * Required only on `plan` and `rollback` (amendment §3.2). Omitted elsewhere,
   * which is how the server is told to store its own default.
   */
  reason?: string;
  kind?: 'release' | 'baseline';
  deliveredRef?: string;
  included?: { itemId: string; contentHash: string }[];
  retired?: string[];
  itemId?: string;
  expectedVersion?: number;
  releaseSeq?: number;
}

export const effectivityLabels: Record<IntentEffectivity, string> = {
  effective: 'In production',
  planned: 'Planned',
  withdrawn: 'Plan withdrawn',
  not_effective: 'No longer in production',
  unknown: 'No recorded evidence',
};

/**
 * WHO wrote the event — mirrors `ReleaseActorKind` in
 * apps/server/src/modules/intent/intent-release.fold.ts. The server stamps
 * every event it writes, plan-side ones included; it is absent only on events
 * written before the automatic actors shipped, so render it when it is there
 * rather than assuming a maintainer wrote what we cannot attribute.
 */
export enum ReleaseActorKind {
  Maintainer = 'maintainer',
  Connector = 'connector',
  Ci = 'ci',
}
/** The PR a delivery came from — `(repoKey, number)`, never a bare number (amendment §1). */
export interface ReleasePr {
  repoKey: string;
  number: number;
  url?: string;
}
/** Workspace setting `intentReleaseTrigger` (amendment §2); `manual` is today's behaviour. */
export enum IntentReleaseTrigger {
  Manual = 'manual',
  Merge = 'merge',
  Deploy = 'deploy',
}
export const releaseTriggerLabels: Record<IntentReleaseTrigger, string> = {
  [IntentReleaseTrigger.Manual]: 'Manual',
  [IntentReleaseTrigger.Merge]: 'On merge',
  [IntentReleaseTrigger.Deploy]: 'On deploy',
};
export const releaseTriggerExplain: Record<IntentReleaseTrigger, string> = {
  [IntentReleaseTrigger.Manual]: 'Deliveries are recorded here, by a maintainer.',
  [IntentReleaseTrigger.Merge]: 'A pull request merged into the production branch records the delivery.',
  [IntentReleaseTrigger.Deploy]: 'The CI step after a production deploy records the delivery.',
};
