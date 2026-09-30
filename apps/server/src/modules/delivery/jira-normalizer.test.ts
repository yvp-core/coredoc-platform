import { describe, expect, it } from 'vitest';
import { normalizeJiraIssue } from './jira-normalizer.js';

const issue: Record<string, unknown> = {
  id: '10042',
  key: 'PROD-42',
  fields: {
    issuetype: { name: 'Story' },
    summary: 'Implement delivery observability',
    status: { name: 'Done' },
    labels: ['backend', 'delivery'],
    assignee: { accountId: 'acc-assignee', displayName: 'Alice Dev', emailAddress: 'alice@example.com' },
    reporter: { accountId: 'acc-reporter', displayName: 'Bob PM', emailAddress: 'bob@example.com' },
    parent: { id: '10001' },
    project: { key: 'PROD' },
    priority: { name: 'High' },
    created: '2026-07-01T09:00:00.000+0000',
    updated: '2026-07-05T10:00:00.000+0000',
    resolutiondate: '2026-07-05T09:30:00.000+0000',
  },
  changelog: {
    histories: [
      {
        id: '100',
        created: '2026-07-02T09:00:00.000+0000',
        author: { accountId: 'acc-dev', displayName: 'Carol Dev' },
        items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
      },
      {
        id: '101',
        created: '2026-07-03T09:00:00.000+0000',
        author: { accountId: 'acc-bot', displayName: 'Automation for Jira', accountType: 'app' },
        items: [{ field: 'summary', fromString: 'Old title', toString: 'New title' }],
      },
      {
        id: '102',
        created: '2026-07-05T09:00:00.000+0000',
        author: { accountId: 'acc-dev', displayName: 'Carol Dev' },
        items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }],
      },
    ],
  },
};

describe('normalizeJiraIssue', () => {
  it('normalizes canonical Jira task state, transitions, actors, and attributes', () => {
    const normalized = normalizeJiraIssue(issue, [])!;

    expect(normalized).toMatchObject({
      externalId: '10042',
      externalKey: 'PROD-42',
      itemType: 'feature',
      title: 'Implement delivery observability',
      statusRaw: 'Done',
      labels: ['backend', 'delivery'],
      assigneeAccountId: 'acc-assignee',
      reporterAccountId: 'acc-reporter',
      parentExternalId: '10001',
      createdAtSource: '2026-07-01T09:00:00.000+0000',
      completedAt: '2026-07-05T09:30:00.000+0000',
      updatedAtSource: '2026-07-05T10:00:00.000+0000',
      attrs: {
        projectKey: 'PROD',
        priority: 'High',
        updatedAtSource: '2026-07-05T10:00:00.000+0000',
      },
    });
    expect(normalized.transitions).toEqual([
      {
        occurredAt: '2026-07-02T09:00:00.000+0000',
        fromStatusRaw: 'To Do',
        toStatusRaw: 'In Progress',
        actorAccountId: 'acc-dev',
        sourceRef: '100',
      },
      {
        occurredAt: '2026-07-05T09:00:00.000+0000',
        fromStatusRaw: 'In Progress',
        toStatusRaw: 'Done',
        actorAccountId: 'acc-dev',
        sourceRef: '102',
      },
    ]);
    expect(normalized.actors.map((actor) => actor.accountId).sort()).toEqual([
      'acc-assignee',
      'acc-bot',
      'acc-dev',
      'acc-reporter',
    ]);
  });

  it('merges extra changelog entries and de-duplicates embedded history ids', () => {
    const normalized = normalizeJiraIssue(issue, [
      {
        id: '100',
        items: [{ field: 'status', fromString: 'Duplicate', toString: 'Duplicate' }],
      },
      {
        id: '103',
        created: '2026-07-06T09:00:00.000+0000',
        author: { accountId: 'acc-dev' },
        items: [{ field: 'status', fromString: 'Done', toString: 'Reopened' }],
      },
    ])!;

    expect(normalized.transitions.map((transition) => transition.sourceRef)).toEqual(['100', '102', '103']);
  });

  it('rejects issues without a string id and tolerates hostile optional shapes', () => {
    expect(normalizeJiraIssue({ key: 'PROD-1' }, [])).toBeNull();
    expect(normalizeJiraIssue({ id: 123 }, [])).toBeNull();
    expect(normalizeJiraIssue({ id: '5', fields: 'bad', changelog: 'bad' }, 'bad' as never)).toMatchObject({
      externalId: '5',
      labels: [],
      transitions: [],
      actors: [],
    });
  });

  it('caps transitions at 500 oldest entries', () => {
    const histories = Array.from({ length: 600 }, (_, index) => ({
      id: String(index),
      created: '2026-07-01T00:00:00.000+0000',
      author: { accountId: 'acc-dev' },
      items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
    }));
    const normalized = normalizeJiraIssue({ id: '11', changelog: { histories } }, [])!;

    expect(normalized.transitions).toHaveLength(500);
    expect(normalized.transitions[0].sourceRef).toBe('0');
    expect(normalized.transitions[499].sourceRef).toBe('499');
  });
});
