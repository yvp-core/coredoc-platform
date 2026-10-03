/**
 * Propose: create and update CANDIDATES (spec §5, §8.2).
 *
 * The row adapter around `intent-propose.plan.ts`. The plan decides what each
 * proposal does; this service reads the facts the plan needs, applies the
 * decision, and writes the audit trail. Everything happens inside the one
 * transaction `runIntentMutation` opens, and proposals are applied IN ORDER —
 * so a batch that proposes the same source identity twice folds onto one
 * candidate exactly as core's `captureIntentItems` does over an in-memory file.
 *
 * What propose is NOT allowed to do, enforced here and in the plan:
 * - it never writes any authority but `candidate` (the column defaults to it
 *   and nothing in this file sets it);
 * - it never touches an accepted, rejected, or superseded row — not even one a
 *   caller names by id;
 * - it never guesses which of two candidates a proposal meant.
 *
 * MERGE, not overwrite. An update applies what the proposal carries and keeps
 * what it does not: sources are unioned by `(ref, localId)`, and an absent
 * optional field (rationale, payload, attachment) leaves the stored value
 * alone. A capture states what one batch of documents says about an intent; it
 * is not a redefinition of the item, and a plain overwrite would silently erase
 * work recorded by an earlier capture or by a maintainer.
 */
import { Injectable } from '@nestjs/common';
import {
  IntentKind,
  RegistryIssueCode,
  VariantIssueCode,
  checkVariantOverlap,
  validateAgainstRegistry,
  type AuthoringHint,
  type ContextCondition,
  type IntentDimension,
  type IntentDimensionValue,
  type RuleVariant,
} from '@coredoc/core';
import { IntentAuditEntityKind, IntentItemAuthority, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { ProposeIntentItemsInput, ProposedIntentItemInput } from './contract/index.js';
import {
  IntentAnchorTargetService,
  type IntentAnchorTargetRequest,
  type ResolvedAnchorTarget,
} from './intent-anchor-target.js';
import {
  HINT_ITEM_SELECT,
  authoringHintsOf,
  readHintDimensions,
  readReferencedClauses,
} from './intent-authoring-hints.js';
import { intentIdScanPrefix } from './intent-id.js';
import {
  IntentAuditOperation,
  IntentOperation,
  findSpentIntentRequest,
  hashIntentRequest,
  runIntentMutation,
  updateItemWithVersion,
  type IntentActor,
  type IntentAuditRecord,
  type IntentTransaction,
} from './intent-idempotency.js';
import { ProposalOutcome, planProposal, sourceIdentity, type ExistingItemFacts } from './intent-propose.plan.js';
import { intentNotFound, intentStateError } from './intent-state-errors.js';
import { IntentErrorCode } from './contract/index.js';

/**
 * Ids scanned when deriving a slug. A workspace with more than this many items
 * sharing one title's first word is far outside any reviewed-intent scale; the
 * cap keeps a single propose from turning into an unbounded read.
 */
const MAX_ID_SCAN = 1_000;

/**
 * Provenance rows inspected for ONE proposal's source identities.
 *
 * A proposal carries at most ten `(ref, localId)` identities and each belongs to
 * one item, so fifty rows is far past the point where the answer is already
 * ambiguous. It is a REFUSAL bound, not a page: the rows decide whether this
 * proposal updates an existing candidate, and a scan that stopped early could
 * miss the live candidate and silently fork the intent into a second row — the
 * exact failure BR-6 exists to prevent. See {@link readSourceMatches}.
 */
const MAX_SOURCE_MATCH_SCAN = 50;

/**
 * Items loaded while walking `item`-clause references for the cycle check.
 * A REFUSAL bound: a walk that still has unloaded references at the cap is
 * refused as unverifiable, never assumed acyclic.
 * ponytail: per-propose graph walk; store a closure if chains grow real.
 */
const MAX_CONDITION_WALK = 500;

export interface ProposedItemResult {
  proposalIndex: number;
  itemId: string;
  outcome: ProposalOutcome;
  /** The item's version after this propose — the token a reviewer decides against. */
  version: number;
  /** True when the id was derived from the title because the proposal omitted one. */
  derivedId: boolean;
  /** Accepted items sharing a source identity with this proposal; left byte-identical (BR-2). */
  preservedAcceptedItemIds: string[];
  /** Source identities the candidate already carried that this proposal did not repeat, and that were KEPT. */
  retainedSourceCount: number;
  /** Anchor suggestions resolved against the graph and stored on the candidate. */
  anchorCount: number;
}

export type ProposeHint = { proposalIndex: number } & AuthoringHint;

export interface ProposeResponse {
  items: ProposedItemResult[];
  /** Non-blocking notes for the reviewer (BR-3, BR-5); absent when there are none. */
  hints?: ProposeHint[];
}

/** A suggestion after server-side resolution: graph facts plus the caller's reason. */
interface ResolvedSuggestion {
  target: ResolvedAnchorTarget;
  rationale: string | undefined;
}

@Injectable()
export class IntentProposeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly anchorTargets: IntentAnchorTargetService,
  ) {}

  async propose(workspaceId: string, actor: IntentActor, input: ProposeIntentItemsInput): Promise<ProposeResponse> {
    // The ledger FIRST, before any graph work. Anchor resolution refuses rather
    // than degrades (see `intent-anchor-target.ts`), so a replay of a committed
    // key whose node has since vanished would fail with `anchor_node_missing`
    // instead of returning what it stored. `runIntentMutation`'s in-transaction
    // check is still the authority; this one only keeps a settled request from
    // being re-decided against a graph that has moved on.
    const replay = await findSpentIntentRequest(
      this.prisma,
      workspaceId,
      input.idempotencyKey,
      IntentOperation.ItemsPropose,
      hashIntentRequest(IntentOperation.ItemsPropose, input),
    );
    if (replay) return replay.response as ProposeResponse;

    // Resolved BEFORE the transaction opens: this leases the workspace graph
    // snapshot, and a lease must never be held across a PostgreSQL transaction.
    const suggestions = await this.resolveAnchorSuggestions(workspaceId, input);

    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.ItemsPropose,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        await this.validateContextConditions(tx, workspaceId, input);
        const results: ProposedItemResult[] = [];
        const audits: IntentAuditRecord[] = [];

        for (const [index, proposal] of input.items.entries()) {
          const applied = await this.applyProposal(
            tx,
            workspaceId,
            actor,
            proposal,
            index,
            suggestions.get(index) ?? [],
          );
          results.push(applied.result);
          audits.push(...applied.audits);
        }
        const hints = await this.readHints(tx, workspaceId, results);
        return { response: { items: results, ...(hints.length > 0 ? { hints } : {}) }, audits };
      },
    );
  }

  /**
   * Hints over each item as stored after this batch (its merged text, own
   * conditions and attachment), against one registry read.
   */
  private async readHints(
    tx: IntentTransaction,
    workspaceId: string,
    results: ProposedItemResult[],
  ): Promise<ProposeHint[]> {
    // No early return on an empty registry: an `item` clause to a candidate needs no dimension to be worth a hint.
    const dimensions = await readHintDimensions(tx, workspaceId);
    const rows = await tx.intentItem.findMany({
      where: { workspaceId, id: { in: [...new Set(results.map((result) => result.itemId))] } },
      select: { id: true, ...HINT_ITEM_SELECT },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const referenced = await readReferencedClauses(tx, workspaceId, rows);
    return results.flatMap((result) => {
      const row = byId.get(result.itemId);
      return row
        ? authoringHintsOf(row, dimensions, referenced).map((hint) => ({
            proposalIndex: result.proposalIndex,
            ...hint,
          }))
        : [];
    });
  }

  /**
   * Resolve every anchor suggestion in the batch against the workspace snapshot,
   * in ONE lease, keyed back to the item that carried it.
   *
   * The caller supplies `repoKey` + `nodeId` and nothing else; `nodeType` and
   * the `capturedVersionedId` drift baseline are read from the graph (spec §4.6)
   * — which is exactly what the previous `anchor_suggestions_unsupported`
   * refusal existed to avoid fabricating, and why it is gone.
   *
   * A suggestion that cannot be resolved refuses the request with the structured
   * error PATH-SCOPED to the item and suggestion that carried it
   * (`items.2.anchorSuggestions.1.nodeId`), which is the per-item error shape
   * every other propose refusal already uses. It is a refusal rather than a
   * partial result because propose commits one transaction under one idempotency
   * key: a half-applied batch would spend the key on a result no retry could
   * reproduce.
   */
  private async resolveAnchorSuggestions(
    workspaceId: string,
    input: ProposeIntentItemsInput,
  ): Promise<Map<number, ResolvedSuggestion[]>> {
    const requests: IntentAnchorTargetRequest[] = [];
    const owners: { index: number; rationale: string | undefined }[] = [];

    input.items.forEach((item, index) => {
      (item.anchorSuggestions ?? []).forEach((suggestion, suggestionIndex) => {
        requests.push({
          repoKey: suggestion.repoKey,
          nodeId: suggestion.nodeId,
          path: ['items', String(index), 'anchorSuggestions', String(suggestionIndex)],
        });
        owners.push({ index, rationale: suggestion.rationale });
      });
    });

    const byItem = new Map<number, ResolvedSuggestion[]>();
    if (requests.length === 0) return byItem;

    const { targets } = await this.anchorTargets.resolve(this.prisma, workspaceId, requests);
    targets.forEach((target, position) => {
      const owner = owners[position];
      if (!owner) return;
      const bucket = byItem.get(owner.index) ?? [];
      bucket.push({ target, rationale: owner.rationale });
      byItem.set(owner.index, bucket);
    });
    return byItem;
  }

  private async applyProposal(
    tx: IntentTransaction,
    workspaceId: string,
    actor: IntentActor,
    proposal: ProposedIntentItemInput,
    index: number,
    suggestions: readonly ResolvedSuggestion[],
  ): Promise<{ result: ProposedItemResult; audits: IntentAuditRecord[] }> {
    const path = ['items', String(index)];
    const attachment = await this.resolveAttachment(tx, workspaceId, proposal, path);
    const successorOf = await this.resolveProposedSuccessor(tx, workspaceId, proposal, path);

    const plan = planProposal(
      proposal,
      {
        byId: proposal.id === undefined ? undefined : await this.readItemFacts(tx, workspaceId, proposal.id),
        sourceMatches: await this.readSourceMatches(tx, workspaceId, proposal, path),
        takenIds: await this.readTakenIds(tx, workspaceId, proposal),
      },
      path,
    );
    if (proposal.appliesWhen !== undefined) {
      await this.assertNoConditionCycle(tx, workspaceId, plan.itemId, proposal.appliesWhen, path);
    }

    if (plan.outcome === ProposalOutcome.CreatedCandidate) {
      const created = await tx.intentItem.create({
        data: {
          workspaceId,
          id: plan.itemId,
          kind: proposal.kind,
          title: proposal.title,
          statement: proposal.statement,
          rationale: proposal.rationale ?? null,
          body: (proposal.body as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull,
          payload: (proposal.payload as Prisma.InputJsonValue) ?? Prisma.DbNull,
          // `[]` means "no conditions", stored as NULL like an absent field.
          appliesWhen: proposal.appliesWhen?.length ? (proposal.appliesWhen as Prisma.InputJsonValue) : Prisma.DbNull,
          domainId: attachment.domainId,
          featureId: attachment.featureId,
          proposedSuccessorOfId: successorOf,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.writeSources(tx, workspaceId, plan.itemId, proposal);
      const anchorAudits = await this.writeAnchors(tx, workspaceId, plan.itemId, actor, suggestions);

      return {
        result: {
          proposalIndex: index,
          itemId: created.id,
          outcome: plan.outcome,
          version: created.version,
          derivedId: plan.derivedId,
          preservedAcceptedItemIds: plan.preservedAcceptedItemIds,
          retainedSourceCount: 0,
          anchorCount: suggestions.length,
        },
        audits: [
          {
            entityKind: IntentAuditEntityKind.item,
            entityId: created.id,
            operation: IntentAuditOperation.ProposeCreate,
            after: {
              kind: created.kind,
              authority: created.authority,
              version: created.version,
              domainId: created.domainId,
              featureId: created.featureId,
            },
          },
          ...anchorAudits,
        ],
      };
    }

    const before = await tx.intentItem.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: plan.itemId } },
    });
    const retainedSourceCount = await this.writeSources(tx, workspaceId, plan.itemId, proposal);
    const anchorAudits = await this.writeAnchors(tx, workspaceId, plan.itemId, actor, suggestions);
    const version = await updateItemWithVersion(tx, {
      workspaceId,
      itemId: plan.itemId,
      expectedVersion: before.version,
      updatedBy: actor.id,
      path: [...path, 'id'],
      // The plan read is unlocked, so a review may accept this candidate before
      // the write lands. The guard keeps accepted items byte-identical
      // (`br-accepted-items-survive-capture`).
      requireAuthority: IntentItemAuthority.candidate,
      data: {
        title: proposal.title,
        statement: proposal.statement,
        // Absent optional fields PRESERVE the stored value; see the merge note
        // at the top of this file.
        ...(proposal.rationale !== undefined ? { rationale: proposal.rationale } : {}),
        ...(proposal.body !== undefined ? { body: proposal.body as Prisma.InputJsonValue } : {}),
        ...(proposal.payload !== undefined ? { payload: proposal.payload as Prisma.InputJsonValue } : {}),
        // `appliesWhen: []` CLEARS the stored conditions (the one way to remove them).
        ...(proposal.appliesWhen !== undefined
          ? {
              appliesWhen: proposal.appliesWhen.length
                ? (proposal.appliesWhen as Prisma.InputJsonValue)
                : Prisma.DbNull,
            }
          : {}),
        ...(attachment.supplied ? { domainId: attachment.domainId, featureId: attachment.featureId } : {}),
        ...(successorOf !== null ? { proposedSuccessorOfId: successorOf } : {}),
      },
    });

    return {
      result: {
        proposalIndex: index,
        itemId: plan.itemId,
        outcome: plan.outcome,
        version,
        derivedId: plan.derivedId,
        preservedAcceptedItemIds: plan.preservedAcceptedItemIds,
        retainedSourceCount,
        anchorCount: suggestions.length,
      },
      audits: [
        {
          entityKind: IntentAuditEntityKind.item,
          entityId: plan.itemId,
          operation: IntentAuditOperation.ProposeUpdate,
          before: { version: before.version, domainId: before.domainId, featureId: before.featureId },
          after: {
            version,
            domainId: attachment.supplied ? attachment.domainId : before.domainId,
            featureId: attachment.supplied ? attachment.featureId : before.featureId,
          },
        },
        ...anchorAudits,
      ],
    };
  }

  /* ------------------------------------------------------------- facts --- */

  private async readItemFacts(
    tx: IntentTransaction,
    workspaceId: string,
    id: string,
  ): Promise<ExistingItemFacts | undefined> {
    const row = await tx.intentItem.findUnique({
      where: { workspaceId_id: { workspaceId, id } },
      select: { id: true, kind: true, authority: true },
    });
    return row === null ? undefined : { id: row.id, kind: row.kind as IntentKind, authority: row.authority };
  }

  /**
   * Items carrying at least one of the proposal's `(ref, localId)` source
   * identities.
   *
   * ORDERED and BOUNDED-WITH-A-REFUSAL. The scan is what decides between
   * "update this candidate" and "create a new one", so an unordered `take` was a
   * correctness bug rather than a performance knob: on a workspace where more
   * rows than the cap share the proposal's identities, the planner could return
   * any fifty and the live candidate could simply fall out of the window,
   * duplicating the intent. Ordering by `(createdAt, id)` makes the window the
   * same one on every run, and one row past the cap is refused as the ambiguity
   * it is — beyond the bound the answer is unknown, and guessing is what BR-6
   * forbids.
   */
  private async readSourceMatches(
    tx: IntentTransaction,
    workspaceId: string,
    proposal: ProposedIntentItemInput,
    path: string[],
  ): Promise<ExistingItemFacts[]> {
    const rows = await tx.intentItemSource.findMany({
      where: {
        workspaceId,
        OR: proposal.sources.map((source) => ({ ref: source.ref, localId: source.localId })),
      },
      select: { itemId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_SOURCE_MATCH_SCAN + 1,
    });
    if (rows.length > MAX_SOURCE_MATCH_SCAN) {
      throw intentStateError(
        IntentErrorCode.AmbiguousSourceIdentity,
        `This proposal's source identities are shared by more than ${MAX_SOURCE_MATCH_SCAN} provenance rows, ` +
          'so which candidate it updates cannot be decided. Cite a narrower source identity.',
        [...path, 'sources'],
      );
    }
    const itemIds = [...new Set(rows.map((row) => row.itemId))];
    if (itemIds.length === 0) return [];

    const items = await tx.intentItem.findMany({
      where: { workspaceId, id: { in: itemIds } },
      select: { id: true, kind: true, authority: true },
      orderBy: { id: 'asc' },
    });
    return items.map((item) => ({ id: item.id, kind: item.kind as IntentKind, authority: item.authority }));
  }

  /** Ids already taken under this title's derivation prefix — one indexed scan, not the whole workspace. */
  private async readTakenIds(
    tx: IntentTransaction,
    workspaceId: string,
    proposal: ProposedIntentItemInput,
  ): Promise<string[]> {
    const prefix = intentIdScanPrefix(proposal.kind, proposal.title);
    if (prefix === null) return [];
    const rows = await tx.intentItem.findMany({
      where: { workspaceId, id: { startsWith: prefix } },
      select: { id: true },
      take: MAX_ID_SCAN,
    });
    return rows.map((row) => row.id);
  }

  /**
   * Attachment: the product root, a domain, or a feature (whose own domain is
   * carried along, because the composite foreign key demands they agree).
   *
   * `supplied` distinguishes "attach here" from "this proposal says nothing
   * about attachment", which on an update means keep the item where it is.
   */
  private async resolveAttachment(
    tx: IntentTransaction,
    workspaceId: string,
    proposal: ProposedIntentItemInput,
    path: string[],
  ): Promise<{ supplied: boolean; domainId: string | null; featureId: string | null }> {
    if (proposal.featureId !== undefined) {
      const feature = await tx.intentFeature.findUnique({
        where: { workspaceId_id: { workspaceId, id: proposal.featureId } },
        select: { id: true, domainId: true },
      });
      if (!feature) {
        throw intentNotFound(
          IntentErrorCode.FeatureNotFound,
          `Feature '${proposal.featureId}' does not exist in this workspace`,
          [...path, 'featureId'],
        );
      }
      if (proposal.domainId !== undefined && proposal.domainId !== feature.domainId) {
        throw intentStateError(
          IntentErrorCode.FeatureDomainMismatch,
          `Feature '${feature.id}' belongs to domain '${feature.domainId}', not '${proposal.domainId}'`,
          [...path, 'domainId'],
        );
      }
      return { supplied: true, domainId: feature.domainId, featureId: feature.id };
    }

    if (proposal.domainId !== undefined) {
      const domain = await tx.intentDomain.findUnique({
        where: { workspaceId_id: { workspaceId, id: proposal.domainId } },
        select: { id: true },
      });
      if (!domain) {
        throw intentNotFound(
          IntentErrorCode.DomainNotFound,
          `Domain '${proposal.domainId}' does not exist in this workspace`,
          [...path, 'domainId'],
        );
      }
      return { supplied: true, domainId: domain.id, featureId: null };
    }

    return { supplied: false, domainId: null, featureId: null };
  }

  /**
   * BR-5/BR-6 for the whole batch, before anything is written: every dimension
   * and value an `appliesWhen` clause or rule variant names is declared and not
   * archived, variants neither overlap nor carry a second default, every `item`
   * clause names an item in the workspace or in this batch, and no `item` clause
   * closes a cycle. The registry is read once per batch, and not at all for a
   * batch that carries no conditions or variants.
   */
  private async validateContextConditions(
    tx: IntentTransaction,
    workspaceId: string,
    input: ProposeIntentItemsInput,
  ): Promise<void> {
    const variantsOf = (proposal: ProposedIntentItemInput): RuleVariant[] | undefined =>
      proposal.kind === IntentKind.BusinessRule ? (proposal.payload?.variants as RuleVariant[] | undefined) : undefined;
    const conditioned = input.items.some(
      (proposal) => proposal.appliesWhen !== undefined || variantsOf(proposal) !== undefined,
    );
    if (!conditioned) return;

    // BR-7 race: FOR SHARE on every referenced dimension row, so a concurrent
    // dimension delete/archive/value-drop (which takes FOR UPDATE on that row
    // before its in-use scan) either waits for this propose to commit — and
    // then sees its item — or has committed, and the read below sees the change.
    const referenced = [
      ...new Set(
        input.items.flatMap((proposal) => [
          ...(proposal.appliesWhen ?? []).flatMap((clause) => ('dimension' in clause ? [clause.dimension] : [])),
          ...(variantsOf(proposal) ?? []).flatMap((variant) => Object.keys(variant.when ?? {})),
        ]),
      ),
    ].sort();
    if (referenced.length > 0) {
      await tx.$queryRaw`SELECT 1 FROM intent_dimensions WHERE workspace_id = ${workspaceId}::uuid AND id IN (${Prisma.join(referenced)}) ORDER BY id FOR SHARE`;
    }

    const dimensions: IntentDimension[] = (
      await tx.intentDimension.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } })
    ).map((row) => ({
      id: row.id,
      title: row.title,
      values: row.values as unknown as IntentDimensionValue[],
      multi: row.multi,
      archived: row.archived,
    }));

    for (const [index, proposal] of input.items.entries()) {
      const variants = variantsOf(proposal);
      const [issue] = validateAgainstRegistry(proposal.appliesWhen, variants, dimensions);
      if (issue) {
        const path = [
          'items',
          String(index),
          ...(issue.path[0] === 'variants' ? ['payload'] : []),
          ...issue.path.map(String),
        ];
        throw issue.code === RegistryIssueCode.DimensionValueNotFound
          ? intentNotFound(
              IntentErrorCode.DimensionValueNotFound,
              `Dimension '${issue.dimension}' declares no value '${issue.value}'`,
              path,
            )
          : intentNotFound(
              IntentErrorCode.DimensionNotFound,
              `Dimension '${issue.dimension}' is not declared in this workspace, or is archived`,
              path,
            );
      }
      const [overlap] = checkVariantOverlap(variants);
      if (overlap) {
        throw intentStateError(
          IntentErrorCode.VariantOverlap,
          overlap.code === VariantIssueCode.SecondDefault
            ? `Variant ${overlap.index} is a second default (no 'when'); variant ${overlap.otherIndex} already is one`
            : `Variant ${overlap.index} overlaps variant ${overlap.otherIndex}: same dimensions, intersecting values`,
          ['items', String(index), 'payload', 'variants', String(overlap.index)],
        );
      }
    }

    await this.validateItemClauses(tx, workspaceId, input);
  }

  /** `item` clauses: existence (workspace or same batch) and the lock the per-write cycle check relies on. */
  private async validateItemClauses(
    tx: IntentTransaction,
    workspaceId: string,
    input: ProposeIntentItemsInput,
  ): Promise<void> {
    const references = input.items.flatMap((proposal, index) =>
      (proposal.appliesWhen ?? []).flatMap((clause, clauseIndex) =>
        'item' in clause ? [{ index, clauseIndex, item: clause.item }] : [],
      ),
    );
    if (references.length === 0) return;

    // Two concurrent proposes that each add one half of A→B→A both walk the old
    // graph and commit a cycle. Only a batch carrying `item` clauses can add an
    // edge, so those serialize here; propose runs READ COMMITTED, so every read
    // below sees the edges of a propose that committed while this one waited.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`intent-conditions:${workspaceId}`}, 0))`;

    const batchIds = new Set(input.items.flatMap((proposal) => (proposal.id === undefined ? [] : [proposal.id])));
    const outside = [...new Set(references.map((ref) => ref.item).filter((id) => !batchIds.has(id)))];
    const found = new Map(
      (
        await tx.intentItem.findMany({
          where: { workspaceId, id: { in: outside } },
          select: { id: true, authority: true },
        })
      ).map((row) => [row.id, row.authority]),
    );
    const missing = references.find((ref) => !batchIds.has(ref.item) && !found.has(ref.item));
    if (missing) {
      throw intentNotFound(
        IntentErrorCode.ConditionItemNotFound,
        `Intent item '${missing.item}' does not exist in this workspace or in this batch`,
        ['items', String(missing.index), 'appliesWhen', String(missing.clauseIndex), 'item'],
      );
    }
    // Candidates and accepted items only: a rejected or superseded target could never filter.
    const inactive = references.find((ref) => {
      const authority = batchIds.has(ref.item) ? undefined : found.get(ref.item);
      return authority === IntentItemAuthority.rejected || authority === IntentItemAuthority.superseded;
    });
    if (inactive) {
      throw intentStateError(
        IntentErrorCode.ConditionItemInactive,
        `Intent item '${inactive.item}' is ${found.get(inactive.item)}; an item clause must name a candidate or accepted item`,
        ['items', String(inactive.index), 'appliesWhen', String(inactive.clauseIndex), 'item'],
      );
    }
  }

  /**
   * Refuse `clauses` on `owner` when they close a cycle of item conditions.
   *
   * Runs per proposal, right before its write and after `planProposal` picked
   * the item it lands on, so the owner is exactly the row about to change — an
   * id-less proposal that source identity (or an earlier proposal in the same
   * batch) resolves to an existing item included. Every other edge is read from
   * the transaction, which already holds the batch's earlier writes; any cycle
   * the batch forms is therefore caught at the write that closes it. The caller
   * holds the advisory lock taken in {@link validateItemClauses}.
   */
  private async assertNoConditionCycle(
    tx: IntentTransaction,
    workspaceId: string,
    owner: string,
    clauses: readonly ContextCondition[],
    path: string[],
  ): Promise<void> {
    const itemRefs = (list: readonly ContextCondition[] | null | undefined) =>
      (list ?? []).flatMap((clause) => ('item' in clause ? [clause.item] : []));
    const ownRefs = itemRefs(clauses);
    if (ownRefs.length === 0) return;
    const clausePath = (item: string) => [
      ...path,
      'appliesWhen',
      String(clauses.findIndex((c) => 'item' in c && c.item === item)),
      'item',
    ];

    // The proposal replaces the owner's stored clauses; every other item keeps what is stored.
    const edges = new Map<string, string[]>([[owner, ownRefs]]);
    let frontier = [...new Set(ownRefs)].filter((id) => !edges.has(id));
    while (frontier.length > 0) {
      if (edges.size >= MAX_CONDITION_WALK) {
        throw intentStateError(
          IntentErrorCode.ConditionCycle,
          `The item-condition reference chain is longer than ${MAX_CONDITION_WALK} items, ` +
            'so it cannot be verified free of cycles. Shorten the chain of item clauses.',
          clausePath(ownRefs[0]!),
        );
      }
      const rows = await tx.intentItem.findMany({
        where: { workspaceId, id: { in: frontier } },
        select: { id: true, appliesWhen: true },
      });
      const stored = new Map(rows.map((row) => [row.id, row.appliesWhen as unknown as ContextCondition[] | null]));
      for (const id of frontier) edges.set(id, itemRefs(stored.get(id)));
      frontier = [...new Set(frontier.flatMap((id) => edges.get(id) ?? []))].filter((id) => !edges.has(id));
    }

    const reaches = (from: string): boolean => {
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (id === owner) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        stack.push(...(edges.get(id) ?? []));
      }
      return false;
    };
    const closing = ownRefs.find(reaches);
    if (closing !== undefined) {
      throw intentStateError(
        IntentErrorCode.ConditionCycle,
        `The item clause on '${owner}' naming '${closing}' closes a cycle of item conditions`,
        clausePath(closing),
      );
    }
  }

  /**
   * `proposedSuccessorOfId` names the ACCEPTED item this candidate intends to
   * replace (spec §5). Anything else — a missing item, a candidate, an already
   * superseded one — is refused here rather than becoming a proposal nobody can
   * act on at review time.
   */
  private async resolveProposedSuccessor(
    tx: IntentTransaction,
    workspaceId: string,
    proposal: ProposedIntentItemInput,
    path: string[],
  ): Promise<string | null> {
    if (proposal.proposedSuccessorOfId === undefined) return null;
    const predecessor = await tx.intentItem.findUnique({
      where: { workspaceId_id: { workspaceId, id: proposal.proposedSuccessorOfId } },
      select: { id: true, authority: true },
    });
    if (!predecessor) {
      throw intentNotFound(
        IntentErrorCode.ItemNotFound,
        `Intent item '${proposal.proposedSuccessorOfId}' does not exist in this workspace`,
        [...path, 'proposedSuccessorOfId'],
      );
    }
    if (predecessor.authority !== IntentItemAuthority.accepted) {
      throw intentStateError(
        IntentErrorCode.ItemNotCandidate,
        `Intent item '${predecessor.id}' is ${predecessor.authority}; only an accepted item can be replaced.`,
        [...path, 'proposedSuccessorOfId'],
      );
    }
    return predecessor.id;
  }

  /**
   * Union the proposal's sources into the item's provenance rows and report how
   * many stored identities the proposal did not repeat.
   *
   * Identity is `(ref, localId)` — `kind` is a classification of the document
   * and deliberately not part of it, so a re-capture that reclassified one
   * source refreshes that row instead of appending a second one. The unique
   * index includes `kind`, which is exactly why the refresh is delete-then-
   * insert rather than an upsert on the index.
   *
   * `title` and `url` are PERSISTED, not dropped: the contract has always
   * validated them (`IntentSourceSchema`, and the shared `externalUrl` rule for
   * the URL), and accepting a field only to discard it is the worst of the three
   * options — the caller believes the link was kept. They are descriptive, not
   * identifying: a re-titled or re-hosted document is the same source.
   */
  private async writeSources(
    tx: IntentTransaction,
    workspaceId: string,
    itemId: string,
    proposal: ProposedIntentItemInput,
  ): Promise<number> {
    const stored = await tx.intentItemSource.findMany({
      where: { workspaceId, itemId },
      select: { ref: true, localId: true },
    });
    const proposed = new Set(proposal.sources.map(sourceIdentity));
    const retained = stored.filter((source) => !proposed.has(sourceIdentity(source))).length;

    for (const source of proposal.sources) {
      await tx.intentItemSource.deleteMany({
        where: { workspaceId, itemId, ref: source.ref, localId: source.localId },
      });
      await tx.intentItemSource.create({
        data: {
          workspaceId,
          itemId,
          kind: source.kind,
          ref: source.ref,
          localId: source.localId,
          revision: source.revision ?? null,
          locator: source.locator ?? null,
          title: source.title ?? null,
          url: source.url ?? null,
        },
      });
    }
    return retained;
  }

  /**
   * Union the resolved suggestions into the candidate's anchors.
   *
   * MERGE, like sources: identity is `(itemId, repoKey, nodeId)`, a repeated
   * identity re-captures the baseline the graph reports NOW, and an anchor the
   * proposal did not mention is left alone. A capture states what one batch of
   * documents says; it is not a redefinition of the item's touchpoints.
   *
   * Every write returns its audit row, so the "every change is audited"
   * invariant still holds at the single `runIntentMutation` seam.
   */
  private async writeAnchors(
    tx: IntentTransaction,
    workspaceId: string,
    itemId: string,
    actor: IntentActor,
    suggestions: readonly ResolvedSuggestion[],
  ): Promise<IntentAuditRecord[]> {
    const audits: IntentAuditRecord[] = [];
    for (const { target, rationale } of suggestions) {
      const existing = await tx.intentAnchor.findUnique({
        where: {
          workspaceId_itemId_repoKey_nodeId: { workspaceId, itemId, repoKey: target.repoKey, nodeId: target.nodeId },
        },
      });
      if (existing?.disabledAt) continue;
      const anchor = existing
        ? await tx.intentAnchor.update({
            where: { id: existing.id },
            data: {
              nodeType: target.nodeType,
              capturedVersionedId: target.capturedVersionedId,
              ...(rationale !== undefined ? { rationale } : {}),
            },
          })
        : await tx.intentAnchor.create({
            data: {
              workspaceId,
              itemId,
              repoKey: target.repoKey,
              nodeId: target.nodeId,
              nodeType: target.nodeType,
              capturedVersionedId: target.capturedVersionedId,
              rationale: rationale ?? null,
              createdBy: actor.id,
            },
          });

      audits.push({
        entityKind: IntentAuditEntityKind.anchor,
        entityId: anchor.id.toString(),
        operation: existing ? IntentAuditOperation.Update : IntentAuditOperation.Create,
        ...(existing
          ? { before: { nodeType: existing.nodeType, capturedVersionedId: existing.capturedVersionedId } }
          : {}),
        after: {
          itemId: anchor.itemId,
          repoKey: anchor.repoKey,
          nodeId: anchor.nodeId,
          nodeType: anchor.nodeType,
          capturedVersionedId: anchor.capturedVersionedId,
        },
      });
    }
    return audits;
  }
}
