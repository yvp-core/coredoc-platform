/**
 * The two cloud-facing intent verbs: `coredoc intent import` (onboarding +
 * cutover, spec §8.1) and `coredoc intent export` (the projection, spec §9).
 *
 * Separate from `commands/intent.ts` because the split is real: that file is
 * the LOCAL overlay surface and touches no network; this one talks to a
 * workspace and is the only place a project's write authority changes hands.
 *
 * NO STATE MACHINE. Import is one idempotent POST followed by one config write.
 * If the process dies between them the server already holds the content and the
 * marker is missing — rerunning the identical command re-derives the identical
 * idempotency key, the server replays the stored result, and the marker write
 * completes. That is the whole recovery story; the archived handover's frozen
 * intermediate states are exactly what this retires.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BrownfieldPacketInvalidError,
  IntentOverlayStatus,
  MAX_INTENT_IMPORT_BODY_BYTES,
  ProjectIntentMode,
  canonicalIntentJson,
  parseBrownfieldPacket,
  readIntentFile,
  resolveIntentTarget,
  type RuntimeConfig,
} from '@coredoc/core';
import { writeProjectIntent } from '../sync/config-writer.js';
import { safe } from './intent.js';
import {
  IntentApiError,
  exportIntent,
  getIntentImportPreflight,
  importIntentOverlay,
  recordIntentRelease,
  type CloudIntentExportDocument,
  type CloudIntentImportResult,
  type CloudIntentReleaseResult,
  type ImportIntentOverlayBody,
  type IntentImportPreflight,
  type RecordIntentReleaseBody,
} from '../sync/workspace-api.js';

/**
 * The idempotency key `coredoc intent import` spends.
 *
 * Derived from the overlay revision and NOTHING else — not a timestamp, not a
 * random id — because rerunning after a crash must produce the same key or the
 * server would import a second copy instead of replaying the first. Editing the
 * overlay changes the revision and therefore the key, which is correct: that is
 * a different import, and it will be refused by `workspace_not_empty` rather
 * than silently merged.
 */
export function intentImportIdempotencyKey(localRevision: string): string {
  return `intent-import-${localRevision}`;
}

/**
 * The bytes `POST …/intent/import` will actually see.
 *
 * `JSON.stringify` on the exact object the transport sends, not an estimate
 * from the file size: the envelope adds its own keys, and the CLI uploads the
 * READ-BACK model rather than the raw file bytes.
 */
export function intentImportBodyBytes(body: ImportIntentOverlayBody): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf-8');
}

/**
 * Refuse an oversize import BEFORE it is sent, naming the bound.
 *
 * The server caps this route at `MAX_INTENT_IMPORT_BODY_BYTES` and answers 413
 * from `Content-Length` — a bare status with no intent error shape, so the §12
 * renderer has nothing to show and the maintainer learns only that "something"
 * was too big. The same bound checked here turns that into a sentence naming
 * the file, its size, and the ceiling. It is deliberately the SAME constant, so
 * this can only be stricter than the server by accident of drift, never by
 * design.
 */
export function assertIntentImportBodyWithinCeiling(body: ImportIntentOverlayBody, intentPath: string): void {
  const bytes = intentImportBodyBytes(body);
  if (bytes <= MAX_INTENT_IMPORT_BODY_BYTES) return;
  throw new Error(
    `${intentPath} serialises to a ${bytes}-byte import request, above the ${MAX_INTENT_IMPORT_BODY_BYTES}-byte ` +
      'ceiling the cloud import route accepts. Nothing was sent. Split the overlay or shorten its payloads; ' +
      'the bound is `MAX_INTENT_IMPORT_BODY_BYTES` in @coredoc/core.',
  );
}

/** Injected in tests so the flow is exercised without a server. */
export interface IntentCloudTransport {
  importOverlay: (workspaceId: string, body: ImportIntentOverlayBody) => Promise<CloudIntentImportResult>;
  fetchExport: (workspaceId: string) => Promise<CloudIntentExportDocument>;
}

const defaultTransport: IntentCloudTransport = { importOverlay: importIntentOverlay, fetchExport: exportIntent };

export interface IntentImportCliResult {
  projectId: string;
  workspaceId: string;
  repo: string;
  intentPath: string;
  localRevision: string;
  idempotencyKey: string;
  /** True when the config already carried this exact marker before the run. */
  markerAlreadyPresent: boolean;
  result: CloudIntentImportResult;
}

/**
 * What `coredoc intent import` is about to do, spelled out before it does it.
 *
 * Import is a ONE-WAY authority cutover: after it, local `intent capture` fails
 * fast and the overlay on disk becomes a frozen snapshot. There is no
 * un-cutover verb. A step that irreversible must not happen because someone
 * pasted a command with the wrong `-w`, so the confirmation is explicit and the
 * refusal is the description of the consequence.
 */
export function describeIntentImportPlan(plan: {
  projectId: string;
  workspaceId: string;
  intentPath: string;
  items: number;
  relations: number;
  domains: number;
  codeAnchors: number;
}): string {
  return [
    `\`coredoc intent import\` hands product-intent AUTHORITY for project "${plan.projectId}" to workspace ${plan.workspaceId}. This cannot be undone by a command.`,
    `  overlay:      ${plan.intentPath}`,
    `  items:        ${plan.items}`,
    `  relations:    ${plan.relations} (the cloud model has no item-to-item relations — these are dropped)`,
    `  domains:      ${plan.domains}`,
    `  code anchors: ${plan.codeAnchors}`,
    '  after:        local `coredoc intent capture` fails fast; the overlay on disk becomes a frozen, non-authoritative snapshot.',
    'Re-run with --yes to proceed.',
  ].join('\n');
}

export async function runIntentImport(options: {
  config: RuntimeConfig;
  projectId: string;
  workspaceId: string;
  /** Explicit confirmation of the one-way cutover. Absent, the command refuses. */
  yes?: boolean;
  transport?: IntentCloudTransport;
}): Promise<IntentImportCliResult> {
  const { config, projectId, workspaceId } = options;
  const transport = options.transport ?? defaultTransport;

  const existing = config.projects.find((project) => project.id === projectId)?.intent;
  if (existing !== undefined && existing.workspaceId !== workspaceId) {
    // Not a recoverable rerun: two workspaces cannot both own one project's
    // intent, and guessing which the maintainer meant is exactly the silent
    // authority split the cutover marker exists to prevent.
    throw new Error(
      `Project "${projectId}" already cut over to workspace ${existing.workspaceId}; ` +
        `refusing to re-point it at ${workspaceId}. Remove the "intent" marker from the config to override.`,
    );
  }
  const markerAlreadyPresent = existing?.workspaceId === workspaceId;

  const target = resolveIntentTarget(config, projectId);
  const read = readIntentFile(target.intentPath, {
    containmentRoot: target.repoRoot,
    expectedProjectId: projectId,
  });
  if (read.status === IntentOverlayStatus.NotConfigured) {
    throw new Error(`No intent overlay at ${read.path} — there is nothing to import for project "${projectId}".`);
  }
  if (read.status === IntentOverlayStatus.Invalid) {
    // The local reader's message already lists the failing paths; importing an
    // overlay the local writer would refuse is never the right recovery.
    throw new Error(read.message);
  }

  // Refused only AFTER the overlay is loaded, so the description carries the
  // real counts from the file that would be handed over rather than a warning
  // about an abstract one.
  if (options.yes !== true) {
    throw new Error(
      describeIntentImportPlan({
        projectId,
        workspaceId,
        intentPath: read.path,
        items: read.file.items.length,
        relations: read.file.relations.length,
        domains: read.file.domains.length,
        codeAnchors: read.file.items.reduce((total, item) => total + (item.codeAnchors?.length ?? 0), 0),
      }),
    );
  }

  const localRevision = createHash('sha256').update(canonicalIntentJson(read.file)).digest('hex');
  const idempotencyKey = intentImportIdempotencyKey(localRevision);
  const body: ImportIntentOverlayBody = {
    idempotencyKey,
    localRevision,
    // The server validates this with core's own `validateIntentFile`; sending
    // the READ-BACK model rather than the raw bytes keeps the revision hash and
    // the uploaded document describing the same thing.
    overlay: read.file as unknown as Record<string, unknown>,
  };
  assertIntentImportBodyWithinCeiling(body, read.path);
  const result = await transport.importOverlay(workspaceId, body);

  // Only after the server has committed. A marker written first would claim a
  // cutover that never happened.
  writeProjectIntent(config.configPath, projectId, { mode: ProjectIntentMode.Cloud, workspaceId });

  return {
    projectId,
    workspaceId,
    repo: target.repoName,
    intentPath: read.path,
    localRevision,
    idempotencyKey,
    markerAlreadyPresent,
    result,
  };
}

export interface IntentExportCliResult {
  workspaceId: string;
  outPath: string;
  contentHash: string;
  generatedAt: string;
  bytes: number;
}

/**
 * `out` is a REQUIRED, explicit path. The command never derives one from the
 * project's repos: in a multi-repo workspace there is no "the" repository to
 * drop a projection into, and picking one silently writes another service's
 * checkout (spec §8.1, last bullet).
 */
export async function runIntentExport(options: {
  workspaceId: string;
  out: string;
  transport?: IntentCloudTransport;
}): Promise<IntentExportCliResult> {
  const transport = options.transport ?? defaultTransport;
  const document = await transport.fetchExport(options.workspaceId);

  const outPath = path.resolve(options.out);
  const content = `${JSON.stringify(document, null, 2)}\n`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content, 'utf-8');

  return {
    workspaceId: options.workspaceId,
    outPath,
    contentHash: document.contentHash,
    generatedAt: document.generatedAt,
    bytes: Buffer.byteLength(content, 'utf-8'),
  };
}

/* ------------------------------------------------------ bootstrap-check --- */

/**
 * Read-only readiness for `coredoc intent import` (spec §8.1, follow-up 14).
 *
 * Import is a ONE-WAY authority cutover that spends an idempotency key, so
 * "run it and read the failure" is not a diagnostic — it is the operation. This
 * verb asks the import's own questions without performing it: nothing is
 * written locally, nothing is written in the workspace, and no idempotency key
 * is spent.
 *
 * It is not a dry-run of the import either. The overlay is validated by core's
 * own reader (the same one the import path uses), and the two facts only the
 * server holds — is this workspace still empty, which repo identities does it
 * carry — come from `GET …/intent/import/preflight`, which reads them through
 * the very functions the import asserts over.
 */
export enum BootstrapCheckId {
  /** The overlay is present, parseable and valid against the current schema. */
  Overlay = 'overlay',
  /** The request the import would send fits the server's body ceiling. */
  ImportBody = 'import_body',
  /** `--input <packet.json>`: the brownfield packet parses and cross-checks. */
  Packet = 'packet',
  /** No cutover marker, or one already naming this workspace. */
  Cutover = 'cutover',
  /** The workspace answered — reachable, and this actor may read its intent. */
  Workspace = 'workspace',
  /** The workspace holds no intent content, which v1 import requires. */
  WorkspaceEmpty = 'workspace_empty',
  /** Every repo an overlay anchor names is a registered durable identity. */
  RepoIdentity = 'repo_identity',
}

export enum BootstrapCheckStatus {
  Pass = 'pass',
  Fail = 'fail',
  /** Not asked: either it was not requested, or a check it depends on failed. */
  Skipped = 'skipped',
}

export interface BootstrapCheck {
  id: BootstrapCheckId;
  status: BootstrapCheckStatus;
  /** One line, sanitized at render time — it quotes overlay and server content. */
  detail: string;
}

export interface IntentBootstrapCheckResult {
  projectId: string;
  workspaceId: string;
  /** True only when no check failed. A skipped prerequisite already failed. */
  ok: boolean;
  checks: BootstrapCheck[];
}

/** The one server read this verb makes. Injected in tests so no network is touched. */
export interface IntentBootstrapTransport {
  preflight: (workspaceId: string) => Promise<IntentImportPreflight>;
}

const defaultBootstrapTransport: IntentBootstrapTransport = { preflight: getIntentImportPreflight };

const pass = (id: BootstrapCheckId, detail: string): BootstrapCheck => ({
  id,
  status: BootstrapCheckStatus.Pass,
  detail,
});
const fail = (id: BootstrapCheckId, detail: string): BootstrapCheck => ({
  id,
  status: BootstrapCheckStatus.Fail,
  detail,
});
const skip = (id: BootstrapCheckId, detail: string): BootstrapCheck => ({
  id,
  status: BootstrapCheckStatus.Skipped,
  detail,
});

/**
 * Every check runs and reports; nothing throws for a FAILED check.
 *
 * The point of a readiness verb is the whole list — a maintainer fixing one
 * problem at a time because the tool stops at the first is the friction this
 * closes. Only an unusable invocation (unknown project) throws.
 */
export async function runIntentBootstrapCheck(options: {
  config: RuntimeConfig;
  projectId: string;
  workspaceId: string;
  /** Optional brownfield packet to validate alongside the overlay (spec §8.2). */
  input?: string;
  transport?: IntentBootstrapTransport;
}): Promise<IntentBootstrapCheckResult> {
  const { config, projectId, workspaceId } = options;
  const transport = options.transport ?? defaultBootstrapTransport;
  const checks: BootstrapCheck[] = [];

  // Throws, unlike every check below: an unknown project means there is no
  // overlay to be ready and no question left to answer.
  const target = resolveIntentTarget(config, projectId);
  const read = readIntentFile(target.intentPath, {
    containmentRoot: target.repoRoot,
    expectedProjectId: projectId,
  });

  let anchoredRepos: string[] = [];
  if (read.status === IntentOverlayStatus.NotConfigured) {
    checks.push(fail(BootstrapCheckId.Overlay, `no overlay at ${read.path} — there is nothing to import`));
    checks.push(skip(BootstrapCheckId.ImportBody, 'no overlay to size'));
  } else if (read.status === IntentOverlayStatus.Invalid) {
    checks.push(fail(BootstrapCheckId.Overlay, read.message));
    checks.push(skip(BootstrapCheckId.ImportBody, 'overlay invalid'));
  } else {
    const anchors = read.file.items.flatMap((item) => item.codeAnchors ?? []);
    anchoredRepos = [...new Set(anchors.map((anchor) => anchor.repo))].sort();
    checks.push(
      pass(
        BootstrapCheckId.Overlay,
        `${read.path}: ${read.file.items.length} item(s), ${read.file.domains.length} domain(s), ` +
          `${anchors.length} anchor(s), ${read.file.relations.length} relation(s) (relations are dropped by import)`,
      ),
    );

    const localRevision = createHash('sha256').update(canonicalIntentJson(read.file)).digest('hex');
    const bytes = intentImportBodyBytes({
      idempotencyKey: intentImportIdempotencyKey(localRevision),
      localRevision,
      overlay: read.file as unknown as Record<string, unknown>,
    });
    checks.push(
      bytes <= MAX_INTENT_IMPORT_BODY_BYTES
        ? pass(BootstrapCheckId.ImportBody, `${bytes} of ${MAX_INTENT_IMPORT_BODY_BYTES} bytes`)
        : fail(BootstrapCheckId.ImportBody, `${bytes} bytes, above the ${MAX_INTENT_IMPORT_BODY_BYTES}-byte ceiling`),
    );
  }

  if (options.input === undefined) {
    checks.push(skip(BootstrapCheckId.Packet, 'no --input packet given'));
  } else {
    checks.push(checkBrownfieldPacketFile(options.input));
  }

  const marker = config.projects.find((project) => project.id === projectId)?.intent;
  if (marker === undefined) {
    checks.push(pass(BootstrapCheckId.Cutover, 'no cutover marker — the local overlay still owns authority'));
  } else if (marker.workspaceId === workspaceId) {
    checks.push(
      pass(
        BootstrapCheckId.Cutover,
        `already cut over to ${marker.workspaceId}; a rerun of import replays the stored result`,
      ),
    );
  } else {
    checks.push(
      fail(
        BootstrapCheckId.Cutover,
        `project already cut over to workspace ${marker.workspaceId}; import into ${workspaceId} is refused`,
      ),
    );
  }

  let preflight: IntentImportPreflight | undefined;
  try {
    preflight = await transport.preflight(workspaceId);
    checks.push(pass(BootstrapCheckId.Workspace, `workspace ${workspaceId} answered its intent preflight`));
  } catch (error) {
    checks.push(
      fail(
        BootstrapCheckId.Workspace,
        error instanceof IntentApiError
          ? `${error.publicError?.code ?? `HTTP ${error.status}`}: ${error.publicError?.message ?? error.message}`
          : error instanceof Error
            ? error.message
            : String(error),
      ),
    );
  }

  if (preflight === undefined) {
    checks.push(skip(BootstrapCheckId.WorkspaceEmpty, 'workspace unreachable'));
    checks.push(skip(BootstrapCheckId.RepoIdentity, 'workspace unreachable'));
    return { projectId, workspaceId, ok: false, checks };
  }

  const { content } = preflight;
  checks.push(
    preflight.empty
      ? pass(BootstrapCheckId.WorkspaceEmpty, 'no domains, features, dimensions, or items')
      : fail(
          BootstrapCheckId.WorkspaceEmpty,
          `already holds domains: ${content.domains}, features: ${content.features}, ` +
            `dimensions: ${content.dimensions ?? 0}, items: ${content.items} — ` +
            'v1 import requires an empty workspace',
        ),
  );

  const registered = new Set(preflight.intentRepoKeys);
  const unknown = anchoredRepos.filter((repo) => !registered.has(repo));
  if (anchoredRepos.length === 0) {
    checks.push(pass(BootstrapCheckId.RepoIdentity, 'the overlay carries no code anchors'));
  } else if (unknown.length === 0) {
    checks.push(pass(BootstrapCheckId.RepoIdentity, `anchored repos registered: ${anchoredRepos.join(', ')}`));
  } else {
    // A FAIL, not a warning: the import succeeds and silently lands without
    // those anchors, which is the outcome this verb exists to surface before the cutover.
    checks.push(
      fail(
        BootstrapCheckId.RepoIdentity,
        `anchors name repo identities this workspace does not carry: ${unknown.join(', ')}. ` +
          `Registered: ${preflight.registeredRepoIdentities.join(', ') || 'none'}. ` +
          'Import would drop those anchors.',
      ),
    );
  }

  return { projectId, workspaceId, ok: checks.every((check) => check.status !== BootstrapCheckStatus.Fail), checks };
}

/**
 * The packet check, split out because its failure mode is a THROWN core error
 * rather than a status: `parseBrownfieldPacket` is the same validator the
 * capture path runs, and a consumer repo without `@coredoc/core` installed has
 * no other way to run it.
 */
function checkBrownfieldPacketFile(inputPath: string): BootstrapCheck {
  const resolved = path.resolve(inputPath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf-8');
  } catch (error) {
    return fail(BootstrapCheckId.Packet, `${resolved} unreadable: ${error instanceof Error ? error.message : error}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return fail(BootstrapCheckId.Packet, `${resolved} is not JSON: ${error instanceof Error ? error.message : error}`);
  }
  try {
    const packet = parseBrownfieldPacket(document);
    return pass(
      BootstrapCheckId.Packet,
      `${resolved}: domain "${packet.domain}"${packet.feature ? `, feature "${packet.feature}"` : ''}, ` +
        `${packet.candidates.length} candidate(s), ` +
        `${packet.sources.length} source(s), ${packet.conflicts.length} conflict(s)`,
    );
  } catch (error) {
    return fail(
      BootstrapCheckId.Packet,
      error instanceof BrownfieldPacketInvalidError ? error.message : `${resolved}: ${String(error)}`,
    );
  }
}

/* ------------------------------------------------------------- rendering --- */

/**
 * `overlay.items.3.sources.0.ref` — the shape a maintainer can search their
 * file for. Sanitized: a path segment echoes a key from the maintainer's own
 * (agent-authored) overlay back through the server.
 */
function formatErrorPath(segments: readonly string[]): string {
  return segments.length === 0 ? '<request>' : safe(segments.join('.'));
}

/**
 * The server's structured refusal, printed WITHOUT summarizing (spec §12).
 *
 * Every field the server sent is shown: the code a caller branches on, the
 * bounded message, the exact failing path, and every `details` entry. Nothing
 * here elides, truncates, or replaces the server's text with a friendlier
 * paraphrase — the archived CLI's generic hint is the named defect, and a
 * paraphrase is the same defect with better manners.
 *
 * "Verbatim" stops at CONTROL characters. A refusal message quotes the
 * offending overlay content back, and that content is agent-authored: an
 * embedded ANSI/OSC escape would rewrite the terminal that is meant to be
 * showing the maintainer what went wrong. Every server-derived string here goes
 * through the same {@link safe} the local overlay renderer uses; printable text
 * is untouched, so nothing a human needs is lost.
 */
export function formatIntentApiError(error: IntentApiError): string {
  const lines = [`${safe(error.operation)} refused by the server (HTTP ${error.status}).`];
  if (error.publicError) {
    lines.push(`  code:    ${safe(error.publicError.code)}`);
    lines.push(`  message: ${safe(error.publicError.message)}`);
    lines.push(`  path:    ${formatErrorPath(error.publicError.path)}`);
    for (const detail of error.publicError.details ?? []) {
      lines.push(`  - ${safe(detail.code)} at ${formatErrorPath(detail.path)}: ${safe(detail.message)}`);
    }
  } else if (error.rawBody.trim() !== '') {
    // Not the intent error shape (a proxy page, a gateway error). Shown as it
    // arrived — minus control bytes — rather than replaced by a guess about
    // what it meant. Line structure survives because the split happens first.
    lines.push('  response body:');
    for (const line of error.rawBody.split('\n')) lines.push(`    ${safe(line)}`);
  } else {
    lines.push('  the server sent no response body.');
  }
  return lines.join('\n');
}

/**
 * Every value the server echoed back is sanitized on its way to the terminal
 * ({@link safe}): ids, domain titles, repo names and skip reasons all originate
 * in an agent-authored overlay, and a round trip through the server does not
 * make them trusted.
 */
export function printIntentImportResult(result: IntentImportCliResult): void {
  const { result: imported } = result;
  console.log(`Imported ${result.intentPath} into workspace ${safe(result.workspaceId)}`);
  console.log(`  project:       ${result.projectId} (repo ${safe(result.repo)})`);
  console.log(`  revision:      ${safe(result.localRevision)}`);
  console.log(`  domains:       ${imported.createdDomains.map((domain) => safe(domain.id)).join(', ') || 'none'}`);
  console.log(`  items:         ${imported.importedItems.length}`);
  for (const [authority, count] of countByAuthority(imported.importedItems)) {
    console.log(`    ${safe(authority)}: ${count}`);
  }
  console.log(`  sources:       ${imported.importedSourceCount}`);
  console.log(`  anchors:       ${imported.importedAnchorCount}`);

  // The two things import deliberately does not carry. Named, never counted
  // away: a maintainer must be able to see exactly what did not arrive.
  if (imported.skippedAnchors.length > 0) {
    console.log('  anchors skipped (repo identity not registered in this workspace):');
    for (const group of imported.skippedAnchors) {
      console.log(
        `    ${safe(group.repo)} — ${group.anchorCount} anchor(s) on ${group.itemIds.map(safe).join(', ')} ` +
          `(${safe(group.reason)})`,
      );
    }
    console.log(`    registered identities: ${imported.registeredRepoIdentities.map(safe).join(', ') || 'none'}`);
  }
  if (imported.droppedRelations.length > 0) {
    console.log('  relations dropped (the cloud model has no item-to-item relations):');
    for (const relation of imported.droppedRelations) {
      console.log(`    ${safe(relation.from)} --${safe(relation.type)}--> ${safe(relation.to)}`);
    }
  }

  console.log(
    result.markerAlreadyPresent
      ? `\nCutover marker re-confirmed: workspace ${safe(result.workspaceId)} owns product intent for "${result.projectId}".`
      : `\nCutover complete: workspace ${safe(result.workspaceId)} now owns product intent for "${result.projectId}".`,
  );
  console.log('Local `coredoc intent capture` will now fail fast; status/list/context keep working.');
}

function countByAuthority(items: ReadonlyArray<{ authority: string }>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.authority, (counts.get(item.authority) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
}

/**
 * One line per check, in the order they were asked, with the status first.
 *
 * Every detail string is sanitized: they quote overlay ids, domain titles, repo
 * identities and server messages, all of which originate in agent-authored or
 * remote text. Nothing is elided — a readiness report that hides the failing
 * detail is the same defect as a summarized refusal (spec §12).
 */
export function printIntentBootstrapCheckResult(result: IntentBootstrapCheckResult): void {
  console.log(`Bootstrap readiness for project "${result.projectId}" into workspace ${safe(result.workspaceId)}`);
  for (const check of result.checks) {
    console.log(`  ${check.status.toUpperCase().padEnd(7)} ${check.id.padEnd(16)} ${safe(check.detail)}`);
  }
  console.log(
    result.ok
      ? '\nReady: `coredoc intent import` would pass these preconditions. Nothing was written or reserved by this check.'
      : '\nNot ready: fix the FAIL lines above. Nothing was written or reserved by this check.',
  );
}

export function printIntentExportResult(result: IntentExportCliResult): void {
  console.log(`Wrote ${result.outPath} (${result.bytes} bytes)`);
  console.log(`  workspace:   ${safe(result.workspaceId)}`);
  // Server-derived, so sanitized like every other value that arrived over the
  // wire — even though both are expected to be machine-generated.
  console.log(`  contentHash: ${safe(result.contentHash)}`);
  console.log(`  generatedAt: ${safe(result.generatedAt)}`);
  console.log('The export is a read-only projection: it is never a write authority.');
}

/* ---------------------------------------------------------------- release --- */

/**
 * `coredoc intent release` — the CI actor of amendment §3.2.
 *
 * It reads NOTHING locally except the trailers file: the ref, the deploy
 * identity and the PR are facts of the deployment that the caller (the action
 * step, or any pipeline) already holds. There are no defaults for `deployId`
 * and `deployedAt` on purpose — a CLI-minted `now()` would move on every retry,
 * minting a fresh idempotency key and letting a late retry leapfrog a later
 * release (amendment §8.6).
 */
export interface IntentReleaseTransport {
  record: (workspaceId: string, body: RecordIntentReleaseBody) => Promise<CloudIntentReleaseResult>;
}

const defaultReleaseTransport: IntentReleaseTransport = { record: recordIntentRelease };

export interface IntentReleaseCliOptions {
  workspaceId: string;
  repo: string;
  ref: string;
  deployId: string;
  deployedAt: string;
  handoffId?: string;
  transport?: IntentReleaseTransport;
}

export interface IntentReleaseCliResult {
  workspaceId: string;
  repo: string;
  handoffId?: string;
  result: CloudIntentReleaseResult;
}

/**
 * The offset-bearing ISO datetime the server's `z.iso.datetime()` accepts.
 *
 * `Date.parse` alone is not this check: it happily reads `2026-09-11`, which
 * the server then refuses after a round trip, and the maintainer reads a schema
 * path instead of the flag they mistyped.
 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export async function runIntentRelease(options: IntentReleaseCliOptions): Promise<IntentReleaseCliResult> {
  const transport = options.transport ?? defaultReleaseTransport;
  for (const [flag, value] of [
    ['--workspace-id', options.workspaceId],
    ['--repo', options.repo],
    ['--ref', options.ref],
    ['--deploy-id', options.deployId],
    ['--deployed-at', options.deployedAt],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${flag} is required and has no default — it is a property of the deployment, not of this run.`);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(options.ref))
    throw new Error('--ref must be a full commit SHA; resolve the deployed ref before recording delivery.');
  if (!ISO_DATETIME.test(options.deployedAt) || Number.isNaN(Date.parse(options.deployedAt))) {
    throw new Error(
      `--deployed-at must be an ISO datetime with a timezone (e.g. 2026-09-11T10:04:07Z), got "${safe(options.deployedAt)}". ` +
        "It is the deploy run's start time (GitHub's `run_started_at`), never this step's clock.",
    );
  }

  const result = await transport.record(options.workspaceId, {
    kind: 'release',
    repoKey: options.repo,
    deliveredRef: options.ref,
    deployId: options.deployId,
    deployedAt: options.deployedAt,
    ...(options.handoffId ? { handoffId: options.handoffId } : {}),
  });

  return { workspaceId: options.workspaceId, repo: options.repo, result };
}

/**
 * The recorded release, server values sanitized like everywhere else on this
 * surface — `deliveredRef` and the item ids come from a PR body.
 */
export function printIntentReleaseResult(result: IntentReleaseCliResult): void {
  const printDeliveries = () => {
    for (const d of result.result.deliveries ?? [])
      console.log(
        `  pr #${d.pr}: ${safe(d.outcome)}${d.seq ? ` (#${d.seq})` : ''}${d.reason ? ` ${safe(d.reason)}` : ''}`,
      );
  };
  if ('outcome' in result.result) {
    console.log(`Intent delivery: ${safe(result.result.reason)}`);
    printDeliveries();
    return;
  }
  const { event } = result.result;
  console.log(`Recorded release #${event.seq} in workspace ${safe(result.workspaceId)}`);
  console.log(`  repo:         ${safe(result.repo)}`);
  console.log(`  deliveredRef: ${safe(event.data.deliveredRef ?? '')}`);
  console.log(`  included:     ${event.data.included?.length ?? 0}`);
  for (const itemId of event.data.included ?? []) console.log(`    + ${safe(itemId)}`);
  console.log(`  retired:      ${event.data.retired?.length ?? 0}`);
  for (const itemId of event.data.retired ?? []) console.log(`    - ${safe(itemId)}`);
  console.log(`  actorKind:    ${safe(event.data.actorKind ?? 'unknown')}`);
  if (event.data.orderingToken) console.log(`  deployedAt:   ${safe(event.data.orderingToken)}`);
  if (event.data.pr) console.log(`  pr:           ${safe(event.data.pr.repoKey)}#${event.data.pr.number}`);
  console.log(`  headSeq:      ${result.result.headSeq}`);
  printDeliveries();
}
