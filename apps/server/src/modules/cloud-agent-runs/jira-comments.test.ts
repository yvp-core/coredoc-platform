import { describe, expect, it } from 'vitest';
import { commentHasMarker, doneComment, failureComment, runMarker } from './jira-comments.js';

const RUN_URL = 'https://coredoc.example/w/acme/agent-runs/run-1';
const PULLS = [
  { repository: 'billing-api', number: 4, url: 'https://github.com/example-org/billing-api/pull/4' },
  { repository: 'orders-api', number: 9, url: 'https://github.com/example-org/orders-api/pull/9' },
];

/** Text and link targets in document order. */
function flatten(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const { text, marks, content } = node as {
    text?: string;
    marks?: Array<{ attrs?: { href?: string } }>;
    content?: unknown[];
  };
  const own = [
    ...(text ? [text] : []),
    ...(marks ?? []).flatMap((mark) => (mark.attrs?.href ? [`<${mark.attrs.href}>`] : [])),
  ];
  return [...own, ...(content ?? []).flatMap(flatten)];
}

describe('Jira comment bodies', () => {
  it('the done comment lists the pull requests in merge order, links the run and carries the marker', () => {
    const marker = runMarker('run-1', 'done');
    const body = doneComment({ pullRequests: PULLS, runUrl: RUN_URL, marker });
    expect(body).toMatchObject({ type: 'doc', version: 1 });
    const parts = flatten(body);
    const billing = parts.indexOf(`<${PULLS[0]!.url}>`);
    const orders = parts.indexOf(`<${PULLS[1]!.url}>`);
    expect(billing).toBeGreaterThan(-1);
    expect(orders).toBeGreaterThan(billing);
    expect(parts).toContain(`<${RUN_URL}>`);
    expect(commentHasMarker(body, marker)).toBe(true);
  });

  it('a failure comment with verified pull requests carries the fixed message, the pull requests and the run link', () => {
    const marker = runMarker('run-1', 'failure');
    const body = failureComment({
      message: 'Opening or verifying the pull requests, or posting the Jira done comment, failed.',
      pullRequests: PULLS.slice(0, 1),
      runUrl: RUN_URL,
      marker,
    });
    const parts = flatten(body).join('\n');
    expect(parts).toContain('Opening or verifying the pull requests, or posting the Jira done comment, failed.');
    expect(parts).toContain(`<${PULLS[0]!.url}>`);
    expect(parts).toContain(`<${RUN_URL}>`);
    expect(commentHasMarker(body, marker)).toBe(true);
  });

  it('a failure comment without pull requests has no pull request list', () => {
    const body = failureComment({
      message: 'Nobody answered or reviewed within the waiting limit.',
      pullRequests: [],
      runUrl: RUN_URL,
      marker: runMarker('run-1', 'failure'),
    });
    expect(JSON.stringify(body)).not.toMatch(/pull request|orderedList|bulletList/i);
  });

  it('markers tell runs and comment kinds apart', () => {
    const body = doneComment({ pullRequests: [], runUrl: RUN_URL, marker: runMarker('run-1', 'done') });
    expect(commentHasMarker(body, runMarker('run-1', 'failure'))).toBe(false);
    expect(commentHasMarker(body, runMarker('run-2', 'done'))).toBe(false);
  });
});
