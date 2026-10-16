/**
 * Only server-owned facts go in, so no agent-written text reaches Jira. Each
 * comment carries a run marker that a retry finds before posting again.
 */

export interface CommentPullRequest {
  repository: string;
  number: number;
  url: string;
}

type AdfNode = Record<string, unknown>;

const text = (value: string): AdfNode => ({ type: 'text', text: value });
const link = (value: string, href: string): AdfNode => ({
  type: 'text',
  text: value,
  marks: [{ type: 'link', attrs: { href } }],
});
const paragraph = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });

export function runMarker(runId: string, kind: 'done' | 'failure'): string {
  return `coredoc-agent-run:${runId}:${kind}`;
}

export function commentHasMarker(body: unknown, marker: string): boolean {
  return JSON.stringify(body ?? null).includes(marker);
}

function pullRequestList(pullRequests: CommentPullRequest[]): AdfNode {
  return {
    type: 'orderedList',
    content: pullRequests.map((pull) => ({
      type: 'listItem',
      content: [paragraph(text(`${pull.repository}: `), link(`#${pull.number}`, pull.url))],
    })),
  };
}

function markerParagraph(marker: string): AdfNode {
  return paragraph({ type: 'text', text: marker, marks: [{ type: 'code' }] });
}

function doc(content: AdfNode[]): AdfNode {
  return { type: 'doc', version: 1, content };
}

export function doneComment(input: { pullRequests: CommentPullRequest[]; runUrl: string; marker: string }): AdfNode {
  return doc([
    paragraph(
      text(
        input.pullRequests.length
          ? 'Coredoc agent run finished. Draft pull requests, in merge order:'
          : 'Coredoc agent run finished.',
      ),
    ),
    ...(input.pullRequests.length ? [pullRequestList(input.pullRequests)] : []),
    paragraph(text('Run: '), link(input.runUrl, input.runUrl)),
    markerParagraph(input.marker),
  ]);
}

export function failureComment(input: {
  message: string;
  pullRequests: CommentPullRequest[];
  runUrl: string;
  marker: string;
}): AdfNode {
  return doc([
    paragraph(text(`Coredoc agent run failed: ${input.message}`)),
    ...(input.pullRequests.length
      ? [paragraph(text('Draft pull requests opened before it failed:')), pullRequestList(input.pullRequests)]
      : []),
    paragraph(text('Run: '), link(input.runUrl, input.runUrl)),
    markerParagraph(input.marker),
  ]);
}
