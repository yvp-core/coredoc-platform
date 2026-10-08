/**
 * Draft pull request titles and bodies for the delivery turn. The server
 * assembles them so agent-written text is sanitised in one place: issue keys
 * other than the run's own get a non-breaking hyphen (Delivery analytics
 * reads keys from titles and bodies and must not link unrelated tasks), and
 * images are removed. The full spec is never included; the run page has it.
 */

export const MAX_PULL_REQUEST_BODY_CHARS = 60_000;

const NON_BREAKING_HYPHEN = '‑';
const ISSUE_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9_]+)-(\d+)(?![A-Za-z0-9])/g;
const INLINE_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const REFERENCE_IMAGE = /!\[([^\]]*)\]\[[^\]]*\]/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;
const TRUNCATION_NOTE = '\n\n_This description was truncated; the run page has the rest._';

export function sanitiseAgentText(text: string, ownIssueKey: string): string {
  return text
    .replace(INLINE_IMAGE, '$1')
    .replace(REFERENCE_IMAGE, '$1')
    .replace(HTML_IMAGE, '')
    .replace(ISSUE_KEY, (key, project: string, number: string) =>
      key === ownIssueKey ? key : `${project}${NON_BREAKING_HYPHEN}${number}`,
    );
}

export interface PullRequestBodyInput {
  issueKey: string;
  /** The accepted spec's title. */
  specTitle: string;
  /** This pull request's repository key. */
  repository: string;
  /** What the agent said it changed here; null when it gave no per-repository summary. */
  summary: string | null;
  /** Every touched repository's key, in merge order. */
  mergeOrder: string[];
  assumptions: string[];
  withheldPaths: string[];
  binaryPaths: string[];
  /** Why the agent could not build or test this repository in the runner; null when it could. */
  notBuiltOrTested: string | null;
  runUrl: string;
  previousRunUrl: string | null;
}

/** A path as inline code; a backtick in it would end the span early. */
const codePath = (path: string) => `\`${path.replace(/`/g, "'")}\``;

export function assemblePullRequest(input: PullRequestBodyInput): { title: string; body: string } {
  const clean = (text: string) => sanitiseAgentText(text, input.issueKey);
  const sections: string[] = [
    `## What this pull request changes in ${input.repository}\n\n${clean(input.summary?.trim() || 'See the run page.')}`,
    `## Merge order\n\n${input.mergeOrder
      .map((key, index) => `${index + 1}. ${key}${key === input.repository ? ' (this pull request)' : ''}`)
      .join('\n')}`,
  ];
  if (input.assumptions.length) {
    sections.push(`## Assumptions\n\n${input.assumptions.map((text) => `- ${clean(text)}`).join('\n')}`);
  }
  const review: string[] = [];
  if (input.withheldPaths.length) {
    review.push(
      `Withheld from the push, for a person to apply:\n\n${input.withheldPaths.map((p) => `- ${clean(codePath(p))}`).join('\n')}`,
    );
  }
  if (input.binaryPaths.length) {
    review.push(
      `Binary files the secret scan could not review:\n\n${input.binaryPaths.map((p) => `- ${clean(codePath(p))}`).join('\n')}`,
    );
  }
  if (review.length) sections.push(`## For review\n\n${review.join('\n\n')}`);
  if (input.notBuiltOrTested) {
    sections.push(`## Not built or tested in the runner\n\n${clean(input.notBuiltOrTested)}`);
  }

  const footer = [
    '---',
    `Agent run: ${input.runUrl} (the full accepted spec is on the run page)`,
    ...(input.previousRunUrl ? [`Previous run: ${input.previousRunUrl}`] : []),
  ].join('\n');

  let main = sections.join('\n\n');
  const room = MAX_PULL_REQUEST_BODY_CHARS - footer.length - 2;
  if (main.length > room) main = `${main.slice(0, room - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
  return {
    title: `${input.issueKey}: ${clean(input.specTitle.trim())}`,
    body: `${main}\n\n${footer}`,
  };
}
