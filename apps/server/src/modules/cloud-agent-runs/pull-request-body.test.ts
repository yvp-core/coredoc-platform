import { describe, expect, it } from 'vitest';
import {
  assemblePullRequest,
  MAX_PULL_REQUEST_BODY_CHARS,
  type PullRequestBodyInput,
  sanitiseAgentText,
} from './pull-request-body.js';

const NB = '‑';

describe('sanitiseAgentText', () => {
  it.each([
    ['the run’s own key stays linkable', 'Implements PROJ-12 as asked', 'Implements PROJ-12 as asked'],
    ['a foreign key gets a non-breaking hyphen', 'See OPS-7 for context', `See OPS${NB}7 for context`],
    ['an epic child key counts as foreign', 'Split from PROJ-13 and PROJ-12', `Split from PROJ${NB}13 and PROJ-12`],
    ['keys inside words are not keys', 'utf-8 and X-1 and abcPROJ-9', `utf-8 and X-1 and abcPROJ-9`],
    ['keys with digits and underscores', 'A2_B-44, PROJ-120', `A2_B${NB}44, PROJ${NB}120`],
    ['an inline image keeps only its alt text', 'Look ![the chart](https://x.example/c.png) here', 'Look the chart here'],
    ['a reference image keeps only its alt text', 'Look ![chart][1] here', 'Look chart here'],
    ['an HTML image is removed', 'Look <img src="https://x.example/c.png" alt="c"> here', 'Look  here'],
    ['an ordinary link stays', 'Docs at [the guide](https://x.example/g)', 'Docs at [the guide](https://x.example/g)'],
  ])('%s', (_name, text, expected) => {
    expect(sanitiseAgentText(text, 'PROJ-12')).toBe(expected);
  });
});

const input = (overrides: Partial<PullRequestBodyInput> = {}): PullRequestBodyInput => ({
  issueKey: 'PROJ-12',
  specTitle: 'Order exports',
  repository: 'orders-api',
  summary: 'Adds the CSV export endpoint.',
  mergeOrder: ['billing-api', 'orders-api'],
  assumptions: ['CSV only'],
  withheldPaths: [],
  binaryPaths: [],
  notBuiltOrTested: null,
  runUrl: 'https://coredoc.example/w/acme/agent-runs/run-1',
  previousRunUrl: null,
  ...overrides,
});

describe('assemblePullRequest', () => {
  it('titles the pull request with the issue key and the spec title', () => {
    expect(assemblePullRequest(input()).title).toBe('PROJ-12: Order exports');
  });

  it('carries the summary, the merge order, the assumptions and the run link; no spec text', () => {
    const { body } = assemblePullRequest(input());
    expect(body).toContain('Adds the CSV export endpoint.');
    expect(body).toMatch(/1\. billing-api\n2\. orders-api \(this pull request\)/);
    expect(body).toContain('- CSV only');
    expect(body).toContain('https://coredoc.example/w/acme/agent-runs/run-1');
    expect(body).not.toMatch(/previous run/i);
    expect(body).not.toMatch(/not built or tested/i);
  });

  it('lists withheld and binary paths for review, and a repository not built or tested with its reason', () => {
    const { body } = assemblePullRequest(
      input({
        withheldPaths: ['.github/workflows/ci.yml'],
        binaryPaths: ['assets/logo.png'],
        notBuiltOrTested: 'Its tests need Docker compose',
      }),
    );
    expect(body).toContain('`.github/workflows/ci.yml`');
    expect(body).toContain('`assets/logo.png`');
    expect(body).toMatch(/not built or tested[^\n]*\n+Its tests need Docker compose/i);
  });

  it('links the previous run on a re-run', () => {
    const { body } = assemblePullRequest(input({ previousRunUrl: 'https://coredoc.example/w/acme/agent-runs/run-0' }));
    expect(body).toMatch(/previous run[^\n]*https:\/\/coredoc\.example\/w\/acme\/agent-runs\/run-0/i);
  });

  it('neutralises foreign keys and removes images in every agent-written part, title included', () => {
    const { title, body } = assemblePullRequest(
      input({
        specTitle: 'Exports for OPS-1',
        summary: 'Follows OPS-2 ![diagram](https://x.example/d.png)',
        assumptions: ['Same as PROJ-13'],
        withheldPaths: ['docs/OPS-3.md'],
        notBuiltOrTested: 'Blocked by INFRA-4 <img src="https://x.example/p.png">',
      }),
    );
    expect(title).toBe(`PROJ-12: Exports for OPS${NB}1`);
    expect(`${title}\n${body}`).not.toMatch(/(?<![A-Za-z0-9])(?!PROJ-12\b)[A-Z][A-Z0-9_]+-\d+/);
    expect(body).not.toMatch(/!\[|<img/i);
    expect(body).toContain('diagram');
  });

  it('caps the body with a truncation note, keeping the run link', () => {
    const { body } = assemblePullRequest(input({ summary: 'x'.repeat(100_000) }));
    expect(body.length).toBeLessThanOrEqual(MAX_PULL_REQUEST_BODY_CHARS);
    expect(body).toMatch(/truncated/i);
    expect(body).toContain('https://coredoc.example/w/acme/agent-runs/run-1');
  });
});
