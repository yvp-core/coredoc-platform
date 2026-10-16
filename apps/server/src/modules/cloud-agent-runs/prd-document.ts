import { adfToMarkdown } from './adf-to-markdown.js';

export interface PrdIssue {
  key: string;
  summary: string;
  issueType: string | null;
  status: string | null;
  labels: string[];
  /** Atlassian Document Format. */
  description: unknown;
}

export interface PrdSource {
  siteUrl: string;
  issue: PrdIssue;
  /** In Jira rank order, only those in configured projects. */
  epicChildren: PrdIssue[];
  /** The PRD tooling keeps shared decisions on the epic. */
  parentEpic: PrdIssue | null;
}

function body(issue: PrdIssue): string {
  return adfToMarkdown(issue.description) || '(The issue has no description.)';
}

export function buildPrdDocument(source: PrdSource): string {
  const { issue } = source;
  const facts = [issue.issueType, issue.status].filter(Boolean).join(', ');
  const labels = issue.labels.length ? `; labels: ${issue.labels.join(', ')}` : '';
  const sections = [
    `# ${issue.key}: ${issue.summary}`,
    `Jira issue: ${source.siteUrl}/browse/${issue.key}${facts || labels ? ` (${facts}${labels})` : ''}`,
    body(issue),
  ];
  if (source.epicChildren.length) {
    sections.push('## Child issues');
    for (const child of source.epicChildren) sections.push(`### ${child.key}: ${child.summary}`, body(child));
  }
  if (source.parentEpic) {
    sections.push(
      `## Shared context from epic ${source.parentEpic.key}: ${source.parentEpic.summary}`,
      body(source.parentEpic),
    );
  }
  return `${sections.join('\n\n')}\n`;
}
