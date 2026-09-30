/**
 * The composed capture flow: read baseline → capture → validate → atomic write.
 *
 * `captureIntentItems` is pure and knows nothing about files; `readIntentFile`
 * and `writeIntentFile` know nothing about capture rules. Composing them is the
 * step that decides which file version is the BR-2 baseline, and getting that
 * wrong silently disarms the accepted-item protection — so it is authored ONCE
 * here rather than in each caller (CLI today, any later surface).
 *
 * For a single-process capture run, the file read at the start of this function
 * IS the baseline BR-2 compares against: nothing between that read and the
 * atomic rename can be a maintainer edit this process should adopt.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { captureIntentItems, deriveIntentId } from './capture.js';
import type { CaptureItemResult } from './capture.js';
import {
  type IntentValidationError,
  IntentValidationCode,
  boundErrorReport,
  formatIntentValidationErrors,
  validateIntentFile,
} from './schema.js';
import {
  IntentOverlayStatus,
  canonicalIntentJson,
  readIntentFile,
  serializeIntentFile,
  writeIntentFile,
} from './storage.js';
import {
  INTENT_ID_PREFIX_BY_KIND,
  INTENT_SCHEMA_VERSION,
  IntentAuthority,
  type IntentFileV2,
  type IntentItem,
  type IntentItemProposal,
  type IntentKind,
} from './types.js';

/** The existing overlay could not be loaded, so capture refuses rather than overwriting it. */
export class IntentOverlayInvalidError extends Error {
  constructor(
    readonly filePath: string,
    readonly errors: IntentValidationError[],
    message: string,
  ) {
    super(message);
    this.name = 'IntentOverlayInvalidError';
  }
}

/** The proposals document was rejected before any overlay was touched. */
export class IntentProposalsInvalidError extends Error {
  constructor(
    readonly errors: IntentValidationError[],
    message: string,
  ) {
    super(message);
    this.name = 'IntentProposalsInvalidError';
  }
}

export interface CaptureIntoIntentFileOptions {
  /** Project the overlay must belong to; also the project id of a newly created shell. */
  expectedProjectId: string;
  /** Passed through to the reader's symlink-containment check. */
  containmentRoot?: string;
}

export interface CaptureIntoIntentFileResult {
  path: string;
  /** The overlay did not exist and this run created it (UC-1 first run). */
  createdFile: boolean;
  /** True when the bytes on disk changed; false on an idempotent re-capture. */
  changed: boolean;
  /** Ids of candidates this run added, in proposal order. */
  createdItemIds: string[];
  /** Ids of existing candidates this run rewrote, in proposal order. */
  updatedItemIds: string[];
  /** Ids matched by a proposal whose stored payload is already identical. */
  unchangedItemIds: string[];
  /** Accepted items sharing a source identity with a proposal; left untouched (BR-2). */
  preservedAcceptedItemIds: string[];
  /** Domain ids the CREATED shell declared from the proposals; empty for an existing overlay. */
  seededDomainIds: string[];
  /** Supplied proposal ids the matched items did not adopt (BR-17), in proposal order. */
  ignoredProposalIds: string[];
  /**
   * Ids whose stored code anchors a proposal's own anchor set replaced, with how
   * many touchpoints it displaced. The one thing capture still overwrites, so it
   * is surfaced rather than left for the maintainer to find in the diff.
   */
  droppedAnchors: Array<{ itemId: string; count: number }>;
  results: CaptureItemResult[];
  file: IntentFileV2;
}

/**
 * A capture into an absent overlay is UC-1's first run, so it creates the file
 * rather than failing: `not_configured` is a read-side state (reads never create
 * the file), while capture is an explicit, authorized write.
 *
 * The shell DECLARES the domains the first batch references, with placeholder
 * titles for the maintainer to rewrite in review. This is the one place a
 * registry is written by capture, and it is not an edit of anyone's registry:
 * an existing overlay's `domains` are never touched, so an undeclared domain
 * there stays a refusal (BR-18/BR-19). Without it the very first capture into a
 * repo could never validate, since every item must name a declared domain and
 * no surface creates the registry.
 */
function freshOverlay(projectId: string, proposals: IntentItemProposal[]): IntentFileV2 {
  const domains: IntentFileV2['domains'] = [];
  for (const proposal of proposals) {
    if (domains.some((domain) => domain.id === proposal.domain)) continue;
    domains.push({ id: proposal.domain, title: placeholderDomainTitle(proposal.domain) });
  }
  return { schemaVersion: INTENT_SCHEMA_VERSION, projectId, domains, items: [], relations: [] };
}

/**
 * `order-capture` → `TODO review: order capture`.
 *
 * The domains registry is maintainer-owned (BR-18/BR-19 rely on that); a
 * first-capture seed is the one exception, and it must not read like a
 * reviewed entry once it lands in the diff. A plain-cased title ("Order
 * capture") is indistinguishable from one a maintainer wrote by hand, so a
 * reviewer would have no signal that an agent invented the product area. The
 * `TODO review:` marker carries that provisionality into the artifact itself,
 * stable and deterministic so re-seeding never produces a different title.
 */
function placeholderDomainTitle(domainId: string): string {
  const words = domainId.split('-').join(' ');
  return `TODO review: ${words}`;
}

/**
 * Containment for the file this run is about to CREATE.
 *
 * The reader's check only guards a file that already exists, so on the UC-1
 * first run a `.coredoc` symlinked out of the checkout would be followed by the
 * write with nothing in the way. The decision is made on the nearest EXISTING
 * ancestor of the overlay path — that is the directory the write actually lands
 * in once the missing segments are created, and it is the only link the
 * filesystem can resolve today.
 *
 * The message is fixed and echoes no content, matching the reader's refusal.
 */
function assertCreatePathContained(intentPath: string, containmentRoot: string): void {
  let realAncestor: string;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(containmentRoot);
    let ancestor = path.dirname(path.resolve(intentPath));
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    realAncestor = fs.realpathSync(ancestor);
  } catch (error) {
    throw refuseUncontainedCreate(intentPath, `unresolvable (${errnoOf(error)})`);
  }

  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
    throw refuseUncontainedCreate(intentPath, 'path escapes repository');
  }
}

/** `EACCES`, `ELOOP`, … — an errno name carries no file content. */
function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

function refuseUncontainedCreate(intentPath: string, reason: string): IntentOverlayInvalidError {
  return new IntentOverlayInvalidError(
    intentPath,
    [{ code: IntentValidationCode.Malformed, path: [], message: reason }],
    `intent.json at ${intentPath} is invalid:\n<file>: ${reason}\nCapture refused: nothing was written.`,
  );
}

export function captureIntoIntentFile(
  intentPath: string,
  proposals: IntentItemProposal[],
  options: CaptureIntoIntentFileOptions,
): CaptureIntoIntentFileResult {
  const read = readIntentFile(intentPath, {
    expectedProjectId: options.expectedProjectId,
    ...(options.containmentRoot !== undefined ? { containmentRoot: options.containmentRoot } : {}),
  });

  if (read.status === IntentOverlayStatus.Invalid) {
    throw new IntentOverlayInvalidError(
      intentPath,
      read.errors,
      `${read.message}\nCapture refused: fix the overlay (or restore it from Git) and run capture again. Nothing was written.`,
    );
  }

  const createdFile = read.status === IntentOverlayStatus.NotConfigured;
  if (createdFile && options.containmentRoot !== undefined) {
    assertCreatePathContained(intentPath, options.containmentRoot);
  }
  const baseline = createdFile ? freshOverlay(options.expectedProjectId, proposals) : read.file;
  const beforeById = new Map(baseline.items.map((item) => [item.id, canonicalIntentJson(item)]));

  // baseline === current: for one CLI run there is no second, newer version of
  // the file to reconcile against.
  const captured = captureIntentItems({ baseline, current: baseline, proposals });

  const createdItemIds: string[] = [];
  const updatedItemIds: string[] = [];
  const unchangedItemIds: string[] = [];
  const preservedAcceptedItemIds: string[] = [];
  const ignoredProposalIds: string[] = [];
  const droppedAnchors: Array<{ itemId: string; count: number }> = [];
  const capturedById = new Map(captured.file.items.map((item) => [item.id, item] as [string, IntentItem]));

  for (const result of captured.results) {
    const before = beforeById.get(result.itemId);
    const after = capturedById.get(result.itemId);
    if (before === undefined) createdItemIds.push(result.itemId);
    else if (after !== undefined && canonicalIntentJson(after) === before) unchangedItemIds.push(result.itemId);
    else updatedItemIds.push(result.itemId);
    for (const acceptedId of result.preservedAcceptedItemIds) {
      if (!preservedAcceptedItemIds.includes(acceptedId)) preservedAcceptedItemIds.push(acceptedId);
    }
    if (result.ignoredProposalId !== undefined) ignoredProposalIds.push(result.ignoredProposalId);
    if (result.droppedAnchorCount !== undefined) {
      droppedAnchors.push({ itemId: result.itemId, count: result.droppedAnchorCount });
    }
  }

  // Writing identical bytes would still be correct, but it would touch a
  // git-tracked file on every no-op re-capture; skipping keeps a re-run
  // invisible in the maintainer's working tree.
  const nextBytes = serializeIntentFile(captured.file);
  const changed = createdFile || nextBytes !== serializeIntentFile(baseline);
  if (changed) {
    writeIntentFile(intentPath, captured.file, { expectedProjectId: options.expectedProjectId });
  }

  return {
    path: intentPath,
    createdFile,
    changed,
    createdItemIds,
    updatedItemIds,
    unchangedItemIds,
    preservedAcceptedItemIds,
    seededDomainIds: createdFile ? baseline.domains.map((domain) => domain.id) : [],
    ignoredProposalIds,
    droppedAnchors,
    results: captured.results,
    file: captured.file,
  };
}

/**
 * The proposals document an agent hands to capture: `{ items: [...] }` and
 * nothing else.
 *
 * Item strictness is NOT re-declared here — the proposals are given the
 * `candidate` authority they are always going to get (BR-1) and run through the
 * one strict file validator, so the bounded-text and unknown-key denials that
 * keep source bodies, prompts, and transcripts out of the overlay (BR-14 /
 * AC-11) cannot drift between the capture entry point and the file contract.
 */
const ProposalsDocumentSchema = z.object({ items: z.array(z.unknown()).min(1) }).strict();

export function parseIntentProposalsDocument(input: unknown, expectedProjectId: string): IntentItemProposal[] {
  const document = ProposalsDocumentSchema.safeParse(input);
  if (!document.success) {
    throw new IntentProposalsInvalidError(
      // zod echoes the offending key, which is untrusted authored input: the
      // report goes through the same bound the file validator applies.
      boundErrorReport(
        document.error.issues.map((issue) => ({
          code: IntentValidationCode.Schema,
          path: issue.path as (string | number)[],
          message: issue.message,
        })),
      ),
      'the proposals document must be {"items": [<one or more intent proposals>]} with no other keys',
    );
  }

  // A proposal carries no `authority` by construction. Refusing the key
  // explicitly is what makes BR-1 observable: silently overwriting it would let
  // an agent believe it had accepted its own proposal.
  const authored = document.data.items.map((item, index) => {
    if (typeof item === 'object' && item !== null && 'authority' in item) {
      throw new IntentProposalsInvalidError(
        [
          {
            code: IntentValidationCode.Schema,
            path: ['items', index, 'authority'],
            message:
              'a proposal must not set authority: capture always writes a candidate, and only a maintainer edit can accept it',
          },
        ],
        'the proposals document sets an authority',
      );
    }
    return { ...(item as object), authority: IntentAuthority.Candidate };
  });

  // A proposal may omit its id (capture derives it from the title), but the ONE
  // strict validator this function reuses describes complete items. Each such
  // proposal is validated under a PROVISIONAL id derived the same way capture
  // will derive the real one, and the id is stripped again on the way out so
  // capture — which alone knows the overlay's taken ids — still assigns it.
  const provisionalIndexes = new Set<number>();
  // Seeded with every id an author supplied explicitly, not just other
  // provisional ones: an id-less proposal that would derive the SAME id as an
  // explicit sibling must not collide with it here, or a legal batch (real
  // capture would suffix the id-less one, e.g. `-2`) is rejected against a key
  // the author never wrote.
  const provisionalIds = new Set<string>(
    authored.map((item) => (item as { id?: unknown }).id).filter((id): id is string => typeof id === 'string'),
  );
  const withIds = authored.map((item, index) => {
    if (typeof (item as { id?: unknown }).id === 'string') return item;
    provisionalIndexes.add(index);
    const provisional = provisionalProposalId(item, index, provisionalIds);
    provisionalIds.add(provisional);
    return { ...item, id: provisional };
  });

  const validated = validateIntentFile(
    {
      schemaVersion: INTENT_SCHEMA_VERSION,
      projectId: expectedProjectId,
      // The proposals document carries no registry; the domains it references
      // are declared here so this pass checks their FORMAT only. Whether the
      // overlay actually declares them is decided against the real file when
      // capture validates its result (BR-18).
      domains: declaredDomainsOf(withIds),
      items: withIds,
      relations: [],
    },
    { expectedProjectId },
  );
  if (!validated.ok) {
    throw new IntentProposalsInvalidError(
      validated.errors,
      `the proposals document was rejected:\n${formatIntentValidationErrors(validated.errors)}`,
    );
  }

  return validated.file.items.map((item, index) => {
    const { authority: _authority, ...proposal } = item;
    if (!provisionalIndexes.has(index)) return proposal as IntentItemProposal;
    const { id: _provisionalId, ...withoutId } = proposal;
    return withoutId as IntentItemProposal;
  });
}

/** Every distinct, non-empty `domain` the document references, as a format-checkable registry. */
function declaredDomainsOf(items: object[]): IntentFileV2['domains'] {
  const domains: IntentFileV2['domains'] = [];
  for (const item of items) {
    const domain = (item as { domain?: unknown }).domain;
    if (typeof domain !== 'string' || domain.length === 0) continue;
    if (domains.some((declared) => declared.id === domain)) continue;
    domains.push({ id: domain, title: domain });
  }
  return domains;
}

/**
 * A stand-in id for a proposal that omitted one, good enough for the strict
 * validator to describe the rest of the item.
 *
 * A proposal whose `kind` or `title` cannot produce a slug gets a placeholder
 * rather than an exception: the very next validation pass reports the real
 * defect (an unknown kind, a missing title) with its own path, which is what
 * the author has to fix.
 */
function provisionalProposalId(item: object, index: number, taken: Set<string>): string {
  const kind = (item as { kind?: unknown }).kind as IntentKind;
  const prefix = INTENT_ID_PREFIX_BY_KIND[kind] as string | undefined;
  if (prefix === undefined) return `unresolved-kind-${index}`;
  const title = (item as { title?: unknown }).title;
  if (typeof title !== 'string') return `${prefix}-untitled-proposal-${index}`;
  try {
    return deriveIntentId(kind, title, taken);
  } catch {
    return `${prefix}-untitled-proposal-${index}`;
  }
}
