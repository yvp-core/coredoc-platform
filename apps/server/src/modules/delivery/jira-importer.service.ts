import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { DeliveryProvider, Prisma } from '../../generated/prisma/client.js';
import { decrypt, isEncryptionAvailable } from '../../database/encryption.js';
import { ActorRegistryService } from './actor-registry.service.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';
import { JiraCanonicalProjectionService } from './jira-canonical-projection.service.js';
import { JiraAuthError, JiraClient, JiraRateLimitError, normalizeJiraBaseUrl } from './jira-client.js';
import { normalizeJiraIssue, type NormalizedJiraIssue } from './jira-normalizer.js';
import { resolveWindowStart } from './ingest-window.js';
import { packRawPayload, unpackRawPayload } from './raw-payload-codec.js';
import { StatusMapService } from './status-map.service.js';

/** Raw-payload normalization schema version, stamped on every stored row. */
export const JIRA_NORM_VERSION = 1;

/**
 * JQL datetime literals use the API user's timezone. A 13-hour overlap covers
 * every Jira timezone; canonical source freshness makes the overlap idempotent.
 */
const JIRA_JQL_TZ_SAFETY_MS = 13 * 3_600_000;

const BASE_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'created',
  'updated',
  'resolutiondate',
  'assignee',
  'reporter',
  'labels',
  'parent',
  'priority',
  'project',
];

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
/** Stays under the client's 100-issue search page, so one `key in (...)` call suffices. */
const SOURCE_CREATED_BACKFILL_BATCH = 50;
/** Batches per sync: 500 refs is a bounded walk, and the keyset resumes next sync. */
const SOURCE_CREATED_BACKFILL_BATCHES = 10;
const MAX_CONTINUATION_TOKEN_CHARS = 8_192;
const MAX_LOGGED_EXTERNAL_ID_CHARS = 256;
const PER_ISSUE_CANONICAL_CONFLICT_CODES: ReadonlySet<string> = new Set([
  'TASK_IDENTITY_CONFLICT',
  'TASK_EXTERNAL_REF_CONFLICT',
  'TASK_AUTHORITY_CONFLICT',
  'TASK_AUTHORITY_MIGRATION_REQUIRED',
  'TASK_STATE_FACT_CONFLICT',
  'SHIP_EVIDENCE_CONFLICT',
  'REWORK_SIGNAL_CONFLICT',
]);

type JiraClientFactory = (opts: { baseUrl: string; email: string; apiToken: string }) => JiraClient;

interface IssuesContinuation {
  queryCursor: string | null;
  nextPageToken: string;
  maxUpdatedAt: string | null;
}

export const JIRA_CLIENT_FACTORY = Symbol('JIRA_CLIENT_FACTORY');

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function perIssueCanonicalConflictCode(error: unknown): string | null {
  if (!(error instanceof ConflictException)) return null;
  const code = asStr(asRecord(error.getResponse()).code);
  return code !== undefined && PER_ISSUE_CANONICAL_CONFLICT_CODES.has(code) ? code : null;
}

function formatJqlDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

@Injectable()
export class JiraImporterService {
  private readonly logger = new Logger(JiraImporterService.name);
  private readonly clientFactory: JiraClientFactory;

  constructor(
    private readonly prisma: PrismaService,
    private readonly actorRegistry: ActorRegistryService,
    private readonly statusMap: StatusMapService,
    private readonly canonicalDelivery: CanonicalDeliveryService,
    private readonly canonicalProjection: JiraCanonicalProjectionService,
    @Optional() @Inject(JIRA_CLIENT_FACTORY) clientFactory?: JiraClientFactory,
  ) {
    this.clientFactory = clientFactory ?? ((opts) => new JiraClient(opts));
  }

  private logSkippedCanonicalConflict(externalId: string, error: unknown): boolean {
    const code = perIssueCanonicalConflictCode(error);
    if (code === null) return false;
    this.logger.warn(
      `jira import: skipped issue externalId=${JSON.stringify(externalId.slice(0, MAX_LOGGED_EXTERNAL_ID_CHARS))} conflict=${code}`,
    );
    return true;
  }

  /**
   * Fetch one bounded Jira chunk and converge it onto canonical tasks. Jira issue
   * ID is the immutable identity; key, URL, state, and freshness are observations.
   * A returned search token is checkpointed only after every item in that chunk
   * has completed resolver/projection work, so failure retries the same chunk.
   */
  async syncConnector(connectorId: string): Promise<{
    issues: number;
    issuesIncomplete: boolean;
    changelogsIncomplete: boolean;
  }> {
    const connector = await this.prisma.deliveryConnector.findUnique({ where: { id: connectorId } });
    if (!connector) throw new NotFoundException(`Connector ${connectorId} not found`);
    if (connector.provider !== DeliveryProvider.jira) {
      throw new BadRequestException(
        `Connector ${connectorId} is not a jira connector (provider=${connector.provider})`,
      );
    }

    const storedBaseUrl = connector.baseUrl;
    if (storedBaseUrl == null) {
      throw new BadRequestException(`Connector ${connectorId} has no baseUrl (Jira requires a host)`);
    }
    let baseUrl: string;
    try {
      baseUrl = normalizeJiraBaseUrl(storedBaseUrl);
    } catch {
      throw new BadRequestException(`Connector ${connectorId} has an invalid Jira baseUrl`);
    }

    const { email, apiToken } = this.resolveCredentials(connector.credentialsEncrypted, connectorId);
    const client = this.clientFactory({ baseUrl, email, apiToken });
    const cfg = asRecord(connector.config);
    const projectKeys = this.sanitizeProjects(cfg.projects);
    const workspaceId = connector.workspaceId;

    // Mutate this copy only once a complete search chunk has converged. `finally`
    // therefore persists the prior continuation after any mid-chunk failure.
    const cursors: Record<string, unknown> = { ...asRecord(connector.cursors) };
    const persist = () =>
      this.prisma.deliveryConnector.update({
        where: { id: connectorId },
        data: { cursors: { ...cursors } as Prisma.InputJsonValue, lastSyncAt: new Date() },
      });

    let issuesSynced = 0;
    let issuesIncomplete = false;
    let changelogsIncomplete = false;

    try {
      await this.actorRegistry.seedWorkspace(workspaceId);

      const globalStatuses = await client.listStatuses();
      const projectStatuses: unknown[] = [];
      for (const key of projectKeys) {
        try {
          for (const entry of asArray(await client.listProjectStatuses(key))) {
            for (const status of asArray(asRecord(entry).statuses)) projectStatuses.push(status);
          }
        } catch (error) {
          this.logger.debug(`jira import: listProjectStatuses(${key}) failed — ${(error as Error)?.message ?? error}`);
        }
      }
      await this.statusMap.bootstrapFromStatuses(workspaceId, connectorId, [...globalStatuses, ...projectStatuses]);

      const continuation = this.validIssuesContinuation(cursors.issuesContinuation);
      const completedCursor = this.validSince(cursors.issues);
      // Backfill floor (absolute `config.since`, else the relative window, default 30
      // days): with no stored cursor, bound the JQL to it so a first sync against a
      // years-old project does not fetch its whole history. Once a cursor exists it wins
      // outright (floor inert), and an in-flight continuation keeps its frozen
      // queryCursor so a multi-page backfill never re-floors against a relative window
      // that moved between pages. Never max() — that would push `updated >=` past
      // unimported issues in a quiet gap and drop them.
      const queryCursor = continuation?.queryCursor ?? completedCursor ?? resolveWindowStart(cfg);
      const page = await client.searchIssues(this.buildJql(queryCursor, projectKeys), BASE_FIELDS, {
        nextPageToken: continuation?.nextPageToken ?? null,
      });
      issuesIncomplete = page.nextPageToken !== null;

      const actorCache = new Map<string, string>();
      let maxUpdatedAt = this.laterFreshness(continuation?.maxUpdatedAt ?? completedCursor, null);

      for (const rawIssue of page.items) {
        const raw = asRecord(rawIssue);
        const externalId = asStr(raw.id);
        if (externalId === undefined) {
          this.logger.warn('jira import: issue with no usable id — skipping');
          continue;
        }

        const baseNorm = normalizeJiraIssue(raw, []);
        const sourceUpdatedAt = toDate(baseNorm?.updatedAtSource);
        if (!baseNorm || !sourceUpdatedAt) {
          this.logger.warn('jira import: issue with no usable source freshness — skipping');
          continue;
        }

        const observedAt = new Date();
        let resolution: Awaited<ReturnType<CanonicalDeliveryService['resolveConnectorTask']>>;
        try {
          resolution = await this.canonicalDelivery.resolveConnectorTask(connectorId, {
            repositoryKey: null,
            externalId: baseNorm.externalId,
            externalKey: baseNorm.externalKey ?? null,
            externalUrl: baseNorm.externalKey ? `${baseUrl}/browse/${baseNorm.externalKey}` : null,
            externalState: baseNorm.statusRaw ?? null,
            sourceCreatedAt: toDate(baseNorm.createdAtSource) ?? null,
            sourceUpdatedAt,
            observedAt,
          });
        } catch (error) {
          if (this.logSkippedCanonicalConflict(externalId, error)) continue;
          throw error;
        }

        if (resolution.status === 'stale') {
          maxUpdatedAt = this.laterFreshness(maxUpdatedAt, baseNorm.updatedAtSource);
          continue;
        }

        const embeddedChangelog = asRecord(raw.changelog);
        const embeddedHistories = asArray(embeddedChangelog.histories);
        const changelogResult =
          (num(embeddedChangelog.total) ?? 0) > embeddedHistories.length
            ? await client.listChangelog(externalId)
            : { items: [], total: embeddedHistories.length, nextStartAt: null, incomplete: false };
        changelogsIncomplete ||= changelogResult.incomplete;

        const norm = normalizeJiraIssue(raw, changelogResult.items);
        if (!norm) {
          this.logger.warn('jira import: issue failed normalization — skipping');
          continue;
        }

        const full = { issue: raw, extraChangelog: changelogResult.items };
        const packed = packRawPayload(full, { issue: raw });
        await this.resolveActors(workspaceId, norm, actorCache);
        const rawSnapshot = {
          workspaceId,
          connectorId,
          resourceType: 'issue',
          externalId,
          payload: packed.payload as unknown as Prisma.InputJsonValue,
          truncated: packed.truncated || changelogResult.incomplete,
          normVersion: JIRA_NORM_VERSION,
        };
        if (resolution.status === 'accepted' || resolution.status === 'updated') {
          await this.prisma.deliveryRawPayload.create({ data: rawSnapshot });
        } else {
          await this.ensureJiraRawSnapshot({
            workspaceId,
            connectorId,
            externalId,
            sourceUpdatedAt,
            rawSnapshot,
          });
        }

        try {
          await this.canonicalProjection.projectIssue({
            workspaceId,
            connectorId,
            taskId: resolution.taskId,
            externalRefId: BigInt(resolution.externalRef.id),
            currentState: norm.statusRaw ?? null,
            title: norm.title ?? null,
            sourceUpdatedAt,
            observedAt,
            transitions: norm.transitions.flatMap((transition) => {
              const occurredAt = toDate(transition.occurredAt);
              if (!occurredAt || transition.toStatusRaw === undefined) return [];
              return [
                {
                  sourceRef: transition.sourceRef,
                  fromState: transition.fromStatusRaw ?? null,
                  toState: transition.toStatusRaw,
                  occurredAt,
                  actorId: transition.actorAccountId ? (actorCache.get(transition.actorAccountId) ?? null) : null,
                },
              ];
            }),
          });
        } catch (error) {
          if (this.logSkippedCanonicalConflict(externalId, error)) continue;
          throw error;
        }

        maxUpdatedAt = this.laterFreshness(maxUpdatedAt, norm.updatedAtSource);
        if (resolution.status === 'accepted' || resolution.status === 'updated') issuesSynced += 1;
      }

      // Commit continuation state only after every fetched item completed. The
      // original completed cursor remains frozen until that Jira query exhausts.
      if (page.nextPageToken !== null) {
        cursors.issuesContinuation = {
          queryCursor,
          nextPageToken: page.nextPageToken,
          maxUpdatedAt,
        } satisfies IssuesContinuation;
      } else {
        const finalizedCursor = this.laterFreshness(completedCursor, maxUpdatedAt);
        if (finalizedCursor !== null) cursors.issues = finalizedCursor;
        else delete cursors.issues;
        delete cursors.issuesContinuation;
      }

      await this.backfillSourceCreatedAt(workspaceId, connectorId, client);
    } catch (error) {
      if (error instanceof JiraAuthError) {
        throw new BadRequestException(`Jira auth failed for connector ${connectorId}: ${error.message}`);
      }
      if (error instanceof JiraRateLimitError) throw error;
      throw error;
    } finally {
      await persist();
    }

    return { issues: issuesSynced, issuesIncomplete, changelogsIncomplete };
  }

  /**
   * Refs imported before `source_created_at` existed are never re-observed by the
   * incremental `updated >=` query, so walk them in `id asc` with a keyset cursor,
   * bounded batches per sync. Best-effort: a failure here must not fail the sync
   * or touch cursors.
   */
  private async backfillSourceCreatedAt(workspaceId: string, connectorId: string, client: JiraClient): Promise<void> {
    try {
      let cursor: bigint | null = null;
      let attempted = 0;
      let filled = 0;
      for (let batch = 0; batch < SOURCE_CREATED_BACKFILL_BATCHES; batch += 1) {
        // Annotated because the keyset makes the query depend on the previous batch.
        const refs: { id: bigint; externalKey: string | null }[] = await this.prisma.taskExternalRef.findMany({
          where: {
            workspaceId,
            connectorId,
            sourceCreatedAt: null,
            externalKey: { not: null },
            ...(cursor === null ? {} : { id: { gt: cursor } }),
          },
          select: { id: true, externalKey: true },
          orderBy: { id: 'asc' },
          take: SOURCE_CREATED_BACKFILL_BATCH,
        });
        if (refs.length === 0) break;
        // Advance past EVERY fetched ref, answered or not: an issue Jira no longer
        // returns would otherwise hold this batch forever and starve the rest.
        cursor = refs[refs.length - 1].id;

        const idByKey = new Map<string, bigint>();
        for (const ref of refs) {
          if (ref.externalKey !== null && ISSUE_KEY_RE.test(ref.externalKey)) idByKey.set(ref.externalKey, ref.id);
        }
        if (idByKey.size === 0) continue;
        attempted += idByKey.size;

        const page = await client.searchIssues(`key in (${[...idByKey.keys()].join(', ')})`, ['created']);
        for (const rawIssue of page.items) {
          const raw = asRecord(rawIssue);
          const id = idByKey.get(asStr(raw.key) ?? '');
          const sourceCreatedAt = toDate(asStr(asRecord(raw.fields).created));
          if (id === undefined || sourceCreatedAt === null) continue;
          const updated = await this.prisma.taskExternalRef.updateMany({
            where: { id, sourceCreatedAt: null },
            data: { sourceCreatedAt },
          });
          filled += updated.count;
        }
      }
      this.logger.debug(`jira import: sourceCreatedAt backfill attempted ${attempted} refs, filled ${filled}`);
    } catch (error) {
      this.logger.warn(`jira import: sourceCreatedAt backfill failed — ${(error as Error)?.message ?? error}`);
    }
  }

  /**
   * A duplicate can follow a resolver commit whose raw write failed. The latest
   * retained row is sufficient because duplicate freshness is the canonical head;
   * without a uniqueness key this repairs bounded retries, not concurrent creates.
   */
  private async ensureJiraRawSnapshot(input: {
    workspaceId: string;
    connectorId: string;
    externalId: string;
    sourceUpdatedAt: Date;
    rawSnapshot: Prisma.DeliveryRawPayloadUncheckedCreateInput;
  }): Promise<void> {
    const retained = await this.prisma.deliveryRawPayload.findFirst({
      where: {
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
        resourceType: 'issue',
        externalId: input.externalId,
      },
      orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
      select: { payload: true },
    });
    if (retained) {
      const envelope = asRecord(unpackRawPayload(retained.payload));
      const normalized = normalizeJiraIssue(asRecord(envelope.issue), asArray(envelope.extraChangelog));
      if (toDate(normalized?.updatedAtSource)?.getTime() === input.sourceUpdatedAt.getTime()) return;
    }

    await this.prisma.deliveryRawPayload.create({ data: input.rawSnapshot });
  }

  private async resolveActors(
    workspaceId: string,
    issue: NormalizedJiraIssue,
    actorCache: Map<string, string>,
  ): Promise<void> {
    for (const actor of issue.actors) {
      if (actorCache.has(actor.accountId)) continue;
      const actorId = await this.actorRegistry.resolveJiraActor(workspaceId, {
        accountId: actor.accountId,
        displayName: actor.displayName,
        email: actor.email,
        kind: actor.kind,
      });
      actorCache.set(actor.accountId, actorId);
    }
  }

  private buildJql(cursor: string | null, projectKeys: string[]): string {
    const clauses: string[] = [];
    if (projectKeys.length > 0) clauses.push(`project in (${projectKeys.join(', ')})`);
    if (cursor) {
      const literal = formatJqlDate(new Date(new Date(cursor).getTime() - JIRA_JQL_TZ_SAFETY_MS));
      clauses.push(`updated >= "${literal}"`);
    }
    const where = clauses.join(' AND ');
    return where ? `${where} ORDER BY updated ASC` : 'ORDER BY updated ASC';
  }

  private sanitizeProjects(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const projects: string[] = [];
    for (const project of raw) {
      if (typeof project === 'string' && PROJECT_KEY_RE.test(project)) projects.push(project);
      else this.logger.warn(`jira import: dropping non-conforming project key ${JSON.stringify(project)}`);
    }
    return projects;
  }

  private laterFreshness(current: string | null, candidate: string | null | undefined): string | null {
    const currentDate = toDate(current ?? undefined);
    const candidateDate = toDate(candidate ?? undefined);
    if (!candidateDate) return currentDate ? current! : null;
    if (!currentDate || candidateDate.getTime() > currentDate.getTime()) return candidate!;
    return current!;
  }

  private resolveCredentials(
    credentialsEncrypted: string | null,
    connectorId: string,
  ): { email: string; apiToken: string } {
    if (!isEncryptionAvailable() || credentialsEncrypted == null) {
      throw new BadRequestException(
        `Connector ${connectorId} has no usable credentials (encryption unavailable or column null)`,
      );
    }
    let decrypted: string;
    try {
      decrypted = decrypt(credentialsEncrypted);
    } catch (error) {
      throw new BadRequestException(
        `Connector ${connectorId} credentials could not be decrypted: ${(error as Error)?.message ?? error}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      throw new BadRequestException(`Connector ${connectorId} credentials are not valid JSON`);
    }
    const record = asRecord(parsed);
    const email = asStr(record.email) ?? '';
    const apiToken = asStr(record.apiToken) ?? '';
    if (email === '' || apiToken === '') {
      throw new BadRequestException(`Connector ${connectorId} credentials missing email or apiToken`);
    }
    return { email, apiToken };
  }

  private validSince(value: unknown): string | null {
    if (typeof value === 'string' && Number.isFinite(new Date(value).getTime())) return value;
    if (value !== undefined && value !== null) {
      this.logger.warn(`jira import: ignoring corrupt issues cursor — full refetch`);
    }
    return null;
  }

  private validIssuesContinuation(value: unknown): IssuesContinuation | null {
    if (value === undefined || value === null) return null;
    const record = asRecord(value);
    const nextPageToken = asStr(record.nextPageToken);
    const queryCursor = record.queryCursor === null ? null : this.validSince(record.queryCursor);
    const maxUpdatedAt = record.maxUpdatedAt === null ? null : this.validSince(record.maxUpdatedAt);
    const valid =
      nextPageToken !== undefined &&
      nextPageToken.length > 0 &&
      nextPageToken.length <= MAX_CONTINUATION_TOKEN_CHARS &&
      (record.queryCursor === null || queryCursor !== null) &&
      (record.maxUpdatedAt === null || maxUpdatedAt !== null);
    if (!valid) {
      this.logger.warn('jira import: ignoring corrupt issues continuation — restarting from completed cursor');
      return null;
    }
    return { queryCursor, nextPageToken, maxUpdatedAt };
  }
}
