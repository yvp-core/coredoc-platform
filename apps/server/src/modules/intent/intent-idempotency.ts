/**
 * Idempotency ledger + audit trail, written in the SAME transaction as the
 * state change (spec §4.8).
 *
 * Lifted from the archived `intent-authority.service.ts` (`cached()` /
 * `auditAndRemember()`), with the `projectId` discriminator dropped — the key
 * is `(workspaceId, idempotencyKey)`, because the workspace is the product root
 * and there are no projects any more.
 *
 * The single invariant this file exists to hold: a mutation's STATE CHANGE, its
 * AUDIT ROW, and its LEDGER ROW commit together or not at all. A crash between
 * them would otherwise leave either an unrecorded change (no trail) or a spent
 * key with no effect (a retry that reports success and did nothing).
 */
import { createHash } from 'node:crypto';
import { IntentAuditEntityKind, type IntentItemAuthority, Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { intentConflict, intentNotFound } from './intent-state-errors.js';
import { IntentErrorCode } from './contract/index.js';

/** The interactive-transaction client every mutation body receives. */
export type IntentTransaction = Prisma.TransactionClient;

/**
 * Operation names as stored in `intent_mutation_requests.operation`. A replay
 * of a key under a DIFFERENT operation is a conflict, so these strings are
 * durable contract, not log text.
 */
export enum IntentOperation {
  HandoffSave = 'handoff.save',
  ReleaseEvent = 'release.event',
  DomainCreate = 'domain.create',
  DomainUpdate = 'domain.update',
  DomainArchive = 'domain.archive',
  DomainDelete = 'domain.delete',
  FeatureCreate = 'feature.create',
  FeatureUpdate = 'feature.update',
  FeatureArchive = 'feature.archive',
  FeatureDelete = 'feature.delete',
  DimensionCreate = 'dimension.create',
  DimensionUpdate = 'dimension.update',
  DimensionArchive = 'dimension.archive',
  DimensionDelete = 'dimension.delete',
  SeedPut = 'seed.put',
  SeedDelete = 'seed.delete',
  RelationPut = 'relation.put',
  RelationDelete = 'relation.delete',
  CommentCreate = 'comment.create',
  CommentStatus = 'comment.status',
  ItemsPropose = 'items.propose',
  ItemsReview = 'items.review',
  AnchorAdd = 'anchor.add',
  AnchorRefresh = 'anchor.refresh',
  AnchorRemove = 'anchor.remove',
  SourceUpdate = 'source.update',
  /**
   * Whole-workspace import of a `CloudIntentWorkspaceDocumentV1`. Export has no
   * member on purpose: it is a read, and a read spends no key. (`overlay.import`
   * is a retired value that persisted ledger rows may still carry.)
   */
  WorkspaceImport = 'workspace.import',
}

/** What an audit row says happened to one entity. */
export enum IntentAuditOperation {
  Create = 'create',
  Update = 'update',
  Archive = 'archive',
  Unarchive = 'unarchive',
  Delete = 'delete',
  ProposeCreate = 'propose_create',
  ProposeUpdate = 'propose_update',
}

/**
 * The acting principal. ALWAYS derived from the auth token (spec §4.7), never
 * from a request payload — the content contract rejects email-shaped strings
 * precisely so nobody can smuggle an identity through one.
 */
export interface IntentActor {
  id: string;
  role: string;
}

/** One audit row to write alongside the change. */
export interface IntentAuditRecord {
  entityKind: (typeof IntentAuditEntityKind)[keyof typeof IntentAuditEntityKind];
  entityId: string;
  operation: IntentAuditOperation;
  /** Bounded projections — identifiers and small scalars, never a full row dump. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Serialized-size ceiling for one audit projection. Exceeding it is a bug in the caller. */
const MAX_AUDIT_PROJECTION_CHARS = 4_096;

/**
 * Stable JSON: object keys in sorted order at every depth, so the request hash
 * of two equal requests is equal regardless of key order on the wire.
 * Not core's `canonicalIntentJson`: that one assigns keys, so an own `__proto__`
 * key vanishes, while this keeps it — swapping would change persisted ledger hashes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeys(entry)]));
}

/**
 * The request fingerprint stored in the ledger.
 *
 * The operation is mixed in so that two different operations sharing a body
 * shape can never look like a replay of each other, and the idempotency key is
 * NOT part of it — the key is the lookup, the hash is what the key was spent on.
 *
 * The separator is a NUL, written as the `\0` ESCAPE. A NUL cannot occur in an
 * `IntentOperation` value, so no operation/body pair can straddle it into
 * another pair's digest. Written as a raw 0x00 byte this file stopped being
 * text to `file`, `grep`, and `git diff`; the escape is byte-identical at
 * runtime, which `hashIntentRequest is byte-stable` below pins to fixed digests
 * so nobody can "clean up" the separator and silently orphan every persisted
 * `intent_mutation_requests.request_hash`.
 */
export function hashIntentRequest(operation: IntentOperation, request: unknown): string {
  return createHash('sha256')
    .update(`${operation}\0${canonicalJson(request)}`)
    .digest('hex');
}

function assertBoundedProjection(projection: Record<string, unknown> | undefined, label: string): void {
  if (projection === undefined) return;
  if (canonicalJson(projection).length > MAX_AUDIT_PROJECTION_CHARS) {
    // Not a caller-facing refusal: the module builds these projections itself,
    // so an oversized one is a programming error, caught loudly in tests.
    throw new Error(`Intent audit ${label} projection exceeds ${MAX_AUDIT_PROJECTION_CHARS} characters`);
  }
}

function json(value: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  return value === undefined ? undefined : (sortKeys(value) as Prisma.InputJsonValue);
}

/**
 * Rows per `createMany` statement.
 *
 * Postgres caps one statement at 65535 bind parameters. The widest intent row
 * has well under 16 columns, so 1000 rows stays an order of magnitude clear of
 * that ceiling for every table here — no per-table tuning, no silent breakage
 * when a column is added.
 */
const CREATE_MANY_CHUNK_ROWS = 1_000;

/** The one method this module needs off a Prisma model delegate. */
interface CreateManyDelegate<Row> {
  createMany(args: { data: Row[] }): Promise<{ count: number }>;
}

/**
 * `createMany` in bounded chunks, returning the rows actually written.
 *
 * The alternative — `await create()` per row — costs one round trip per row
 * inside the transaction, which is what put a legal-sized import over its time
 * budget. Nothing here reads a generated column back, so there is no reason to
 * pay for per-row results.
 */
export async function createIntentRowsChunked<Row>(delegate: CreateManyDelegate<Row>, rows: Row[]): Promise<number> {
  let written = 0;
  for (let start = 0; start < rows.length; start += CREATE_MANY_CHUNK_ROWS) {
    const result = await delegate.createMany({ data: rows.slice(start, start + CREATE_MANY_CHUNK_ROWS) });
    written += result.count;
  }
  return written;
}

/** The narrowest reader the ledger lookup needs — the client and a transaction both satisfy it. */
export interface IntentMutationRequestReader {
  intentMutationRequest: Pick<Prisma.TransactionClient['intentMutationRequest'], 'findUnique'>;
}

/** One spent-key verdict. Absent means unspent; the wrapper keeps a stored `null` readable. */
export interface IntentSpentRequest {
  /**
   * The stored response of the committed request, ready to return verbatim.
   * `unknown` rather than `Prisma.JsonValue`: the only reader is the operation
   * that stored it, which knows its own response type, and typing it as JSON
   * would force every caller through a double cast to say so.
   */
  response: unknown;
}

/**
 * Return the stored response when this key was already spent on this exact
 * request; refuse when it was spent on something else.
 *
 * TWO CALLERS, ONE COMPARISON. {@link runIntentMutation} runs it INSIDE the
 * transaction, which is the only sound place for the authoritative check: it is
 * serialized with the write, and that is what makes two racing replays safe.
 * The mutations that must resolve graph facts before they can open a
 * transaction (propose-with-anchor-suggestions, anchor add/refresh) run it a
 * second time FIRST, outside any transaction, against the client: graph
 * resolution REFUSES rather than degrades, so a replay of an already-committed
 * key would fail with `anchor_node_missing` if the node had since been deleted
 * or the snapshot republished — breaking the one promise an idempotency key
 * makes. A key spent on something else is the usual typed conflict, raised
 * there too so a mismatched replay is not charged a snapshot lease either.
 *
 * The pre-transaction call is an OPTIMISATION, NOT THE AUTHORITY: it can miss a
 * key that commits a microsecond later, the in-transaction call still decides,
 * and the ledger's primary key still catches the loser of a race.
 */
export async function findSpentIntentRequest(
  reader: IntentMutationRequestReader,
  workspaceId: string,
  idempotencyKey: string,
  operation: IntentOperation,
  requestHash: string,
): Promise<IntentSpentRequest | undefined> {
  const existing = await reader.intentMutationRequest.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
  });
  if (!existing) return undefined;
  if (existing.operation !== operation) {
    throw intentConflict(
      IntentErrorCode.IdempotencyOperationConflict,
      `This idempotency key was already used for the '${existing.operation}' operation`,
      ['idempotencyKey'],
    );
  }
  if (existing.requestHash !== requestHash) {
    throw intentConflict(
      IntentErrorCode.IdempotencyRequestConflict,
      'This idempotency key was already used for a different request body',
      ['idempotencyKey'],
    );
  }
  return { response: existing.response };
}

/** One audit row, for a write that records its trail outside {@link runIntentMutation}. */
export async function writeIntentAudit(
  tx: IntentTransaction,
  workspaceId: string,
  actor: IntentActor,
  audit: IntentAuditRecord,
): Promise<void> {
  assertBoundedProjection(audit.before, 'before');
  assertBoundedProjection(audit.after, 'after');
  await tx.intentAuditEvent.create({
    data: {
      workspaceId,
      entityKind: audit.entityKind,
      entityId: audit.entityId,
      operation: audit.operation,
      actorId: actor.id,
      actorRole: actor.role,
      before: json(audit.before),
      after: json(audit.after),
    },
  });
}

/** Write the audit rows and the ledger row. Same `tx` as the change, by construction. */
async function auditAndRemember(
  tx: IntentTransaction,
  args: {
    workspaceId: string;
    actor: IntentActor;
    operation: IntentOperation;
    idempotencyKey: string;
    requestHash: string;
    audits: IntentAuditRecord[];
    response: unknown;
  },
): Promise<void> {
  // Per-row `create`, deliberately. An import's audit trail is the longest one
  // written here (one row per item plus one per domain, so low hundreds), which
  // is a small share of the import transaction's budget; batching these bought
  // little and would have changed the write shape every mutation in the module
  // depends on. The rows that scale with the document are inserted in chunks at
  // their own call site in `intent-workspace-import`.
  for (const audit of args.audits) await writeIntentAudit(tx, args.workspaceId, args.actor, audit);

  await tx.intentMutationRequest.create({
    data: {
      workspaceId: args.workspaceId,
      idempotencyKey: args.idempotencyKey,
      operation: args.operation,
      requestHash: args.requestHash,
      response: sortKeys(args.response) as Prisma.InputJsonValue,
    },
  });
}

export interface IntentMutationContext {
  workspaceId: string;
  actor: IntentActor;
  operation: IntentOperation;
  idempotencyKey: string;
  /** The validated request, hashed into the ledger. */
  request: unknown;
  /**
   * Transaction shape for mutations that are not small.
   *
   * Omitted, a mutation runs on Prisma's defaults (READ COMMITTED, 5s), which
   * is right for the ordinary single-row tree and review writes. An operation
   * whose worst LEGAL input is bigger than that — import, which writes an entire
   * workspace document — must state its own budget here rather than discover the 5s ceiling
   * in production, where the timeout aborts the transaction WITHOUT a ledger row
   * and the caller's only documented recovery is to replay a key that will time
   * out identically.
   */
  transaction?: IntentTransactionOptions;
  /** Reconcile a newly attached dependent operation with an already committed result.
   * Runs only after the replay hash matches, in the same transaction as its return. */
  onReplay?: (tx: IntentTransaction) => Promise<void>;
}

/** The `$transaction` options a mutation may set. Mirrors Prisma's own option names. */
export interface IntentTransactionOptions {
  /** Milliseconds the interactive transaction may run before Prisma aborts it. */
  timeout: number;
  /** Milliseconds to wait for a connection from the pool before giving up. */
  maxWait: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * Run one intent mutation: replay check, change, audit, ledger — one
 * transaction, in that order.
 *
 * `apply` returns the caller-visible response together with the audit rows that
 * describe what it changed. Returning them (rather than writing them itself)
 * is what makes "every change writes an audit row" checkable at this single
 * seam instead of at every call site.
 */
export async function runIntentMutation<T>(
  prisma: PrismaService,
  context: IntentMutationContext,
  apply: (tx: IntentTransaction) => Promise<{ response: T; audits: IntentAuditRecord[] }>,
): Promise<T> {
  const requestHash = hashIntentRequest(context.operation, context.request);

  try {
    return await prisma.$transaction(async (tx) => {
      const replay = await findSpentIntentRequest(
        tx,
        context.workspaceId,
        context.idempotencyKey,
        context.operation,
        requestHash,
      );
      if (replay !== undefined) {
        await context.onReplay?.(tx);
        return replay.response as T;
      }

      const { response, audits } = await apply(tx);
      await auditAndRemember(tx, {
        workspaceId: context.workspaceId,
        actor: context.actor,
        operation: context.operation,
        idempotencyKey: context.idempotencyKey,
        requestHash,
        audits,
        response,
      });
      return response;
    }, context.transaction);
  } catch (error) {
    throw translateMutationFailure(error);
  }
}

/** The Prisma error codes this seam translates. Enum, so no bare string reaches a branch. */
enum PrismaErrorCode {
  UniqueConstraint = 'P2002',
  TransactionTimedOut = 'P2028',
  WriteConflict = 'P2034',
}

/**
 * The columns of `intent_mutation_requests`' primary key, as Prisma reports them
 * in `P2002.meta.target`. Matching on this — rather than on the bare `P2002`
 * code — is what keeps the in-flight answer HONEST: it is only true of a race on
 * the LEDGER row itself.
 */
const LEDGER_PRIMARY_KEY_COLUMNS = ['workspaceId', 'idempotencyKey'];

/** Prisma reports `meta.target` as `string[]` on Postgres and `string` elsewhere. */
function uniqueConstraintColumns(error: Prisma.PrismaClientKnownRequestError): string[] | null {
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target) && target.every((column) => typeof column === 'string')) return target;
  if (typeof target === 'string') return [target];
  return null;
}

/**
 * Map a failed mutation to the refusal that is TRUE of it.
 *
 * The narrow case: two replays of one key racing. The loser's ledger INSERT
 * hits `(workspaceId, idempotencyKey)`; its transaction rolled back, so nothing
 * was applied twice, and the caller retries to read the winner's stored
 * response. That is the only unique violation `idempotency_in_flight` describes.
 *
 * Every OTHER unique violation is a different fact — a duplicate domain id, a
 * repeated anchor identity, a seed proposed twice — and answering "retry to read
 * its result" would send the caller into a loop that can never succeed, because
 * there is no winner to read. Those surface as `unique_constraint_violation`
 * NAMING the constraint, so the refusal is actionable rather than a lie.
 */
export function translateMutationFailure(error: unknown): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return error;

  // Nothing committed, so the key is still unspent and the DOCUMENTED recovery
  // ("re-send the same request with the same key") actually works. Left as a raw
  // Prisma error these surfaced as a 500, which told the caller nothing about
  // whether their write landed.
  if (error.code === PrismaErrorCode.WriteConflict || error.code === PrismaErrorCode.TransactionTimedOut) {
    const cause =
      error.code === PrismaErrorCode.WriteConflict
        ? 'a concurrent write to the same rows'
        : 'exceeding its time budget';
    return intentConflict(
      IntentErrorCode.TransactionConflict,
      `The request did not commit because of ${cause}; nothing was written, so retry it with the same idempotency key`,
      ['idempotencyKey'],
    );
  }

  if (error.code !== PrismaErrorCode.UniqueConstraint) return error;

  const columns = uniqueConstraintColumns(error);
  const isLedgerRace =
    columns !== null &&
    columns.length === LEDGER_PRIMARY_KEY_COLUMNS.length &&
    LEDGER_PRIMARY_KEY_COLUMNS.every((column) => columns.includes(column));

  if (isLedgerRace) {
    return intentConflict(
      IntentErrorCode.IdempotencyInFlight,
      'A concurrent request with this idempotency key is still committing; retry to read its result',
      ['idempotencyKey'],
    );
  }

  // A constraint Prisma could not name is still NOT the ledger race, so it must
  // not borrow the retryable answer.
  const named = columns === null ? 'a unique constraint' : `the unique constraint on (${columns.join(', ')})`;
  return intentConflict(
    IntentErrorCode.UniqueConstraintViolation,
    `This request conflicts with a row that already exists: ${named}`,
    [],
  );
}

/**
 * Optimistic concurrency for `intent_items` (spec §13): one conditional
 *
 *   UPDATE intent_items SET …, version = version + 1
 *   WHERE workspace_id = ? AND id = ? AND version = ?
 *
 * whose affected-row count IS the concurrency check — never a read-then-write.
 * On failure the caller gets the CURRENT version in a typed conflict so a
 * reviewer can re-read exactly what changed instead of guessing (spec §5).
 */
export interface UpdateItemWithVersionArgs {
  workspaceId: string;
  itemId: string;
  /** The version the caller actually read. */
  expectedVersion: number;
  /** Column updates. `version` and `updatedAt` are managed here, never by the caller. */
  data: Record<string, unknown>;
  /** Actor id for `updated_by`. */
  updatedBy: string;
  /** Field path reported on a conflict (e.g. `['decisions', '0', 'expectedVersion']`). */
  path?: string[];
  /**
   * Also require this authority in the same statement. Propose passes
   * `candidate` so a concurrent accept can never be overwritten; review omits
   * it because it writes accepted rows itself.
   */
  requireAuthority?: IntentItemAuthority;
}

/**
 * Apply a versioned update and return the item's NEW version.
 *
 * Throws {@link IntentErrorCode.VersionConflict} (409) when the row exists
 * at a different version, and {@link IntentErrorCode.ItemNotFound} (404)
 * when it does not exist at all — the two are distinguished by a follow-up
 * read, because `updateMany` reports only a count and "0 rows" alone cannot
 * tell a reviewer whether they lost a race or named a ghost.
 */
export async function updateItemWithVersion(tx: IntentTransaction, args: UpdateItemWithVersionArgs): Promise<number> {
  const path = args.path ?? ['expectedVersion'];
  const updated = await tx.intentItem.updateMany({
    where: {
      workspaceId: args.workspaceId,
      id: args.itemId,
      version: args.expectedVersion,
      ...(args.requireAuthority !== undefined ? { authority: args.requireAuthority } : {}),
    },
    data: { ...args.data, updatedBy: args.updatedBy, version: { increment: 1 } },
  });
  if (updated.count === 1) return args.expectedVersion + 1;

  const current = await tx.intentItem.findUnique({
    where: { workspaceId_id: { workspaceId: args.workspaceId, id: args.itemId } },
    select: { version: true, authority: true },
  });
  if (!current) {
    throw intentNotFound(
      IntentErrorCode.ItemNotFound,
      `Intent item '${args.itemId}' does not exist in this workspace`,
      path,
    );
  }
  // Checked before the version: an authority change is terminal for this
  // update, whereas a version conflict invites a re-read and retry.
  if (args.requireAuthority !== undefined && current.authority !== args.requireAuthority) {
    throw intentConflict(
      IntentErrorCode.ItemNoLongerCandidate,
      `Intent item '${args.itemId}' was ${current.authority} while this request was in flight and was left unchanged; propose again to create a successor candidate.`,
      path,
    );
  }
  throw intentConflict(
    IntentErrorCode.VersionConflict,
    `Intent item '${args.itemId}' changed: expected version ${args.expectedVersion}, current version is ${current.version}. Re-read the item and decide again.`,
    path,
  );
}
