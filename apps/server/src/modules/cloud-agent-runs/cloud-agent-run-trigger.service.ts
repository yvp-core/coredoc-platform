import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { CloudAgentRunAvailability } from './cloud-agent-run-availability.service.js';
import { CloudAgentRunJiraConnector } from './cloud-agent-run-jira-connector.js';
import { CloudAgentRunSettingsService } from './cloud-agent-run-settings.service.js';
import { CloudAgentRunService, type TriggeredIssue } from './cloud-agent-run.service.js';

/** What the trigger reads per issue; `id` and `key` come with every search result. */
const TRIGGER_FIELDS = ['summary', 'labels', 'issuetype', 'status', 'updated'];
/** One bounded search per tick: at most this many 100-issue pages. */
const TRIGGER_MAX_PAGES = 5;

/** A JQL string literal; Atlassian's reference recommends quoting labels and relative dates. */
function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The trigger search. Never issued without the project clause; the caller
 * passes at least one validated project key.
 */
export function triggerJql(projectKeys: readonly string[], label: string): string {
  if (projectKeys.length === 0) throw new Error('trigger search needs a project key');
  const projects = projectKeys.map(jqlString).join(', ');
  return `project in (${projects}) AND labels = ${jqlString(label)} AND updated >= "-1d" ORDER BY created ASC`;
}

function asTriggeredIssue(item: Record<string, unknown>): TriggeredIssue | null {
  const fields = (item.fields ?? {}) as { labels?: unknown };
  if (typeof item.id !== 'string' || typeof item.key !== 'string') return null;
  const labels = Array.isArray(fields.labels) ? fields.labels.filter((l): l is string => typeof l === 'string') : [];
  return { id: item.id, key: item.key, labels };
}

/**
 * One workspace's trigger tick: promote queued runs while agent runs are
 * enabled and available, then, when the trigger is ready, search the
 * configured projects for the trigger label and create a run for every issue
 * that never had one.
 */
@Injectable()
export class CloudAgentRunTrigger {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CloudAgentRunSettingsService,
    private readonly availability: CloudAgentRunAvailability,
    private readonly jira: CloudAgentRunJiraConnector,
    private readonly runs: CloudAgentRunService,
  ) {}

  async tick(workspaceId: string): Promise<void> {
    const settings = await this.settings.get(workspaceId);
    if (!settings.enabled) return;
    const availability = await this.availability.check(workspaceId, settings);
    // Queued runs stay queued while unavailable; settings and the list page show why.
    if (!availability.available) return;
    await this.runs.promote(workspaceId, settings);

    const runOwnerId = settings.runOwnerId;
    if (!availability.trigger.ready || !runOwnerId) return;
    const jira = await this.jira.state(workspaceId);
    if (jira.status !== 'active' || jira.projectKeys.length === 0) return;

    const { items } = await this.jira
      .client(jira.connector)
      .searchIssues(triggerJql(jira.projectKeys, settings.triggerLabel), TRIGGER_FIELDS, {
        expandChangelog: false,
        maxPages: TRIGGER_MAX_PAGES,
      });
    const issues = items.map(asTriggeredIssue).filter((issue): issue is TriggeredIssue => issue !== null);
    if (issues.length === 0) return;

    // The label stays on an issue after its run, so most hits already had one;
    // skip those before the per-issue work. Creation re-checks under the lock.
    const known = new Set(
      (
        await this.prisma.cloudAgentRun.findMany({
          where: { workspaceId, jiraIssueId: { in: issues.map((issue) => issue.id) } },
          select: { jiraIssueId: true },
        })
      ).map((run) => run.jiraIssueId),
    );
    for (const issue of issues) {
      if (known.has(issue.id)) continue;
      await this.runs.createFromJira(workspaceId, { ...settings, runOwnerId }, jira.connector.id, issue);
    }
  }
}
