import { describe, expect, it } from 'vitest';
import {
  assemblePullRequest,
  MAX_PULL_REQUEST_BODY_CHARS,
  PART_CAPS,
  type PullRequestBodyInput,
  sanitiseAgentText,
} from './pull-request-body.js';

const NB = '\u2011';

/** True when markdown would read an image: a `![` whose `!` is not escaped by an odd run of backslashes. */
const formsImage = (text: string) => /(?:^|[^\\])(?:\\\\)*!\[/.test(text);
/** What Delivery analytics reads as an issue key (the GitHub normalizer's pattern). */
const analyticsKeys = (text: string) => [...text.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g)].map((m) => m[1]);

describe('sanitiseAgentText', () => {
  it.each([
    ['the run’s own key stays linkable', 'Implements PROJ-12 as asked', 'Implements PROJ-12 as asked'],
    ['a foreign key gets a non-breaking hyphen', 'See OPS-7 for context', `See OPS${NB}7 for context`],
    ['an epic child key counts as foreign', 'Split from PROJ-13 and PROJ-12', `Split from PROJ${NB}13 and PROJ-12`],
    ['keys inside words are not keys', 'utf-8 and X-1 and abcPROJ-9', `utf-8 and X-1 and abcPROJ-9`],
    ['keys with digits and underscores', 'A2_B-44, PROJ-120', `A2_B${NB}44, PROJ${NB}120`],
    [
      'an inline image is escaped',
      'Look ![chart](https://x.example/c.png)',
      'Look \\![chart](https://x.example/c.png)',
    ],
    [
      'an HTML image is escaped',
      'Look <img src="https://x.example/c.png">',
      'Look &lt;img src="https://x.example/c.png"&gt;',
    ],
    ['an ordinary link stays', 'Docs at [the guide](https://x.example/g)', 'Docs at [the guide](https://x.example/g)'],
    ['a key wrapped in markup is still neutralised', '<OPS-7>', `&lt;OPS${NB}7&gt;`],
  ])('%s', (_name, text, expected) => {
    expect(sanitiseAgentText(text, 'PROJ-12')).toBe(expected);
  });

  it.each([
    ['a nested image tag', '<im<img>g src="https://x.example/p.png">'],
    ['a picture with a source set', '<picture><source srcset="https://x.example/p.png"></picture>'],
    ['a video poster', '<video poster="https://x.example/p.png"></video>'],
    ['an SVG image', '<svg><image href="https://x.example/p.png"/></svg>'],
    ['a reference image with its definition', '![chart][1]\n\n[1]: https://x.example/p.png'],
    ['an image URL with parentheses', '![chart](https://x.example/a_(b).png)'],
    ['a doubled bang', '!![x](https://x.example/a.png)[y](https://x.example/b.png)'],
    [
      'an agent-written escape before the image',
      '\\![x](https://x.example/a.png) and \\\\![y](https://x.example/b.png)',
    ],
    ['an image inside a link', '[![x](https://x.example/a.png)](https://x.example)'],
  ])('%s cannot render HTML or an image', (_name, text) => {
    const out = sanitiseAgentText(text, 'PROJ-12');
    expect(out).not.toMatch(/</);
    expect(formsImage(out)).toBe(false);
  });

  it.each([
    ['split by a tag', 'OPS-<b>7</b> and <i>OPS</i>-8'],
    ['split by an escaped bang', 'OPS-![7](u)'],
    ['next to entities the escaping adds', '<OPS-9>&OPS-10;'],
  ])('a key %s is never left for analytics to read', (_name, text) => {
    expect(analyticsKeys(sanitiseAgentText(text, 'PROJ-12'))).toEqual([]);
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

  it('neutralises foreign keys and escapes HTML and images in every agent-written part, title included', () => {
    const { title, body } = assemblePullRequest(
      input({
        specTitle: 'Exports for OPS-1 <img src="https://x.example/t.png">',
        summary: 'Follows OPS-2 ![diagram](https://x.example/d.png)',
        assumptions: ['Same as PROJ-13 <video poster="https://x.example/v.png">'],
        withheldPaths: ['docs/OPS-3.md', 'evil`\n\n<img src="https://x.example/w.png">'],
        binaryPaths: ['assets/![x](https://x.example/b.png)'],
        notBuiltOrTested: 'Blocked by INFRA-4 <img src="https://x.example/p.png">',
      }),
    );
    expect(title).toBe(`PROJ-12: Exports for OPS${NB}1 &lt;img src="https://x.example/t.png"&gt;`);
    expect(analyticsKeys(`${title}\n${body}`).filter((key) => key !== 'PROJ-12')).toEqual([]);
    // Paths are one-line code spans, where nothing renders; everything else is escaped.
    const outsideCode = body.replace(/`[^`\n]*`/g, '');
    expect(outsideCode).not.toMatch(/</);
    expect(formsImage(outsideCode)).toBe(false);
    expect(body).toContain('`evil   <img src="https://x.example/w.png">`');
  });

  it('caps the body between whole parts with a truncation note, keeping the run link', () => {
    const { body } = assemblePullRequest(input({ assumptions: Array.from({ length: 50 }, () => 'x'.repeat(2_000)) }));
    expect(body.length).toBeLessThanOrEqual(MAX_PULL_REQUEST_BODY_CHARS);
    expect(body).toMatch(/truncated/i);
    expect(body).toContain('https://coredoc.example/w/acme/agent-runs/run-1');
    expect(body.match(/^- x+$/gm)!.every((line) => line === `- ${'x'.repeat(2_000)}`)).toBe(true);
  });

  /** Markup and the run's own key placed exactly across a cap: a cut must never form markup or a foreign key. */
  const acrossCap = (cap: number) =>
    ['<img src="https://x.example/p.png">', '![a](https://x.example/p.png)', '&lt;img', 'PROJ-12'].flatMap((tail) =>
      // The cap falls mid-tail, and one character before its end (`PROJ-12` becomes `PROJ-1`).
      [Math.ceil(tail.length / 2), tail.length - 1].map((kept) => `${'y'.repeat(cap - kept - 1)} ${tail}`),
    );

  it.each(
    acrossCap(PART_CAPS.summary).map((summary) => [summary.slice(-40), summary]),
  )('a summary cut at its cap (…%s) forms no markup and no foreign key', (_tail, summary) => {
    const { body } = assemblePullRequest(input({ summary }));
    expect(body).not.toMatch(/</);
    expect(formsImage(body)).toBe(false);
    expect(analyticsKeys(body).filter((key) => key !== 'PROJ-12')).toEqual([]);
  });

  it('a body cut at its cap, with markup in every part, forms no markup and no foreign key', () => {
    const assumptions = Array.from({ length: 50 }, (_, index) => acrossCap(PART_CAPS.item)[index % 8]!);
    const { title, body } = assemblePullRequest(
      input({
        specTitle: acrossCap(PART_CAPS.title)[7]!,
        summary: acrossCap(PART_CAPS.summary)[0]!,
        assumptions,
        withheldPaths: acrossCap(PART_CAPS.path),
      }),
    );
    expect(body.length).toBeLessThanOrEqual(MAX_PULL_REQUEST_BODY_CHARS);
    expect(body).toMatch(/truncated/i);
    const outsideCode = body.replace(/`[^`\n]*`/g, '');
    expect(outsideCode).not.toMatch(/</);
    expect(formsImage(outsideCode)).toBe(false);
    expect(analyticsKeys(`${title}\n${body}`).filter((key) => key !== 'PROJ-12')).toEqual([]);
  });
});
