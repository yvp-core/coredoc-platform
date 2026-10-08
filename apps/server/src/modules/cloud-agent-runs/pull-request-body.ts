/**
 * Draft pull request titles and bodies for the delivery turn. The server
 * assembles them so agent-written text is sanitised in one place: issue keys
 * other than the run's own get a non-breaking hyphen (Delivery analytics
 * reads keys from titles and bodies and must not link unrelated tasks), and
 * nothing in them can load a remote resource. The full spec is never
 * included; the run page has it.
 */

export const MAX_PULL_REQUEST_BODY_CHARS = 60_000;

const NON_BREAKING_HYPHEN = '‑';
/**
 * A superset of what Delivery analytics reads as a key (`\b[A-Z][A-Z0-9]{1,9}-\d+\b`
 * in the GitHub normalizer): neutralising a little too much is harmless.
 */
const ISSUE_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9_]+)-(\d+)(?![A-Za-z0-9])/g;
const TRUNCATION_NOTE = '\n\n_This description was truncated; the run page has the rest._';

/**
 * Escapes rather than removes, so nothing can be reassembled from the
 * pieces: no raw HTML renders (`<` and `>` become entities, which covers
 * `<img>`, `<picture>`, `<video poster>` and SVG `<image>` alike), and no
 * markdown image forms (every `![` becomes `\![`, with backslashes doubled
 * first so an agent-written `\` cannot cancel that escape).
 */
function escapeAgentMarkdown(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/!\[/g, '\\![');
}

function neutraliseIssueKeys(text: string, ownIssueKey: string): string {
  return text.replace(ISSUE_KEY, (key, project: string, number: string) =>
    key === ownIssueKey ? key : `${project}${NON_BREAKING_HYPHEN}${number}`,
  );
}

/** Every agent-written part of a title or body goes through this; the server's own template does not. */
export function sanitiseAgentText(text: string, ownIssueKey: string): string {
  return neutraliseIssueKeys(escapeAgentMarkdown(text), ownIssueKey);
}

/**
 * A path as a one-line code span, where nothing renders: backticks would end
 * the span and line breaks could end the paragraph, so both are replaced.
 */
function codePath(path: string, ownIssueKey: string): string {
  return `\`${neutraliseIssueKeys(path.replace(/[`\r\n]/g, ' '), ownIssueKey)}\``;
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

/**
 * Raw caps per agent-written part, applied before escaping so a cut can never
 * split an escape or the run's own key (a cut key is a foreign key, and is
 * neutralised with the rest). Escaping at most quadruples a part, so the
 * summary still fits the body cap.
 */
export const PART_CAPS = { title: 200, summary: 10_000, item: 2_000, path: 1_024 } as const;

/** A whole markdown block and the separator before it; the body is only ever cut between blocks. */
interface Block {
  separator: '' | '\n' | '\n\n';
  text: string;
}

export function assemblePullRequest(input: PullRequestBodyInput): { title: string; body: string } {
  const clean = (text: string, cap: number) => sanitiseAgentText(text.slice(0, cap), input.issueKey);
  const path = (text: string) => codePath(text.slice(0, PART_CAPS.path), input.issueKey);
  const blocks: Block[] = [];
  const section = (heading: string, items: string[], itemSeparator: Block['separator'] = '\n') => {
    blocks.push({ separator: blocks.length ? '\n\n' : '', text: heading });
    items.forEach((text, index) => blocks.push({ separator: index === 0 ? '\n\n' : itemSeparator, text }));
  };

  section(`## What this pull request changes in ${input.repository}`, [
    clean(input.summary?.trim() || 'See the run page.', PART_CAPS.summary),
  ]);
  section(
    '## Merge order',
    input.mergeOrder.map(
      (key, index) => `${index + 1}. ${key}${key === input.repository ? ' (this pull request)' : ''}`,
    ),
  );
  if (input.assumptions.length) {
    section(
      '## Assumptions',
      input.assumptions.map((text) => `- ${clean(text, PART_CAPS.item)}`),
    );
  }
  if (input.withheldPaths.length || input.binaryPaths.length) section('## For review', []);
  if (input.withheldPaths.length) {
    blocks.push({ separator: '\n\n', text: 'Withheld from the push, for a person to apply:' });
    input.withheldPaths.forEach((p, index) => blocks.push({ separator: index ? '\n' : '\n\n', text: `- ${path(p)}` }));
  }
  if (input.binaryPaths.length) {
    blocks.push({ separator: '\n\n', text: 'Binary files the secret scan could not review:' });
    input.binaryPaths.forEach((p, index) => blocks.push({ separator: index ? '\n' : '\n\n', text: `- ${path(p)}` }));
  }
  if (input.notBuiltOrTested) {
    section('## Not built or tested in the runner', [clean(input.notBuiltOrTested, PART_CAPS.item)]);
  }

  const footer = [
    '---',
    `Agent run: ${input.runUrl} (the full accepted spec is on the run page)`,
    ...(input.previousRunUrl ? [`Previous run: ${input.previousRunUrl}`] : []),
  ].join('\n');

  // Whole blocks only: when the next one does not fit, stop and say so.
  const room = MAX_PULL_REQUEST_BODY_CHARS - footer.length - 2 - TRUNCATION_NOTE.length;
  let main = '';
  let truncated = false;
  for (const block of blocks) {
    const next = `${main}${block.separator}${block.text}`;
    if (next.length > room) {
      truncated = true;
      break;
    }
    main = next;
  }
  if (truncated) main += TRUNCATION_NOTE;
  return {
    title: `${input.issueKey}: ${clean(input.specTitle.trim(), PART_CAPS.title)}`,
    body: `${main}\n\n${footer}`,
  };
}
