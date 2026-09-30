/**
 * Ephemeral brownfield bootstrap packets (spec §8.2).
 *
 * A packet classifies the sources behind one bounded domain/risk slice and
 * cross-checks them BEFORE anything is proposed. It is deliberately not a write
 * path and not a persisted shape: only `candidates[].proposal` leaves this
 * module, and it leaves through the ordinary `intent_propose` call. The wrapper
 * — classes, owners, conflicts — is review evidence for the session, never
 * workspace content.
 *
 * The value here is the ENFORCED source-authority matrix: observed
 * implementation cannot be laundered into a product claim by an agent that
 * read some code, a stale source cannot enter without a named decision owner
 * for the question it raises, and a proposal cannot cite provenance it never
 * classified.
 *
 * Boundary note: a `proposal` is validated against the shape
 * `ProposedIntentItemSchema` (`apps/server`, the propose contract) accepts, so a
 * validated packet's proposals go through `intent_propose` 1:1. That contract is
 * authoritative and re-validates everything, including the optional per-kind
 * `payload` (D9) which is passed through here as a bounded JSON object rather
 * than re-implemented — one payload validator in the product, and it is the one
 * the server already reaches through `validateIntentFile`.
 */
import { z } from 'zod';
import { ContextConditionsSchema, INTENT_LIMITS } from './schema.js';
import { canonicalIntentJson } from './storage.js';
import { INTENT_SLUG_PATTERN, IntentKind, IntentSourceKind } from './types.js';

/**
 * Candidates per packet. Mirrors the propose contract's batch bound: a packet
 * that cannot be proposed in one call is not a packet, it is a scan.
 */
export const MAX_BROWNFIELD_PACKET_CANDIDATES = 10;

/** Classified sources per packet. A slice needing more evidence is two slices. */
export const MAX_BROWNFIELD_PACKET_SOURCES = 20;

/** Open questions per packet; each one is a human decision the maintainer owes. */
export const MAX_BROWNFIELD_PACKET_CONFLICTS = 10;

/** Sources named by one conflict entry or cited by one candidate. */
export const MAX_BROWNFIELD_SOURCE_REFS = 10;

/** Bounded free text inside the wrapper: risk theme, owner, decision owner, question. */
export const BROWNFIELD_TEXT_LIMITS = {
  riskTheme: 200,
  owner: 200,
  question: 500,
} as const;

/**
 * How much product authority a source can carry. A class is provenance, never a
 * confidence score and never acceptance: everything in a packet still enters as
 * a candidate.
 */
export enum BrownfieldSourceClass {
  /** Explicit current product decision — approved spec/ADR, or an owner's decision. */
  ExplicitDecision = 'A',
  /** Maintained product evidence — user/API docs, a release or support contract. */
  MaintainedEvidence = 'B',
  /** Observed implementation — code, tests, config, telemetry, the graph, an AI summary. */
  ObservedImplementation = 'C',
  /** Stale or unknown provenance. */
  StaleOrUnknown = 'D',
}

/** How a candidate speaks. A/B may claim product intent; C/D may only describe or ask. */
export enum BrownfieldCandidateFraming {
  ProductCandidate = 'product_candidate',
  ObservedBehavior = 'observed_behavior',
  Question = 'question',
}

const text = (max: number) => z.string().trim().min(1).max(max);

const slugId = (max: number = INTENT_LIMITS.itemId) =>
  text(max).regex(INTENT_SLUG_PATTERN, 'id must be a lowercase slug: a-z0-9 words joined by single hyphens');

/**
 * Provenance row shape, mirrored from the propose contract's `IntentSourceSchema`
 * (which is core's `SourceRefSchema` plus the optional display `title`/`url`).
 * Identity is `(ref, localId)` — the pair propose dedupes a re-run on.
 */
const SourceRefSchema = z
  .object({
    kind: z.enum(IntentSourceKind),
    ref: text(INTENT_LIMITS.ref),
    localId: text(INTENT_LIMITS.id),
    revision: text(INTENT_LIMITS.id).optional(),
    locator: text(INTENT_LIMITS.ref).optional(),
    title: text(INTENT_LIMITS.title).optional(),
    url: z.string().url().max(2048).optional(),
  })
  .strict();

/**
 * An anchor SUGGESTION: repo + node id and a reason, nothing else. Node type and
 * the drift baseline are graph facts the server resolves (spec §4.6) — a
 * bootstrap agent must never fabricate them.
 */
const AnchorSuggestionSchema = z
  .object({
    // Both are cloud COLUMN widths, not free choices: `intent_anchors.repo_key`
    // is VARCHAR(200) and `.node_id` is VARCHAR(500). Expressed through the
    // constants core already exports for exactly these two shapes — `repo` and
    // `nodeId` on `CodeAnchorSchema` use the same pair — so a packet cannot pass
    // here and then fail in the server's driver with no field named. These read
    // 256 and 2000, which were both wider than the columns.
    repoKey: text(INTENT_LIMITS.id),
    nodeId: text(INTENT_LIMITS.ref),
    rationale: text(INTENT_LIMITS.text).optional(),
  })
  .strict();

/**
 * One proposal, in the propose contract's item shape.
 *
 * `domainId` is required and must be the packet's domain: that is what makes
 * "one packet, one domain" checkable here. A packet that names a `feature`
 * lands every item in it, so each proposal also carries `featureId` equal to
 * it; propose then refuses the pair unless the feature belongs to that domain
 * (`feature_domain_mismatch`), so the domain check survives server-side. Without
 * a packet `feature` the items land on the domain, as before.
 */
const ProposalSchema = z
  .object({
    id: slugId().optional(),
    kind: z.enum(IntentKind),
    title: text(INTENT_LIMITS.title),
    statement: text(INTENT_LIMITS.statement),
    rationale: text(INTENT_LIMITS.text).optional(),
    /** OPTIONAL (D9); the server validates it per kind. */
    payload: z.record(z.string(), z.unknown()).optional(),
    /** Item conditions, passed through; propose checks them against the workspace registry. */
    appliesWhen: ContextConditionsSchema.optional(),
    domainId: slugId(),
    featureId: slugId().optional(),
    proposedSuccessorOfId: slugId().optional(),
    sources: z.array(SourceRefSchema).min(1).max(INTENT_LIMITS.sourcesPerItem),
    anchorSuggestions: z.array(AnchorSuggestionSchema).max(INTENT_LIMITS.anchorsPerItem).optional(),
  })
  .strict();

const PacketSchema = z
  .object({
    domain: slugId(),
    /** Optional: every item lands in this feature of `domain` instead of on the domain itself. */
    feature: slugId().optional(),
    riskTheme: text(BROWNFIELD_TEXT_LIMITS.riskTheme),
    sources: z
      .array(
        z
          .object({
            id: slugId(),
            class: z.enum(BrownfieldSourceClass),
            owner: text(BROWNFIELD_TEXT_LIMITS.owner),
            source: SourceRefSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BROWNFIELD_PACKET_SOURCES),
    conflicts: z
      .array(
        z
          .object({
            sourceIds: z.array(slugId()).min(2).max(MAX_BROWNFIELD_SOURCE_REFS),
            question: text(BROWNFIELD_TEXT_LIMITS.question),
            /** Named, always: an unowned question is how stale evidence drifts back in. */
            decisionOwner: text(BROWNFIELD_TEXT_LIMITS.owner),
          })
          .strict(),
      )
      .max(MAX_BROWNFIELD_PACKET_CONFLICTS)
      .default([]),
    candidates: z
      .array(
        z
          .object({
            framing: z.enum(BrownfieldCandidateFraming),
            sourceIds: z.array(slugId()).min(1).max(MAX_BROWNFIELD_SOURCE_REFS),
            proposal: ProposalSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BROWNFIELD_PACKET_CANDIDATES),
  })
  .strict();

/** One proposal, ready to send as an `intent_propose` item. */
export type BrownfieldProposal = z.infer<typeof ProposalSchema>;

export interface BrownfieldPacketSource {
  id: string;
  class: BrownfieldSourceClass;
  owner: string;
  source: z.infer<typeof SourceRefSchema>;
}

export interface BrownfieldPacketConflict {
  sourceIds: string[];
  question: string;
  decisionOwner: string;
}

export interface BrownfieldCandidate {
  framing: BrownfieldCandidateFraming;
  sourceIds: string[];
  proposal: BrownfieldProposal;
}

export interface BrownfieldPacket {
  domain: string;
  feature?: string;
  riskTheme: string;
  sources: BrownfieldPacketSource[];
  conflicts: BrownfieldPacketConflict[];
  candidates: BrownfieldCandidate[];
}

export class BrownfieldPacketInvalidError extends Error {
  constructor(message: string) {
    super(`Brownfield packet refused: ${message}`);
    this.name = 'BrownfieldPacketInvalidError';
  }
}

/**
 * Parse and cross-check one bounded packet. Pure: it writes nothing and reaches
 * nothing. A refusal names the failing path, and it happens before any propose
 * call — a rejected packet cannot have half-landed.
 */
export function parseBrownfieldPacket(input: unknown): BrownfieldPacket {
  const parsed = PacketSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? issue.path.join('.') : '<packet>';
    throw new BrownfieldPacketInvalidError(`${location}: ${issue?.message ?? 'invalid packet'}`);
  }

  const packet = parsed.data;
  const sources = new Map<string, BrownfieldPacketSource>();
  for (const source of packet.sources) {
    if (sources.has(source.id)) throw new BrownfieldPacketInvalidError(`duplicate source id "${source.id}"`);
    sources.set(source.id, source);
  }

  // Every source named by a conflict entry — and, by the schema, every such
  // entry names a decision owner. This set is what a class-D source must be in.
  const conflictSourceIds = new Set<string>();
  for (const [index, conflict] of packet.conflicts.entries()) {
    const unique = new Set(conflict.sourceIds);
    if (unique.size !== conflict.sourceIds.length) {
      throw new BrownfieldPacketInvalidError(`conflicts.${index}.sourceIds contains a duplicate`);
    }
    for (const sourceId of unique) {
      if (!sources.has(sourceId)) {
        throw new BrownfieldPacketInvalidError(`conflicts.${index} references unknown source "${sourceId}"`);
      }
      conflictSourceIds.add(sourceId);
    }
  }

  const candidates: BrownfieldCandidate[] = [];
  for (const [index, candidate] of packet.candidates.entries()) {
    const uniqueIds = new Set(candidate.sourceIds);
    if (uniqueIds.size !== candidate.sourceIds.length) {
      throw new BrownfieldPacketInvalidError(`candidates.${index}.sourceIds contains a duplicate`);
    }
    const inventory = candidate.sourceIds.map((sourceId) => {
      const source = sources.get(sourceId);
      if (!source) {
        throw new BrownfieldPacketInvalidError(`candidates.${index} references unknown source "${sourceId}"`);
      }
      return source;
    });

    if (
      candidate.framing === BrownfieldCandidateFraming.ProductCandidate &&
      inventory.some(
        (source) =>
          source.class === BrownfieldSourceClass.ObservedImplementation ||
          source.class === BrownfieldSourceClass.StaleOrUnknown,
      )
    ) {
      throw new BrownfieldPacketInvalidError(
        `candidates.${index} uses class C/D evidence as a product candidate; frame it as observed_behavior or question`,
      );
    }
    for (const source of inventory) {
      if (source.class === BrownfieldSourceClass.StaleOrUnknown && !conflictSourceIds.has(source.id)) {
        throw new BrownfieldPacketInvalidError(
          `class D source "${source.id}" must stay in an explicit conflict/debt question with a named decision owner`,
        );
      }
    }

    const proposal = candidate.proposal;
    if (proposal.domainId !== packet.domain) {
      throw new BrownfieldPacketInvalidError(
        `candidates.${index}.proposal.domainId must be the packet domain "${packet.domain}"`,
      );
    }
    if (proposal.featureId !== packet.feature) {
      throw new BrownfieldPacketInvalidError(
        packet.feature === undefined
          ? `candidates.${index}.proposal.featureId needs a packet feature; name it as the packet's "feature"`
          : `candidates.${index}.proposal.featureId must be the packet feature "${packet.feature}"`,
      );
    }
    const expectedSources = inventory.map((source) => canonicalIntentJson(source.source)).sort();
    const proposalSources = proposal.sources.map((source) => canonicalIntentJson(source)).sort();
    if (canonicalIntentJson(expectedSources) !== canonicalIntentJson(proposalSources)) {
      throw new BrownfieldPacketInvalidError(
        `candidates.${index}.proposal.sources must exactly match its classified sourceIds`,
      );
    }

    candidates.push({ framing: candidate.framing, sourceIds: [...candidate.sourceIds], proposal });
  }

  return {
    domain: packet.domain,
    ...(packet.feature !== undefined ? { feature: packet.feature } : {}),
    riskTheme: packet.riskTheme,
    sources: [...sources.values()],
    conflicts: packet.conflicts.map((conflict) => ({ ...conflict, sourceIds: [...conflict.sourceIds] })),
    candidates,
  };
}

/**
 * The ONLY thing a packet contributes to `intent_propose`: its proposals, in
 * packet order. The classification wrapper stays in the session — this function
 * is the seam that makes "the tool never receives the packet" structural rather
 * than a rule in a prompt.
 */
export function brownfieldProposeItems(packet: BrownfieldPacket): BrownfieldProposal[] {
  return packet.candidates.map((candidate) => candidate.proposal);
}
