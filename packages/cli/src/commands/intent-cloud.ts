/**
 * The cloud-facing intent verbs: `coredoc intent export` (the projection, spec
 * §9) and `coredoc intent release` (the CI delivery actor). Cloud read, propose
 * and review are MCP and UI surfaces, not CLI verbs (spec §11).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safe } from './terminal-safe.js';
import {
  IntentApiError,
  exportIntent,
  exportIntentWorkspace,
  recordIntentRelease,
  type CloudIntentExportDocument,
  type CloudIntentReleaseResult,
  type CloudIntentWorkspaceDocument,
  type RecordIntentReleaseBody,
} from '../sync/workspace-api.js';

/** What `coredoc intent export` writes. */
export enum IntentExportFormat {
  /** `GET …/intent/export`: the hashed backup projection with history (`CloudIntentExportV1`). */
  Backup = 'backup',
  /** `GET …/intent/export/workspace`: the document `POST …/intent/import/workspace` takes. */
  Workspace = 'workspace',
}

/** Injected in tests so the flow is exercised without a server. */
export interface IntentCloudTransport {
  fetchExport: (workspaceId: string) => Promise<CloudIntentExportDocument>;
  fetchWorkspaceExport: (workspaceId: string) => Promise<CloudIntentWorkspaceDocument>;
}

const defaultTransport: IntentCloudTransport = {
  fetchExport: exportIntent,
  fetchWorkspaceExport: exportIntentWorkspace,
};

/** Parse `--format`; an unknown value is an error naming the accepted ones. */
export function parseIntentExportFormat(value: string | undefined): IntentExportFormat {
  if (value === undefined) return IntentExportFormat.Backup;
  const known = Object.values(IntentExportFormat) as string[];
  if (!known.includes(value)) {
    throw new Error(`--format must be one of ${known.join(', ')}, got "${safe(value)}"`);
  }
  return value as IntentExportFormat;
}

interface IntentExportCliResultBase {
  workspaceId: string;
  outPath: string;
  bytes: number;
}

export type IntentExportCliResult =
  | (IntentExportCliResultBase & { format: IntentExportFormat.Backup; contentHash: string; generatedAt: string })
  | (IntentExportCliResultBase & { format: IntentExportFormat.Workspace; revision: string; items: number });

/**
 * `out` is a REQUIRED, explicit path. The command never derives one from the
 * project's repos: in a multi-repo workspace there is no "the" repository to
 * drop a projection into, and picking one silently writes another service's
 * checkout (spec §8.1, last bullet).
 */
export async function runIntentExport(options: {
  workspaceId: string;
  out: string;
  format?: IntentExportFormat;
  transport?: IntentCloudTransport;
}): Promise<IntentExportCliResult> {
  const transport = options.transport ?? defaultTransport;
  const format = options.format ?? IntentExportFormat.Backup;
  const document =
    format === IntentExportFormat.Workspace
      ? await transport.fetchWorkspaceExport(options.workspaceId)
      : await transport.fetchExport(options.workspaceId);

  const outPath = path.resolve(options.out);
  const content = `${JSON.stringify(document, null, 2)}\n`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content, 'utf-8');

  const base = { workspaceId: options.workspaceId, outPath, bytes: Buffer.byteLength(content, 'utf-8') };
  if (format === IntentExportFormat.Workspace) {
    const workspace = document as CloudIntentWorkspaceDocument;
    return { ...base, format, revision: workspace.source.revision, items: workspace.items.length };
  }
  const backup = document as CloudIntentExportDocument;
  return { ...base, format, contentHash: backup.contentHash, generatedAt: backup.generatedAt };
}

/* ------------------------------------------------------------- rendering --- */

/**
 * `items.3.sources.0.ref` — the shape a maintainer can search a document for.
 * Sanitized: a path segment echoes agent-authored keys back through the server.
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
 * offending content back, and that content is agent-authored: an embedded
 * ANSI/OSC escape would rewrite the terminal that is meant to be showing the
 * maintainer what went wrong. Every server-derived string here goes through
 * {@link safe}; printable text is untouched, so nothing a human needs is lost.
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

export function printIntentExportResult(result: IntentExportCliResult): void {
  console.log(`Wrote ${result.outPath} (${result.bytes} bytes)`);
  console.log(`  workspace:   ${safe(result.workspaceId)}`);
  console.log(`  format:      ${result.format}`);
  // Server-derived, so sanitized like every other value that arrived over the
  // wire — even though they are expected to be machine-generated.
  if (result.format === IntentExportFormat.Workspace) {
    console.log(`  revision:    ${safe(result.revision)}`);
    console.log(`  items:       ${result.items}`);
    console.log(
      'Import it into an empty workspace with `POST …/intent/import/workspace` as `{ idempotencyKey, document }`, from a signed-in user session.',
    );
    return;
  }
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
