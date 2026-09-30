/**
 * Onboarding import: one repo-local `IntentFileV2` overlay becomes the intent
 * content of an empty workspace (spec §8.1).
 *
 * ONE IDEMPOTENT POST, NO STATE MACHINE. The archived design had a multi-step
 * handover ceremony with a frozen local state; this replaces it with a single
 * keyed mutation. Recovery from a crash is rerunning the same request with the
 * same key: `runIntentMutation` returns the stored result and the CLI finishes
 * the config write it never got to. Nothing here is resumable because nothing
 * here is partial — the whole import is one transaction.
 *
 * WHY THE EMPTINESS CHECK LIVES INSIDE `apply`. It has to be behind the replay
 * cache, not in front of it. A successful import makes the workspace non-empty,
 * so a check placed before the ledger lookup would turn the designated recovery
 * path ("rerun the same key") into a `workspace_not_empty` refusal — the exact
 * opposite of what it is for.
 *
 * VALIDATION IS CORE'S. The overlay is validated by `validateIntentFile` from
 * `@coredoc/core`, not by a second copy of the file schema here: the cloud must
 * refuse precisely what the local writer refuses, and two schemas drift. The
 * envelope's own shape and the §10 content walk are `parseContract`'s job at
 * the controller, with the import node budget.
 */
import { Injectable } from '@nestjs/common';
import {
  IntentAuthority,
  IntentKind,
  checkVariantOverlap,
  type RuleVariant,
  type CodeAnchor,
  type IntentDomain,
  type IntentFileV2,
  type IntentItem,
  type IntentSourceRef,
  validateIntentFile,
} from '@coredoc/core';
import {
  IntentAuditEntityKind,
  IntentAuthoritySourceKind,
  IntentItemAuthority,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentErrorCode, type ImportIntentOverlayInput, type IntentErrorDetail } from './contract/index.js';
import {
  CLOUD_INTENT_IMPORT_FORMAT_VERSION,
  IntentImportSkipReason,
  type CloudIntentDroppedRelation,
  type CloudIntentImportResultV1,
  type CloudIntentImportSkippedAnchors,
  type CloudIntentImportedItem,
} from './intent-import.operations.js';
import {
  IntentAuditOperation,
  IntentOperation,
  createIntentRowsChunked,
  runIntentMutation,
  type IntentActor,
  type IntentAuditRecord,
  type IntentTransaction,
  type IntentTransactionOptions,
} from './intent-idempotency.js';
import {
  assertWorkspaceIntentEmpty,
  readIntentContentCounts,
  readIntentImportPreflight,
  type IntentImportPreflightResultV1,
} from './intent-import.preconditions.js';
import { readWorkspaceIntentRepoIdentities } from './intent-repo-keys.js';
import { intentStateError } from './intent-state-errors.js';

/**
 * `intent_domains.statement` is NOT NULL while the overlay's domain statement
 * is optional. The empty string is the same "nobody has written one yet" value
 * `IntentTreeService` writes for a domain created without one.
 */
const EMPTY_STATEMENT = '';

/** How many overlay validation failures travel in the refusal's `details`. */
const MAX_REPORTED_OVERLAY_ERRORS = 20;

/** Authority values are the same strings on both sides; this is the checked crossing. */
const AUTHORITY_BY_OVERLAY: Record<IntentAuthority, IntentItemAuthority> = {
  [IntentAuthority.Candidate]: IntentItemAuthority.candidate,
  [IntentAuthority.Accepted]: IntentItemAuthority.accepted,
  [IntentAuthority.Rejected]: IntentItemAuthority.rejected,
  [IntentAuthority.Superseded]: IntentItemAuthority.superseded,
};

/**
 * The import transaction's shape. The one mutation here whose worst LEGAL input
 * is not small, so the one that must state its own budget (spec §8.1).
 *
 * `Serializable`, because {@link IntentImportService.assertWorkspaceEmpty} is a
 * read that a later write depends on. Under READ COMMITTED two concurrent
 * imports of the same empty workspace both see zero rows and both proceed, and
 * the emptiness invariant — the whole precondition of v1 import — is decided by
 * a race. Serializable makes the loser abort with a serialization failure, which
 * `runIntentMutation` turns into a retryable `transaction_conflict`. This is the
 * archived design's isolation level for import, restored.
 *
 * `timeout` is sized for the worst overlay that can actually ARRIVE. The route
 * now carries `INTENT_IMPORT_BODY_LIMIT` (core's `MAX_INTENT_IMPORT_BODY_BYTES`,
 * a maximal overlay plus its envelope), so the binding ceiling is core's own
 * schema cap — 500 items with their bounded sources and anchors. That is some
 * thousands of rows, which chunked `createMany` writes in a few dozen
 * statements, far inside two minutes.
 *
 * The number exists so the abort path is a deliberate ceiling rather than
 * Prisma's 5s default, which a legal import blew through while leaving NO ledger
 * row — making the documented "rerun the same key" recovery loop forever.
 */
const IMPORT_TRANSACTION: IntentTransactionOptions = {
  timeout: 120_000,
  maxWait: 15_000,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
};

@Injectable()
export class IntentImportService {
  constructor(private readonly prisma: PrismaService) {}

  async import(
    workspaceId: string,
    actor: IntentActor,
    input: ImportIntentOverlayInput,
  ): Promise<CloudIntentImportResultV1> {
    const overlay = this.parseOverlay(input.overlay);

    return runIntentMutation<CloudIntentImportResultV1>(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.OverlayImport,
        idempotencyKey: input.idempotencyKey,
        request: { localRevision: input.localRevision, overlay: input.overlay },
        transaction: IMPORT_TRANSACTION,
      },
      async (tx) => this.apply(tx, workspaceId, actor, input.localRevision, overlay),
    );
  }

  /**
   * The import's preconditions, read-only (`coredoc intent bootstrap-check`).
   *
   * Deliberately NOT a dry-run of the import: it opens no transaction, spends no
   * idempotency key, and validates no overlay — the overlay is the caller's own
   * file and core validates it locally. What only the server can answer is
   * whether this workspace is still empty and which repo identities it carries,
   * and those are read here through the same functions `apply` asserts over.
   */
  async preflight(workspaceId: string): Promise<IntentImportPreflightResultV1> {
    return readIntentImportPreflight(this.prisma, workspaceId);
  }

  /**
   * Core's validator, with its errors converted to the §12 public triple.
   *
   * Paths are prefixed with `overlay` so a caller reading a refusal knows the
   * failing field is inside the uploaded document rather than in the envelope
   * around it.
   */
  private parseOverlay(document: Record<string, unknown>): IntentFileV2 {
    const result = validateIntentFile(document);
    if (result.ok) {
      assertImportableVariants(result.file);
      return result.file;
    }

    const details: IntentErrorDetail[] = result.errors.slice(0, MAX_REPORTED_OVERLAY_ERRORS).map((error) => ({
      code: IntentErrorCode.ImportOverlayInvalid,
      message: error.message,
      path: ['overlay', ...error.path.map(String)],
    }));
    const first = details[0];
    throw intentStateError(
      IntentErrorCode.ImportOverlayInvalid,
      first?.message ?? 'The uploaded document is not a valid intent overlay',
      first?.path ?? ['overlay'],
      undefined,
      details,
    );
  }

  private async apply(
    tx: IntentTransaction,
    workspaceId: string,
    actor: IntentActor,
    localRevision: string,
    overlay: IntentFileV2,
  ): Promise<{ response: CloudIntentImportResultV1; audits: IntentAuditRecord[] }> {
    await this.assertWorkspaceEmpty(tx, workspaceId);

    const identities = await readWorkspaceIntentRepoIdentities(tx, workspaceId);
    const audits: IntentAuditRecord[] = [];

    const createdDomains = await this.createDomains(tx, workspaceId, actor, overlay.domains, audits);

    const importedItems: CloudIntentImportedItem[] = [];
    const skipped = new Map<string, { anchorCount: number; itemIds: Set<string> }>();

    // Every row is BUILT first and WRITTEN below in FK order. The previous shape
    // — four awaits per item — spent one network round trip per row inside the
    // transaction, so a legal 500-item overlay could not finish inside any
    // sensible budget. Building is pure and cheap; the writes are a few dozen
    // statements.
    const itemRows: Prisma.IntentItemCreateManyInput[] = [];
    const sourceRows: Prisma.IntentItemSourceCreateManyInput[] = [];
    const anchorRows: Prisma.IntentAnchorCreateManyInput[] = [];
    const transitionRows: Prisma.IntentAuthorityTransitionCreateManyInput[] = [];

    for (const item of overlay.items) {
      const authority = AUTHORITY_BY_OVERLAY[item.authority];
      itemRows.push({
        workspaceId,
        id: item.id,
        kind: item.kind,
        domainId: item.domain,
        // The local format has no features; feature placement is later,
        // ordinary tree work (spec §8.1).
        featureId: null,
        title: item.title,
        statement: item.statement,
        // A closed per-kind interface, not an index-signature type; core
        // already proved it is JSON (it was parsed from the overlay file).
        payload: item.payload as unknown as Prisma.InputJsonValue,
        // The overlay carries no item-level rationale — a decision's
        // reasoning lives inside its payload — so inventing one would be
        // fabricated provenance.
        rationale: null,
        authority,
        createdBy: actor.id,
        updatedBy: actor.id,
      });

      sourceRows.push(...this.sourceRows(workspaceId, item.id, item.sources));
      anchorRows.push(
        ...this.anchorRows(
          workspaceId,
          actor,
          item.id,
          item.codeAnchors ?? [],
          identities.graphKeyByDurableKey,
          skipped,
        ),
      );
      transitionRows.push(
        this.arrivalTransitionRow(workspaceId, actor, item, authority, localRevision, overlay.projectId),
      );

      audits.push({
        entityKind: IntentAuditEntityKind.item,
        entityId: item.id,
        operation: IntentAuditOperation.Create,
        after: { kind: item.kind, authority, domainId: item.domain },
      });
      importedItems.push({ id: item.id, authority, domainId: item.domain });
    }

    // Items before the three tables whose foreign keys name them; domains were
    // already written above, for the same reason.
    await createIntentRowsChunked(tx.intentItem, itemRows);
    const importedSourceCount = await createIntentRowsChunked(tx.intentItemSource, sourceRows);
    const importedAnchorCount = await createIntentRowsChunked(tx.intentAnchor, anchorRows);
    await createIntentRowsChunked(tx.intentAuthorityTransition, transitionRows);

    return {
      response: {
        formatVersion: CLOUD_INTENT_IMPORT_FORMAT_VERSION,
        workspaceId,
        localRevision,
        projectId: overlay.projectId,
        createdDomains,
        importedItems,
        importedSourceCount,
        importedAnchorCount,
        skippedAnchors: renderSkippedAnchors(skipped),
        droppedRelations: overlay.relations.map(
          (relation): CloudIntentDroppedRelation => ({
            from: relation.from,
            type: relation.type,
            to: relation.to,
          }),
        ),
        registeredRepoIdentities: identities.enumeration,
      },
      audits,
    };
  }

  /**
   * v1 import is onboarding, not merge (spec §8.1). "Content" is the tables
   * (domains, features, items, dimensions) a maintainer would recognise as
   * their knowledge base; seeds and anchors cannot exist without a feature or
   * an item, so counting those two would be counting the same emptiness twice.
   *
   * The counts and the refusal live in `intent-import.preconditions.ts` so the
   * read-only preflight below answers with the SAME rule this asserts.
   */
  private async assertWorkspaceEmpty(tx: IntentTransaction, workspaceId: string): Promise<void> {
    assertWorkspaceIntentEmpty(await readIntentContentCounts(tx, workspaceId));
  }

  /** Local domains become cloud domains; the registry is imported whole, unused entries included (BR-19). */
  private async createDomains(
    tx: IntentTransaction,
    workspaceId: string,
    actor: IntentActor,
    domains: readonly IntentDomain[],
    audits: IntentAuditRecord[],
  ): Promise<Array<{ id: string; title: string }>> {
    await createIntentRowsChunked(
      tx.intentDomain,
      domains.map((domain) => ({
        workspaceId,
        id: domain.id,
        title: domain.title,
        statement: domain.statement ?? EMPTY_STATEMENT,
        createdBy: actor.id,
        updatedBy: actor.id,
      })),
    );
    for (const domain of domains) {
      audits.push({
        entityKind: IntentAuditEntityKind.domain,
        entityId: domain.id,
        operation: IntentAuditOperation.Create,
        after: { title: domain.title },
      });
    }
    return domains.map((domain) => ({ id: domain.id, title: domain.title }));
  }

  /** Sources import as-is, `locator` preserved (spec §8.1, §4.5). */
  private sourceRows(
    workspaceId: string,
    itemId: string,
    sources: readonly IntentSourceRef[],
  ): Prisma.IntentItemSourceCreateManyInput[] {
    return sources.map((source) => ({
      workspaceId,
      itemId,
      kind: source.kind,
      ref: source.ref,
      localId: source.localId,
      revision: source.revision ?? null,
      locator: source.locator ?? null,
    }));
  }

  /**
   * Anchors import as-is — `nodeType` and `capturedVersionedId` come from the
   * overlay, which carries both (spec §8.1: "anchor status is recomputed
   * against the workspace graph on read, not trusted from the file"). The
   * imported `capturedVersionedId` is a DRIFT BASELINE, not a claim about the
   * current graph: an anchor whose code has since moved reads back `changed`,
   * which is the true statement.
   *
   * The one thing that cannot import as-is is the anchor's `repo`: cloud
   * anchors are keyed by the workspace's durable intent identity (§6.5), and an
   * overlay written before those repos were connected names identities this
   * workspace has never heard of. Those anchors are SKIPPED and reported, never
   * stored under a fabricated key.
   */
  private anchorRows(
    workspaceId: string,
    actor: IntentActor,
    itemId: string,
    anchors: readonly CodeAnchor[],
    registered: ReadonlyMap<string, string>,
    skipped: Map<string, { anchorCount: number; itemIds: Set<string> }>,
  ): Prisma.IntentAnchorCreateManyInput[] {
    // `(itemId, repoKey, nodeId)` is a unique index. Two overlay anchors on one
    // item for the same code point are the same fact stated twice, so the
    // duplicate is collapsed rather than allowed to raise a constraint error.
    const seen = new Set<string>();
    const rows: Prisma.IntentAnchorCreateManyInput[] = [];

    for (const anchor of anchors) {
      if (!registered.has(anchor.repo)) {
        const bucket = skipped.get(anchor.repo) ?? { anchorCount: 0, itemIds: new Set<string>() };
        bucket.anchorCount += 1;
        bucket.itemIds.add(itemId);
        skipped.set(anchor.repo, bucket);
        continue;
      }
      // NUL separator (written as the `\0` escape, never a raw 0x00 byte —
      // that makes the file binary to `file`/`grep`/`git diff`): neither a repo
      // key nor a node id may contain one, so two distinct pairs cannot collide
      // into one identity. In-memory only; nothing persists this string.
      const identity = `${anchor.repo}\0${anchor.nodeId}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      rows.push({
        workspaceId,
        itemId,
        repoKey: anchor.repo,
        nodeId: anchor.nodeId,
        nodeType: anchor.nodeType,
        capturedVersionedId: anchor.capturedVersionedId,
        rationale: anchor.rationale,
        createdBy: actor.id,
      });
    }

    return rows;
  }

  /**
   * The NULL-`from` arrival transition (spec §4.7, §8.1).
   *
   * `from` is NULL because an import records that an item ARRIVED already
   * decided; writing `candidate → accepted` would fabricate a review that no
   * human performed. The authorizing source names the local artifact and its
   * revision, and the actor is the token's — never the file's.
   */
  private arrivalTransitionRow(
    workspaceId: string,
    actor: IntentActor,
    item: IntentItem,
    authority: IntentItemAuthority,
    localRevision: string,
    projectId: string,
  ): Prisma.IntentAuthorityTransitionCreateManyInput {
    return {
      workspaceId,
      itemId: item.id,
      fromAuthority: null,
      toAuthority: authority,
      actorId: actor.id,
      actorRole: actor.role,
      reason: `Imported from the local intent overlay of project "${projectId}".`,
      sourceKind: IntentAuthoritySourceKind.import,
      sourceRef: `local-overlay/${projectId}`,
      sourceLocalId: item.id,
      sourceRevision: localRevision,
    };
  }
}

/** Deterministic order so a replayed result is byte-identical to the first one. */
function renderSkippedAnchors(
  skipped: ReadonlyMap<string, { anchorCount: number; itemIds: Set<string> }>,
): CloudIntentImportSkippedAnchors[] {
  return [...skipped.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([repo, bucket]) => ({
      repo,
      reason: IntentImportSkipReason.UnknownRepoKey,
      anchorCount: bucket.anchorCount,
      itemIds: [...bucket.itemIds].sort(),
    }));
}

/**
 * The overlay accepts business-rule variants without registry checks (LIM-1),
 * and an import target is empty, so it declares no dimensions: a variant `when`
 * could only name undeclared ones. Refused rather than stripped — dropping a
 * variant would silently change what the rule says. A single default-only
 * variant names nothing and imports as-is; a second default is refused as
 * propose refuses it.
 */
function assertImportableVariants(overlay: IntentFileV2): void {
  overlay.items.forEach((item, index) => {
    if (item.kind !== IntentKind.BusinessRule) return;
    const variants = (item.payload as { variants?: RuleVariant[] }).variants ?? [];
    const conditioned = variants.findIndex((variant) => variant.when !== undefined);
    if (conditioned >= 0) {
      throw intentStateError(
        IntentErrorCode.DimensionNotFound,
        `Item '${item.id}' has a variant conditioned on dimension(s) ${Object.keys(variants[conditioned].when ?? {}).join(', ')}, which an empty workspace does not declare. Import it without that variant, then declare the dimensions and propose the variants.`,
        ['overlay', 'items', String(index), 'payload', 'variants', String(conditioned), 'when'],
      );
    }
    const [overlap] = checkVariantOverlap(variants);
    if (overlap) {
      throw intentStateError(
        IntentErrorCode.VariantOverlap,
        `Item '${item.id}' has more than one default variant (variants ${overlap.otherIndex} and ${overlap.index}).`,
        ['overlay', 'items', String(index), 'payload', 'variants', String(overlap.index)],
      );
    }
  });
}
