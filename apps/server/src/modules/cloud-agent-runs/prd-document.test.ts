import { describe, expect, it } from 'vitest';
import { buildPrdDocument } from './prd-document.js';

const adf = (value: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
});

const issue = (key: string, summary: string, description: unknown, type = 'Story') => ({
  key,
  summary,
  issueType: type,
  status: 'To Do',
  labels: ['coredoc-agent'],
  description,
});

describe('PRD document', () => {
  it('starts with the issue key, link and title, followed by the converted description', () => {
    const markdown = buildPrdDocument({
      siteUrl: 'https://example.atlassian.net',
      issue: issue('PROJ-7', 'Export orders', adf('Customers need CSV exports.')),
      epicChildren: [],
      parentEpic: null,
    });
    expect(markdown).toBe(
      [
        '# PROJ-7: Export orders',
        '',
        'Jira issue: https://example.atlassian.net/browse/PROJ-7 (Story, To Do; labels: coredoc-agent)',
        '',
        'Customers need CSV exports.',
        '',
      ].join('\n'),
    );
  });

  it('appends an epic’s child issues in the order given (Jira rank)', () => {
    const markdown = buildPrdDocument({
      siteUrl: 'https://example.atlassian.net',
      issue: issue('PROJ-1', 'Exports', adf('Shared decisions.'), 'Epic'),
      epicChildren: [
        issue('PROJ-3', 'Request an export', adf('Story A.')),
        issue('PROJ-2', 'Download', adf('Story B.')),
      ],
      parentEpic: null,
    });
    expect(markdown.indexOf('## Child issues')).toBeGreaterThan(markdown.indexOf('Shared decisions.'));
    expect(markdown.indexOf('### PROJ-3: Request an export')).toBeLessThan(markdown.indexOf('### PROJ-2: Download'));
    expect(markdown).toContain('Story A.');
    expect(markdown).toContain('Story B.');
  });

  it('adds the parent epic’s description as shared context for a child issue', () => {
    const markdown = buildPrdDocument({
      siteUrl: 'https://example.atlassian.net',
      issue: issue('PROJ-2', 'Download', adf('Story B.')),
      epicChildren: [],
      parentEpic: issue('PROJ-1', 'Exports', adf('Shared decisions.'), 'Epic'),
    });
    expect(markdown).toContain('## Shared context from epic PROJ-1: Exports');
    expect(markdown.indexOf('Shared decisions.')).toBeGreaterThan(markdown.indexOf('Story B.'));
  });

  it('says so when the description is empty, rather than handing the agent nothing', () => {
    const markdown = buildPrdDocument({
      siteUrl: 'https://example.atlassian.net',
      issue: issue('PROJ-9', 'Empty', null),
      epicChildren: [],
      parentEpic: null,
    });
    expect(markdown).toContain('(The issue has no description.)');
  });
});
